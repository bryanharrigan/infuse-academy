#!/usr/bin/env node
/**
 * infuse-deploy.mjs — pull-based deploy daemon for Infuse Academy.
 *
 * Runs on the ORIGIN machine (the Windows PC with cloudflared + Node on :3000).
 *
 * WHAT IT DOES
 *   Every `pollSeconds`, fetches the tracking branch and compares it to HEAD.
 *   If the remote moved, it runs ONE fixed sequence:
 *
 *       git fetch --prune  ->  verify  ->  back up build/  ->  git reset --hard
 *       ->  npm ci (only if the lockfile changed)  ->  npm run build
 *       ->  restart the app service  ->  health check  ->  rollback on failure
 *
 * WHY POLLING AND NOT A WEBHOOK
 *   There is no inbound network path. Nothing listens on any port, so there is
 *   no endpoint to authenticate, no HMAC secret to store and rotate, no WAF
 *   rule to maintain, and no new tunnel ingress or DNS record. The origin only
 *   ever makes outbound HTTPS calls to GitHub. The attack surface of this
 *   daemon is exactly: "whoever can push to the tracked branch".
 *
 * SAFETY PROPERTIES
 *   - No shell. Every command goes through execFile with an argv array, so
 *     nothing from git output or the repo can be interpreted as a command.
 *   - The command sequence is fixed in this file. The remote cannot influence
 *     WHICH commands run, only WHAT CODE is checked out.
 *   - The remote URL is pinned. If origin's URL ever differs from the config,
 *     the daemon refuses to deploy.
 *   - Optional commit-signature enforcement (requireSignedCommits). With
 *     branch protection this closes the "GitHub account compromised" hole.
 *   - build/ is backed up before every deploy and restored if the build fails
 *     or the app does not come back healthy.
 *   - One deploy at a time, guarded by an in-process lock.
 *   - .env is never touched. It is gitignored, so `git reset --hard` leaves it
 *     alone; the daemon never reads or writes it.
 *
 * USAGE
 *   node infuse-deploy.mjs --config C:\ProgramData\infuse-deploy\config.json
 *   node infuse-deploy.mjs --config ... --once       # single pass, then exit
 *   node infuse-deploy.mjs --config ... --dry-run    # report only, change nothing
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync, renameSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";

const exec = promisify(execFile);

// ----------------------------------------------------------------- config --

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const CONFIG_PATH = opt("config", join(process.cwd(), "config.json"));
const ONCE = flag("once");
const DRY_RUN = flag("dry-run");

/** @type {{
 *  repoPath: string, branch: string, expectedRemote: string,
 *  appServiceName: string, healthUrl: string, healthTimeoutSeconds: number,
 *  pollSeconds: number, requireSignedCommits: boolean, logPath: string,
 *  gitPath: string, npmPath: string, nssmPath: string|null
 * }} */
let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (err) {
  console.error(`FATAL: cannot read config at ${CONFIG_PATH}: ${err.message}`);
  process.exit(2);
}

const required = ["repoPath", "branch", "expectedRemote", "appServiceName", "healthUrl"];
for (const key of required) {
  if (!cfg[key]) {
    console.error(`FATAL: config is missing required key "${key}"`);
    process.exit(2);
  }
}

cfg.pollSeconds ??= 60;
cfg.healthTimeoutSeconds ??= 90;
cfg.requireSignedCommits ??= false;
cfg.gitPath ??= "git";
// Node >= 20.12 refuses to spawn .cmd/.bat without a shell (EINVAL), and the
// origin runs Node 24. So npm is invoked as `node npm-cli.js ...` rather than
// `npm.cmd`, which keeps shell:false and avoids the restriction entirely.
cfg.nodePath ??= process.execPath;
cfg.npmCliJs ??= null;
cfg.nssmPath ??= null;
cfg.logPath ??= join(dirname(CONFIG_PATH), "deploy.log");

const BUILD_DIR = join(cfg.repoPath, "build");
const BACKUP_DIR = join(cfg.repoPath, ".build-prev");

/**
 * Deploy status, served to the browser.
 *
 * ┌─ Why this file exists ────────────────────────────────────┐
 * │ Rollback worked exactly as designed and that was the problem.    │
 * │ From 14 to 16 Oct 2026, main carried a route importing a module  │
 * │ that was never committed. Every build failed, every rollback     │
 * │ succeeded, and the site kept serving a two-day-old build while   │
 * │ looking completely healthy. A failed deploy and no deploy at all │
 * │ were indistinguishable from a browser, so nobody looked at the   │
 * │ log, because nothing suggested there was anything to look at.    │
 * │                                                                  │
 * │ So: after every outcome, write what is ACTUALLY being served. A  │
 * │ silent rollback is now a visible one.                            │
 * └──────────────────────────────────────────────────────┘
 *
 * build/client is the static root remix-serve publishes, so this lands at
 * GET /deploy-status.json with no app route and no app code - which matters,
 * because an app route could not report on a deploy that stopped the app
 * from having that route.
 */
const STATUS_FILE = join(BUILD_DIR, "client", "deploy-status.json");

/** Absolute paths and multi-line stack noise do not belong on a public URL. */
function publicError(msg) {
  return String(msg ?? "")
    .split("\n")[0]
    // Segments split on backslash; a segment may contain spaces (C:\Program
    // Files\...), so stopping at the first space would leave half the path
    // exposed. Over-redacts trailing prose, which is the safe direction.
    .replace(/[A-Za-z]:(?:\\[^\\\n"']*)+/g, "<path>")
    .slice(0, 300);
}

/** Describe a commit for the status file; never throws. */
async function describe(sha) {
  if (!sha) return null;
  const safe = async (fmt) => {
    try {
      return await gitOut("log", "-1", `--format=${fmt}`, sha);
    } catch {
      return null;
    }
  };
  return {
    sha,
    short: sha.slice(0, 8),
    subject: await safe("%s"),
    committedAt: await safe("%cI"),
  };
}

/**
 * Write the status file. Called AFTER the build settles - including after a
 * rollback, because restoreBuild() copies the previous build back over
 * build/ and would otherwise restore the previous status file along with
 * it, reporting the failure as a success.
 */
function writeStatus(payload) {
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2) + "\n"
    );
    info(`status written -> ${STATUS_FILE}`);
  } catch (e) {
    // Never let status reporting break a deploy that otherwise worked.
    warn(`could not write status file: ${e.message}`);
  }
}

// ------------------------------------------------------------------ logging

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(dirname(cfg.logPath), { recursive: true });
    appendFileSync(cfg.logPath, line + "\n");
  } catch {
    /* logging must never take the daemon down */
  }
}
const info = (m) => log("INFO", m);
const warn = (m) => log("WARN", m);
const error = (m) => log("ERROR", m);

// ------------------------------------------------------------ command layer

/**
 * Run a command with an explicit argv array. Never uses a shell, so no value
 * passed here can be reinterpreted as shell syntax.
 */
async function run(file, argv, { cwd = cfg.repoPath, timeout = 600_000 } = {}) {
  const pretty = `${file} ${argv.join(" ")}`;
  info(`$ ${pretty}`);
  try {
    const { stdout, stderr } = await exec(file, argv, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      shell: false,
    });
    const out = (stdout || "").trim();
    if (out) out.split("\n").slice(-40).forEach((l) => info(`  | ${l}`));
    const err = (stderr || "").trim();
    if (err) err.split("\n").slice(-40).forEach((l) => info(`  | ${l}`));
    return { ok: true, stdout: out, stderr: err };
  } catch (e) {
    error(`command failed: ${pretty}`);
    const combined = `${e.stdout || ""}\n${e.stderr || ""}`.trim();
    if (combined) combined.split("\n").slice(-40).forEach((l) => error(`  | ${l}`));
    if (e.killed) error(`  | killed after timeout (${timeout}ms)`);
    return { ok: false, stdout: e.stdout || "", stderr: e.stderr || "", err: e };
  }
}

const git = (...argv) => run(cfg.gitPath, argv);

/**
 * Run npm WITHOUT a shell. Node >= 20.12 blocks spawning .cmd/.bat with
 * shell:false, so npm.cmd is unusable here. npm ships a plain JS entrypoint
 * (npm-cli.js); running it under node sidesteps the restriction and keeps the
 * no-shell guarantee that makes the fixed command sequence trustworthy.
 */
async function npm(argv, timeout = 900_000) {
  if (!cfg.npmCliJs) {
    throw new Error('config.npmCliJs is not set - point it at npm-cli.js (e.g. "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js")');
  }
  if (!existsSync(cfg.npmCliJs)) {
    throw new Error(`config.npmCliJs does not exist: ${cfg.npmCliJs}`);
  }
  return run(cfg.nodePath, [cfg.npmCliJs, ...argv], { timeout });
}

async function gitOut(...argv) {
  const r = await exec(cfg.gitPath, argv, {
    cwd: cfg.repoPath,
    windowsHide: true,
    shell: false,
  }).catch((e) => ({ stdout: "", _err: e }));
  return (r.stdout || "").trim();
}

// ---------------------------------------------------------------- preflight

async function preflight() {
  if (!existsSync(cfg.repoPath)) throw new Error(`repoPath does not exist: ${cfg.repoPath}`);
  if (!existsSync(join(cfg.repoPath, ".git"))) throw new Error(`not a git checkout: ${cfg.repoPath}`);

  // Pin the remote. A changed origin URL means someone repointed the checkout.
  const remote = await gitOut("remote", "get-url", "origin");
  const norm = (u) => u.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  if (norm(remote) !== norm(cfg.expectedRemote)) {
    throw new Error(
      `origin URL mismatch — refusing to deploy.\n` +
        `  expected: ${cfg.expectedRemote}\n` +
        `  actual:   ${remote}`
    );
  }

  if (!cfg.npmCliJs || !existsSync(cfg.npmCliJs)) {
    throw new Error(`npmCliJs missing or not found: ${cfg.npmCliJs}`);
  }

  const branch = await gitOut("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== cfg.branch) {
    throw new Error(`checkout is on "${branch}", expected "${cfg.branch}" — refusing to deploy`);
  }

  return true;
}

// ------------------------------------------------------------ health checks

async function isHealthy(timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.healthUrl, { signal: ctl.signal, redirect: "manual" });
    // Anything that is not a 5xx means the Node process is up and routing.
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitForHealthy() {
  const deadline = Date.now() + cfg.healthTimeoutSeconds * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    if (await isHealthy()) {
      info(`health check passed on attempt ${attempt} (${cfg.healthUrl})`);
      return true;
    }
    await sleep(3000);
  }
  error(`health check never passed within ${cfg.healthTimeoutSeconds}s (${cfg.healthUrl})`);
  return false;
}

// ------------------------------------------------------------ service control

async function restartApp() {
  if (cfg.nssmPath) {
    const r = await run(cfg.nssmPath, ["restart", cfg.appServiceName], { timeout: 120_000 });
    if (r.ok) return true;
    warn("nssm restart failed, falling back to sc.exe stop/start");
  }
  // sc.exe returns non-zero if the service is already stopped; tolerate that.
  await run("sc.exe", ["stop", cfg.appServiceName], { timeout: 60_000 });
  await sleep(3000);
  const start = await run("sc.exe", ["start", cfg.appServiceName], { timeout: 60_000 });
  return start.ok;
}

// ------------------------------------------------------------ build backup

function backupBuild() {
  if (!existsSync(BUILD_DIR)) {
    info("no existing build/ to back up (first deploy?)");
    return false;
  }
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  cpSync(BUILD_DIR, BACKUP_DIR, { recursive: true });
  info(`backed up build/ -> ${BACKUP_DIR}`);
  return true;
}

function restoreBuild() {
  if (!existsSync(BACKUP_DIR)) {
    warn("no build backup to restore from");
    return false;
  }
  rmSync(BUILD_DIR, { recursive: true, force: true });
  cpSync(BACKUP_DIR, BUILD_DIR, { recursive: true });
  warn(`restored build/ from ${BACKUP_DIR}`);
  return true;
}

// ----------------------------------------------------------------- deploy

let deploying = false;

async function deploy(fromSha, toSha) {
  if (deploying) {
    warn("a deploy is already running; skipping this pass");
    return;
  }
  deploying = true;
  const started = Date.now();
  info("=".repeat(70));
  info(`DEPLOY ${fromSha.slice(0, 8)} -> ${toSha.slice(0, 8)}`);

  const subject = await gitOut("log", "-1", "--format=%s", toSha);
  const author = await gitOut("log", "-1", "--format=%an <%ae>", toSha);
  info(`  commit : ${subject}`);
  info(`  author : ${author}`);

  try {
    // -- signature gate -----------------------------------------------------
    if (cfg.requireSignedCommits) {
      const sig = await gitOut("log", "-1", "--format=%G?", toSha);
      // G = good, U = good but untrusted, E/B/N = bad or absent
      if (sig !== "G") {
        throw new Error(
          `commit ${toSha.slice(0, 8)} has signature status "${sig}" (need "G") — refusing to deploy`
        );
      }
      info(`  signature: verified (${await gitOut("log", "-1", "--format=%GS", toSha)})`);
    }

    // -- does the lockfile change? decides whether npm ci is needed ----------
    const changed = await gitOut("diff", "--name-only", `${fromSha}..${toSha}`);
    const files = changed ? changed.split("\n") : [];
    const needsInstall =
      files.includes("package-lock.json") ||
      files.includes("package.json") ||
      !existsSync(join(cfg.repoPath, "node_modules"));
    info(`  files changed: ${files.length}${needsInstall ? "  (dependency install required)" : ""}`);

    if (DRY_RUN) {
      info("DRY RUN — stopping before any change is made");
      return;
    }

    // -- back up the currently-serving build --------------------------------
    backupBuild();

    // -- check out the new code ---------------------------------------------
    const reset = await git("reset", "--hard", toSha);
    if (!reset.ok) throw new Error("git reset --hard failed");

    // NOTE: `git clean -df` was REMOVED on 14 Oct 2026.
    //
    // The origin machine carries `.env.production` (live secrets) as an
    // UNTRACKED file. `clean -df` removes untracked-and-unignored files, so it
    // would have deleted the production secrets on the first deploy. Adding
    // `.env.*` to .gitignore fixes that, but a destructive step guarding
    // nothing important is not worth the blast radius. Files that git stops
    // tracking now linger in the working tree; that is the safer failure.

    // -- dependencies --------------------------------------------------------
    if (needsInstall) {
      const ci = await npm(["ci", "--no-audit", "--no-fund"], 900_000);
      if (!ci.ok) throw new Error("npm ci failed");
    }

    // -- build ---------------------------------------------------------------
    const build = await npm(["run", "build"], 900_000);
    if (!build.ok) throw new Error("npm run build failed");

    // -- restart + verify ----------------------------------------------------
    await restartApp();
    const healthy = await waitForHealthy();
    if (!healthy) throw new Error("app did not become healthy after restart");

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    info(`DEPLOY OK — now serving ${toSha.slice(0, 8)} (${secs}s)`);
    writeStatus({
      status: "ok",
      serving: await describe(toSha),
      attempted: null,
      error: null,
      tookSeconds: Number(secs),
      note: "Build, restart and health check all passed. This is the running code.",
    });
  } catch (e) {
    error(`DEPLOY FAILED: ${e.message}`);
    error("rolling back...");

    let outcome = "rollback-failed";
    let rollbackError = null;
    try {
      await git("reset", "--hard", fromSha);
      restoreBuild();
      await restartApp();
      const ok = await waitForHealthy();
      if (ok) {
        warn(`ROLLBACK OK — back on ${fromSha.slice(0, 8)}`);
        outcome = "failed";
      } else {
        error("ROLLBACK FAILED — THE SITE IS DOWN AND NEEDS A HUMAN");
        rollbackError = "app did not become healthy after rollback";
      }
    } catch (rb) {
      error(`ROLLBACK THREW: ${rb.message} — THE SITE IS DOWN AND NEEDS A HUMAN`);
      rollbackError = publicError(rb.message);
    }

    // Written last, after restoreBuild() has put the old build/ back - the
    // restore would otherwise overwrite this file with the previous build's
    // copy and report a failed deploy as a success.
    writeStatus({
      status: outcome,
      serving: await describe(fromSha),
      attempted: await describe(toSha),
      error: publicError(e.message),
      rollbackError,
      note:
        outcome === "failed"
          ? "This commit FAILED to deploy. The site is serving the previous build, which is older than origin/main."
          : "Deploy failed AND rollback failed. The site needs a human.",
    });
  } finally {
    deploying = false;
    info("=".repeat(70));
  }
}

// -------------------------------------------------------------------- loop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pass() {
  const fetched = await git("fetch", "--prune", "origin", cfg.branch);
  if (!fetched.ok) {
    warn("git fetch failed; will retry next pass");
    return;
  }
  const local = await gitOut("rev-parse", "HEAD");
  const remote = await gitOut("rev-parse", `origin/${cfg.branch}`);

  if (!local || !remote) {
    warn("could not resolve local or remote HEAD; skipping");
    return;
  }
  if (local === remote) return; // nothing to do, stay quiet

  // Only move forward. If the remote is not a descendant of HEAD, someone
  // force-pushed or rewrote history — deploy it, but say so loudly.
  const ancestor = await exec(cfg.gitPath, ["merge-base", "--is-ancestor", local, remote], {
    cwd: cfg.repoPath,
    windowsHide: true,
    shell: false,
  }).then(() => true).catch(() => false);
  if (!ancestor) {
    warn(`origin/${cfg.branch} is NOT a fast-forward from HEAD (history rewritten or force-pushed)`);
  }

  await deploy(local, remote);
}

async function main() {
  info(`infuse-deploy starting`);
  info(`  config  : ${CONFIG_PATH}`);
  info(`  repo    : ${cfg.repoPath}`);
  info(`  branch  : ${cfg.branch}`);
  info(`  remote  : ${cfg.expectedRemote}`);
  info(`  service : ${cfg.appServiceName}`);
  info(`  health  : ${cfg.healthUrl}`);
  info(`  poll    : ${cfg.pollSeconds}s`);
  info(`  signed  : ${cfg.requireSignedCommits ? "REQUIRED" : "not enforced"}`);
  if (DRY_RUN) info(`  MODE    : DRY RUN — nothing will be changed`);

  try {
    await preflight();
    info("preflight OK");
  } catch (e) {
    error(`PREFLIGHT FAILED: ${e.message}`);
    process.exit(1);
  }

  if (ONCE) {
    await pass();
    return;
  }

  // Keep running whatever happens; a crash loop under a service manager is
  // worse than a logged error and a retry.
  for (;;) {
    try {
      await pass();
    } catch (e) {
      error(`unhandled error in poll loop: ${e.stack || e.message}`);
    }
    await sleep(cfg.pollSeconds * 1000);
  }
}

process.on("SIGTERM", () => {
  info("SIGTERM — exiting");
  process.exit(0);
});
process.on("SIGINT", () => {
  info("SIGINT — exiting");
  process.exit(0);
});

main();

# Infuse Academy — secure change + deploy pipeline

**Status:** design + scripts ready. Nothing has been installed. Step 1 is a read-only probe.

## The model

```
  you ask for a change in chat
        │
        ▼
  Claude edits C:\Projects\infuse-academy on absorb-9r0cl44
        │        (device bridge, scoped to that one folder)
        ▼
  you review `git diff`, commit, push          ◄── the only trust boundary
        │
        ▼
  origin machine notices origin/main moved, pulls, builds,
  restarts, health-checks, rolls back if anything fails
```

Claude never touches the origin machine. There is no inbound network path to
it, no credential for it stored anywhere, and no way for this chat session to
execute a command on it. The origin makes outbound HTTPS calls to GitHub and
nothing else.

### Why polling rather than the signed webhook you picked

You chose the webhook option, and I built the poll variant instead — here's the
reasoning, and say the word if you still want the webhook.

A webhook gets you deploys in ~2 seconds instead of ~30 seconds average. To buy
that you add: a public HTTPS endpoint on the origin, an HMAC secret to store
and rotate, a tunnel ingress rule, a DNS record, and ideally a WAF rule pinning
GitHub's source IPs. Five new things to maintain and one new inbound path.

Polling gets the same automation with none of that. The origin asks GitHub
"has main moved?" once a minute over an outbound connection it already makes.
There is no endpoint to attack, so there is nothing to authenticate.

For a demo site where you push a handful of times a day, 30 seconds of latency
is not worth a public control-plane endpoint. If you later want instant deploys
— say you're iterating live in front of a prospect — the webhook listener is a
small addition on top of this and I'll write it then.

### What the trust boundary actually is

With this design, "who can change the site" reduces to exactly "who can push to
`main`". That is worth hardening, because the repo is **public** and a
compromised GitHub account currently ships straight to production:

1. **Branch protection on `main`** — require a PR, block force-pushes.
2. **Require signed commits**, then flip `requireSignedCommits: true` in the
   daemon config. The origin then refuses any commit not signed by your key,
   so a GitHub-side compromise alone isn't enough to deploy code.
3. Consider making the repo **private**. The findings doc already flags that
   recent commits wired the PSBI demo to a live portal with a real curriculum
   ID, and that nobody has done a pass over `app/.server/` for other things
   that shouldn't be world-readable.

Do (1) today, it's two clicks. (2) is the one that actually closes the hole.

---

## Step 1 — probe the origin machine (read-only, do this first)

The project doc's own rule is *check, don't assume* — and three things about
that machine are unverified: where env vars live now that Amplify is gone,
what keeps Node alive across reboots, and where the checkout actually is.

On the **origin** machine, in an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\discover-origin.ps1
```

It changes nothing. It prints no secret values — `.env` is reported as key
names only, and the tunnel credentials JSON is listed but never read. Skim it
before pasting the output back to me.

**The answer I most need is how the app currently runs**, because that decides
whether a deploy script can restart it at all. Three possibilities:

| What discovery shows | What it means |
|---|---|
| A Windows **service** (nssm.exe or node.exe as a service) | Good. Use that service name, go to step 2. |
| A **scheduled task**, or a `node` under `explorer.exe` | It's a logged-in session. A reboot or logoff kills the site. Needs converting. |
| Nothing on :3000 / can't find it | The site is down, or it's served some other way. Stop and reassess. |

### The prerequisite nobody can skip

`package.json` has `start: remix-serve ./build/server/index.js`. **`remix-serve`
does not read `.env`** — Remix only loads dotenv in dev. The `server.js` at the
repo root *does* (`import "dotenv/config"`), but that file is an Amplify-era
Express shim that the hosting doc lists as dead.

So one of these is true on that machine, and discovery will say which:

- it runs `node server.js`, and `.env` works; or
- it runs `npm start`, and the env vars are set **in the service definition or
  the machine environment**, not in `.env`.

This matters enormously: if I set up supervision assuming the wrong one,
`COOKIE_SECRET` and the OAuth config vanish and every sign-in breaks. Don't
let me guess at it.

---

## Step 2 — supervise the app (only after step 1)

If the app isn't already a service, make it one. NSSM, because it handles env
vars, restarts on crash, survives reboot with no user logged in, and writes
stdout to a file.

```powershell
# from an elevated prompt, in the folder holding nssm.exe
.\nssm.exe install infuse-academy "C:\Program Files\nodejs\node.exe"
.\nssm.exe set infuse-academy AppDirectory       "<repoPath from discovery>"
.\nssm.exe set infuse-academy AppParameters      "<server.js  OR  the remix-serve path>"
.\nssm.exe set infuse-academy AppStdout          "C:\ProgramData\infuse-deploy\app.log"
.\nssm.exe set infuse-academy AppStderr          "C:\ProgramData\infuse-deploy\app.log"
.\nssm.exe set infuse-academy AppRotateFiles     1
.\nssm.exe set infuse-academy Start              SERVICE_AUTO_START
.\nssm.exe set infuse-academy AppExit Default    Restart
.\nssm.exe set infuse-academy AppRestartDelay    5000
```

Plus env vars, **if** discovery shows they don't come from `.env`:

```powershell
.\nssm.exe set infuse-academy AppEnvironmentExtra NODE_ENV=production PORT=3000
# ...and the rest. Set these at the console, never in a file I generate.
```

I'll write the exact commands with the right paths once I see the report. Two
things I'd want to fix at the same time:

- **Bind :3000 to loopback.** Discovery reports whether it's on `0.0.0.0`. If
  it is, the app is reachable from the whole LAN and not just the tunnel, which
  bypasses every Cloudflare control you have. It should be `127.0.0.1:3000`.
- Confirm `cloudflared` is itself a service and not a console window.

---

## Step 3 — install the deploy daemon

```powershell
mkdir C:\ProgramData\infuse-deploy
copy infuse-deploy.mjs      C:\ProgramData\infuse-deploy\
copy config.example.json    C:\ProgramData\infuse-deploy\config.json
# edit config.json with the real paths from discovery
```

Verify before it ever touches anything:

```powershell
# preflight + report only; makes no changes at all
node C:\ProgramData\infuse-deploy\infuse-deploy.mjs `
     --config C:\ProgramData\infuse-deploy\config.json --once --dry-run
```

That confirms the remote URL pin, the branch, and whether a deploy is pending.
Then one real run in the foreground where you can watch it:

```powershell
node C:\ProgramData\infuse-deploy\infuse-deploy.mjs `
     --config C:\ProgramData\infuse-deploy\config.json --once
```

Only once that works, install it as a service:

```powershell
.\nssm.exe install infuse-deploy "C:\Program Files\nodejs\node.exe"
.\nssm.exe set infuse-deploy AppDirectory  "C:\ProgramData\infuse-deploy"
.\nssm.exe set infuse-deploy AppParameters "infuse-deploy.mjs --config C:\ProgramData\infuse-deploy\config.json"
.\nssm.exe set infuse-deploy AppStdout     "C:\ProgramData\infuse-deploy\service.log"
.\nssm.exe set infuse-deploy AppStderr     "C:\ProgramData\infuse-deploy\service.log"
.\nssm.exe set infuse-deploy AppRotateFiles 1
.\nssm.exe set infuse-deploy Start          SERVICE_AUTO_START
.\nssm.exe start infuse-deploy
```

**Service account:** the deployer calls `nssm restart infuse-academy`, which
needs rights over that service. `LocalSystem` (the NSSM default) has them.
That's a lot of privilege for something that runs code from a public repo —
which is exactly why `requireSignedCommits` is worth turning on. A tighter
setup grants a low-privilege account `SERVICE_START`/`SERVICE_STOP` on just
`infuse-academy` via `sc sdset`; worth doing if this ever stops being a demo.

---

## What the daemon guarantees

- **No shell.** Every command runs via `execFile` with an argv array. Nothing
  in git output, a branch name, or a commit message can become a command.
- **Fixed sequence.** The remote decides what code is checked out, never which
  commands run.
- **Pinned remote.** If `origin`'s URL doesn't match the config, it refuses.
- **Wrong branch, no deploy.** Refuses if the checkout isn't on `branch`.
- **`build/` backed up every time**, restored if the build fails or the app
  doesn't come back healthy.
- **Health gate.** After restart it polls `healthUrl` for up to 90s. A non-5xx
  counts as up. Failure triggers rollback: previous SHA, previous build,
  restart, re-check.
- **`.env` untouched.** It's gitignored so `reset --hard` leaves it; `clean -df`
  deliberately omits `-x` so ignored files survive. The daemon never reads it.
- **`npm ci` only when the lockfile moved**, so a content-only change deploys
  in seconds rather than minutes.
- **Force-push detection.** Logs loudly if `origin/main` isn't a fast-forward.

## What it deliberately does not do

- No secret management. Env vars stay in the service definition or `.env`,
  set by you at the console. Nothing I generate carries a credential.
- No zero-downtime swap. The restart is a ~2–5s gap. Proper blue/green needs
  two checkouts and a reverse proxy — real work, and overkill for a demo.
- No alerting. Failures land in `deploy.log`. If you want a ping on rollback,
  that's a webhook call in the catch block and I'll add it.

## Rollback by hand

```powershell
cd <repoPath>
git log --oneline -10
git reset --hard <last-known-good-sha>
npm run build
nssm restart infuse-academy
```

The daemon will try to re-deploy `origin/main` on its next pass and undo that.
To hold a manual rollback, either `nssm stop infuse-deploy` or revert on GitHub
so `main` genuinely points at the good commit — the second is better, because
it keeps the repo as the source of truth.

---

## Open items this doesn't resolve

- **Where env vars live on the origin.** Step 1 answers it. Nothing should be
  installed before it does.
- **The dead AWS files.** `amplify.yml`, `deploy-manifest.json`,
  `scripts/cloudflare-worker-amplify-proxy.js`, and possibly `server.js` are
  all Amplify-era. The hosting doc notes they're the main reason a fresh
  reader thinks the site is on Amplify. Worth deleting — but *not* `server.js`
  until we know whether the origin runs it.
- **Duplicate `psbi-dashboard-demo.html`** at the repo root (58KB) shadowing
  the real one in `public/` (86KB). A change to the wrong copy is silently
  ignored. Delete the root one.
- **Open from the findings doc**, untouched by any of this: minimum TLS still
  1.0, Always Use HTTPS still off, the PKCE claim in the handoff still wrong.

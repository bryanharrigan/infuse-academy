/**
 * test/engine/run.mjs
 *
 * Boots the particle engine in a real browser against the real anatomy
 * assets and photographs it. Catches what a typecheck cannot: a shader that
 * fails to link, an asset the manifest lists but the server does not have,
 * and — the reason this exists — a figure that renders as a cloud of fog.
 *
 *   npx esbuild test/engine/harness.ts --bundle --outfile=test/engine/harness.js --format=iife --target=es2020
 *   CHROME_PATH=... node test/engine/run.mjs [quality]
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { decodePng, exposure } from "./png.mjs";

const ROOT = process.cwd();
const QUALITY = process.argv[2] ?? "medium";
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".bin": "application/octet-stream", ".txt": "text/plain",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const file = url.pathname;
  const p = join(ROOT, file.startsWith("/anatomy/") ? "public" + file : file);
  if (!existsSync(p)) {
    res.writeHead(404).end("missing " + file);
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(8124, r));
mkdirSync("test/engine/shots", { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const failedRequests = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => {
  // The harness is a bare page with no favicon; that 404 is not the app's.
  if (m.type() === "error" && !/favicon/.test(m.text())) consoleErrors.push(m.text());
});
const ignore = (u) => /favicon/.test(u);
page.on("requestfailed", (r) => !ignore(r.url()) && failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => r.status() >= 400 && !ignore(r.url()) && failedRequests.push(`${r.url()} HTTP ${r.status()}`));

let pass = 0;
const fails = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name.padEnd(48)} ${detail}`); }
  else { fails.push(`${name} — ${detail}`); console.log(`  FAIL  ${name.padEnd(48)} ${detail}`); }
};

const t0 = Date.now();
// Served at its real path, not at "/": index.html loads harness.js
// relatively, and at the root that resolves to /harness.js.
await page.goto(`http://localhost:8124/test/engine/index.html?q=${QUALITY}`, {
  waitUntil: "load",
});
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const bootMs = Date.now() - t0;

// The particles fly in from a scatter shell, so a fixed sleep photographs
// whatever the assembly happens to have reached. Wait for it to land.
await page.waitForFunction(
  () => (window.__holo?.state?.form ?? 0) > 0.985,
  null,
  { timeout: 60000 }
);

const errors = await page.evaluate(() => window.__errors);
check("engine boots without throwing", errors.length === 0, errors.join("; "));
check("no failed asset requests", failedRequests.length === 0, failedRequests.slice(0, 3).join("; "));

const progress = await page.evaluate(() => window.__progress);
check("progress reaches completion", progress.at(-1)?.[0] >= 0.99, `last=${JSON.stringify(progress.at(-1))}`);
check("every discipline was mapped",
  progress.filter(([, t]) => t.startsWith("MAPPING")).length >= 10,
  `${progress.filter(([, t]) => t.startsWith("MAPPING")).length} mapped`);
console.log(`\n  boot ${(bootMs / 1000).toFixed(1)}s at ${QUALITY} quality\n`);

// Measure what actually reached the screen. A figure that renders as a wall
// of white, or as nothing at all, passes every other check here.
const shoot = async (name) => {
  const file = `test/engine/shots/${QUALITY}-${name}.png`;
  await page.screenshot({ path: file });
  return exposure(decodePng(readFileSync(file)));
};

const body = await shoot("00-body");
check("the figure is actually drawn", body.litFraction > 0.02,
  `${(body.litFraction * 100).toFixed(1)}% of pixels lit`);
check("the figure is not a wall of white", body.blownFraction < 0.02,
  `${(body.blownFraction * 100).toFixed(2)}% blown out`);
check("exposure is in range", body.meanLuma > 2 && body.meanLuma < 90,
  `mean luma ${body.meanLuma.toFixed(1)}`);

for (const organ of ["heart", "lungs", "brain", "liver", "kidneys", "digestive", "vascular", "skeleton", "muscular", "eyes"]) {
  await page.evaluate((id) => window.__select(id), organ);
  // Hold until the reveal and the camera flight have both settled.
  await page.waitForFunction(
    () => (window.__holo?.state?.reveal ?? 0) > 0.8 && window.__holo?.camT >= 1,
    null,
    { timeout: 30000 }
  ).catch(() => {});
  await page.waitForTimeout(900);
  const s = await shoot(organ);
  check(`${organ} renders`, s.litFraction > 0.004, `${(s.litFraction * 100).toFixed(2)}% lit`);
  check(`${organ} is not blown out`, s.blownFraction < 0.03, `${(s.blownFraction * 100).toFixed(2)}% blown`);
}

check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join("; "));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) process.exit(1);

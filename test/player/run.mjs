import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
const ROOT = process.cwd();
const TYPES = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".bin":"application/octet-stream",".txt":"text/plain"};
const server = createServer((q, r) => {
  const p = join(ROOT, new URL(q.url, "http://x").pathname);
  if (!existsSync(p)) { r.writeHead(404).end(); return; }
  r.writeHead(200, { "Content-Type": TYPES[extname(p)] ?? "application/octet-stream" });
  r.end(readFileSync(p));
});
await new Promise((r) => server.listen(8130, r));
mkdirSync("test/player/shots", { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH,
  args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"] });
for (const [w, h, tag] of [[1920, 1080, "1920"], [1440, 900, "1440"]]) {
  const pg = await b.newPage({ viewport: { width: w, height: h } });
  await pg.goto("http://localhost:8130/test/player/harness.html", { waitUntil: "load" });
  await pg.waitForTimeout(3500);
  for (const state of ["railed", "bare", "expanded"]) {
    await pg.evaluate((s) => window.setState(s), state);
    await pg.waitForTimeout(900);
    await pg.screenshot({ path: `test/player/shots/${tag}-${state}.png` });
    const m = await pg.evaluate(() => {
      const f = document.querySelector(".holo-player__screen iframe").getBoundingClientRect();
      return { w: Math.round(f.width), h: Math.round(f.height) };
    });
    console.log(`${tag} ${state.padEnd(9)} iframe ${m.w}x${m.h}`);
  }
  await pg.close();
}
await b.close(); server.close();

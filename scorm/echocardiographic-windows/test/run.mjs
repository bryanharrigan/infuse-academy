/**
 * Drives the built SCORM package against a stub SCORM 1.2 LMS in headless
 * Chromium and asserts the run-time conversation, not just the pixels.
 *
 *   NODE_PATH=../../node_modules node test/run.mjs
 *
 * Screenshots land in test/shots/.
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { extname, join } from 'path';

const ROOT = 'package';
if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('package/ not built — run `node build.mjs` first');
  process.exit(1);
}
copyFileSync('test/lms-wrapper.html', join(ROOT, 'lms-wrapper.html'));

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.xml':'application/xml' };
const server = createServer((q, r) => {
  const p = join(ROOT, q.url.split('?')[0] === '/' ? '/lms-wrapper.html' : q.url.split('?')[0]);
  if (!existsSync(p)) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
  r.end(readFileSync(p));
});
await new Promise(r => server.listen(8123, r));
mkdirSync('test/shots', { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });

const external = [];
page.on('request', (req) => {
  const u = req.url();
  if (!u.startsWith('http://localhost:8123') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {
  // Chromium always probes /favicon.ico; that 404 belongs to this test
  // server, not to the package, and a SCO has no business shipping a favicon.
  if (m.type() === 'error' && !/favicon/i.test(m.text()) && !/status of 404/.test(m.text())) {
    errors.push('console: ' + m.text());
  }
});

await page.goto('http://localhost:8123/', { waitUntil: 'load' });
const sco = page.frameLocator('#sco');
await sco.locator('#ec-nav .ec-navitem').first().waitFor({ timeout: 60000 });
// Software rendering is slow and the engine clamps its frame delta, so give
// the heart real time to assemble before the first screenshot.
await page.waitForTimeout(9000);

const calls = () => page.evaluate(() => window.__calls.map(c => c.join(' ')));
const store = () => page.evaluate(() => ({ ...window.__store }));
const results = [];
const check = (label, ok, detail = '') => results.push([ok, label, detail]);

check('LMSInitialize called', (await calls()).some(x => x.startsWith('LMSInitialize')));
check('lesson_status moved off "not attempted"',
  (await store())['cmi.core.lesson_status'] === 'incomplete',
  (await store())['cmi.core.lesson_status']);

const navCount = await sco.locator('#ec-nav .ec-navitem').count();
check('8 nav items (7 sections + knowledge check)', navCount === 8, String(navCount));

for (let i = 0; i < navCount; i++) {
  await sco.locator('#ec-nav .ec-navitem').nth(i).click();
  await page.waitForTimeout(i === 0 ? 2500 : 4200); // camera flight + plane fade
  const name = await sco.locator('#ec-nav .ec-navitem').nth(i).getAttribute('data-nav');
  await page.screenshot({ path: `test/shots/${String(i).padStart(2,'0')}-${name}.png` });
}

const s = await store();
check('lesson_location recorded', !!s['cmi.core.lesson_location'], s['cmi.core.lesson_location']);
check('suspend_data recorded', !!s['cmi.suspend_data'], s['cmi.suspend_data']);
check('suspend_data within SCORM 1.2 4096 limit',
  (s['cmi.suspend_data'] || '').length <= 4096, String((s['cmi.suspend_data']||'').length));

for (const [q, a] of Object.entries({ q1: 0, q2: 2, q3: 1, q4: 1, q5: 2 })) {
  await sco.locator(`#${q}-${a}`).check();
}
await sco.locator('#ec-submit').click();
await page.waitForTimeout(700);
await page.screenshot({ path: 'test/shots/08-check-passed.png' });

const s2 = await store();
check('score.raw = 100', s2['cmi.core.score.raw'] === '100', s2['cmi.core.score.raw']);
check('score.min / score.max set', s2['cmi.core.score.min'] === '0' && s2['cmi.core.score.max'] === '100');
check('lesson_status = passed', s2['cmi.core.lesson_status'] === 'passed', s2['cmi.core.lesson_status']);
check('LMSCommit called', (await calls()).includes('commit'));

await sco.locator('#ec-retry').click();
await page.waitForTimeout(300);
for (const [q, a] of Object.entries({ q1: 1, q2: 0, q3: 0, q4: 0, q5: 0 })) {
  await sco.locator(`#${q}-${a}`).check();
}
await sco.locator('#ec-submit').click();
await page.waitForTimeout(500);
const s3 = await store();
check('failing attempt reports failed', s3['cmi.core.lesson_status'] === 'failed', s3['cmi.core.lesson_status']);
check('failing score below mastery', Number(s3['cmi.core.score.raw']) < 80, s3['cmi.core.score.raw']);
await page.screenshot({ path: 'test/shots/09-check-failed.png' });

await page.evaluate(() => { document.getElementById('sco').src = 'about:blank'; });
await page.waitForTimeout(800);
const cFinal = await calls();
check('LMSFinish called on unload', cFinal.some(x => x.startsWith('LMSFinish')));
check('session_time reported', cFinal.some(x => x.startsWith('set cmi.core.session_time')));
check('no external network requests', external.length === 0, external.join(', '));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close(); server.close();

let bad = 0;
for (const [ok, label, detail] of results) {
  if (!ok) bad++;
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${label.padEnd(50)}${detail ? '  ' + detail : ''}`);
}
console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nall SCORM checks passed');
process.exit(bad ? 1 : 0);

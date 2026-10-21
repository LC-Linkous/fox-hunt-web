// The page in headless Chromium against the simulated fox. No hardware.
// SPDX-License-Identifier: GPL-2.0-only
//
// Run:  node --test tests/page/        (needs `playwright` resolvable: npm i -D playwright, or NODE_PATH)
// Skipped, not failed, when Playwright or its Chromium is not available, so
// the plain device tests still run anywhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.py': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain' };

let pw = null;
try { pw = await import('playwright'); } catch { try { pw = await import('/opt/npm-tools/node_modules/playwright/index.mjs'); } catch {} }

let server, base, browser;
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  try { browser = await pw.chromium.launch(); } catch { browser = null; }
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

/** test() whose body runs only when the browser came up (decided after `before`, not at registration). */
const ptest = (name, fn) => test(name, async t => { if (!browser) { if (process.env.REQUIRE_BROWSER) throw new Error('REQUIRE_BROWSER is set and Playwright/Chromium is not available'); return t.skip('Playwright/Chromium not available'); } await fn(t); });

/** A fresh page on the simulated fox, with every console error collected. */
async function demoPage({ viewport = { width: 1300, height: 900 }, geolocation = null } = {}) {
  const ctx = await browser.newContext({ viewport, ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}) });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base + 'index.html'); await page.waitForSelector('#demoBtn');
  await page.click('#demoBtn'); await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Simulated'));
  const open = async sec => { const h = page.locator(`section[data-section="${sec}"] h2 button`); if (await h.getAttribute('aria-expanded') !== 'true') await h.click(); };
  const text = async id => (await page.locator('#' + id).innerText()).trim();
  const close = async () => { assert.deepEqual(errors, [], 'no page errors'); await ctx.close(); };
  return { page, ctx, open, text, errors, close };
}

ptest('loads, connects to the simulated fox, identifies it', async () => {
  const d = await demoPage();
  assert.match(await d.text('statusText'), /Simulated · SA868 dual-band/);
  assert.equal(await d.page.locator('#bandSel').inputValue(), 'dual');
  assert.equal(await d.page.locator('#tuneBtn').isDisabled(), false);
  await d.open('setup');
  assert.equal(await d.text('fwVersion'), '0.4.0'); assert.equal(await d.text('fwNvm'), 'yes');
  await d.close();
});

ptest('receiver: presets tune, live run fills the readout, stop restores the button', async () => {
  const d = await demoPage(); await d.open('receiver');
  await d.page.locator('#presets button').first().click();
  assert.equal(await d.text('tunedNow'), '146.5650 MHz');
  await d.page.click('#liveBtn');
  await d.page.waitForFunction(() => /^\d+$/.test(document.getElementById('rssiNow').textContent));
  await d.page.waitForFunction(() => document.getElementById('rateNow').textContent !== '—', null, { timeout: 8000 });
  assert.match(await d.text('rateNow'), /\d+(\.\d+)? \/ s/);
  assert.equal(await d.text('liveBtn'), 'Stop receiver');
  await d.page.click('#liveBtn'); assert.equal(await d.text('liveBtn'), 'Start receiver');
  // one reading on demand
  await d.page.click('#oneBtn'); assert.match(await d.text('rssiNow'), /^\d+$/);
  await d.close();
});

ptest('scan: one scan finds the keyed fox, pin-peak puts it on the board', async () => {
  const d = await demoPage(); await d.open('scan');
  await d.page.fill('#scanStart', '146.5000'); await d.page.fill('#scanStop', '146.6000'); await d.page.selectOption('#scanStep', '25');
  await d.page.click('#scanBtn');
  await d.page.waitForFunction(() => document.getElementById('scanPeak').textContent !== '—', null, { timeout: 10000 });
  assert.match(await d.text('scanPeak'), /146\.5\d{3}/);
  await d.page.click('#pinPeakBtn'); await d.open('hunt');
  assert.equal(await d.page.locator('#boardBody tr').count(), 1);
  assert.match(await d.page.locator('#boardBody tr').first().innerText(), /146\.5\d{3}/);
  await d.page.click('#boardClearBtn'); assert.equal(await d.page.locator('#boardBody tr').count(), 0);
  await d.close();
});

ptest('autoseek stops on the keyed fox and pins it', async () => {
  const d = await demoPage(); await d.open('scan');
  await d.page.fill('#scanStart', '146.5000'); await d.page.fill('#scanStop', '146.6000'); await d.page.selectOption('#scanStep', '25');
  await d.page.click('#seekBtn');
  await d.page.waitForFunction(() => /(stopped on|on) 146\.5(65|75|50)0 MHz/.test(document.getElementById('seekStatus').textContent), null, { timeout: 60000 });
  assert.equal(await d.page.locator('#seekSkipBtn').isDisabled(), false);
  await d.page.click('#seekBtn');
  await d.open('hunt'); assert.ok(await d.page.locator('#boardBody tr').count() >= 1);
  await d.close();
});

ptest('bearing capture with the heading slider finds the fox to the ENE', async () => {
  const d = await demoPage(); await d.open('receiver'); await d.page.click('#liveBtn'); await d.open('hunt');
  const slider = d.page.locator('#headingSlider');
  await slider.evaluate(el => { el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const btn = d.page.locator('#captureBtn'); const box = await btn.boundingBox();
  await d.page.mouse.move(box.x + 10, box.y + 10); await d.page.mouse.down();
  for (let h = 0; h <= 360; h += 15) { await slider.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, h); await d.page.waitForTimeout(350); }
  await d.page.mouse.up();
  await d.page.waitForFunction(() => /bearing \d+°/.test(document.getElementById('captureStatus').textContent), null, { timeout: 5000 });
  const m = /bearing (\d+)°/.exec(await d.text('captureStatus')); const b = +m[1];
  assert.ok(Math.abs(b - 60) <= 20, `bearing ${b}° should be near 60°`);
  assert.equal(await d.page.locator('#bearingBody tr').count(), 1);
  await d.close();
});

ptest('session: record, save as JSON, load it back as a replay, return to live', async () => {
  const d = await demoPage(); await d.open('session');
  await d.page.click('#recBtn'); await d.open('receiver'); await d.page.click('#liveBtn'); await d.page.waitForTimeout(2500); await d.page.click('#liveBtn');
  await d.open('session'); assert.ok(parseInt(await d.text('recReadings'), 10) >= 10);
  const [dl] = await Promise.all([d.page.waitForEvent('download'), d.page.click('#recJsonBtn')]);
  const file = await dl.path(); const sess = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(sess.tool, 'fox-hunt-web'); assert.ok(sess.readings.length >= 10);
  const [chooser] = await Promise.all([d.page.waitForEvent('filechooser'), d.page.click('#sessLoadBtn')]);
  await chooser.setFiles(file);
  await d.page.waitForFunction(() => !document.getElementById('replayBadge').hidden);
  assert.equal(await d.page.locator('#clipPlayBtn').isDisabled(), false);
  await d.page.click('#clipExitBtn'); assert.ok(await d.page.locator('#replayBadge').isHidden());
  await d.close();
});

ptest('SQ wire: declared on the page, the carrier light follows the simulated pin', async () => {
  const d = await demoPage(); await d.open('setup');
  assert.equal(await d.text('sqLevel'), 'off');
  await d.page.check('#sqWire'); await d.page.waitForFunction(() => /quiet|carrier/.test(document.getElementById('sqLevel').textContent));
  await d.open('receiver'); await d.page.click('#liveBtn');
  // the keyed demo fox is on 12 s of 40: within 45 s both levels are seen
  const seen = new Set(); const t0 = Date.now();
  while (seen.size < 2 && Date.now() - t0 < 45000) { seen.add(await d.text('sqLevel')); await d.page.waitForTimeout(500); }
  assert.deepEqual([...seen].sort(), ['carrier', 'quiet']);
  await d.page.click('#liveBtn');
  await d.open('setup'); await d.page.uncheck('#sqWire'); await d.page.waitForFunction(() => document.getElementById('sqLevel').textContent === 'off');
  await d.close();
});

ptest('bench pair: a simulated beacon is heard by the receiver', async () => {
  const d = await demoPage(); await d.open('receiver'); await d.page.fill('#freq', '146.6000'); await d.page.click('#tuneBtn'); await d.page.waitForFunction(() => document.getElementById('tunedNow').textContent.startsWith('146.6000'));
  await d.open('transmit'); await d.page.click('#pairBtn');
  await d.page.waitForFunction(() => !document.getElementById('pairControls').hidden);
  await d.page.fill('#pairCallsign', 'w1aw'); await d.page.click('#pairCallsignBtn'); await d.page.waitForFunction(() => !document.getElementById('pairArm').disabled);
  await d.page.check('#pairArm'); await d.page.waitForFunction(() => !document.getElementById('pairKeyBtn').disabled);
  await d.open('receiver'); await d.page.click('#liveBtn'); await d.page.waitForTimeout(1500);
  const quiet = parseInt(await d.text('rssiNow'), 10);
  await d.open('transmit'); await d.page.click('#pairFollowBtn'); assert.equal(await d.text('pairFreq'), '146.6000 MHz');
  await d.page.click('#pairKeyBtn'); await d.page.waitForTimeout(3000);
  const loud = parseInt(await d.text('rssiNow'), 10);
  assert.ok(quiet < 60 && loud > 200, `quiet ${quiet}, keyed ${loud} · ${await d.text('pairNote')} · ${await d.text('pairTx')} · ${await d.text('tunedNow')}`);
  await d.page.click('#pairDropBtn'); await d.page.waitForFunction(() => document.getElementById('pairStatus').textContent === 'not paired');
  await d.close();
});

ptest('transmit on the receiver fox: arming needs a callsign; the receiver pauses while keyed', async () => {
  const d = await demoPage(); await d.open('transmit');
  assert.equal(await d.page.locator('#txArm').isDisabled(), true, 'no callsign yet');
  await d.open('setup'); await d.page.fill('#callsign', 'w1aw'); await d.page.click('#callsignBtn');
  await d.open('transmit'); await d.page.waitForFunction(() => !document.getElementById('txArm').disabled);
  await d.page.check('#txArm'); await d.page.waitForFunction(() => !document.getElementById('keyBtn').disabled);
  await d.page.click('#toneBtn'); await d.page.waitForFunction(() => /sent 800 Hz/.test(document.getElementById('txStatus').textContent), null, { timeout: 5000 });
  await d.page.uncheck('#txArm'); await d.page.waitForFunction(() => document.getElementById('keyBtn').disabled);
  await d.close();
});

ptest('disconnect disables the controls; reconnect brings them back', async () => {
  const d = await demoPage();
  await d.page.click('#demoBtn'); await d.page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Not connected'));
  assert.equal(await d.page.locator('#tuneBtn').isDisabled(), true); assert.equal(await d.page.locator('#liveBtn').isDisabled(), true);
  await d.page.click('#demoBtn'); await d.page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Simulated'));
  assert.equal(await d.page.locator('#tuneBtn').isDisabled(), false);
  await d.close();
});

ptest('hunt mode on a phone: panel shown, sidebar hidden, no horizontal scroll, live works', async () => {
  const d = await demoPage({ viewport: { width: 390, height: 800 } });
  await d.page.click('#modeHunt');
  assert.ok(await d.page.locator('#huntPanel').isVisible()); assert.ok(await d.page.locator('#sidebar').isHidden());
  const over = await d.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `horizontal overflow ${over}px`);
  await d.page.click('#hLiveBtn'); await d.page.waitForFunction(() => /^\d+$/.test(document.getElementById('hRssi').textContent));
  await d.page.click('#modeBench'); assert.ok(await d.page.locator('#huntPanel').isHidden());
  await d.close();
});

ptest('about page and the firmware section load without errors', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + 'about.html'); await page.waitForSelector('h1');
  await page.goto(base + 'index.html#firmwareSection'); await page.waitForSelector('#fwInstallBtn');
  assert.match(await page.locator('#fwVersionText').innerText(), /0\.4\.0/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fwDownloadBtn')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(text, /^TX_ENABLED = False$/m); assert.match(text, /FW_VERSION = "0\.4\.0"/);
  assert.deepEqual(errors, []); await ctx.close();
});

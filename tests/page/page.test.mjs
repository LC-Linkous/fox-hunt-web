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
async function demoPage({ viewport = { width: 1300, height: 900 }, geolocation = null, device = null } = {}) {
  const ctx = await browser.newContext({ ...(device || { viewport }), ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}) });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base + 'index.html'); await page.waitForSelector('#demoBtn');
  await page.click('#demoBtn'); await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Simulated'));
  // open a sidebar section; 'setup' is the Setup page now, so that switches mode (and back to Bench on the next sidebar section)
  const open = async sec => {
    if (sec === 'setup') { await page.click('#modeSetup'); return; }
    if (await page.locator('#setupPanel').isVisible()) await page.click('#modeBench');
    const h = page.locator(`section[data-section="${sec}"] h2 button`); if (await h.getAttribute('aria-expanded') !== 'true') await h.click();
  };
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
  assert.equal(await d.text('fwVersion'), '0.5.0'); assert.equal(await d.text('fwNvm'), 'yes');
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

ptest('hunt mode on an Android phone: panel shown, sidebar hidden, no horizontal scroll, touch live works', async () => {
  const d = await demoPage({ device: pw.devices['Pixel 7'] });
  await d.page.tap('#modeHunt');
  assert.ok(await d.page.locator('#huntPanel').isVisible()); assert.ok(await d.page.locator('#sidebar').isHidden());
  assert.ok(await d.page.locator('#firmwareSection').isHidden(), 'the installer is not in the hunt column');
  const over = await d.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, `horizontal overflow ${over}px`);
  assert.match(await d.text('hGuideText'), /Start receiver/);
  await d.page.tap('#hLiveBtn'); await d.page.waitForFunction(() => /^\d+$/.test(document.getElementById('hRssi').textContent));
  await d.page.waitForFunction(() => /FOX IS ON|Listening on|floor/.test(document.getElementById('hGuideText').textContent), null, { timeout: 15000 });
  await d.page.tap('#hHelpBtn'); assert.ok(await d.page.locator('#hHelp').isVisible());
  // the heading slider stands in for a compass the phone did not offer
  await d.page.locator('#hHeadingSlider').evaluate(el => { el.value = 90; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await d.text('hHeading'), /90° \(manual\)/);
  await d.page.tap('#modeBench'); assert.ok(await d.page.locator('#huntPanel').isHidden());
  await d.close();
});

ptest('about page and the firmware section load without errors', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + 'about.html'); await page.waitForSelector('h1');
  await page.goto(base + 'index.html#firmwareSection'); await page.waitForSelector('#fwInstallBtn');
  assert.match(await page.locator('#fwVersionText').innerText(), /0\.5\.0/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fwDownloadBtn')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(text, /^TX_ENABLED = False$/m); assert.match(text, /FW_VERSION = "0\.5\.0"/);
  assert.deepEqual(errors, []); await ctx.close();
});

// ---- the audio path, with Chromium's fake microphone playing our own encoders' output
import os from 'node:os';
import { buildFoxAudioWav } from './make-fixture.mjs';

ptest('audio: the CW decoder reads W1AW from the sound card and the SSTV decoder draws the picture', async t => {
  const wav = path.join(os.tmpdir(), `fox-audio-${process.pid}.wav`); const secs = buildFoxAudioWav(wav);
  // the headless *shell* Playwright uses by default has no audio capture; full Chromium in --headless=new does
  let b2; try { b2 = await pw.chromium.launch({ headless: false, args: ['--headless=new', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] }); }
  catch (e) { fs.rmSync(wav, { force: true }); return t.skip('full Chromium not available for the fake microphone: ' + e.message.split('\n')[0]); }
  const ctx = await b2.newContext({ permissions: ['microphone'] }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });   // full Chromium asks for a favicon
  try {
    await page.goto(base + 'index.html'); await page.waitForSelector('#demoBtn'); await page.click('#demoBtn'); await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Simulated'));
    const h = page.locator('section[data-section="audio"] h2 button'); if (await h.getAttribute('aria-expanded') !== 'true') await h.click();
    await page.check('#quietChk');
    await page.click('#audioBtn');
    await page.waitForFunction(() => /dBFS/.test(document.getElementById('audioLevel').textContent), null, { timeout: 10000 });
    await page.click('#wavRecBtn'); assert.match(await page.locator('#wavRecBtn').innerText(), /Stop recording/);
    await page.waitForFunction(() => /W1AW/.test(document.getElementById('cwDecoded').textContent), null, { timeout: 15000 });
    await page.waitForFunction(() => /line|image|done|decod/i.test(document.getElementById('sstvStatus').textContent), null, { timeout: 20000 });
    await page.waitForFunction(() => /done|complete|finished/i.test(document.getElementById('sstvStatus').textContent), null, { timeout: (secs + 15) * 1000 });
    // the picture: red on the left, green on the right
    const px = await page.evaluate(() => { const c = document.getElementById('sstvCanvas'), g = c.getContext('2d'); const l = g.getImageData(40, 100, 1, 1).data, r = g.getImageData(280, 100, 1, 1).data; return [[...l].slice(0, 3), [...r].slice(0, 3)]; });
    assert.ok(px[0][0] > 150 && px[0][1] < 100, `left pixel ${px[0]} should be red`); assert.ok(px[1][1] > 150 && px[1][0] < 100, `right pixel ${px[1]} should be green`);
    assert.match(await page.locator('#quietText').innerText(), /dB/);
    // the decoded log has the burst with its time and pitch; the WAV we recorded replays through the same decoders
    assert.match(await page.locator('#cwLog').innerText(), /800 Hz.*W1AW/s);
    await page.click('#wavRecBtn'); assert.match(await page.locator('#wavText').innerText(), /\d+ s recorded/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#wavSaveBtn')]); const wavFile = await dl.path();
    assert.ok(fs.statSync(wavFile).size > 1_000_000, 'a real WAV came out');
    await page.click('#cwClearBtn'); await page.click('#audioBtn');                                   // stop live audio, then replay the file fast
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#wavOpenBtn')]); await chooser.setFiles(wavFile);
    await page.waitForFunction(() => /^replayed/.test(document.getElementById('wavText').textContent), null, { timeout: 60000 }).catch(async () => { throw new Error('replay: wavText=' + await page.locator('#wavText').innerText() + ' errors=' + JSON.stringify(errors)); });
    assert.match(await page.locator('#cwDecoded').innerText(), /W1AW/);
    // listen: the slider sets the monitor gain and the hunt button mirrors it
    await page.locator('#listenLevel').evaluate(el => { el.value = 50; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator('#listenText').innerText(), '50%'); assert.equal(await page.locator('#hListenBtn').innerText(), 'Listen 50%');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('fox-hunt-web.settings')).listen), 0.5);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await b2.close(); fs.rmSync(wav, { force: true }); }
});

ptest('setup page: event channels feed the presets, the board and autoseek; export/import round-trips', async () => {
  const d = await demoPage(); await d.page.click('#modeSetup');
  assert.ok(await d.page.locator('#setupPanel').isVisible()); assert.ok(await d.page.locator('#sidebar').isHidden()); assert.ok(await d.page.locator('#firmwareSection').isVisible());
  await d.page.click('#chanAddBtn');                               // the prefilled row adds on the first click
  assert.equal(await d.page.locator('#chanBody tr').count(), 1); assert.match(await d.text('chanNote'), /added 146\.5650/);
  await d.page.fill('#chanLabel', 'Fox A'); await d.page.fill('#chanFreq', '146.52'); await d.page.click('#chanAddBtn');
  await d.page.click('#chanDefaultsBtn');
  assert.equal(await d.page.locator('#chanBody tr').count(), 3);
  await d.page.click('#chanPinAllBtn'); assert.match(await d.text('chanNote'), /3 pinned/);
  const [dl] = await Promise.all([d.page.waitForEvent('download'), d.page.click('#chanExportBtn')]);
  const file = await dl.path(); const o = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(o.channels.length, 3); assert.equal(o.channels[0].f, 146.52);
  await d.page.locator('#chanBody tr').first().locator('button').click(); assert.equal(await d.page.locator('#chanBody tr').count(), 2);
  const [chooser] = await Promise.all([d.page.waitForEvent('filechooser'), d.page.click('#chanImportBtn')]); await chooser.setFiles(file);
  await d.page.waitForFunction(() => document.getElementById('chanBody').querySelectorAll('tr').length === 3);
  await d.page.click('#chanSeekBtn');
  await d.page.click('#modeBench');
  assert.match((await d.text('presets')).replace(/\s+/g, ' '), /146\.520 Fox A/);
  await d.open('hunt'); assert.equal(await d.page.locator('#boardBody tr').count(), 3);
  await d.open('scan'); assert.ok(await d.page.locator('#seekChans').isChecked());
  await d.page.click('#scanEventBtn');                                // lowest to highest event channel, at the step
  await d.page.waitForFunction(() => document.getElementById('scanPeak').textContent !== '—', null, { timeout: 15000 });
  assert.equal(await d.page.locator('#scanStart').inputValue(), '146.5075'); assert.equal(await d.page.locator('#scanStop').inputValue(), '146.5775');
  await d.page.click('#seekBtn'); await d.page.waitForFunction(() => /146\.5(2|65)00 MHz/.test(document.getElementById('seekStatus').textContent), null, { timeout: 30000 });
  await d.page.click('#seekBtn');
  await d.close();
});

ptest('SSTV transmit: a picture keys the fox in line mode for the frame, Stop unkeys and restores mic pwm', async () => {
  const d = await demoPage();
  await d.page.click('#modeSetup'); await d.page.fill('#callsign', 'w1aw'); await d.page.click('#callsignBtn'); await d.page.waitForFunction(() => /W1AW stored/.test(document.getElementById('foxStatus').textContent));
  await d.page.click('#modeBench'); await d.open('transmit');
  assert.ok(await d.page.locator('#sstvTxBlock').isHidden(), 'hidden until the MIC_IN wire is ticked'); assert.ok(await d.page.locator('#sstvTxOff').isVisible());
  await d.page.click('#modeSetup'); await d.page.check('#wireAudioOut'); await d.page.click('#modeBench'); await d.open('transmit');
  assert.ok(await d.page.locator('#sstvTxBlock').isVisible());
  await d.page.waitForFunction(() => !document.getElementById('txArm').disabled); await d.page.check('#txArm'); await d.page.waitForFunction(() => !document.getElementById('keyBtn').disabled);
  const png = await d.page.evaluate(() => { const c = document.createElement('canvas'); c.width = 160; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 160, 120); return c.toDataURL('image/png'); });
  await d.page.setInputFiles('#sstvFile', { name: 't.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
  await d.page.waitForFunction(() => !document.getElementById('sstvSendBtn').disabled);
  assert.match(await d.text('sstvTxNote'), /Robot36.*about 3[5-9] s/);
  await d.page.click('#sstvSendBtn');
  await d.page.waitForFunction(() => /keyed/.test(document.getElementById('txState').textContent), null, { timeout: 5000 });
  const log = await d.page.locator('#log').innerText();
  assert.match(log, /> mic line/); assert.match(log, /> tx on 3[5-9](\.\d+)?/);
  await d.page.click('#sstvStopBtn');
  await d.page.waitForFunction(() => document.getElementById('txState').textContent === 'armed', null, { timeout: 5000 }).catch(async () => { throw new Error('after stop: note=' + await d.text('sstvTxNote') + ' state=' + await d.text('txState') + ' log tail=' + (await d.page.locator('#log').innerText()).slice(-300)); });
  assert.match(await d.page.locator('#log').innerText(), /> mic pwm/);
  assert.equal(await d.text('sstvTxNote'), 'stopped');
  await d.close();
});

// Device-layer tests: Fox over the DemoLink, which produces the real byte
// stream (echo, body, prompt, chunked). Run with:  node --test 'tests/**/*.test.mjs'
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoLink } from '../js/device/demo-link.js';
import { Fox, classifyReply, STATUS, DeviceError } from '../js/device/fox.js';
import { identifyDevice, parseVersion, buildAtLeast, FIRMWARE_FLOOR, MODELS, inBands } from '../js/device/models.js';

async function connected(opts) { const fox = new Fox(new DemoLink(opts)); fox.onWarning = () => {}; await fox.identify(); return fox; }
const rejects = (p, status) => p.then(() => assert.fail('expected a DeviceError'), e => { assert.ok(e instanceof DeviceError, e.message); if (status) assert.equal(e.status, status); });

test('identify: a dual-band fox', async () => {
  const fox = await connected();
  assert.equal(fox.model, 'sa868-dual');
  assert.equal(fox.ident.board, 'xiao-esp32c3');
  assert.deepEqual(fox.ident.build, [0, 5, 0]);
  assert.ok(fox.bandSet);
  assert.equal(fox.state.freq, 146.565);
  assert.ok(fox.ident.label.includes('dual-band'));
});

test('identify: a fox with no band set, then set it', async () => {
  const warnings = [];
  const fox = new Fox(new DemoLink({ band: null })); fox.onWarning = t => warnings.push(t);
  await fox.identify();
  assert.equal(fox.model, 'sa868-unset'); assert.ok(!fox.bandSet);
  assert.ok(warnings.some(w => /band/.test(w)));
  await rejects(fox.tune(146.565), STATUS.BLOCKED);
  await rejects(fox.scan(146.4, 146.6, 25), STATUS.BLOCKED);
  assert.equal(await fox.band('uhf'), 'uhf');
  assert.equal(fox.model, 'sa868-uhf'); assert.equal(fox.state.freq, 433.9);
  await rejects(fox.tune(146.565), STATUS.BLOCKED);              // UHF module now
  assert.equal(await fox.tune(433.9), 433.9);
});

test('identifyDevice parses the version line', () => {
  const d = identifyDevice('foxhunt 0.5.0 xiao-esp32c3 sa868-dual');
  assert.deepEqual([d.ok, d.key, d.band, d.build], [true, 'sa868-dual', 'dual', [0, 5, 0]]);
  assert.equal(identifyDevice('foxhunt 0.5.0 xiao-esp32c3 sa868-unset').key, 'sa868-unset');
  assert.equal(identifyDevice('foxdemo 0.3.0 xiao-esp32c3 sa868-vhf').ok, true);   // the pre-rename firmware name
  assert.equal(identifyDevice('tinySA4_v1.4-252').ok, false);
  assert.equal(identifyDevice('foxhunt 0.5.0 pico sa868-vhf').ok, false);
  assert.equal(identifyDevice('foxhunt 0.5.0 xiao-esp32c3 sa818-vhf').ok, false);
  assert.deepEqual(parseVersion('1.10.3'), [1, 10, 3]);
  assert.ok(buildAtLeast([0, 5, 0], FIRMWARE_FLOOR) && !buildAtLeast([0, 2, 9], FIRMWARE_FLOOR));
});

test('classifyReply follows PROTOCOL.md', () => {
  assert.equal(classifyReply('tune 146.565', '146.5650').status, STATUS.OK);
  assert.equal(classifyReply('tune x', 'usage: tune {MHz}').status, STATUS.USAGE);
  assert.equal(classifyReply('tune 900', 'error: 900.0000 MHz is outside').status, STATUS.REFUSED);
  assert.equal(classifyReply('nosuch', 'nosuch?').status, STATUS.UNKNOWN);
  assert.equal(classifyReply('rssi', '').status, STATUS.OK);
});

test('tune: envelope and firmware both guard the range', async () => {
  const fox = await connected();
  await rejects(fox.tune(900), STATUS.BLOCKED);                  // page-side, never sent
  assert.equal(fox.lastStatus, STATUS.BLOCKED);
  const r = await fox.raw('tune 900');                            // console path reaches the firmware
  assert.equal(r.status, STATUS.REFUSED);
  assert.equal(await fox.tune(433.9), 433.9);
  assert.equal(fox.state.freq, 433.9);
});

test('rssi and bursts', async () => {
  const fox = await connected();
  const one = await fox.rssi();
  assert.ok(one.rssi >= 0 && one.rssi <= 255);
  const b = await fox.rssiBurst(5);
  assert.equal(b.n, 5); assert.equal(b.ms[0], 0); assert.equal(b.ms[4], 400);
  assert.ok(Array.from(b.rssi).every(v => v >= 0 && v <= 255));
  await rejects(fox.rssiBurst(0).then(() => { throw new DeviceError('x', STATUS.BLOCKED); }), STATUS.BLOCKED); // clamps to 1, never 0
});

test('scan finds the keyed fox when it is on', async () => {
  const link = new DemoLink(); link.foxes[0].on = Infinity;        // hold the 146.565 fox keyed for the test
  const fox = new Fox(link); fox.onWarning = () => {}; await fox.identify();
  const s = await fox.scan(146.4, 146.7, 25);
  assert.equal(s.n, 13); assert.equal(s.f[0], 146.4); assert.equal(s.f[12], 146.7);
  let best = 0; for (let i = 1; i < s.n; i++) if (s.rssi[i] > s.rssi[best]) best = i;
  assert.ok(Math.abs(s.f[best] - 146.575) < 0.013, `peak at ${s.f[best]}`);   // 146.565 sits between the 146.550 and 146.575 channels
  assert.equal(fox.state.freq, 146.565);                                       // restored
  await rejects(fox.scan(144, 148, 12.5), STATUS.BLOCKED);                     // 321 channels > 128
  await rejects(fox.scan(146.7, 146.4, 25), STATUS.BLOCKED);
});

test('settings and callsign', async () => {
  const fox = await connected();
  assert.equal(await fox.squelch(5), 5); await rejects(fox.squelch(9), STATUS.BLOCKED);
  assert.equal(await fox.bw(0), 0);      await rejects(fox.bw(2), STATUS.BLOCKED);
  assert.equal(await fox.volume(8), 8);  await rejects(fox.volume(0), STATUS.BLOCKED);
  assert.equal(await fox.callsign(), 'N0CALL');
  assert.equal(await fox.callsign('w1aw'), 'W1AW');
  await rejects(fox.callsign('no spaces here'), STATUS.BLOCKED);
  assert.equal((await fox.info()).callsign, 'W1AW');
});

test('transmit commands are refused on the receive-only build', async () => {
  const fox = await connected();
  for (const c of ['tx on', 'morse CQ', 'fox start']) { const r = await fox.raw(c); assert.equal(r.status, STATUS.REFUSED, c); }
  assert.ok(/not enabled in this firmware build/.test((await fox.raw('tx on')).body));
});

test('envelopes: bands and defaults', () => {
  assert.ok(inBands(146.565, MODELS['sa868-vhf'].moduleBands) && !inBands(433.9, MODELS['sa868-vhf'].moduleBands));
  assert.ok(inBands(433.9, MODELS['sa868-dual'].hamBands) && !inBands(410, MODELS['sa868-dual'].hamBands));
  assert.equal(MODELS['sa868-uhf'].defaultFreq, 433.9);
  for (const m of Object.values(MODELS)) assert.ok(inBands(m.defaultFreq, m.hamBands), m.key);
});

// ---- transmit ---------------------------------------------------------------

test('TX: refused on the receive-only build, on the page and in the firmware', async () => {
  const fox = await connected();                                   // DemoLink default: txEnabled false
  assert.equal(fox.state.txAvailable, false);
  await rejects(fox.arm(), STATUS.BLOCKED);                        // page-side gate
  for (const c of ['tx on', 'morse CQ', 'fox start', 'tone 800 100']) { const r = await fox.raw(c); assert.equal(r.status, STATUS.REFUSED, c); assert.ok(/TX_ENABLED/.test(r.body), c); }
  assert.equal((await fox.raw('tx')).body.trim(), 'disabled');
});

test('TX: callsign then arm then key; nothing keys before that', async () => {
  const link = new DemoLink({ txEnabled: true }); const fox = new Fox(link); fox.onWarning = () => {}; await fox.identify();
  assert.equal(fox.state.txAvailable, true);
  await rejects(fox.arm(), STATUS.BLOCKED);                        // no callsign yet (page-side)
  assert.equal((await fox.raw('tx arm')).status, STATUS.REFUSED);  // and the firmware says the same
  await fox.callsign('W1AW');
  assert.equal((await fox.raw('tx on')).status, STATUS.REFUSED);   // still not armed
  await fox.arm();
  const left = await fox.keyOn(5); assert.ok(left > 4 && left <= 5);
  assert.ok((await fox.txStatus()).keyed);
  await fox.keyOff(); assert.ok(!(await fox.txStatus()).keyed);
  await rejects(fox.keyOn(121), STATUS.BLOCKED);                   // over the cap
  assert.equal(link.txLog.filter(x => x.kind === 'key').length, 1);
});

test('TX: morse air time and the beacon loop', async () => {
  const link = new DemoLink({ txEnabled: true, callsign: 'W1AW' }); const fox = new Fox(link); fox.onWarning = () => {}; await fox.identify();
  await fox.arm();
  await fox.wpm(20);
  const r = await fox.morse('W1AW FOX');
  assert.equal(r.result, 'sent'); assert.ok(Math.abs(r.seconds - fox.morseSeconds('W1AW FOX')) < 0.2, `${r.seconds} vs ${fox.morseSeconds('W1AW FOX')}`);
  await rejects(fox.morse('hello, world'), STATUS.BLOCKED);         // comma is not in the table
  await fox.foxmsg('decoy'); await fox.foxdelay(5);
  assert.equal(fox.state.foxmsg, 'DECOY');
  await fox.foxStart();
  await new Promise(r => setTimeout(r, 600));                        // the simulated beacon runs at 1/10 real time
  const st = await fox.foxStatus(); assert.ok(st.running);
  assert.ok(link.txLog.some(x => x.kind === 'fox' && x.text === 'W1AW DECOY'));
  const n = await fox.foxStop(); assert.ok(n >= 0); assert.ok(!(await fox.foxStatus()).running);
  await fox.disarm(); assert.equal(fox.state.armed, false);
  assert.equal((await fox.raw('tx on')).status, STATUS.REFUSED);   // disarmed again
});

test('TX: rx stops the beacon and unkeys', async () => {
  const link = new DemoLink({ txEnabled: true, callsign: 'W1AW' }); const fox = new Fox(link); fox.onWarning = () => {}; await fox.identify();
  await fox.arm(); await fox.foxStart(); await fox.rx();
  assert.ok(!(await fox.foxStatus()).running); assert.ok(!(await fox.txStatus()).keyed);
});

test('identify rides out a chip reset on port open (boot banner lands on the first command)', async () => {
  const link = new DemoLink({ band: 'vhf', resetOnOpen: true }); const fox = new Fox(link);
  await link.open(); await fox.identify();
  assert.equal(fox.model, 'sa868-vhf'); assert.deepEqual(fox.ident.build, [0, 5, 0]);
  assert.equal(fox.state.freq, 146.565);           // info parsed cleanly after the banner
  assert.equal(await fox.tune(146.52), 146.52);     // and the link is in step afterwards
  await link.close();
});

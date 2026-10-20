// Hunt logic against a synthetic fox: cycle timing, autoseek decisions, the board.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCycleTracker, createSeeker, createBoard, findCallsigns } from '../js/hunt.js';

/** RSSI readings at 10 Hz for a fox keyed `on` s every `period` s, floor ~28, keyed ~200, ±3 jitter. */
function foxReadings({ seconds = 200, on = 12, period = 40, phase = 5, floor = 28, keyed = 200, t0 = 1_000_000 } = {}) {
  const out = [];
  for (let i = 0; i < seconds * 10; i++) { const t = t0 + i * 100, s = i / 10; const isOn = ((s + phase) % period) < on; out.push({ t, rssi: Math.round((isOn ? keyed : floor) + (Math.sin(i * 7.3) * 3)) }); }
  return out;
}

test('cycle tracker learns a 12 s / 40 s fox and predicts the next burst', () => {
  const ct = createCycleTracker(); const rd = foxReadings();
  for (const r of rd) ct.feed(r.t, r.rssi);
  const st = ct.status(rd[rd.length - 1].t);
  assert.ok(st.cycles >= 4, `cycles ${st.cycles}`);
  assert.ok(Math.abs(st.periodMs - 40000) < 600, `period ${st.periodMs}`);
  assert.ok(Math.abs(st.onMs - 12000) < 600, `on ${st.onMs}`);
  assert.ok(st.confidence >= 0.75, `confidence ${st.confidence}`);
  // the prediction lands on the next real onset: phase 5 → onsets at s = 35, 75, 115, 155, 195; last seen 195 → next at 235
  const nextS = (st.nextAt - 1_000_000) / 1000;
  assert.ok(Math.abs(nextS - 235) < 0.6, `next at ${nextS} s`);
});

test('cycle tracker ignores a scan hop (short blip) and a never-keyed channel', () => {
  const ct = createCycleTracker();
  let t = 0; for (let i = 0; i < 300; i++) { ct.feed(t, 30 + (i % 3)); t += 100; }
  ct.feed(t, 180); ct.feed(t + 100, 185); ct.feed(t + 200, 31);          // 200 ms blip
  for (let i = 0; i < 100; i++) { ct.feed(t + 300 + i * 100, 30); }
  const st = ct.status(t + 11000);
  assert.equal(st.cycles, 0); assert.equal(st.nextAt, null); assert.equal(st.confidence, 0);
});

test('seeker steps through quiet channels, stops on a carrier, leaves when it drops', () => {
  const sk = createSeeker({ channels: [146.4, 146.425, 146.45, 146.475], margin: 20, settleReads: 2, dwellMs: 30000, dropMs: 800 });
  let t = 0; const actions = [];
  const read = rssi => { const a = sk.feed(t, rssi); t += 300; actions.push(a.action); return a; };
  // learn floors: two reads per channel, nothing on
  for (let k = 0; k < 8; k++) read(30 + (k % 2));
  assert.deepEqual(actions.filter(a => a !== 'stay'), ['step', 'step', 'step', 'step']);
  assert.equal(sk.channel(), 146.4);
  // carrier appears on the 2nd channel
  read(31); read(31);                        // 146.4 quiet → step
  const f = read(120);                       // 146.425 hot → found
  assert.equal(f.action, 'found'); assert.equal(f.channel, 146.425); assert.ok(f.over > 20);
  for (let k = 0; k < 10; k++) assert.equal(read(118 + (k % 2)).action, 'stay');
  read(31); read(31); read(31); const lost = read(31);   // below for > dropMs
  assert.equal(lost.action, 'lost'); assert.equal(lost.channel, 146.45);
  // lock holds a channel regardless of level
  sk.lock(146.475); for (let k = 0; k < 20; k++) assert.equal(read(30).action, 'stay'); assert.equal(sk.channel(), 146.475);
  sk.unlock(); sk.skip(); assert.equal(sk.state, 'step');
});

test('board: pin, note, identify, serialize round trip', () => {
  const bd = createBoard(); let changes = 0; bd.onChange = () => changes++;
  bd.pin(146.565); bd.pin(433.9, { label: 'UHF fox' });
  assert.equal(bd.list().length, 2); assert.equal(bd.list()[0].f, 146.565);
  const rd = foxReadings({ seconds: 120 });
  for (const r of rd) bd.note(146.565, r.t, r.rssi);
  const x = bd.get(146.565);
  assert.ok(x.max >= 195); assert.ok(x.cycle.status().cycles >= 2); assert.ok(x.lastHeard > 0);
  assert.equal(bd.note(145.0, 0, 50), false);
  assert.ok(bd.identify(146.565, 'W1AW'));
  const s = JSON.parse(JSON.stringify(bd.serialize()));
  const bd2 = createBoard(); bd2.restore(s);
  assert.equal(bd2.get(146.565).id, 'W1AW'); assert.equal(bd2.get(433.9).label, 'UHF fox');
  assert.ok(bd2.get(146.565).cycle.status().periodMs > 39000);
  assert.ok(changes >= 3);
});

test('callsigns are found in decoded text', () => {
  assert.deepEqual(findCallsigns('CQ FOX DE W1AW W1AW K'), ['W1AW', 'W1AW']);
  assert.deepEqual(findCallsigns('n0call decoy'), ['N0CALL']);
  assert.deepEqual(findCallsigns('VE3ABC/P FOX 2E0XYZ'), ['VE3ABC', '2E0XYZ']);
  assert.deepEqual(findCallsigns('FOX FOX 146 565'), []);
});

test('edge feeder: SQ-wire edges give exact bursts, flutter is merged, nextAt lands on the next onset', async () => {
  const { createEdgeFeeder } = await import('../js/hunt.js');
  const ct = createCycleTracker(); ct.hardware = true;
  const ef = createEdgeFeeder(ct);
  const foxNow = 500_000, hostNow = 2_000_000; ef.sync(foxNow, hostNow);
  // 12 s on / 40 s period, four bursts, with a 60 ms squelch flutter at the start of the third
  const edges = [];
  for (let k = 0; k < 4; k++) {
    const on = foxNow + 5000 + k * 40000;
    if (k === 2) { edges.push({ ms: on, on: true }, { ms: on + 40, on: false }, { ms: on + 100, on: true }); }
    else edges.push({ ms: on, on: true });
    edges.push({ ms: on + 12000, on: false });
  }
  assert.equal(ef.feed(edges), 4);
  // RSSI readings meanwhile must not add bursts of their own
  for (let i = 0; i < 400; i++) ct.feed(hostNow + i * 100, i % 400 < 120 ? 200 : 30);
  const now = hostNow + 5000 + 3 * 40000 + 20000;
  const st = ct.status(now);
  assert.equal(st.cycles, 4); assert.equal(st.hardware, true);
  assert.equal(st.periodMs, 40000); assert.ok(Math.abs(st.onMs - 12000) <= 100, `on ${st.onMs}`);
  assert.equal(st.nextAt, hostNow + 5000 + 4 * 40000);
  assert.ok(st.confidence >= 0.75);
  assert.ok(ef.flutter >= 1);
  // the wire's live level drives `on`
  ef.apply(true, foxNow + 5000 + 4 * 40000); assert.equal(ct.status(now + 20000).on, true);
  ef.apply(false, foxNow + 5000 + 4 * 40000 + 12000); assert.equal(ct.on, false);
});

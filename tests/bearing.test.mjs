// Bearing logic: a synthetic yagi sweep, a two-bearing fix, compass math.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapture, restoreCapture, fixFromBearings, headingFromAlpha, bearingBetween, distanceBetween } from '../js/bearing.js';

/** A 3-element yagi-ish pattern: front lobe ~60° wide, back lobe 15 dB down, mapped onto the RSSI byte. */
function sweep(truth, { floor = 30, peak = 180, noise = 4, step = 3, from = 0, to = 360 } = {}) {
  const cap = createCapture({ t: 0, geo: null });
  for (let h = from; h < to; h += step) {
    const d = Math.abs((((h - truth) % 360) + 540) % 360 - 180);              // 0..180 off boresight
    const gain = Math.max(Math.exp(-(d * d) / (2 * 30 * 30)), 0.18 * Math.exp(-((180 - d) ** 2) / (2 * 40 * 40)), 0.05);
    cap.add(h + (Math.random() - 0.5), floor + (peak - floor) * gain + (Math.random() - 0.5) * noise);
  }
  return cap;
}

test('a full-circle sweep finds the bearing within a few degrees', () => {
  for (const truth of [0, 47, 183, 290]) {
    const r = sweep(truth).analyze();
    assert.ok(r.ok, r.why);
    const err = Math.abs((((r.bearing - truth) % 360) + 540) % 360 - 180);
    assert.ok(err < 6, `truth ${truth} got ${r.bearing.toFixed(1)}`);
    assert.ok(r.width >= 40 && r.width <= 110, `width ${r.width}`);
    assert.ok(r.quality > 0.7, `quality ${r.quality}`);
  }
});

test('a partial sweep is reported as partial; a flat sweep as no lobe', () => {
  const part = sweep(100, { from: 0, to: 150 }).analyze();
  assert.ok(part.ok && part.coverage <= 170 && /partial/.test(part.why), JSON.stringify(part));
  const flat = createCapture(); for (let h = 0; h < 360; h += 5) flat.add(h, 120 + (Math.random() - 0.5) * 3);
  const r = flat.analyze(); assert.equal(r.ok, false); assert.ok(/no lobe/.test(r.why));
  const few = createCapture(); few.add(10, 50); few.add(20, 60);
  assert.equal(few.analyze().ok, false);
});

test('serialize / restore keeps the result', () => {
  const c = sweep(215); const o = JSON.parse(JSON.stringify(c.serialize()));
  const r = restoreCapture(o).analyze();
  assert.ok(Math.abs(r.bearing - c.analyze().bearing) < 1, `${r.bearing} vs ${c.analyze().bearing}`);
});

test('two bearings from two places give a fix', () => {
  const fox = { lat: 37.5400, lon: -77.4300 };
  const A = { lat: 37.5300, lon: -77.4400 }, B = { lat: 37.5300, lon: -77.4200 };
  const bA = bearingBetween(A, fox), bB = bearingBetween(B, fox);
  const fix = fixFromBearings({ geo: A, bearing: bA }, { geo: B, bearing: bB });
  assert.ok(fix, 'fix');
  assert.ok(distanceBetween(fix, fox) < 15, `off by ${distanceBetween(fix, fox).toFixed(1)} m`);
  assert.ok(fix.angle > 30);
  // nearly parallel bearings: no fix
  assert.equal(fixFromBearings({ geo: A, bearing: 10 }, { geo: B, bearing: 12 }), null);
  // pointing away from each other: no fix
  assert.equal(fixFromBearings({ geo: A, bearing: 270 }, { geo: B, bearing: 90 }), null);
});

test('compass alpha → heading', () => {
  assert.equal(headingFromAlpha(0), 0);
  assert.equal(headingFromAlpha(270), 90);      // alpha 270 means the device top points east
  assert.equal(headingFromAlpha(90, 10), 280);
  assert.ok(Number.isNaN(headingFromAlpha(null)));
});

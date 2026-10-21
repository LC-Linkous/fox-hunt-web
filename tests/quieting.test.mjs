// Noise quieting on synthetic FM audio: hiss, then a carrier with loud low-band modulation, then hiss again.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuieting } from '../js/audio/quieting.js';

function noise(n, amp, seed = 1) { const out = new Float32Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = amp * ((s / 4294967296) * 2 - 1); } return out; }
function tone(n, hz, amp, sr = 48000) { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * i / sr); return out; }

test('a carrier quiets the high band and is reported with hysteresis; loud 800 Hz modulation does not fool it', () => {
  const sr = 48000, q = createQuieting({ sampleRate: sr }); const edges = [];
  q.onChange = (t, on) => edges.push([t, on]);
  const sec = n => Math.round(n * sr);
  let t = 0; const feed = (x, s) => { q.feed(x, t); t += s * 1000; };
  feed(noise(sec(2), 0.3, 1), 2);                                   // empty channel: hiss
  assert.equal(q.on, false); assert.ok(q.quietingDb < 3, `quieting ${q.quietingDb}`);
  // carrier: hiss drops 20 dB, and a loud Morse tone at 800 Hz is present
  const carrier = noise(sec(1.5), 0.03, 2); const cw = tone(sec(1.5), 800, 0.6); for (let i = 0; i < carrier.length; i++) carrier[i] += cw[i];
  feed(carrier, 1.5);
  assert.equal(q.on, true); assert.ok(q.quietingDb > 12, `quieting ${q.quietingDb}`);
  feed(noise(sec(2), 0.3, 3), 2);                                   // carrier gone
  assert.equal(q.on, false);
  assert.deepEqual(edges.map(e => e[1]), [true, false]);
  assert.ok(edges[0][0] >= 2000 && edges[0][0] <= 2200, `onset ${edges[0][0]}`);
  assert.ok(edges[1][0] >= 3500 && edges[1][0] <= 3700, `end ${edges[1][0]}`);
});

test('a small level change stays off; the reference follows a slow drift', () => {
  const sr = 48000, q = createQuieting({ sampleRate: sr }); let t = 0;
  q.feed(noise(sr * 2, 0.3, 5), t); t += 2000;
  q.feed(noise(sr, 0.22, 6), t); t += 1000;                        // ~2.7 dB down: not a carrier
  assert.equal(q.on, false);
  for (let k = 0; k < 20; k++) { q.feed(noise(sr / 2, 0.3 * (1 - k / 60), 7 + k), t); t += 500; }   // slow fade of the hiss over 10 s
  assert.equal(q.on, false, 'drift tracked by the reference, not reported as quieting');
});

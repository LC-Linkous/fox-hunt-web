// WAV round trip and the decoders on a file, the way the page replays a recording.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWavRecorder, wavBlob, parseWav, playThrough } from '../js/audio/wav.js';
import { CwDecoder } from '../js/audio/cw.js';

const SR = 48000;
const tone = (hz, ms, amp = 0.5) => { const n = Math.round(ms * SR / 1000), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = amp * Math.sin(2 * Math.PI * hz * i / SR); return o; };
const hiss = (ms, amp = 0.02) => { const n = Math.round(ms * SR / 1000), o = new Float32Array(n); let s = 3; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o[i] = amp * ((s / 4294967296) * 2 - 1); } return o; };

test('record → WAV → parse keeps the samples; the cap stops the recorder', async () => {
  const wr = createWavRecorder({ maxSeconds: 1 }); wr.start(SR);
  wr.feed(tone(800, 300), SR); wr.feed(hiss(300), SR);
  assert.ok(wr.on); assert.ok(Math.abs(wr.seconds() - 0.6) < 0.01);
  wr.feed(hiss(600), SR); assert.equal(wr.on, false, 'stopped at the cap');
  const buf = await wr.blob().arrayBuffer();
  const { samples, sampleRate } = parseWav(buf);
  assert.equal(sampleRate, SR); assert.ok(Math.abs(samples.length / SR - 1) < 0.05);
  assert.ok(Math.abs(samples[100] - 0.5 * Math.sin(2 * Math.PI * 800 * 100 / SR)) < 0.001);
  assert.throws(() => parseWav(new ArrayBuffer(12)), /not a WAV/);
});

test('a WAV of Morse replays through the CW decoder and decodes', async () => {
  const MORSE = { W: '.--', 1: '.----', A: '.-' }; const parts = [hiss(500)]; const u = 80;
  for (const c of 'W1AW') { for (const m of MORSE[c] || '.-') { parts.push(tone(800, m === '.' ? u : 3 * u)); parts.push(hiss(u)); } parts.push(hiss(2 * u)); }
  parts.push(hiss(1500));
  const pcm = parts.map(p => Int16Array.from(p, x => Math.round(x * 32767)));
  const { samples, sampleRate } = parseWav(await wavBlob(pcm, SR).arrayBuffer());
  const dec = new CwDecoder({ sampleRate }); let text = ''; dec.onText = ch => { text += ch; };
  const ctl = playThrough(samples, sampleRate, (b, sr) => dec.feed(b)); assert.equal(await ctl.done, true);
  assert.match(text, /W1AW/);
});

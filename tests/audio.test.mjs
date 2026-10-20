// Audio decoders against synthesized signals: a Morse ID in noise, and SSTV
// pictures encoded from the same MODES table the decoder reads.
// Run with:  node --test 'tests/**/*.test.mjs'
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CwDecoder, MORSE } from '../js/audio/cw.js';
import { SstvDecoder, MODES, encodeSstv, visBits, lineMs } from '../js/audio/sstv.js';
import { FFT, goertzel } from '../js/audio/fft.js';

const SR = 48000;
const REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

/** Morse audio: tone at hz, wpm, with white noise at the given SNR (dB, tone power vs noise power). */
function morseAudio(text, { wpm = 15, hz = 800, snrDb = 15, lead = 0.3 } = {}) {
  const unit = 60 / (wpm * 50), out = [];
  let phase = 0; const w = 2 * Math.PI * hz / SR;
  const noiseAmp = 0.5 / Math.sqrt(2) / Math.pow(10, snrDb / 20);     // tone amplitude 0.5 → rms 0.354
  const push = (on, s) => { for (let i = 0; i < Math.round(s * SR); i++) { out.push((on ? 0.5 * Math.sin(phase) : 0) + (Math.random() * 2 - 1) * noiseAmp * Math.sqrt(3)); phase += w; } };
  push(false, lead);
  for (const word of text.toUpperCase().split(' ')) {
    for (const c of word) { for (const k of REV[c]) { push(true, k === '.' ? unit : unit * 3); push(false, unit); } push(false, unit * 2); }
    push(false, unit * 4);
  }
  push(false, 1.0);
  return Float32Array.from(out);
}
function feedInChunks(dec, audio, chunk = 1024) { for (let i = 0; i < audio.length; i += chunk) dec.feed(audio.subarray(i, i + chunk)); }

test('goertzel and FFT agree on a tone', () => {
  const n = 4800, s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 1000 * i / SR);
  assert.ok(goertzel(s, 0, 480, SR, 1000) > goertzel(s, 0, 480, SR, 1400) * 100);
  const f = new FFT(512).peakFrequency(s, 0, SR, 500, 2500, 128).f;
  assert.ok(Math.abs(f - 1000) < 15, `peak ${f}`);
});

test('CW: "CQ FOX DE W1AW" at 15 wpm, 15 dB SNR', () => {
  const dec = new CwDecoder({ sampleRate: SR, toneHz: 800 });
  feedInChunks(dec, morseAudio('CQ FOX DE W1AW', { wpm: 15, snrDb: 15 }));
  assert.equal(dec.text.trim(), 'CQ FOX DE W1AW');
  assert.ok(Math.abs(dec.wpm - 15) < 3, `wpm ${dec.wpm.toFixed(1)}`);
});

test('CW: follows the sender from 12 to 18 wpm and finds the pitch', () => {
  const dec = new CwDecoder({ sampleRate: SR, toneHz: 700, autoTone: true });
  feedInChunks(dec, morseAudio('N0CALL FOX', { wpm: 12, hz: 900, snrDb: 20 }));
  const first = dec.text.trim();
  feedInChunks(dec, morseAudio('FASTER 18', { wpm: 18, hz: 900, snrDb: 20 }));
  assert.ok(first.endsWith('0CALL FOX'), `first: ${first}`);   // the character during which the pitch was found is dropped, not misread
  assert.ok(dec.text.trim().endsWith('TER 18'), dec.text);   // the clock re-locks within a character of a 50 % speed change
  assert.ok(Math.abs(dec.wpm - 18) < 3, `wpm ${dec.wpm.toFixed(1)}`);
  assert.ok(Math.abs(dec.toneHz - 900) <= 50, `tone ${dec.toneHz}`);
});

test('VIS bits: even parity, LSB first', () => {
  assert.deepEqual(visBits(44), [0, 0, 1, 1, 0, 1, 0, 1]);   // Martin M1: 0101100 → bits 2,3,5 → three ones → parity 1
  assert.deepEqual(visBits(8), [0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(Math.round(lineMs(MODES[44]) * 1000) / 1000, 446.446);
  assert.equal(Math.round(lineMs(MODES[60]) * 100) / 100, 428.22);
  assert.equal(lineMs(MODES[8]), 150);
});

/** A test card: horizontal gradient in R, vertical in G, bars in B. */
function card(W, H) {
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; img[o] = x / (W - 1) * 255; img[o + 1] = y / (H - 1) * 255; img[o + 2] = (Math.floor(x / 40) % 2) * 255; img[o + 3] = 255; }
  return img;
}
function decodeRoundTrip(mode, { lines = null, snrDb = null } = {}) {
  // a short image: fewer lines keeps the test fast; the decoder is told the mode's real height, so we send a full one
  const W = mode.width, H = mode.height, src = card(W, H);
  let audio = encodeSstv(mode, src, { sampleRate: SR });
  if (snrDb != null) { const a = 0.5 / Math.sqrt(2) / Math.pow(10, snrDb / 20) * Math.sqrt(3); for (let i = 0; i < audio.length; i++) audio[i] += (Math.random() * 2 - 1) * a; }
  const pre = new Float32Array(SR * 0.2);   // some silence first
  const dec = new SstvDecoder({ sampleRate: SR }); const status = []; dec.onStatus = t => status.push(t);
  let done = false; dec.onImage = () => { done = true; };
  dec.feed(pre); feedInChunks(dec, audio, 4096); dec.feed(new Float32Array(SR * 0.3));
  return { dec, src, done, status, W, H };
}
function meanAbsError(a, b, W, H, chans = [0, 1, 2], margin = 4) {
  let s = 0, n = 0;
  for (let y = 2; y < H - 2; y++) for (let x = margin; x < W - margin; x++) for (const c of chans) { const o = (y * W + x) * 4; s += Math.abs(a[o + c] - b[o + c]); n++; }
  return s / n;
}

test('SSTV Martin M1 round trip', () => {
  const { dec, src, done, status, W, H } = decodeRoundTrip(MODES[44]);
  assert.ok(status.some(t => t.startsWith('Martin M1')), status.join(' | '));
  assert.ok(done, 'image completed');
  const err = meanAbsError(dec.image, src, W, H);
  assert.ok(err < 12, `mean abs error ${err.toFixed(1)}`);
});

test('SSTV Scottie S2 round trip with noise', () => {
  const { dec, src, done, status, W, H } = decodeRoundTrip(MODES[56], { snrDb: 20 });
  assert.ok(status.some(t => t.startsWith('Scottie S2')), status.join(' | '));
  assert.ok(done, 'image completed');
  const err = meanAbsError(dec.image, src, W, H);
  assert.ok(err < 16, `mean abs error ${err.toFixed(1)}`);
});

test('SSTV Robot36 round trip (YUV)', () => {
  const { dec, src, done, status, W, H } = decodeRoundTrip(MODES[8]);
  assert.ok(status.some(t => t.startsWith('Robot36')), status.join(' | '));
  assert.ok(done, 'image completed');
  const err = meanAbsError(dec.image, src, W, H);
  assert.ok(err < 24, `mean abs error ${err.toFixed(1)}`);   // 4:2:0 chroma and the bars cost more here
});

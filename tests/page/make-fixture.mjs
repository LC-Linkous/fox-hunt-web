// make-fixture.mjs — builds a WAV the page tests feed Chromium as a fake microphone:
// 1 s hiss, "W1AW" in CW at 15 wpm, a Robot36 picture, hiss. Built at test time (4 MB is not worth committing).
// SPDX-License-Identifier: GPL-2.0-only
import { writeFileSync } from 'node:fs';
import { MODES, encodeSstv } from '../../js/audio/sstv.js';

export function buildFoxAudioWav(file) {
const SR = 48000, parts = [];
const push = a => parts.push(a);
const tone = (hz, ms, amp = 0.5) => { const n = Math.round(ms * SR / 1000), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = amp * Math.sin(2 * Math.PI * hz * i / SR); return o; };
const hiss = (ms, amp = 0.02) => { const n = Math.round(ms * SR / 1000), o = new Float32Array(n); let s = 7; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; o[i] = amp * ((s / 4294967296) * 2 - 1); } return o; };
const MORSE = { W: '.--', 1: '.----', A: '.-', K: '-.-' };
const cw = (text, wpm = 15) => { const u = 1200 / wpm; for (const w of text.split(' ')) { for (const c of w) { for (const m of MORSE[c]) { push(tone(800, m === '.' ? u : 3 * u)); push(hiss(u)); } push(hiss(2 * u)); } push(hiss(4 * u)); } };
push(hiss(1000)); cw('W1AW'); push(hiss(800));
// a 320×240 picture: red left, green right, blue bar
const W = 320, H = 240, rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; const [r, g, b] = y > 180 ? [0, 0, 255] : x < 160 ? [255, 0, 0] : [0, 255, 0]; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; }
push(encodeSstv(MODES[8], rgba, { sampleRate: SR, amplitude: 0.5 }));
push(hiss(1500));
const n = parts.reduce((a, p) => a + p.length, 0), pcm = new Int16Array(n); let k = 0;
for (const p of parts) for (let i = 0; i < p.length; i++) pcm[k++] = Math.max(-32768, Math.min(32767, Math.round(p[i] * 32767)));
const hdr = Buffer.alloc(44); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length * 2, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length * 2, 40);
writeFileSync(file, Buffer.concat([hdr, Buffer.from(pcm.buffer)]));
return n / SR;
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) console.log(`${buildFoxAudioWav(process.argv[2] || 'fox-audio.wav').toFixed(1)} s`);

// sstv.js — an SSTV decoder for demodulated audio: Martin M1/M2, Scottie S1/S2, Robot36.
// SPDX-License-Identifier: GPL-2.0-only
//
// The classic analogue modes: a VIS header (1900 Hz leader, 1200 Hz start
// bit, eight 30 ms bits at 1100/1300 Hz), then lines of 1200 Hz sync pulses
// and 1500–2300 Hz pixel scans. Frequency is read with a short Hann window
// zero-padded into an FFT and parabolic peak interpolation; each line's
// sync pulse is found near where the mode's timing predicts it, so a sound
// card clock that is a little off does not slant the picture.
//
// feed(Float32Array) with raw samples; onStatus(text), onLine(y) as lines
// land in `image` (RGBA, width × height), onImage() when one is complete.
// The MODES table is also what the test's encoder is built from, so the
// two ends can only disagree with each other through a bug, not a typo.

import { FFT } from './fft.js';

const FREQ_BLACK = 1500, FREQ_WHITE = 2300, FREQ_SYNC = 1200;

/** Each mode: a list of segments per line, each { ms, tone } or { ms, chan }. */
function martin(name, vis, scanMs) {
  const seg = [{ ms: 4.862, tone: FREQ_SYNC, sync: true }, { ms: 0.572, tone: 1500 }];
  for (const chan of ['G', 'B', 'R']) seg.push({ ms: scanMs, chan }, { ms: 0.572, tone: 1500 });
  return { name, vis, width: 320, height: 256, color: 'rgb', preMs: 0, segments: () => seg };
}
function scottie(name, vis, scanMs) {
  const seg = [{ ms: 1.5, tone: 1500 }, { ms: scanMs, chan: 'G' }, { ms: 1.5, tone: 1500 }, { ms: scanMs, chan: 'B' }, { ms: 9, tone: FREQ_SYNC, sync: true }, { ms: 1.5, tone: 1500 }, { ms: scanMs, chan: 'R' }];
  return { name, vis, width: 320, height: 256, color: 'rgb', preMs: 9, preTone: FREQ_SYNC, segments: () => seg };
}
const robot36 = {
  name: 'Robot36', vis: 8, width: 320, height: 240, color: 'yuv420', preMs: 0,
  segments: line => line % 2 === 0
    ? [{ ms: 9, tone: FREQ_SYNC, sync: true }, { ms: 3, tone: 1500 }, { ms: 88, chan: 'Y' }, { ms: 4.5, tone: 1500 }, { ms: 1.5, tone: 1900 }, { ms: 44, chan: 'CR' }]
    : [{ ms: 9, tone: FREQ_SYNC, sync: true }, { ms: 3, tone: 1500 }, { ms: 88, chan: 'Y' }, { ms: 4.5, tone: 2300 }, { ms: 1.5, tone: 1900 }, { ms: 44, chan: 'CB' }],
};
export const MODES = {
  44: martin('Martin M1', 44, 146.432),
  40: martin('Martin M2', 40, 73.216),
  60: scottie('Scottie S1', 60, 138.24),
  56: scottie('Scottie S2', 56, 88.064),
  8: robot36,
};
export const lineMs = (mode, line = 0) => mode.segments(line).reduce((a, s) => a + s.ms, 0);
export const pixelFreq = v => FREQ_BLACK + (FREQ_WHITE - FREQ_BLACK) * v / 255;
export const freqPixel = f => Math.max(0, Math.min(255, Math.round((f - FREQ_BLACK) / (FREQ_WHITE - FREQ_BLACK) * 255)));
/** VIS byte: 7 data bits LSB first, then an even-parity bit. */
export function visBits(code) { const bits = []; let ones = 0; for (let i = 0; i < 7; i++) { const b = (code >> i) & 1; bits.push(b); ones += b; } bits.push(ones & 1); return bits; }

export class SstvDecoder {
  constructor({ sampleRate = 48000 } = {}) {
    this.sr = sampleRate;
    this.fft = new FFT(512);
    this.buf = new Float32Array(0); this.base = 0;      // buf[0] is absolute sample `base`
    this.state = 'vis'; this.mode = null; this.line = 0; this.lineStart = 0; this.image = null;
    this.hop = Math.round(sampleRate * 0.01);           // VIS search step, 10 ms
    this.visPos = 0; this.recent = [];                  // [{ pos, f }] at hop spacing, newest last
    this.onStatus = null; this.onLine = null; this.onImage = null;
    this.statusText = 'waiting for a VIS header';
    this.yuv = null;                                    // Robot36 scratch: { y: [], cr: [], cb: [] } per line
  }
  _status(t) { this.statusText = t; this.onStatus?.(t); }
  get end() { return this.base + this.buf.length; }
  ms2s(ms) { return ms * this.sr / 1000; }

  /** Frequency at absolute sample position `pos`, window of `spanMs` centred there. */
  freqAt(pos, spanMs = 2.6) {
    const span = Math.min(this.fft.n, Math.max(32, Math.round(this.ms2s(spanMs))));
    const off = Math.round(pos - span / 2) - this.base;
    if (off < 0 || off + span > this.buf.length) return NaN;
    return this.fft.peakFrequency(this.buf, off, this.sr, 1000, 2600, span).f;
  }

  feed(samples) {
    const n = new Float32Array(this.buf.length + samples.length); n.set(this.buf); n.set(samples, this.buf.length); this.buf = n;
    this._run();
    // keep only what later processing can still need
    const keep = this.state === 'vis' ? this.visPos - this.ms2s(800) : this.lineStart - this.ms2s(50);
    const drop = Math.floor(keep - this.base);
    if (drop > this.sr) { this.buf = this.buf.slice(drop); this.base += drop; }
  }
  reset() { this.state = 'vis'; this.mode = null; this.recent = []; this.visPos = Math.max(this.visPos, this.end - this.ms2s(100)); this._status('waiting for a VIS header'); }

  _run() {
    for (;;) {
      if (this.state === 'vis') { if (!this._visStep()) return; }
      else if (this.state === 'image') { if (!this._lineStep()) return; }
    }
  }

  // ---- VIS ---------------------------------------------------------------
  _visStep() {
    const pos = Math.max(this.visPos, this.base + this.ms2s(5));
    if (pos + this.ms2s(5) > this.end) return false;
    const f = this.freqAt(pos, 5);
    this.recent.push({ pos, f }); if (this.recent.length > 120) this.recent.shift();   // 1.2 s of history
    this.visPos = pos + this.hop;
    const r = this.recent, n = r.length;
    // a start bit: ≥ 2 hops near 1200 Hz, the hop before them near 1900 Hz
    if (n < 40 || !(Math.abs(r[n - 1].f - 1200) < 80 && Math.abs(r[n - 2].f - 1200) < 80) || !(Math.abs(r[n - 3].f - 1900) < 80)) return true;
    // the leader: at least 40 of the previous ~70 hops near 1900 Hz (the 10 ms break costs one or two)
    let leader = 0; for (let i = Math.max(0, n - 75); i < n - 3; i++) if (Math.abs(r[i].f - 1900) < 80) leader++;
    if (leader < 40) return true;
    // refine the start bit's leading edge at 1 ms, then read the bits
    let t0 = r[n - 2].pos; for (let k = 0; k < 12; k++) { const p = t0 - this.ms2s(1); const ff = this.freqAt(p, 3); if (Number.isNaN(ff) || Math.abs(ff - 1200) > 80) break; t0 = p; }
    if (t0 + this.ms2s(330) > this.end) { this.visPos = pos; this.recent.pop(); return false; }   // wait for the rest of the header
    const bits = [];
    for (let i = 0; i < 8; i++) { const ff = this.freqAt(t0 + this.ms2s(30 + 30 * i + 15), 10); if (Number.isNaN(ff)) return true; bits.push(ff < 1200 ? 1 : 0); }
    const stop = this.freqAt(t0 + this.ms2s(270 + 15), 10);
    if (Math.abs(stop - 1200) > 100) return true;
    let code = 0, ones = 0; for (let i = 0; i < 7; i++) { code |= bits[i] << i; ones += bits[i]; }
    const parityOk = (ones & 1) === bits[7];
    const mode = MODES[code];
    if (!mode) { this._status(`VIS ${code} (unsupported mode)`); this.recent = []; return true; }
    if (!parityOk) { this._status(`VIS ${code} ${mode.name}: parity error, trying anyway`); }
    this._begin(mode, t0 + this.ms2s(300));
    return true;
  }
  _begin(mode, start) {
    this.mode = mode; this.line = 0; this.state = 'image'; this.recent = [];
    this.lineStart = start + this.ms2s(mode.preMs);
    this.image = new Uint8ClampedArray(mode.width * mode.height * 4);
    for (let i = 3; i < this.image.length; i += 4) this.image[i] = 255;
    this.yuv = mode.color === 'yuv420' ? { y: null, cr: null, cb: null } : null;
    this._status(`${mode.name}: decoding`);
  }

  // ---- lines -------------------------------------------------------------
  _lineStep() {
    const mode = this.mode, segs = mode.segments(this.line), total = lineMs(mode, this.line);
    if (this.lineStart + this.ms2s(total + 20) > this.end) return false;
    // find this line's sync pulse near where it should be and re-anchor
    let at = 0; for (const s of segs) { if (s.sync) break; at += s.ms; }
    const sync = segs.find(s => s.sync);
    if (sync) {
      const exp = this.lineStart + this.ms2s(at), win = this.ms2s(12), step = this.ms2s(1), need = Math.round(sync.ms * 0.6);
      let run = 0, found = NaN;
      for (let p = exp - win; p <= exp + win + this.ms2s(sync.ms); p += step) {
        const f = this.freqAt(p, 2); if (f < 1350) { if (++run >= need) { found = p - (run - 1) * step; break; } } else run = 0;
      }
      if (!Number.isNaN(found)) this.lineStart += (found - exp) * 0.8;   // follow, but don't jump on a glitch
    }
    // read the pixel segments
    const y = this.line, W = mode.width;
    let off = this.lineStart;
    const lineVals = {};
    for (const s of segs) {
      if (s.chan) {
        const px = new Uint8ClampedArray(W), dur = this.ms2s(s.ms) / W, span = Math.max(1.2, Math.min(3, s.ms / W * 2.5));
        for (let x = 0; x < W; x++) px[x] = freqPixel(this.freqAt(off + (x + 0.5) * dur, span));
        lineVals[s.chan] = px;
      }
      off += this.ms2s(s.ms);
    }
    this._store(y, lineVals);
    this.lineStart += this.ms2s(total);
    this.line++;
    this.onLine?.(y);
    if (this.line >= mode.height) { this._status(`${mode.name}: image complete`); this.onImage?.(); this.state = 'vis'; this.visPos = this.lineStart; this.recent = []; }
    else if (y % 16 === 0) this._status(`${mode.name}: line ${y} / ${mode.height}`);
    return true;
  }
  _store(y, v) {
    const W = this.mode.width, img = this.image;
    if (this.mode.color === 'rgb') {
      for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; img[o] = v.R[x]; img[o + 1] = v.G[x]; img[o + 2] = v.B[x]; }
      return;
    }
    // Robot36: Y every line; R-Y on even lines, B-Y on odd, each shared by the pair
    const s = this.yuv;
    if (y % 2 === 0) { s.y = v.Y; s.cr = v.CR; return; }
    s.cb = v.CB;
    const rows = [[y - 1, s.y], [y, v.Y]];
    for (const [yy, Y] of rows) for (let x = 0; x < W; x++) {
      const o = (yy * W + x) * 4, cr = (s.cr?.[x] ?? 128) - 128, cb = (s.cb?.[x] ?? 128) - 128;
      img[o] = Y[x] + 1.402 * cr; img[o + 1] = Y[x] - 0.344 * cb - 0.714 * cr; img[o + 2] = Y[x] + 1.772 * cb;
    }
  }
}

/**
 * The matching encoder: audio for an RGBA image in a mode, as Float32 samples.
 * Used by the tests, the simulated audio source, and anyone who wants to
 * send a picture through the TX build later. Lines are rendered from the
 * same MODES table the decoder reads.
 */
export function encodeSstv(mode, rgba, { sampleRate = 48000, amplitude = 0.5 } = {}) {
  const W = mode.width, H = mode.height, out = [];
  let phase = 0;
  const tone = (f, ms) => { const n = Math.round(ms * sampleRate / 1000), w = 2 * Math.PI * f / sampleRate; for (let i = 0; i < n; i++) { out.push(amplitude * Math.sin(phase)); phase += w; } };
  const pxLine = (y, chan, ms) => {
    const n = Math.round(ms * sampleRate / 1000);
    for (let i = 0; i < n; i++) {
      const x = Math.min(W - 1, Math.floor(i / n * W)), o = (y * W + x) * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      let v;
      if (chan === 'R') v = r; else if (chan === 'G') v = g; else if (chan === 'B') v = b;
      else { const Y = 0.299 * r + 0.587 * g + 0.114 * b; v = chan === 'Y' ? Y : chan === 'CR' ? 128 + (r - Y) / 1.402 : 128 + (b - Y) / 1.772; }
      out.push(amplitude * Math.sin(phase)); phase += 2 * Math.PI * pixelFreq(Math.max(0, Math.min(255, v))) / sampleRate;
    }
  };
  // VIS: leader, break, leader, start bit, 8 bits, stop bit
  tone(1900, 300); tone(1200, 10); tone(1900, 300); tone(1200, 30);
  for (const b of visBits(mode.vis)) tone(b ? 1100 : 1300, 30);
  tone(1200, 30);
  if (mode.preMs) tone(mode.preTone, mode.preMs);
  for (let y = 0; y < H; y++) for (const s of mode.segments(y)) { if (s.chan) pxLine(y, s.chan, s.ms); else tone(s.tone, s.ms); }
  return Float32Array.from(out);
}

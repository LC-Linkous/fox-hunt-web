// fft.js — a small radix-2 FFT and a windowed peak-frequency estimator.
// SPDX-License-Identifier: GPL-2.0-only
// No DOM, no state beyond the precomputed tables; used by the SSTV decoder
// and the audio spectrum view. Sizes are powers of two.

export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    this.rev = new Uint32Array(n);
    for (let i = 0, bits = Math.log2(n); i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.windows = new Map();            // Hann windows by span (span ≤ n; the rest is zero-padded)
    this.re = new Float32Array(n); this.im = new Float32Array(n); this.mag = new Float32Array(n / 2);
  }
  _window(span) {
    let w = this.windows.get(span);
    if (!w) { w = new Float32Array(span); for (let i = 0; i < span; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (span - 1)); this.windows.set(span, w); }
    return w;
  }
  /** In-place transform of this.re / this.im. */
  transform() {
    const { n, re, im, cos, sin, rev } = this;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0; j < half; j++) {
        const k = j * step, c = cos[k], s = sin[k], a = i + j, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  /**
   * Windowed magnitude spectrum of samples[offset .. offset+span), zero-padded
   * to n (a short span with a long transform gives a smooth, interpolable
   * peak: the SSTV decoder's pixel windows are 1–3 ms). Returns this.mag.
   */
  magnitude(samples, offset = 0, span = this.n) {
    const { n, re, im, mag } = this, w = this._window(span);
    for (let i = 0; i < span; i++) { const s = samples[offset + i]; re[i] = (s === undefined || Number.isNaN(s) ? 0 : s) * w[i]; im[i] = 0; }
    for (let i = span; i < n; i++) { re[i] = 0; im[i] = 0; }
    this.transform();
    for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }
  /**
   * Frequency of the strongest component between loHz and hiHz, with parabolic
   * interpolation between bins. Returns { f, mag } (f = NaN if nothing is there).
   */
  peakFrequency(samples, offset, sampleRate, loHz, hiHz, span = this.n) {
    const mag = this.magnitude(samples, offset, span), binHz = sampleRate / this.n;
    const lo = Math.max(1, Math.floor(loHz / binHz)), hi = Math.min(this.n / 2 - 2, Math.ceil(hiHz / binHz));
    let b = -1, bv = 0;
    for (let i = lo; i <= hi; i++) if (mag[i] > bv) { bv = mag[i]; b = i; }
    if (b < 0) return { f: NaN, mag: 0 };
    const a = mag[b - 1], c = mag[b + 1], d = a - 2 * bv + c;
    const p = d < 0 ? 0.5 * (a - c) / d : 0;
    return { f: (b + p) * binHz, mag: bv };
  }
}

/** Single-frequency power via Goertzel: cheap enough to run per 10 ms block on many tones. */
export function goertzel(samples, offset, n, sampleRate, hz) {
  const k = Math.floor(0.5 + n * hz / sampleRate), w = 2 * Math.PI * k / n, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s0 = samples[offset + i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
}

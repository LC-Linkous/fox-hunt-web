// quieting.js — noise quieting: an FM receiver's hiss drops when a carrier arrives, with or without modulation.
// SPDX-License-Identifier: GPL-2.0-only
//
// Works on the audio from AF_OUT with the squelch open (squelch 0 on the
// fox, so the audio is always there). The high part of the audio band
// (2.5–4 kHz by default) is almost pure hiss on an empty channel and goes
// quiet under a carrier even when the modulation is loud in the low band,
// so its level, against a slowly tracked "noise reference", is a carrier
// detector that needs no RSSI and no SQ wire. Reports quieting in dB and an
// on/off with hysteresis, as (t, on) edges the cycle tracker can use.

export function createQuieting({ sampleRate = 48000, lo = 2500, hi = 4000, onDb = 8, offDb = 4, blockMs = 50, refRise = 0.05, refFall = 0.1 } = {}) {
  const q = { sampleRate, lo, hi, onDb, offDb, blockMs, refDb: null, levelDb: -120, quietingDb: 0, on: false, onChange: null, lastT: 0 };
  let acc = [];
  /** Band level in dBFS by Goertzel at a few bins across [lo, hi] (cheap; no FFT). */
  const bandDb = (x, n) => {
    const bins = 5; let p = 0;
    for (let k = 0; k < bins; k++) {
      const hz = q.lo + (q.hi - q.lo) * (k + 0.5) / bins, w = 2 * Math.PI * hz / q.sampleRate, c = 2 * Math.cos(w);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) { s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      p += (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
    }
    return 10 * Math.log10(p / bins + 1e-12);
  };
  q.reset = () => { acc = []; q.refDb = null; q.on = false; q.quietingDb = 0; };
  /** Feed samples; `t` is the wall-clock ms of the block's end. */
  q.feed = (samples, t = Date.now()) => {
    const need = Math.round(q.sampleRate * q.blockMs / 1000);
    for (let i = 0; i < samples.length; i++) acc.push(samples[i]);
    while (acc.length >= need) {
      const blk = acc.slice(0, need); acc = acc.slice(need);
      const db = bandDb(blk, need); q.levelDb = db;
      // the reference is the hiss level of an empty channel: a slow average that follows drift, frozen while a carrier is on
      if (q.refDb == null) q.refDb = db;
      else if (db > q.refDb) q.refDb += (db - q.refDb) * refFall;
      else if (!q.on) q.refDb += (db - q.refDb) * refRise;
      q.quietingDb = Math.max(0, q.refDb - db);
      const on = q.on ? q.quietingDb > q.offDb : q.quietingDb > q.onDb;
      if (on !== q.on) { q.on = on; q.lastT = t; q.onChange?.(t, on, q.quietingDb); }
    }
  };
  return q;
}

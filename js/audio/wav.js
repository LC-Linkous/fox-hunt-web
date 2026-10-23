// wav.js — record the captured audio to a WAV, read a WAV back, and run it through the decoders.
// SPDX-License-Identifier: GPL-2.0-only
//
// The point: a hunt-day recording of a real fox is the thing the decoders
// are tuned against. Record on the day, save, replay later — on the page or
// in the tests. 16-bit mono PCM; a recording is capped so a forgotten
// recorder cannot fill the phone.

export function createWavRecorder({ maxSeconds = 600 } = {}) {
  const wr = { on: false, sampleRate: 48000, chunks: [], samples: 0, startedAt: null, onChange: null };
  wr.start = sr => { wr.sampleRate = sr || wr.sampleRate; wr.chunks = []; wr.samples = 0; wr.startedAt = Date.now(); wr.on = true; wr.onChange?.(); };
  wr.stop = () => { wr.on = false; wr.onChange?.(); };
  wr.clear = () => { wr.chunks = []; wr.samples = 0; wr.startedAt = null; wr.onChange?.(); };
  wr.seconds = () => wr.samples / wr.sampleRate;
  /** A block of Float32 samples at `sr`; silently stops at the cap. */
  wr.feed = (block, sr) => {
    if (!wr.on) return;
    if (sr && sr !== wr.sampleRate) { if (!wr.samples) wr.sampleRate = sr; }
    const room = maxSeconds * wr.sampleRate - wr.samples, len = Math.max(0, Math.min(block.length, room));
    const pcm = new Int16Array(len);
    for (let i = 0; i < len; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(block[i] * 32767)));
    if (len) { wr.chunks.push(pcm); wr.samples += len; }
    if (len < block.length) wr.stop();
  };
  wr.blob = () => wavBlob(wr.chunks, wr.sampleRate);
  return wr;
}

export function wavBlob(chunks, sampleRate) {
  const n = chunks.reduce((a, c) => a + c.length, 0), hdr = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) hdr.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); hdr.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true); hdr.setUint16(22, 1, true);
  hdr.setUint32(24, sampleRate, true); hdr.setUint32(28, sampleRate * 2, true); hdr.setUint16(32, 2, true); hdr.setUint16(34, 16, true); str(36, 'data'); hdr.setUint32(40, n * 2, true);
  return new Blob([hdr.buffer, ...chunks.map(c => c.buffer)], { type: 'audio/wav' });
}

/** Parse a PCM WAV (8/16/24/32-bit int or 32-bit float, any channel count → mono). Returns { samples: Float32Array, sampleRate }. */
export function parseWav(buf) {
  const v = new DataView(buf), tag = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, fmt = null, data = null;
  while (o + 8 <= v.byteLength) {
    const id = tag(o), len = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    else if (id === 'data') data = { at: o + 8, len: Math.min(len, v.byteLength - o - 8) };
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data chunks');
  const { channels, sampleRate, bits, format } = fmt, bytes = bits / 8, frames = Math.floor(data.len / (bytes * channels)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      const p = data.at + (i * channels + c) * bytes;
      if (format === 3 && bits === 32) s += v.getFloat32(p, true);
      else if (bits === 16) s += v.getInt16(p, true) / 32768;
      else if (bits === 8) s += (v.getUint8(p) - 128) / 128;
      else if (bits === 24) s += ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16))) / 8388608;
      else if (bits === 32) s += v.getInt32(p, true) / 2147483648;
    }
    out[i] = s / channels;
  }
  return { samples: out, sampleRate };
}

/**
 * Run `samples` through `feed(block, sampleRate)` in blocks, yielding to the
 * page between chunks so the plots keep up. onProgress(0..1). Resolves when done
 * or when the returned controller's stop() is called.
 */
export function playThrough(samples, sampleRate, feed, { blockMs = 50, onProgress = null, realtime = false } = {}) {
  const ctl = { stopped: false, stop() { ctl.stopped = true; } };
  const n = Math.round(sampleRate * blockMs / 1000);
  ctl.done = (async () => {
    const t0 = performance.now();
    for (let off = 0; off < samples.length && !ctl.stopped; off += n) {
      feed(samples.subarray(off, Math.min(samples.length, off + n)), sampleRate);
      onProgress?.(Math.min(1, (off + n) / samples.length));
      if (realtime) { const ahead = (off + n) / sampleRate * 1000 - (performance.now() - t0); if (ahead > 0) await new Promise(r => setTimeout(r, ahead)); }
      else if ((off / n) % 20 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return !ctl.stopped;
  })();
  return ctl;
}

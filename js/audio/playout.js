// playout.js — play a generated signal (SSTV, test tones) out of a chosen sound card.
// SPDX-License-Identifier: GPL-2.0-only
//
// The transmit audio path: this page → USB sound card line out → the SA868's
// MIC_IN pad (firmware in `mic line` mode so D1 floats). Output device choice
// uses AudioContext.setSinkId where the browser has it (Chrome 110+); labels
// appear once any media permission has been granted.

export const hasPlayout = () => !!window.AudioContext;
export async function listOutputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput').map(d => ({ id: d.deviceId, label: d.label || `Output ${d.deviceId.slice(0, 6)}` }));
}

export function createPlayout() {
  const po = { ctx: null, src: null, playing: false, gen: 0 };
  const ctx = () => po.ctx || (po.ctx = new AudioContext());
  /** Play `samples` (Float32Array at `sampleRate`) on `deviceId` ('' = default). Resolves when done or stopped. */
  po.play = async (samples, sampleRate, { deviceId = '', gain = 1, onProgress = null } = {}) => {
    po.stop(); const gen = ++po.gen;
    const c = ctx(); if (c.state === 'suspended') await c.resume();
    if (deviceId && typeof c.setSinkId === 'function') { try { await c.setSinkId(deviceId); } catch (e) { throw new Error('that output cannot be selected: ' + e.message); } }
    if (po.gen !== gen) return false;   // stopped while the context was coming up
    const buf = c.createBuffer(1, samples.length, sampleRate); buf.copyToChannel(samples, 0);
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = gain; src.connect(g); g.connect(c.destination);
    po.src = src; po.playing = true;
    const t0 = c.currentTime, total = samples.length / sampleRate;
    return new Promise(resolve => {
      let raf = 0;
      const tick = () => { if (!po.playing) return; onProgress?.(Math.min(1, (c.currentTime - t0) / total), total); raf = requestAnimationFrame(tick); };
      src.onended = () => { cancelAnimationFrame(raf); const was = po.playing; po.playing = false; po.src = null; resolve(was); };
      src.start(); if (onProgress) tick();
    });
  };
  po.stop = () => { po.gen++; if (po.src) { try { po.src.stop(); } catch {} } po.playing = false; };
  po.close = () => { po.stop(); po.ctx?.close(); po.ctx = null; };
  return po;
}

/** A still image scaled to a mode's size (letterboxed on black) as RGBA bytes. `img` is anything drawImage accepts. */
export function fitImage(img, width, height) {
  const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, width, height);
  const iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height;
  const k = Math.min(width / iw, height / ih), w = Math.round(iw * k), h = Math.round(ih * k);
  g.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  return { rgba: g.getImageData(0, 0, width, height).data, canvas: cv };
}

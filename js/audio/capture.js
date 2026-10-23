// capture.js — microphone / line-in capture for the decoders.
// SPDX-License-Identifier: GPL-2.0-only
//
// The SA868's AF_OUT pad → a USB sound card → this. getUserMedia with every
// browser "enhancement" turned off (echo cancellation, AGC and noise
// suppression all destroy CW timing and SSTV tones), an AudioWorklet that
// hands raw Float32 blocks to the main thread, and an AnalyserNode for the
// spectrum view. The worklet is built from a Blob so there is no second
// file to serve.

const WORKLET = `
class TapProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) { this.buf.push(ch.slice()); this.n += ch.length; }
    if (this.n >= 2048) {                       // ~43 ms at 48 kHz per message
      const out = new Float32Array(this.n); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0;
    }
    return true;
  }
}
registerProcessor('tap', TapProcessor);
`;

export const hasAudioCapture = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext);

/** Input devices; labels only appear after permission has been granted once. */
export async function listInputs() {
  try { const d = await navigator.mediaDevices.enumerateDevices(); return d.filter(x => x.kind === 'audioinput').map(x => ({ id: x.deviceId, label: x.label || 'Audio input' })); }
  catch { return []; }
}

export function createCapture() {
  const cap = { running: false, sampleRate: 48000, ctx: null, stream: null, node: null, analyser: null, onBlock: null, onLevel: null, deviceLabel: '', monitor: null, monitorGain: 0 };
  let spec = null, peakHold = 0;

  cap.start = async deviceId => {
    if (cap.running) await cap.stop();
    const constraints = { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, autoGainControl: false, noiseSuppression: false, channelCount: 1 } };
    cap.stream = await navigator.mediaDevices.getUserMedia(constraints);
    cap.deviceLabel = cap.stream.getAudioTracks()[0]?.label || '';
    cap.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    cap.sampleRate = cap.ctx.sampleRate;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await cap.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    const src = cap.ctx.createMediaStreamSource(cap.stream);
    cap.analyser = cap.ctx.createAnalyser(); cap.analyser.fftSize = 2048; cap.analyser.smoothingTimeConstant = 0.6;
    cap.node = new AudioWorkletNode(cap.ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    cap.node.port.onmessage = e => {
      const block = e.data;
      let pk = 0; for (let i = 0; i < block.length; i++) { const a = Math.abs(block[i]); if (a > pk) pk = a; }
      peakHold = Math.max(pk, peakHold * 0.9);
      cap.onLevel?.(20 * Math.log10(peakHold + 1e-6));
      cap.onBlock?.(block, cap.sampleRate);
    };
    src.connect(cap.analyser); src.connect(cap.node);
    // listen: the same audio to the speaker, through a gain the page controls (0 = silent, the default)
    cap.monitor = cap.ctx.createGain(); cap.monitor.gain.value = cap.monitorGain; src.connect(cap.monitor); cap.monitor.connect(cap.ctx.destination);
    if (cap.ctx.state !== 'running') await cap.ctx.resume();
    cap.running = true;
  };
  cap.stop = async () => {
    cap.running = false;
    try { cap.node?.disconnect(); } catch {}
    try { cap.stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { await cap.ctx?.close(); } catch {}
    cap.ctx = null; cap.stream = null; cap.node = null; cap.analyser = null; cap.monitor = null;
  };
  /** Listen level 0..1 (kept across start/stop). On a phone this is the speaker; on a laptop whatever the default output is. */
  cap.setMonitor = v => { cap.monitorGain = Math.max(0, Math.min(1, v)); if (cap.monitor) cap.monitor.gain.setTargetAtTime(cap.monitorGain, cap.ctx.currentTime, 0.02); };
  /** dB spectrum from the analyser (reused buffer), with the Hz per bin. */
  cap.spectrum = () => {
    if (!cap.analyser) return null;
    if (!spec || spec.length !== cap.analyser.frequencyBinCount) spec = new Float32Array(cap.analyser.frequencyBinCount);
    cap.analyser.getFloatFrequencyData(spec);
    return { db: spec, binHz: cap.sampleRate / cap.analyser.fftSize };
  };
  return cap;
}

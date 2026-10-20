// audio.js — the audio passband: spectrum 0–3 kHz with the CW pitch and the SSTV tones marked.
// SPDX-License-Identifier: GPL-2.0-only
import { clamp, niceStep } from '../fmt.js';
import { cssVar } from './common.js';

/**
 * spec: { db: Float32Array, binHz } from the analyser, or null.
 * opts: { toneHz, cwOn, cwFloor, cwPeak, cwLevel } for the CW overlay.
 */
export function renderAudio(ctx, W, H, spec, { toneHz = 800, cwOn = false, cwFloor = null, cwPeak = null, cwLevel = null } = {}) {
  const pad = { l: 52, r: 18, t: 16, b: 34 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const fMax = 3000, y0 = -100, y1 = -10;
  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  ctx.strokeStyle = cssVar('--axis'); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.stroke();
  const sx = f => pad.l + clamp(f / fMax, 0, 1) * pw, sy = v => pad.t + ph - (clamp(v, y0, y1) - y0) / (y1 - y0) * ph;
  ctx.strokeStyle = cssVar('--grid'); ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let y = y0; y <= y1; y += 20) { const yy = sy(y); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + pw, yy); ctx.stroke(); ctx.fillText(String(y), pad.l - 8, yy); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let f = 0; f <= fMax; f += 500) { const x = sx(f); ctx.strokeStyle = cssVar('--grid'); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.fillText(f === 0 ? '0' : (f / 1000).toFixed(1) + ' kHz', x, pad.t + ph + 6); }
  ctx.save(); ctx.translate(14, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('dBFS', 0, 0); ctx.restore();
  // SSTV tones, faint
  ctx.setLineDash([2, 4]); ctx.strokeStyle = cssVar('--ink-3');
  for (const [f, l] of [[1200, 'sync'], [1500, 'black'], [1900, 'VIS'], [2300, 'white']]) { const x = sx(f); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(l, x, pad.t + ph - 2); }
  ctx.setLineDash([]);
  if (!spec) { ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Start audio to see the receiver\'s passband.', W / 2, H / 2); return; }
  // spectrum
  const n = Math.min(spec.db.length, Math.ceil(fMax / spec.binHz));
  ctx.strokeStyle = cssVar('--trace'); ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < n; i++) { const x = sx(i * spec.binHz), y = sy(spec.db[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke(); ctx.lineWidth = 1;
  // CW pitch marker and detector levels
  const x = sx(toneHz);
  ctx.strokeStyle = cwOn ? cssVar('--maxhold') : cssVar('--minhold'); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = 'bold 12px ' + cssVar('--mono');
  ctx.fillText(`CW ${Math.round(toneHz)} Hz${cwOn ? ' ●' : ''}`, x + 6, pad.t + 4);
  if (cwFloor != null && cwPeak != null && cwPeak > cwFloor + 6) {
    // the detector's own scale is Goertzel power, not dBFS; drawn as a small bar next to the marker
    const bx = x + 6, by = pad.t + 22, bw = 90, bh = 8, span = Math.max(20, cwPeak - cwFloor);
    ctx.fillStyle = cssVar('--grid'); ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = cwOn ? cssVar('--maxhold') : cssVar('--minhold'); ctx.fillRect(bx, by, bw * clamp((cwLevel - cwFloor) / span, 0, 1), bh);
    ctx.strokeStyle = cssVar('--ink'); ctx.beginPath(); ctx.moveTo(bx + bw * 0.5, by - 2); ctx.lineTo(bx + bw * 0.5, by + bh + 2); ctx.stroke();
    ctx.font = '11px ' + cssVar('--font'); ctx.fillStyle = cssVar('--ink-2'); ctx.fillText(`${(cwPeak - cwFloor).toFixed(0)} dB over floor`, bx + bw + 6, by - 2);
  }
}

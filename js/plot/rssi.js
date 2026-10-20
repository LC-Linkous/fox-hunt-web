// rssi.js — RSSI against time: the fox hunter's "warmer / colder" strip.
// SPDX-License-Identifier: GPL-2.0-only
import { clamp, niceStep, fmtAgo } from '../fmt.js';
import { cssVar } from './common.js';

/**
 * samples: [{ t, rssi }] oldest first (rssi −1 = module did not answer, drawn as a gap).
 * opts: { windowS, range: [lo, hi], maxHold: number|null, freq, events: [{t, label}] }.
 * Returns { pad, pw, ph, sx, sy } for hit-testing, or null if nothing was drawn.
 */
export function renderRssi(ctx, W, H, samples, { windowS = 60, range = [0, 255], maxHold = null, freq = null, events = [], lut = null, attenDb = 0 } = {}) {
  // a heat strip of the same samples sits between the plot and the time axis when a palette is given
  const strip = lut ? 14 : 0;
  const pad = { l: 52, r: 18, t: 16, b: 34 + strip }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  ctx.strokeStyle = cssVar('--axis'); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.stroke();
  const [y0, y1] = range;
  const now = samples.length ? samples[samples.length - 1].t : Date.now();
  const tMin = now - windowS * 1000;
  const sx = t => pad.l + clamp((t - tMin) / (windowS * 1000), 0, 1) * pw;
  const sy = v => pad.t + ph - (clamp(v, y0, y1) - y0) / (y1 - y0) * ph;
  // grid
  ctx.strokeStyle = cssVar('--grid'); ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const ys = niceStep(y1 - y0, 5);
  for (let y = Math.ceil(y0 / ys) * ys; y <= y1 + 1e-9; y += ys) { const yy = sy(y); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + pw, yy); ctx.stroke(); ctx.fillText(String(Math.round(y)), pad.l - 8, yy); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const xs = niceStep(windowS, Math.max(3, Math.floor(pw / 90)));
  for (let s = 0; s <= windowS + 1e-9; s += xs) { const x = sx(now - s * 1000); ctx.strokeStyle = cssVar('--grid'); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.fillText(s === 0 ? 'now' : fmtAgo(s), x, pad.t + ph + strip + 6); }
  ctx.save(); ctx.translate(14, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = cssVar('--ink-2'); ctx.fillText('RSSI (module byte)', 0, 0); ctx.restore();
  if (!samples.length) { ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Start the receiver to see signal strength over time.', W / 2, H / 2); return null; }
  // event ticks (retunes, scan results tuned to)
  ctx.strokeStyle = cssVar('--ink-3'); ctx.setLineDash([2, 3]);
  for (const e of events) { if (e.t < tMin) continue; const x = sx(e.t); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); }
  ctx.setLineDash([]);
  // max hold
  if (maxHold != null && maxHold >= 0) { const y = sy(maxHold); ctx.strokeStyle = cssVar('--maxhold'); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = cssVar('--maxhold'); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`max ${maxHold}`, pad.l + 6, y - 3); }
  // heat strip: each sample a coloured sliver, the single-channel waterfall
  if (lut) {
    const y = pad.t + ph + 2, h = strip - 4;
    ctx.fillStyle = cssVar('--screen'); ctx.fillRect(pad.l, y, pw, h);
    let prevX = null;
    for (const s of samples) { if (s.t < tMin) continue; const x = sx(s.t); if (s.rssi < 0) { prevX = x; continue; } const w = prevX == null ? 2 : Math.max(1, x - prevX); ctx.fillStyle = lut[Math.round(clamp((s.rssi - y0) / (y1 - y0), 0, 1) * 255)]; ctx.fillRect(x - w, y, w + 0.5, h); prevX = x; }
  }
  // the trace, with gaps where the module did not answer
  ctx.strokeStyle = cssVar('--trace'); ctx.lineWidth = 2; ctx.beginPath(); let pen = false;
  for (const s of samples) { if (s.t < tMin) continue; if (s.rssi < 0) { pen = false; continue; } const x = sx(s.t), y = sy(s.rssi); pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; }
  ctx.stroke(); ctx.lineWidth = 1;
  // readout
  const last = samples[samples.length - 1];
  ctx.font = 'bold 22px ' + cssVar('--mono'); ctx.fillStyle = last.rssi >= 0 ? cssVar('--trace') : cssVar('--err'); ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(last.rssi >= 0 ? String(last.rssi) : 'no reply', pad.l + pw - 8, pad.t + 6);
  if (freq != null) { ctx.font = '12px ' + cssVar('--font'); ctx.fillStyle = cssVar('--ink-2'); ctx.fillText(`${freq.toFixed(4)} MHz${attenDb ? ` · ${attenDb} dB attenuator in line` : ''}`, pad.l + pw - 8, pad.t + 32); }
  return { pad, pw, ph, sx, sy };
}

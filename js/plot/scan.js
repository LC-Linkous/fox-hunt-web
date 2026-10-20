// scan.js — per-channel RSSI as bars: which channel has a fox on it.
// SPDX-License-Identifier: GPL-2.0-only
import { clamp, niceStep, fmtAxisMHz, peakIndex, floorOf } from '../fmt.js';
import { cssVar } from './common.js';

/**
 * scan: { f: Float64Array (MHz), rssi: Int16Array } or null.
 * opts: { range: [lo, hi], hover: index|null, tuned: MHz|null }.
 * Returns { pad, pw, ph, barW, xOf, indexAt(px) } for hit-testing, or null.
 */
export function renderScan(ctx, W, H, scan, { range = [0, 255], hover = null, tuned = null } = {}) {
  const pad = { l: 52, r: 18, t: 16, b: 40 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  ctx.strokeStyle = cssVar('--axis'); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.stroke();
  const [y0, y1] = range;
  const sy = v => pad.t + ph - (clamp(v, y0, y1) - y0) / (y1 - y0) * ph;
  ctx.strokeStyle = cssVar('--grid'); ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const ys = niceStep(y1 - y0, 5);
  for (let y = Math.ceil(y0 / ys) * ys; y <= y1 + 1e-9; y += ys) { const yy = sy(y); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + pw, yy); ctx.stroke(); ctx.fillText(String(Math.round(y)), pad.l - 8, yy); }
  ctx.save(); ctx.translate(14, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('RSSI (module byte)', 0, 0); ctx.restore();
  if (!scan || !scan.f.length) { ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Run a scan to compare channels.', W / 2, H / 2); return null; }
  const n = scan.f.length, barW = pw / n, xOf = i => pad.l + i * barW;
  const peak = peakIndex(scan.rssi), floor = floorOf(scan.rssi);
  // floor line
  const fy = sy(floor); ctx.strokeStyle = cssVar('--ink-3'); ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(pad.l, fy); ctx.lineTo(pad.l + pw, fy); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(`median ${floor}`, pad.l + pw - 4, fy - 2);
  // bars
  for (let i = 0; i < n; i++) {
    const v = scan.rssi[i], x = xOf(i) + 1, w = Math.max(1, barW - 2);
    if (v < 0) { ctx.fillStyle = cssVar('--err'); ctx.fillRect(x, pad.t + ph - 3, w, 3); continue; }
    const y = sy(v);
    const isTuned = tuned != null && Math.abs(scan.f[i] - tuned) < 1e-6;
    ctx.fillStyle = i === peak ? cssVar('--maxhold') : isTuned ? cssVar('--minhold') : cssVar('--trace');
    ctx.globalAlpha = i === hover ? 1 : 0.85; ctx.fillRect(x, y, w, pad.t + ph - y); ctx.globalAlpha = 1;
  }
  // x labels: as many as fit
  ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));
  for (let i = 0; i < n; i += every) ctx.fillText(fmtAxisMHz(scan.f[i]), xOf(i) + barW / 2, pad.t + ph + 6);
  ctx.fillStyle = cssVar('--ink-3'); ctx.fillText('MHz', pad.l + pw / 2, pad.t + ph + 22);
  // peak callout
  if (peak >= 0) { ctx.fillStyle = cssVar('--maxhold'); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = 'bold 13px ' + cssVar('--mono'); ctx.fillText(`strongest ${scan.f[peak].toFixed(4)} MHz · ${scan.rssi[peak]}`, pad.l + 8, pad.t + 6); }
  // hover
  if (hover != null && hover >= 0 && hover < n) {
    const x = xOf(hover) + barW / 2; ctx.strokeStyle = cssVar('--ink'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.setLineDash([]);
  }
  return { pad, pw, ph, barW, xOf, indexAt: px => (px < pad.l || px > pad.l + pw) ? null : Math.min(n - 1, Math.floor((px - pad.l) / barW)) };
}

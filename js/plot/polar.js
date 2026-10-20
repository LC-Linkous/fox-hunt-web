// polar.js — RSSI against heading as a polar plot, several captures overlaid, the peak marked.
// SPDX-License-Identifier: GPL-2.0-only
import { clamp } from '../fmt.js';
import { cssVar } from './common.js';
import { BIN_DEG } from '../bearing.js';

const DASHES = [[], [6, 4], [2, 3], [10, 3, 2, 3]];

/**
 * captures: [{ cap, label, active }] — cap from bearing.js; the active one is drawn solid and thick.
 * opts: { heading (current, or NaN), range: [lo, hi], live: { h, r } the reading in progress }.
 */
export function renderPolar(ctx, W, H, captures, { heading = NaN, range = [0, 255], live = null } = {}) {
  const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) / 2 - 28, [lo, hi] = range;
  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  // rings and spokes
  ctx.strokeStyle = cssVar('--grid'); for (let k = 1; k <= 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, R * k / 4, 0, Math.PI * 2); ctx.stroke(); }
  for (let d = 0; d < 360; d += 30) { const a = (d - 90) * Math.PI / 180; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a)); ctx.stroke(); }
  ctx.strokeStyle = cssVar('--axis'); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [d, l] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) { const a = (d - 90) * Math.PI / 180; ctx.fillText(l, cx + (R + 14) * Math.cos(a), cy + (R + 14) * Math.sin(a)); }
  ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'left'; ctx.fillText(String(hi), cx + 4, cy - R + 8); ctx.fillText(String(lo), cx + 4, cy - 8);
  const rr = v => R * clamp((v - lo) / (hi - lo), 0, 1);
  const pt = (deg, v) => { const a = (deg - 90) * Math.PI / 180, r = rr(v); return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  if (!captures.length && !live) { ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.fillText('Hold Capture and turn the antenna through a full circle.', cx, cy + R + 2); }
  captures.forEach((c, k) => {
    const b = c.cap.binned(), n = b.length, col = c.active ? cssVar('--trace') : cssVar('--minhold');
    ctx.strokeStyle = col; ctx.lineWidth = c.active ? 2.5 : 1.5; ctx.setLineDash(c.active ? [] : DASHES[k % DASHES.length]); ctx.beginPath(); let pen = false;
    for (let i = 0; i <= n; i++) { const v = b[i % n]; if (Number.isNaN(v)) { pen = false; continue; } const [x, y] = pt((i + 0.5) * BIN_DEG, v); pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; }
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    const res = c.cap.analyze();
    if (res.ok) { const a = (res.bearing - 90) * Math.PI / 180; ctx.strokeStyle = c.active ? cssVar('--maxhold') : col; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = 'center'; ctx.font = (c.active ? 'bold 13px ' : '12px ') + cssVar('--mono'); ctx.fillText(`${Math.round(res.bearing)}°${c.label ? ' ' + c.label : ''}`, cx + (R * 0.72) * Math.cos(a), cy + (R * 0.72) * Math.sin(a) - 8); ctx.font = '12px ' + cssVar('--font'); }
  });
  if (live) { const [x, y] = pt(live.h, live.r); ctx.fillStyle = cssVar('--trace'); ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
  if (Number.isFinite(heading)) {
    const a = (heading - 90) * Math.PI / 180; ctx.strokeStyle = cssVar('--ink'); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (R + 6) * Math.cos(a), cy + (R + 6) * Math.sin(a)); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = cssVar('--ink'); ctx.textAlign = 'center'; ctx.font = 'bold 14px ' + cssVar('--mono'); ctx.fillText(`${Math.round(heading)}°`, cx, cy + R + 16);
  }
}

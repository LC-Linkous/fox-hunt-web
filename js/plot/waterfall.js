// waterfall.js — scan rows over time: channel across, time down, RSSI as colour.
// SPDX-License-Identifier: GPL-2.0-only
//
// One row per completed scan on the same channel grid (a few seconds each),
// so the picture is minutes of which channels are alive: a fox keyed 12 s
// in 40 shows as a dashed column. Not a spectrum waterfall; the SA868 has
// no sweep. The palette LUT is tinysa-web's.
import { clamp } from '../fmt.js';
import { fmtAxisMHz } from '../fmt.js';
import { cssVar } from './common.js';

export const WATERFALL_ROWS = 240;

/**
 * rows: [{ t, rssi: Int16Array }] newest first; f: Float64Array of channel MHz.
 * opts: { lut (256 strings), range: [lo, hi], hover: {col, row}|null }.
 * Returns { pad, pw, ph, cellW, cellH, colAt(px), rowAt(py) } or null.
 */
export function renderScanWaterfall(ctx, W, H, rows, f, { lut, range = [0, 255], hover = null } = {}) {
  const pad = { l: 52, r: 18, t: 16, b: 40 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  ctx.strokeStyle = cssVar('--axis'); ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.stroke();
  if (!rows.length || !f || !f.length) { ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Scan continuously to build a waterfall: one row per scan.', W / 2, H / 2); return null; }
  const n = f.length, m = Math.min(rows.length, WATERFALL_ROWS), [y0, y1] = range;
  const cellW = pw / n, cellH = Math.max(1, ph / Math.max(m, 40));   // rows fill the window until there are 40, then compress toward WATERFALL_ROWS
  for (let r = 0; r < m; r++) {
    const row = rows[r], y = pad.t + r * cellH;
    for (let c = 0; c < n; c++) {
      const v = row.rssi[c];
      ctx.fillStyle = v < 0 ? cssVar('--err') : lut[Math.round(clamp((v - y0) / (y1 - y0), 0, 1) * 255)];
      ctx.fillRect(pad.l + c * cellW, y, Math.ceil(cellW), Math.ceil(cellH));
    }
  }
  // channel labels
  ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));
  for (let c = 0; c < n; c += every) ctx.fillText(fmtAxisMHz(f[c]), pad.l + (c + 0.5) * cellW, pad.t + ph + 6);
  ctx.fillStyle = cssVar('--ink-3'); ctx.fillText('MHz', pad.l + pw / 2, pad.t + ph + 22);
  // time axis: newest at the top; label a few rows with "ago"
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = cssVar('--ink-2');
  const now = rows[0].t, step = Math.max(1, Math.ceil(16 / cellH));   // one label per ~16 px
  for (let r = 0; r < m; r += step) { const ago = (now - rows[r].t) / 1000; ctx.fillText(ago < 1 ? 'now' : ago < 90 ? `${ago.toFixed(0)} s` : `${(ago / 60).toFixed(1)} m`, pad.l - 8, pad.t + (r + 0.5) * cellH); }
  ctx.save(); ctx.translate(14, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('scans, newest at top', 0, 0); ctx.restore();
  if (hover && hover.col != null && hover.row != null && hover.row < m) {
    ctx.strokeStyle = cssVar('--ink'); ctx.lineWidth = 1.5; ctx.strokeRect(pad.l + hover.col * cellW, pad.t + hover.row * cellH, cellW, cellH); ctx.lineWidth = 1;
  }
  return { pad, pw, ph, cellW, cellH, colAt: px => (px < pad.l || px > pad.l + pw) ? null : Math.min(n - 1, Math.floor((px - pad.l) / cellW)), rowAt: py => (py < pad.t || py > pad.t + ph) ? null : Math.min(m - 1, Math.floor((py - pad.t) / cellH)) };
}

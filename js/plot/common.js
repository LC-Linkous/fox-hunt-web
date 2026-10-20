// common.js — shared drawing helpers.
// SPDX-License-Identifier: GPL-2.0-only

export const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** Numbered triangle marker, outlined so it reads on any trace colour. */
export function drawMarkerGlyph(ctx, x, y, n) {
  const ink = cssVar('--marker'), bg = cssVar('--panel');
  ctx.fillStyle = ink; ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y + 7); ctx.lineTo(x - 8, y + 7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = bg; ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y + 3.5); ctx.lineTo(x - 4, y + 3.5); ctx.closePath(); ctx.fill();
  const prev = ctx.font; ctx.font = 'bold 12px ' + cssVar('--font'); ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(String(n), x, y - 10); ctx.font = prev;
}

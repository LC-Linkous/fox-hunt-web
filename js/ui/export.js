// export.js — CSV, PNG, device screenshot.
// SPDX-License-Identifier: GPL-2.0-only

export function download(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/** Same two columns as tsapython's save_scan_csv.py, so the two tools' files are interchangeable. */
export function csvBlob(sw) {
  const rows = ['Frequency_Hz,Signal_Strength_dBm'];
  for (let i = 0; i < sw.pts; i++) rows.push(`${Math.round(sw.f[i])},${sw.dbm[i].toFixed(3)}`);
  return new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
}

export function canvasPng(canvas, name) { canvas.toBlob(b => download(name, b), 'image/png'); }

export function rgbaToPngDownload({ width, height, rgba }, name) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(width, height); img.data.set(rgba); ctx.putImageData(img, 0, 0);
  canvasPng(c, name);
}

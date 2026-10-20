// fmt.js — pure formatting and axis helpers. No DOM, no state.
// SPDX-License-Identifier: GPL-2.0-only
// (tinysa-web keeps these in sa.js with its dBm math; here the units are MHz and an RSSI byte.)

export const clamp = (v, a, b) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : a));

/** "146.5650 MHz" — the firmware's four decimals. */
export const fmtMHz = (f, digits = 4) => Number.isFinite(f) ? f.toFixed(digits) + ' MHz' : '—';
/** Short axis label: drop trailing zeros ("146.4", "433.9"). */
export const fmtAxisMHz = f => f.toFixed(4).replace(/\.?0+$/, '');
/** "12 s ago" style for the time axis. */
export const fmtAgo = s => s >= 60 ? (s / 60).toFixed(1) + ' min' : s.toFixed(0) + ' s';

export function niceStep(range, target) {
  const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** Index of the highest value (−1 readings never win). */
export function peakIndex(a) { let b = -1, bv = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] >= 0 && a[i] > bv) { bv = a[i]; b = i; } return b; }

/** Median of the valid readings — a cheap noise-floor estimate. */
export function floorOf(a) { const s = Array.from(a).filter(v => v >= 0).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }

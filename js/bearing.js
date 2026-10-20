// bearing.js — RSSI against heading: a capture, its peak bearing, and a fix from two of them.
// SPDX-License-Identifier: GPL-2.0-only
//
// No DOM, no device. The page feeds (t, heading, rssi) while the user turns
// the antenna; this bins by heading, finds the lobe, and reports a bearing
// with a width. Two captures from two places, each with a location, give a
// fix by intersecting the bearing lines on a local flat-earth projection,
// which is fine at hunt distances (a few km).

export const BIN_DEG = 5;
const norm = d => ((d % 360) + 360) % 360;
const circDiff = (a, b) => { let d = norm(a - b); if (d > 180) d -= 360; return d; };

/** One capture: samples in, bearing out. */
export function createCapture({ t = Date.now(), geo = null, freq = null } = {}) {
  const cap = { t, geo, freq, samples: [], bins: null, result: null };
  cap.add = (heading, rssi) => { if (!Number.isFinite(heading) || !(rssi >= 0)) return; cap.samples.push({ h: norm(heading), r: rssi }); cap.result = null; };
  /** Mean RSSI per 5° bin (NaN where nothing was sampled), lightly smoothed around the circle. */
  cap.binned = () => {
    const n = 360 / BIN_DEG, sum = new Float64Array(n), cnt = new Uint32Array(n);
    for (const s of cap.samples) { const b = Math.floor(s.h / BIN_DEG) % n; sum[b] += s.r; cnt[b]++; }
    const raw = Array.from({ length: n }, (_, i) => cnt[i] ? sum[i] / cnt[i] : NaN);
    // smooth: 3-bin circular mean over the bins that have data
    return raw.map((v, i) => { let s = 0, k = 0; for (const d of [-1, 0, 1]) { const u = raw[(i + d + n) % n]; if (!Number.isNaN(u)) { s += u * (d ? 0.5 : 1); k += d ? 0.5 : 1; } } return k ? s / k : NaN; });
  };
  /**
   * { bearing, peak, floor, width, coverage, quality, ok, why }.
   * bearing: centre of the lobe (parabolic interpolation on the peak bin);
   * width: degrees over which the smoothed RSSI stays above half way
   * between floor and peak; coverage: degrees of the circle sampled.
   */
  cap.analyze = () => {
    if (cap.result) return cap.result;
    const b = cap.binned(), n = b.length, have = b.filter(v => !Number.isNaN(v));
    const coverage = have.length * BIN_DEG;
    if (have.length < 6) return (cap.result = { ok: false, why: 'turn through more of the circle', coverage, bearing: null });
    let pi = -1, peak = -Infinity, floor = Infinity;
    b.forEach((v, i) => { if (Number.isNaN(v)) return; if (v > peak) { peak = v; pi = i; } if (v < floor) floor = v; });
    if (peak - floor < 10) return (cap.result = { ok: false, why: 'no lobe: RSSI barely changed with heading (too close, or no directional antenna?)', coverage, bearing: null, peak, floor });
    const l = b[(pi - 1 + n) % n], r = b[(pi + 1) % n];
    const a = Number.isNaN(l) ? peak : l, c = Number.isNaN(r) ? peak : r, d = a - 2 * peak + c;
    const p = d < 0 ? 0.5 * (a - c) / d : 0;
    const bearing = norm((pi + 0.5 + p) * BIN_DEG);
    const half = (peak + floor) / 2; let width = BIN_DEG;
    for (let k = 1; k < n / 2; k++) { const v = b[(pi + k) % n]; if (Number.isNaN(v) || v < half) break; width += BIN_DEG; }
    for (let k = 1; k < n / 2; k++) { const v = b[(pi - k + n) % n]; if (Number.isNaN(v) || v < half) break; width += BIN_DEG; }
    const quality = Math.min(1, (peak - floor) / 60) * Math.min(1, coverage / 270) * (width <= 120 ? 1 : 0.6);
    return (cap.result = { ok: true, bearing, peak, floor, width, coverage, quality, why: coverage < 270 ? 'partial circle; the true peak may be outside what was turned through' : width > 120 ? 'broad lobe; a weak or saturated signal' : '' });
  };
  cap.serialize = () => ({ t: cap.t, geo: cap.geo, freq: cap.freq, samples: cap.samples.map(s => [Math.round(s.h * 10) / 10, s.r]) });
  return cap;
}
export function restoreCapture(o) { const c = createCapture({ t: o.t, geo: o.geo, freq: o.freq }); for (const [h, r] of o.samples || []) c.add(h, r); return c; }

/** Compass math: heading from a DeviceOrientation alpha (0 = north when absolute), manual offset applied. */
export function headingFromAlpha(alpha, offset = 0) { return Number.isFinite(alpha) ? norm(360 - alpha + offset) : NaN; }

/**
 * Fix from two bearings taken at two places: intersection of the two rays on
 * a local projection around the first point. Returns { lat, lon, distA, distB,
 * angle } or null when the lines are near-parallel (angle < 10°) or the
 * intersection lies behind either observer.
 */
export function fixFromBearings(a, b) {
  if (!a?.geo || !b?.geo || !Number.isFinite(a.bearing) || !Number.isFinite(b.bearing)) return null;
  const R = 6371000, lat0 = a.geo.lat * Math.PI / 180;
  const toXY = g => ({ x: (g.lon - a.geo.lon) * Math.PI / 180 * R * Math.cos(lat0), y: (g.lat - a.geo.lat) * Math.PI / 180 * R });
  const A = toXY(a.geo), B = toXY(b.geo);
  const da = { x: Math.sin(a.bearing * Math.PI / 180), y: Math.cos(a.bearing * Math.PI / 180) }, db = { x: Math.sin(b.bearing * Math.PI / 180), y: Math.cos(b.bearing * Math.PI / 180) };
  const angle = Math.abs(circDiff(a.bearing, b.bearing)); if (angle < 10 || angle > 170) return null;
  const den = da.x * db.y - da.y * db.x; if (Math.abs(den) < 1e-9) return null;
  const dx = B.x - A.x, dy = B.y - A.y;
  const ta = (dx * db.y - dy * db.x) / den, tb = (dx * da.y - dy * da.x) / den;
  if (ta < 0 || tb < 0) return null;
  const P = { x: A.x + da.x * ta, y: A.y + da.y * ta };
  return { lat: a.geo.lat + P.y / R * 180 / Math.PI, lon: a.geo.lon + P.x / (R * Math.cos(lat0)) * 180 / Math.PI, distA: ta, distB: tb, angle };
}
export const bearingBetween = (from, to) => { const lat0 = from.lat * Math.PI / 180; const dx = (to.lon - from.lon) * Math.cos(lat0), dy = to.lat - from.lat; return norm(Math.atan2(dx, dy) * 180 / Math.PI); };
export const distanceBetween = (from, to) => { const R = 6371000, lat0 = from.lat * Math.PI / 180; const dx = (to.lon - from.lon) * Math.PI / 180 * R * Math.cos(lat0), dy = (to.lat - from.lat) * Math.PI / 180 * R; return Math.hypot(dx, dy); };

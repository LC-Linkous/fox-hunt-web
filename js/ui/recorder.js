// recorder.js — timestamped logging of RSSI readings and scans, with CSV / JSON export.
// SPDX-License-Identifier: GPL-2.0-only
// Shape follows tinysa-web's recorder.js; the records are readings and scans, not sweeps.

const iso = t => new Date(t).toISOString();

export function createRecorder() {
  const rec = { on: false, readings: [], scans: [], edges: [], startedAt: null, onChange: null };

  rec.start = () => { rec.on = true; rec.startedAt = rec.startedAt || Date.now(); rec.onChange?.(); };
  rec.stop = () => { rec.on = false; rec.onChange?.(); };
  rec.clear = () => { rec.readings = []; rec.scans = []; rec.edges = []; rec.startedAt = null; rec.onChange?.(); };
  /** A carrier edge from the SQ wire or noise quieting: { t, on, source, f }. */
  rec.addEdge = e => { if (!rec.on) return; rec.edges.push({ t: Math.round(e.t), on: !!e.on, source: e.source, f: e.f }); if (rec.edges.length > 5000) rec.edges.shift(); };

  /** One reading { t, f, rssi }, or a burst { t0, ms, rssi, f }. Stores copies. */
  /** geo: optional { lat, lon, acc } stamped onto the record (the page passes geo.stamp()). */
  rec.addReading = (r, geo) => { if (!rec.on) return; rec.readings.push({ t: r.t, f: r.f, rssi: r.rssi, ...(geo || {}) }); rec.onChange?.(); };
  rec.addBurst = (b, geo) => { if (!rec.on) return; for (let i = 0; i < b.n; i++) rec.readings.push({ t: b.t0 + b.ms[i], f: b.f, rssi: b.rssi[i], ...(geo || {}) }); rec.onChange?.(); };
  rec.addScan = (s, geo) => { if (!rec.on) return; rec.scans.push({ t: s.t, start: s.start, stop: s.stop, stepKHz: s.stepKHz, f: Array.from(s.f), rssi: Array.from(s.rssi), ...(geo || {}) }); rec.onChange?.(); };
  const geoCols = r => `,${r.lat ?? ''},${r.lon ?? ''},${r.acc ?? ''}`;

  rec.count = () => rec.readings.length + rec.scans.reduce((a, s) => a + s.f.length, 0);

  /** Readings, long format: one row per reading. */
  rec.readingsCsv = () => {
    const rows = ['timestamp_iso,t_ms,frequency_mhz,rssi,lat,lon,accuracy_m'];
    for (const r of rec.readings) rows.push(`${iso(r.t)},${r.t},${r.f == null ? '' : r.f.toFixed(4)},${r.rssi}${geoCols(r)}`);
    return new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  };
  /** Scans, long format: one row per channel, with a scan index. */
  rec.scansCsv = () => {
    const rows = ['timestamp_iso,scan_index,scan_t_ms,frequency_mhz,rssi,lat,lon,accuracy_m'];
    rec.scans.forEach((s, k) => { const ts = iso(s.t); for (let i = 0; i < s.f.length; i++) rows.push(`${ts},${k},${s.t},${s.f[i].toFixed(4)},${s.rssi[i]}${geoCols(s)}`); });
    return new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  };
  /** Replace the contents with a parsed session's records (session.js parseSession). */
  rec.load = ({ readings, scans, edges, startedAt }) => { rec.edges = (edges || []).map(e => ({ ...e })); rec.readings = readings.map(r => ({ ...r })); rec.scans = scans.map(s => ({ ...s, f: Array.from(s.f), rssi: Array.from(s.rssi) })); rec.startedAt = startedAt || rec.readings[0]?.t || rec.scans[0]?.t || null; rec.onChange?.(); };

  return rec;
}

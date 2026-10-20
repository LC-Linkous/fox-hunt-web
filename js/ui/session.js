// session.js — one JSON for everything: settings, the recorder, scan rows, samples; and replay.
// SPDX-License-Identifier: GPL-2.0-only
//
// A session is what you hand to someone, or load the morning after a hunt.
// Replay walks the recorder's readings and scans in time order and hands
// them to the page's acceptReading / acceptScan, so the windows redraw as
// they did live. Nothing here touches the fox.

const iso = t => new Date(t).toISOString();

/** Serialize. meta: { app, device, band, settings }. */
export function sessionBlob(recorder, meta) {
  return new Blob([JSON.stringify({ tool: 'fox-hunt-web', kind: 'session', version: 1, ...meta, savedAt: iso(Date.now()), startedAt: recorder.startedAt && iso(recorder.startedAt), readings: recorder.readings, scans: recorder.scans })], { type: 'application/json' });
}
/** Parse a session (or a plain recording from an earlier version). Throws if it isn't one. */
export function parseSession(text) {
  const o = JSON.parse(text);
  if (!o || !['fox-hunt-web', 'fox-demo-web'].includes(o.tool) || !['session', 'recording'].includes(o.kind)) throw new Error('not a fox-hunt-web session');   // fox-demo-web: the project's name before v0.5
  const readings = (o.readings || []).map(r => ({ t: +r.t, f: r.f == null ? null : +r.f, rssi: +r.rssi, lat: r.lat, lon: r.lon, acc: r.acc }));
  const scans = (o.scans || []).map(s => ({ t: +s.t, start: +s.start, stop: +s.stop, stepKHz: +s.stepKHz, f: Float64Array.from(s.f), rssi: Int16Array.from(s.rssi), n: s.f.length, lat: s.lat, lon: s.lon, acc: s.acc }));
  return { meta: { app: o.app, device: o.device, band: o.band, settings: o.settings, savedAt: o.savedAt, board: Array.isArray(o.board) ? o.board : [] }, readings, scans, startedAt: o.startedAt ? Date.parse(o.startedAt) : null };
}
/** Open a file chooser; resolves with the file's text, or null if cancelled. */
export function pickFile(accept = '.json,application/json') {
  return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => { const f = i.files[0]; if (!f) return res(null); f.text().then(res); }; i.click(); });
}

/**
 * Replay controller. events: the merged, time-sorted list of
 * { t, kind: 'reading'|'scan', ... }. onEvent(ev) is called for each as the
 * cursor passes it; onPos(t, i, n) after every step; onEnd() when it runs out.
 */
export function createReplay() {
  const rp = { events: [], i: 0, playing: false, speed: 1, onEvent: null, onPos: null, onEnd: null, active: false };
  let timer = null, t0Wall = 0, t0Rec = 0;
  rp.load = (readings, scans) => {
    rp.events = [...readings.map(r => ({ ...r, kind: 'reading' })), ...scans.map(s => ({ ...s, kind: 'scan' }))].sort((a, b) => a.t - b.t);
    rp.i = 0; rp.active = rp.events.length > 0; return rp.events.length;
  };
  rp.get = () => rp.events;
  rp.start = () => rp.events.length ? rp.events[0].t : 0;
  rp.end = () => rp.events.length ? rp.events[rp.events.length - 1].t : 0;
  /** Jump to index i: re-feeds events 0..i (the page's accept functions rebuild state from scratch after a reset). */
  rp.seek = i => { rp.i = Math.max(0, Math.min(rp.events.length, i)); rp.onPos?.(rp.events[Math.max(0, rp.i - 1)]?.t ?? rp.start(), rp.i, rp.events.length); };
  rp.feedTo = i => { for (; rp.i < i && rp.i < rp.events.length; rp.i++) rp.onEvent?.(rp.events[rp.i]); rp.onPos?.(rp.events[Math.max(0, rp.i - 1)]?.t ?? rp.start(), rp.i, rp.events.length); if (rp.i >= rp.events.length) { rp.pause(); rp.onEnd?.(); } };
  rp.play = () => { if (!rp.events.length) return; if (rp.i >= rp.events.length) rp.i = 0; rp.playing = true; t0Wall = performance.now(); t0Rec = rp.events[rp.i].t; timer = setInterval(() => { const tRec = t0Rec + (performance.now() - t0Wall) * rp.speed; let j = rp.i; while (j < rp.events.length && rp.events[j].t <= tRec) j++; rp.feedTo(j); }, 100); };
  rp.pause = () => { rp.playing = false; if (timer) { clearInterval(timer); timer = null; } };
  rp.stop = () => { rp.pause(); rp.active = false; rp.events = []; rp.i = 0; };
  return rp;
}

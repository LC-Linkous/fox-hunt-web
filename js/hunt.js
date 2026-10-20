// hunt.js — the hunt logic, with no DOM and no device: cycle timing, autoseek decisions, the board.
// SPDX-License-Identifier: GPL-2.0-only
//
// Everything here is fed readings and returns decisions, so the tests can
// drive it with a synthetic fox and the page can drive it with a real one.

// ---------------------------------------------------------------- cycle timing
/**
 * Watches one channel's RSSI over time and learns the fox's keying: how
 * long each burst lasts and how often it comes, from threshold crossings.
 * Threshold sits between a running floor and the running peak; a burst
 * needs ≥ minOnMs to count, so a scan hopping through doesn't register.
 */
export function createCycleTracker({ minOnMs = 800, minMargin = 20, keep = 8 } = {}) {
  const ct = { floor: null, peak: null, on: false, onsetT: null, onsetValid: false, onsets: [], durations: [], lastOff: null, seenOff: false };
  ct.reset = () => { ct.floor = null; ct.peak = null; ct.on = false; ct.onsetT = null; ct.onsetValid = false; ct.onsets = []; ct.durations = []; ct.lastOff = null; ct.seenOff = false; };
  ct.threshold = () => ct.floor == null ? Infinity : ct.floor + Math.max(minMargin, (ct.peak - ct.floor) / 2);
  ct.feed = (t, rssi) => {
    if (rssi < 0) return;
    if (ct.floor == null) { ct.floor = rssi; ct.peak = rssi; }
    if (!ct.on) ct.floor = rssi < ct.floor ? ct.floor * 0.5 + rssi * 0.5 : ct.floor * 0.98 + rssi * 0.02;
    ct.peak = rssi > ct.peak ? rssi : Math.max(ct.peak - 0.05, ct.floor + minMargin);
    const thr = ct.threshold(), on = ct.on ? rssi > thr - 6 : rssi > thr + 6;
    if (on && !ct.on) { ct.on = true; ct.onsetT = t; ct.onsetValid = ct.seenOff; }   // a burst already on when listening began has no known onset
    else if (!on && ct.on) {
      ct.on = false; ct.seenOff = true; const dur = t - ct.onsetT;
      if (dur >= minOnMs && ct.onsetValid) { ct.onsets.push(ct.onsetT); ct.durations.push(dur); if (ct.onsets.length > keep) { ct.onsets.shift(); ct.durations.shift(); } ct.lastOff = t; }
    } else if (!on) ct.seenOff = true;
  };
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  /** { cycles, onMs, periodMs, nextAt, confidence } — nextAt is null until two bursts have been seen. */
  ct.status = (now = Date.now()) => {
    const n = ct.onsets.length;
    const onMs = median(ct.durations);
    const gaps = []; for (let i = 1; i < n; i++) gaps.push(ct.onsets[i] - ct.onsets[i - 1]);
    const periodMs = median(gaps);
    let nextAt = null;
    const lastOnset = ct.on && ct.onsetValid ? ct.onsetT : ct.onsets[n - 1]; // a burst in progress counts from its own onset
    if (periodMs && n >= 2) { nextAt = lastOnset + periodMs; while (nextAt < now) nextAt += periodMs; }   // roll forward if a burst was missed
    const spread = gaps.length >= 2 ? (Math.max(...gaps) - Math.min(...gaps)) / periodMs : 1;
    return { cycles: n, onMs, periodMs, nextAt, on: ct.on, spread, confidence: n < 2 ? 0 : Math.min(1, (n - 1) / 4) * (spread < 0.15 ? 1 : spread < 0.4 ? 0.6 : 0.3), floor: ct.floor, peak: ct.peak, threshold: ct.threshold() };
  };
  return ct;
}

// ---------------------------------------------------------------- autoseek
/**
 * Decides where the receiver goes next. The page tunes and reads; this
 * says "stay" or "step". Per-channel floors are learned as it goes, so a
 * channel that is always noisy does not keep stopping the seek.
 */
export function createSeeker({ channels = [], margin = 20, settleReads = 3, dwellMs = 20000, dropMs = 2500, locked = null } = {}) {
  const sk = { channels: channels.slice(), i: 0, margin, settleReads, dwellMs, dropMs, floors: new Map(), state: 'step', dwellSince: null, belowSince: null, reads: 0, found: null, locked };
  sk.channel = () => sk.locked ?? sk.channels[sk.i];
  sk.setChannels = ch => { sk.channels = ch.slice(); sk.i = 0; sk.state = 'step'; sk.reads = 0; };
  sk.lock = f => { sk.locked = f; sk.state = 'dwell'; sk.dwellSince = Date.now(); sk.belowSince = null; };
  sk.unlock = () => { sk.locked = null; sk.state = 'step'; sk.reads = 0; };
  sk.skip = () => { sk.locked = null; sk.state = 'step'; sk.reads = 0; sk.belowSince = null; sk.i = (sk.i + 1) % Math.max(1, sk.channels.length); };
  sk.floor = f => sk.floors.get(f) ?? null;
  /**
   * One reading on the current channel. Returns { action: 'stay'|'step'|'found'|'lost', channel, floor, over }.
   * 'found' is the moment a dwell begins; 'lost' the moment it ends.
   */
  sk.feed = (t, rssi) => {
    const f = sk.channel(); if (f == null) return { action: 'stay', channel: null };
    if (rssi < 0) return { action: 'stay', channel: f };
    const fl = sk.floors.get(f);
    const floor = fl == null ? rssi : (rssi < fl ? fl * 0.6 + rssi * 0.4 : fl * 0.995 + rssi * 0.005);
    sk.floors.set(f, floor);
    const over = rssi - floor;
    if (sk.state === 'step') {
      sk.reads++;
      if (over >= sk.margin && sk.reads >= 1) { sk.state = 'dwell'; sk.dwellSince = t; sk.belowSince = null; sk.found = f; return { action: 'found', channel: f, floor, over }; }
      if (sk.reads >= sk.settleReads) { sk.reads = 0; if (sk.locked == null) sk.i = (sk.i + 1) % sk.channels.length; return { action: 'step', channel: sk.channel(), floor, over }; }
      return { action: 'stay', channel: f, floor, over };
    }
    // dwelling
    if (over < sk.margin / 2) { if (sk.belowSince == null) sk.belowSince = t; } else sk.belowSince = null;
    const dropped = sk.belowSince != null && t - sk.belowSince >= sk.dropMs, timedOut = t - sk.dwellSince >= sk.dwellMs;
    if ((dropped || timedOut) && sk.locked == null) { sk.state = 'step'; sk.reads = 0; sk.i = (sk.i + 1) % sk.channels.length; return { action: 'lost', channel: sk.channel(), floor, over, why: dropped ? 'signal gone' : 'dwell timeout' }; }
    return { action: 'stay', channel: f, floor, over };
  };
  return sk;
}

// ---------------------------------------------------------------- the board
/** Pinned foxes: one entry per frequency, with what has been learned about it. */
export function createBoard() {
  const bd = { foxes: new Map(), onChange: null };
  const changed = () => bd.onChange?.();
  bd.list = () => [...bd.foxes.values()].sort((a, b) => a.f - b.f);
  bd.get = f => bd.foxes.get(key(f));
  const key = f => +(+f).toFixed(4);
  bd.pin = (f, { id = null, label = '' } = {}) => {
    const k = key(f); let x = bd.foxes.get(k);
    if (!x) { x = { f: k, id, label, firstSeen: Date.now(), lastHeard: null, max: -1, spark: [], cycle: createCycleTracker(), notes: '' }; bd.foxes.set(k, x); }
    else if (id) x.id = id;
    changed(); return x;
  };
  bd.unpin = f => { bd.foxes.delete(key(f)); changed(); };
  bd.clear = () => { bd.foxes.clear(); changed(); };
  /** A reading on a pinned frequency: feeds its cycle tracker and sparkline. Returns true if the frequency was pinned. */
  bd.note = (f, t, rssi) => {
    const x = bd.foxes.get(key(f)); if (!x) return false;
    x.cycle.feed(t, rssi);
    if (rssi >= 0) { x.spark.push(rssi); if (x.spark.length > 120) x.spark.shift(); if (rssi > x.max) x.max = rssi; const st = x.cycle.status(t); if (st.on || rssi > (st.threshold ?? Infinity)) x.lastHeard = t; }
    return true;
  };
  bd.identify = (f, id, t = Date.now()) => { const x = bd.foxes.get(key(f)); if (!x) return false; x.id = id; x.idAt = t; x.lastHeard = t; changed(); return true; };
  /** For the session file. */
  bd.serialize = () => bd.list().map(x => ({ f: x.f, id: x.id, label: x.label, firstSeen: x.firstSeen, lastHeard: x.lastHeard, max: x.max, idAt: x.idAt || null, notes: x.notes, onsets: x.cycle.onsets.slice(), durations: x.cycle.durations.slice() }));
  bd.restore = list => { bd.foxes.clear(); for (const e of list || []) { const x = bd.pin(e.f, { id: e.id, label: e.label }); Object.assign(x, { firstSeen: e.firstSeen, lastHeard: e.lastHeard, max: e.max ?? -1, idAt: e.idAt, notes: e.notes || '' }); x.cycle.onsets = (e.onsets || []).slice(); x.cycle.durations = (e.durations || []).slice(); } changed(); };
  return bd;
}

/** A callsign in decoded text: prefix letters, a digit, suffix letters (W1AW, N0CALL, VE3ABC, 2E0ABC). */
export const CALLSIGN_RE = /\b(?:[A-Z]{1,2}|[0-9][A-Z])[0-9][A-Z]{1,4}\b/g;
export function findCallsigns(text) { return [...String(text).toUpperCase().matchAll(CALLSIGN_RE)].map(m => m[0]); }

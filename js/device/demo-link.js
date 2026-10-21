// demo-link.js — a simulated fox running firmware/code.py.
// SPDX-License-Identifier: GPL-2.0-only
//
// Produces the same byte stream the real firmware does (echo, body, the
// "ch> " prompt, chunked delivery) so ShellLink's parser is exercised, not
// bypassed. Command set and reply shapes follow PROTOCOL.md; if the real
// board does something odd, teach this class to do it too.
//
// The simulated air has two foxes on it: one on 146.565 MHz that keys up
// for 12 s every 40 s (a Morse ID and a song, like the real DC34 fox), and
// a weaker one on 433.900 MHz that is on all the time. The RSSI byte
// follows the SA868's habit: a noise floor in the 20s-30s, saturation at
// 255, a few counts of jitter.
import { ShellLink } from './shell-link.js';

const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '/': '-..-.', '?': '..--..', '=': '-...-' };
const BANDS = { vhf: [[134, 174]], uhf: [[400, 480]], dual: [[134, 174], [400, 480]] };
const DEFAULT_FREQ = { vhf: 146.565, uhf: 433.900, dual: 146.565 };

/** Every open simulated fox: one's transmitter is heard by the others, so a paired beacon shows up on the receiver. */
const AIR = new Set();

export class DemoLink extends ShellLink {
  /** opts.band: 'vhf'|'uhf'|'dual'|null (null = fresh board, band unset). opts.txEnabled mirrors TX_ENABLED. */
  constructor({ band = 'dual', callsign = 'N0CALL', txEnabled = false, resetOnOpen = false } = {}) {
    super();
    this.resetOnOpen = resetOnOpen;   // like the real board: opening the port resets the chip, and the boot banner lands on top of the first command
    this.band = band; this.callsign = callsign; this.txEnabled = txEnabled;
    this.armed = false; this.keyedUntil = 0; this.keyedFrom = 0; this.power = 'low'; this.wpm = 12; this.tone = 800; this.foxmsg = 'FOX'; this.foxdelay = 30;
    this.foxRunning = false; this.foxNext = 0; this.foxCycles = 0; this.foxTimer = null; this.txLog = [];   // txLog: what went on the air, for the tests
    this.freq = band ? DEFAULT_FREQ[band] : 146.565;
    this.bw = 1; this.squelch = 3; this.volume = 5;
    this.t0 = Date.now() - 600_000;   // "booted" ten minutes ago: tick counts are positive like a real fox's
    this.foxes = [
      { f: 146.565, peak: 215, on: 12, period: 40, phase: 0, bearing: 60 },    // keyed, like the DC34 fox; it sits to the ENE
      { f: 433.900, peak: 140, on: Infinity, period: 1, phase: 0, bearing: 300 }, // a continuous one, weaker, to the NW
      { f: 146.520, peak: 90, on: 3, period: 17, phase: 5, bearing: 180 },     // someone calling on the simplex channel
    ];
    this.heading = null;   // set by the page when a heading is known: the simulated antenna is a yagi pointing that way
    this.sqOn = false; this.sqSince = Date.now();   // the simulated SQ wire: `sq on` declares it, `events` drains edges since sqSince
    AIR.add(this);
  }
  /** Is the squelch open on `f` at `at`? The SA868's SQ pin: low when the signal clears the squelch setting. */
  carrierAt(f, at = Date.now()) { return this.strengthAt(f, at) > 32 + 8 * this.squelch; }
  /** Carrier edges on the tuned channel between two wall-clock times, from the keying schedule: [[ms, 1|0], ...]. */
  edgesBetween(from, to) {
    const out = []; let level = this.carrierAt(this.freq, from);
    for (let at = from + 50; at <= to; at += 50) { const l = this.carrierAt(this.freq, at); if (l !== level) { level = l; out.push([at, l ? 1 : 0]); } }
    return out;
  }
  async open() {
    if (this.resetOnOpen) this._send(this.enc.encode(`\r\nfoxhunt 0.4.0 xiao-esp32c3 sa868-${this.band || 'unset'}\r\nSA868 ready, receiving on ${this.freq.toFixed(4)} MHz (${this.band})\r\nreceive only: PTT is held high. type help.\r\nch> `), 400);
  }
  info() { return 'demo'; }
  async close() { this.closed = true; this._foxStop(); AIR.delete(this); }

  // ---- transmit simulation ------------------------------------------------
  _keyed() { return this.keyedUntil > Date.now(); }
  _keyedAt(at) { return this.keyedFrom <= at && at < this.keyedUntil; }
  _unkey() { this.keyedUntil = 0; }
  _txWhy() {
    if (!this.txEnabled) return 'transmit commands are not enabled in this firmware build (TX_ENABLED is False)';
    if (this.callsign === 'N0CALL') return 'no callsign stored; set one with `callsign` first';
    if (!this.armed) return 'not armed; send `tx arm` first';
    if (!this.band) return 'module band not set; send `band vhf|uhf|dual` first';
    return '';
  }
  _morseSeconds(text) {
    const unit = 60 / (this.wpm * 50); let units = 0;
    for (const w of text.toUpperCase().split(/\s+/)) { for (const c of w) { const m = MORSE[c]; if (m) for (const k of m) units += (k === '.' ? 1 : 3) + 1; units += 2; } units += 4; }
    return units * unit + 0.95;
  }
  _foxStop() { this.foxRunning = false; if (this.foxTimer) { clearTimeout(this.foxTimer); this.foxTimer = null; } this._unkey(); }
  _foxSchedule(ms) {
    if (this.foxTimer) clearTimeout(this.foxTimer);
    this.foxNext = Date.now() + ms;
    this.foxTimer = setTimeout(() => {
      this.foxTimer = null; if (!this.foxRunning || this.closed) return;
      if (this._txWhy()) { this.foxRunning = false; return; }
      const text = `${this.callsign} ${this.foxmsg}`, s = this._morseSeconds(text);
      // a cycle: the simulated air carries the ID; the demo keeps it to 1/10 of real time so the page can be exercised
      this.keyedFrom = Date.now(); this.keyedUntil = Date.now() + s * 100; this.txLog.push({ t: Date.now(), kind: 'fox', text });
      setTimeout(() => { if (this.foxRunning) { this.foxCycles++; this._unkey(); this._foxSchedule(this.foxdelay * 100); } }, s * 100);
    }, ms);
  }

  _send(bytes, delay, chunk = 256) {
    let i = 0;
    const step = () => { if (this.closed || i >= bytes.length) return; this._feed(bytes.slice(i, i + chunk)); i += chunk; setTimeout(step, 2); };
    setTimeout(step, delay);
  }
  _reply(cmd, body, delay) { this._send(this.enc.encode(cmd + '\r\n' + (body ? body + '\r\n' : '') + 'ch> '), delay); }

  _ranges() { return BANDS[this.band] || []; }
  _inBand(f) { return this._ranges().some(([lo, hi]) => f >= lo && f <= hi); }
  _bandText() { return this.band ? this._ranges().map(([a, b]) => `${a}-${b}`).join(' ') + ' MHz' : 'unset'; }

  /** The RSSI byte the module would report at frequency f (MHz) right now. */
  /** The strongest simulated signal on `f` at `at`, as the receiver would see it (selectivity, fade, antenna), without noise. 0 when nothing is keyed there. */
  strengthAt(f, at = Date.now()) {
    const t = (at - this.t0) / 1000; let v = 0;
    for (const fx of this.foxes) {
      const keyed = fx.on === Infinity || (((t + fx.phase) % fx.period + fx.period) % fx.period) < fx.on;
      if (!keyed) continue;
      // FM receiver selectivity: full strength within half the channel width, then falls off fast
      const d = Math.abs(f - fx.f) * 1000, half = this.bw ? 12.5 : 6.25;
      const sel = d <= half ? 1 : Math.max(0, 1 - (d - half) / (half * 1.5));
      const fade = 1 - 0.15 * Math.max(0, Math.sin(t * 0.9 + fx.f));   // a little walking-around fade
      // a 3-element yagi: front lobe ~60° wide, back lobe ~15 dB down; only when the page has a heading
      let gain = 1;
      if (this.heading != null) { const d = Math.abs((((this.heading - fx.bearing) % 360) + 540) % 360 - 180); gain = Math.max(Math.exp(-(d * d) / (2 * 30 * 30)), 0.18 * Math.exp(-((180 - d) ** 2) / (2 * 40 * 40)), 0.06); }
      v = Math.max(v, fx.peak * sel * fade * gain);
    }
    // another simulated fox keyed on the bench: a few feet away, so it pins the meter on its channel
    for (const o of AIR) {
      if (o === this || o.closed || !o._keyedAt(at)) continue;
      const d = Math.abs(f - o.freq) * 1000, half = this.bw ? 12.5 : 6.25;
      const sel = d <= half ? 1 : Math.max(0, 1 - (d - half) / (half * 1.5));
      v = Math.max(v, (o.power === 'high' ? 250 : 232) * sel);
    }
    return v;
  }
  rssiAt(f, at = Date.now()) {
    const t = (at - this.t0) / 1000;
    let v = Math.max(26 + 3 * Math.sin(t / 7), this.strengthAt(f, at));   // slowly wandering floor under the signal
    v += (Math.random() - 0.5) * 5;
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  _write(s) {
    const cmd = s.trim(); const [c, ...a] = cmd.split(/\s+/); const lc = (c || '').toLowerCase();
    let body = '', delay = 10;
    const needBand = () => { if (this.band) return false; body = 'error: module band not set; send `band vhf|uhf|dual` first'; return true; };
    switch (lc) {
      case '': break;
      case 'version': body = `foxhunt 0.4.0 xiao-esp32c3 sa868-${this.band || 'unset'}`; break;
      case 'info': body = [
        'firmware: foxhunt 0.4.0', 'board: xiao-esp32c3', `module: sa868-${this.band || 'unset'} connected`,
        'module_version: +VERSION:SA868S-VHF/UHF_V1.6 (demo)', `band: ${this.band || 'unset'}`, `bands: ${this._bandText()}`,
        `callsign: ${this.callsign}`, `freq: ${this.freq.toFixed(4)}`, `bw: ${this.bw}`, `squelch: ${this.squelch}`, `volume: ${this.volume}`,
        'rssi_cmd: AT+RSSI?', 'nvm: yes', `ptt: ${this._keyed() ? `TX keyed ${((this.keyedUntil - Date.now()) / 1000).toFixed(1)} s left` : 'rx'}`, `tx: ${this.txEnabled ? 'available' : 'disabled'}`,
        `sq: ${!this.sqOn ? 'off' : this.carrierAt(this.freq) ? 'on carrier' : 'on quiet'}`,
        `armed: ${this.armed ? 'yes' : 'no'}`, `power: ${this.power}`, `wpm: ${this.wpm}`, `tone: ${this.tone}`, `foxmsg: ${this.foxmsg}`, `foxdelay: ${this.foxdelay}`, `fox: ${this.foxRunning ? 'running' : 'stopped'} (${this.foxCycles} cycles)`].join('\n'); break;
      case 'help': body = 'commands: version info help band callsign tune rssi scan squelch bw volume at rx led sq events\n' + (this.txEnabled ? 'transmit: tx arm|disarm|on [s]|off  tone {Hz} {ms}  morse {text}  power low|high  wpm {n}  foxmsg {text}  foxdelay {s}  fox start|stop' : 'transmit: disabled in this build (TX_ENABLED is False)'); break;
      case 'band': {
        if (!a.length) { body = this.band || 'unset'; break; }
        const w = a[0].toLowerCase();
        if (!BANDS[w]) { body = 'usage: band vhf|uhf|dual'; break; }
        const changed = w !== this.band; this.band = w;
        if (changed || !this._inBand(this.freq)) this.freq = DEFAULT_FREQ[w];
        body = w; break; }
      case 'callsign': {
        if (!a.length) { body = this.callsign; break; }
        const cs = a[0].toUpperCase();
        if (cs.length > 16 || !/^[A-Z0-9/]+$/.test(cs)) { body = 'usage: callsign {A-Z 0-9 /, up to 16}'; break; }
        this.callsign = cs; body = cs; break; }
      case 'tune': {
        if (!a.length) { body = this.freq.toFixed(4); break; }
        if (needBand()) break;
        const f = parseFloat(a[0]);
        if (!Number.isFinite(f)) { body = 'usage: tune {MHz}'; break; }
        if (!this._inBand(f)) { body = `error: ${f.toFixed(4)} MHz is outside ${this._bandText()}`; break; }
        this.freq = f; body = f.toFixed(4); delay = 40; break; }
      case 'rssi': {
        let n = 1;
        if (a.length) { n = parseInt(a[0], 10); if (!Number.isFinite(n)) { body = 'usage: rssi [count]'; break; } if (n < 1 || n > 200) { body = 'usage: rssi [1..200]'; break; } }
        if (n === 1) { body = String(this.rssiAt(this.freq)); delay = 30; break; }
        // the real firmware prints as it goes; here the lines are precomputed and the delay covers the burst
        const L = []; const start = Date.now();
        for (let i = 0; i < n; i++) L.push(`${i * 100} ${this.rssiAt(this.freq, start + i * 100)}`);
        body = L.join('\n'); delay = n * 100; break; }
      case 'scan': {
        if (a.length !== 3) { body = 'usage: scan {start_MHz} {stop_MHz} {step_kHz}'; break; }
        if (needBand()) break;
        const st = parseFloat(a[0]), sp = parseFloat(a[1]), step = parseFloat(a[2]);
        if (![st, sp, step].every(Number.isFinite)) { body = 'usage: scan {start_MHz} {stop_MHz} {step_kHz}'; break; }
        if (step <= 0 || sp < st) { body = 'usage: start <= stop, step > 0'; break; }
        if (!this._inBand(st) || !this._inBand(sp)) { body = `error: range is outside ${this._bandText()}`; break; }
        const count = Math.round((sp - st) / (step / 1000)) + 1;
        if (count > 128) { body = `error: ${count} channels; the limit is 128`; break; }
        const L = []; const start = Date.now();
        for (let i = 0; i < count; i++) { const f = st + i * step / 1000; L.push(`${f.toFixed(4)} ${this.rssiAt(f, start + i * 150)}`); }
        body = L.join('\n'); delay = count * 150; break; }
      case 'squelch': { if (!a.length) { body = String(this.squelch); break; } const v = parseInt(a[0], 10); if (!(v >= 0 && v <= 8)) { body = 'usage: squelch {0..8}'; break; } this.squelch = v; body = String(v); break; }
      case 'bw':      { if (!a.length) { body = String(this.bw); break; }      const v = parseInt(a[0], 10); if (!(v === 0 || v === 1)) { body = 'usage: bw {0..1}'; break; } this.bw = v; body = String(v); break; }
      case 'volume':  { if (!a.length) { body = String(this.volume); break; }  const v = parseInt(a[0], 10); if (!(v >= 1 && v <= 8)) { body = 'usage: volume {1..8}'; break; } this.volume = v; body = String(v); break; }
      case 'at': {
        if (!a.length) { body = 'usage: at {AT+...}'; break; }
        const at = a.join(' ').toUpperCase();
        body = at === 'AT+DMOCONNECT' ? '+DMOCONNECT:0' : at === 'AT+VERSION' ? '+VERSION:SA868S-VHF/UHF_V1.6 (demo)' : at === 'AT+RSSI?' || at === 'RSSI?' ? `RSSI=${String(this.rssiAt(this.freq)).padStart(3, '0')}` : at.startsWith('AT+DMOSETGROUP=') ? '+DMOSETGROUP:0' : at.startsWith('AT+DMOSETVOLUME=') ? '+DMOSETVOLUME:0' : '(no reply)';
        delay = 60; break; }
      case 'rx': this._foxStop(); body = 'rx'; break;
      case 'sq': {
        if (!a.length) { body = !this.sqOn ? 'off' : this.carrierAt(this.freq) ? 'carrier' : 'quiet'; break; }
        const w = a[0].toLowerCase(); if (!['on', 'off'].includes(w)) { body = 'usage: sq on|off'; break; }
        this.sqOn = w === 'on'; this.sqSince = Date.now(); body = w; break; }
      case 'events': {
        if (!this.sqOn) { body = 'error: the SQ wire is not enabled; send `sq on` once it is soldered to D2'; break; }
        const now = Date.now(), L = [`now ${now - this.t0} ${this.carrierAt(this.freq, now) ? 'carrier' : 'quiet'}`];
        for (const [at, l] of this.edgesBetween(this.sqSince, now).slice(-64)) L.push(`${at - this.t0} ${l}`);
        this.sqSince = now; body = L.join('\n'); break; }
      case 'led': body = ['on', 'off'].includes((a[0] || '').toLowerCase()) ? a[0].toLowerCase() : 'usage: led on|off'; break;
      case 'tx': {
        if (!a.length) { body = !this.txEnabled ? 'disabled' : this._keyed() ? `on ${((this.keyedUntil - Date.now()) / 1000).toFixed(1)}` : this.armed ? 'armed' : 'off'; break; }
        const w = a[0].toLowerCase();
        if (!this.txEnabled) { body = 'error: transmit commands are not enabled in this firmware build (TX_ENABLED is False)'; break; }
        if (w === 'arm') { if (this.callsign === 'N0CALL') { body = 'error: no callsign stored; set one with `callsign` first'; break; } this.armed = true; body = 'armed'; }
        else if (w === 'disarm') { this.armed = false; this._foxStop(); body = 'off'; }
        else if (w === 'on') { const why = this._txWhy(); if (why) { body = 'error: ' + why; break; } let secs = 10; if (a[1] != null) { secs = parseFloat(a[1]); if (!Number.isFinite(secs)) { body = 'usage: tx on [seconds]'; break; } } if (secs > 60) { body = 'usage: tx on [1..60]'; break; } secs = Math.max(0.1, secs); this.keyedFrom = Date.now(); this.keyedUntil = Date.now() + secs * 1000; this.txLog.push({ t: Date.now(), kind: 'key', secs }); body = `on ${secs.toFixed(1)}`; }
        else if (w === 'off') { this._unkey(); body = 'off'; }
        else body = 'usage: tx [arm|disarm|on [s]|off]';
        break; }
      case 'tone': {
        if (a.length !== 2) { body = 'usage: tone {Hz} {ms}'; break; }
        const hz = parseInt(a[0], 10), dur = parseInt(a[1], 10);
        if (!(hz >= 300 && hz <= 3000) || !(dur >= 10 && dur <= 5000)) { body = 'usage: tone {300..3000} {10..5000}'; break; }
        const why = this._txWhy(); if (why) { body = 'error: ' + why; break; }
        this.keyedFrom = Date.now() + 800; this.keyedUntil = this.keyedFrom + dur;   // on the air for the tone itself
        this.txLog.push({ t: Date.now(), kind: 'tone', hz, dur }); body = `sent ${hz} Hz ${dur} ms`; delay = Math.min(1500, 850 + dur); break; }
      case 'morse': {
        if (!a.length) { body = 'usage: morse {text}'; break; }
        const text = a.join(' '); if (text.length > 64) { body = 'usage: morse text up to 64 characters'; break; }
        const why = this._txWhy(); if (why) { body = 'error: ' + why; break; }
        const s = this._morseSeconds(text); this.txLog.push({ t: Date.now(), kind: 'morse', text, s });
        this.keyedFrom = Date.now(); this.keyedUntil = Date.now() + Math.min(2000, s * 100);
        body = `sent ${s.toFixed(1)}`; delay = Math.min(2000, s * 100); break; }   // 1/10 of real time
      case 'power': { if (!a.length) { body = this.power; break; } const w = a[0].toLowerCase(); if (!['low', 'high'].includes(w)) { body = 'usage: power low|high'; break; } if (!this.txEnabled) { body = 'error: transmit commands are not enabled in this firmware build (TX_ENABLED is False)'; break; } this.power = w; body = w; break; }
      case 'wpm': { if (!a.length) { body = String(this.wpm); break; } const v = parseInt(a[0], 10); if (!(v >= 5 && v <= 35)) { body = 'usage: wpm {5..35}'; break; } this.wpm = v; body = String(v); break; }
      case 'foxdelay': { if (!a.length) { body = String(this.foxdelay); break; } const v = parseInt(a[0], 10); if (!(v >= 5 && v <= 600)) { body = 'usage: foxdelay {5..600}'; break; } this.foxdelay = v; body = String(v); break; }
      case 'foxmsg': { if (!a.length) { body = this.foxmsg; break; } const t = a.join(' ').toUpperCase(); if (t.length > 40 || !/^[A-Z0-9/?= ]+$/.test(t)) { body = 'usage: foxmsg {A-Z 0-9 / ? = and spaces, up to 40}'; break; } this.foxmsg = t; body = t; break; }
      case 'fox': {
        if (!a.length) { body = `${this.foxRunning ? 'running' : 'stopped'} ${this.foxCycles} ${this.foxRunning ? Math.max(0, Math.round((this.foxNext - Date.now()) / 1000)) : 0}`; break; }
        const w = a[0].toLowerCase();
        if (w === 'start') { const why = this._txWhy(); if (why) { body = 'error: ' + why; break; } this.foxRunning = true; this.foxCycles = 0; this._foxSchedule(0); body = 'running'; }
        else if (w === 'stop') { const n = this.foxCycles; this._foxStop(); body = `stopped ${n}`; }
        else body = 'usage: fox [start|stop]';
        break; }
      default: body = `${lc}?`; break;
    }
    this._reply(cmd, body, delay);
    return Promise.resolve();
  }
}

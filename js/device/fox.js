// fox.js — the fox-hunt-web device API. One ShellLink (serial or demo) underneath.
// SPDX-License-Identifier: GPL-2.0-only
//
// The layer main.js talks to. Callers never see "ch>": they get numbers,
// typed arrays and thrown DeviceErrors. Shape follows tinysa.js so the
// page-side code ports across; the command set is PROTOCOL.md.

import { MODELS, UNSET_MODEL, modelForBand, identifyDevice, FIRMWARE_FLOOR, buildAtLeast, inBands, BAND_KEYS } from './models.js';
import { PROMPT } from './shell-link.js';

export const STATUS = { OK: 'ok', BLOCKED: 'blocked', USAGE: 'usage', UNKNOWN: 'unknown-command', REFUSED: 'device-refused', TIMEOUT: 'timeout' };

export class DeviceError extends Error {
  constructor(message, status, reply = '') { super(message); this.name = 'DeviceError'; this.status = status; this.reply = reply; }
}

/** Reply classification per PROTOCOL.md "Reply conventions". */
export function classifyReply(sent, body) {
  const name = (sent || '').trim().split(/\s+/)[0] || '';
  const text = (body || '').trim();
  if (text === '') return { status: STATUS.OK, reason: '' };
  if (name && text === name + '?') return { status: STATUS.UNKNOWN, reason: `this firmware does not have the '${name}' command` };
  if (text.startsWith('usage:')) return { status: STATUS.USAGE, reason: 'firmware rejected the argument' };
  if (text.startsWith('error:')) return { status: STATUS.REFUSED, reason: text.slice(6).trim() };
  return { status: STATUS.OK, reason: '' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** An RSSI reading: { t (ms since epoch), rssi (0..255, or -1 for no answer), f (MHz) }. */
/** A scan: { f: Float64Array (MHz), rssi: Int16Array, start, stop, stepKHz, t, ms }. */

export class Fox {
  constructor(link) {
    this.link = link;
    this.model = UNSET_MODEL.key;
    this.ident = { version: '', info: '', firmware: '', build: null, board: '', module: '', band: null, label: '' };
    this.state = { freq: null, bw: null, squelch: null, volume: null, band: null, callsign: '', moduleConnected: null, moduleVersion: '', rssiCmd: '', nvm: null, sqWire: false, sqCarrier: null, mic: 'pwm',
      txAvailable: false, armed: false, keyed: false, keyedLeft: 0, power: 'low', wpm: 12, tone: 800, foxmsg: '', foxdelay: 30, foxRunning: false, foxCycles: 0 };
    this.lastStatus = STATUS.OK;
    this.onWarning = null;         // (text) => void
  }
  get env() { return MODELS[this.model] || UNSET_MODEL; }
  get bandSet() { return !!this.state.band; }
  has(cmd) { return this.env.commands.has(cmd); }
  _warn(t) { if (this.onWarning) this.onWarning(t); }
  _blocked(what, why) { this.lastStatus = STATUS.BLOCKED; throw new DeviceError(`${what}: ${why}`, STATUS.BLOCKED); }
  _needBand(what) { if (!this.bandSet) this._blocked(what, 'the module band is not set; pick VHF, UHF or dual-band first'); }

  // ---- the one path every command takes ----------------------------------
  async _cmd(cmd, opts = {}) {
    cmd = cmd.trim();
    let r;
    try { r = await this.link.command(cmd, { requireEcho: true, ...opts }); }
    catch (e) { this.lastStatus = STATUS.TIMEOUT; throw new DeviceError(e.message, STATUS.TIMEOUT); }
    r = { ...r, ...classifyReply(cmd, r.body) };
    this.lastStatus = r.status;
    return r;
  }
  async _ok(cmd, what, opts) {
    const r = await this._cmd(cmd, opts);
    if (r.status !== STATUS.OK) throw new DeviceError(`${what}: ${r.reason} ("${r.body.trim().split('\n')[0]}")`, r.status, r.body);
    return r;
  }

  // ---- identity ----------------------------------------------------------
  async version() { return (await this._cmd('version', { timeoutMs: 3000 })).body.trim(); }
  async help()    { return (await this._cmd('help',    { timeoutMs: 3000, quiet: true })).body; }

  /** info -> the key: value map; also refreshes this.state. */
  async info() {
    const body = (await this._cmd('info', { timeoutMs: 3000 })).body;
    const kv = {};
    for (const line of body.split('\n')) {
      const i = line.indexOf(':'); if (i < 0) continue;
      kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const s = this.state;
    s.freq = parseFloat(kv.freq); s.bw = parseInt(kv.bw, 10); s.squelch = parseInt(kv.squelch, 10); s.volume = parseInt(kv.volume, 10);
    s.band = BAND_KEYS.includes(kv.band) ? kv.band : null;
    s.callsign = kv.callsign || '';
    s.moduleConnected = /connected/.test(kv.module || '') && !/NOT/.test(kv.module || '');
    s.moduleVersion = kv.module_version || ''; s.rssiCmd = kv.rssi_cmd || ''; s.nvm = kv.nvm === 'yes';
    s.txAvailable = kv.tx === 'available'; s.armed = kv.armed === 'yes';
    s.mic = kv.mic === 'line' ? 'line' : 'pwm';
    s.sqWire = /^on/.test(kv.sq || ''); s.sqCarrier = s.sqWire ? /carrier/.test(kv.sq) : null;
    const k = /keyed ([\d.]+)/.exec(kv.ptt || ''); s.keyed = !!k; s.keyedLeft = k ? parseFloat(k[1]) : 0;
    s.power = kv.power || 'low'; s.wpm = parseInt(kv.wpm, 10) || 12; s.tone = parseInt(kv.tone, 10) || 800; s.foxmsg = kv.foxmsg || ''; s.foxdelay = parseInt(kv.foxdelay, 10) || 30;
    const fx = /^(running|stopped) \((\d+) cycles\)/.exec(kv.fox || ''); s.foxRunning = fx ? fx[1] === 'running' : false; s.foxCycles = fx ? parseInt(fx[2], 10) : 0;
    this.model = modelForBand(s.band).key;
    return kv;
  }

  /**
   * version + info. Throws if the port is not a fox running this firmware.
   * The first `version` is retried once: opening the port can reset the
   * ESP32, and the banner takes about a second to arrive.
   */
  async identify() {
    let v;
    try { v = await this.link.command('version', { timeoutMs: 2500 }); }
    catch { await sleep(1200); v = await this.link.command('version', { timeoutMs: 3000 }); }
    if (!v.raw.includes(PROMPT)) throw new Error('that port did not answer with a ch> prompt');
    // the boot banner (chip reset on port open) prints the same version line before its own prompt, possibly
    // ahead of our echo: take the version line wherever it is in what came back, not the first line
    let id = identifyDevice(v.body);
    if (!id.ok) { const m = /^(fox\w+ \d+\.\d+\.\d+ [^\r\n]+)/m.exec(v.raw); if (m) id = identifyDevice(m[1]); }
    if (!id.ok) {   // a banner-only reply: the command itself may not have been read yet; ask once more
      await sleep(800); const again = await this.link.command('version', { timeoutMs: 3000 });
      id = identifyDevice(again.body); if (!id.ok) { const m = /^(fox\w+ \d+\.\d+\.\d+ [^\r\n]+)/m.exec(again.raw); if (m) id = identifyDevice(m[1]); }
      if (id.ok) v = again;
    }
    if (!id.ok) throw new Error(id.reason);
    this.ident = { version: v.body.trim(), info: '', firmware: id.firmware, build: id.build, board: id.board, module: id.module, band: id.band, label: '' };
    const kv = await this.info();
    this.ident.info = Object.entries(kv).map(([k, val]) => `${k}: ${val}`).join('\n');
    this._label();
    if (!buildAtLeast(id.build, FIRMWARE_FLOOR)) this._warn(`firmware ${id.firmware} is older than ${FIRMWARE_FLOOR.join('.')}, the oldest this page is written for`);
    if (this.state.moduleConnected === false) this._warn('the firmware is up but the SA868 did not answer its handshake; check the module power (PD) and the UART');
    if (!this.bandSet) this._warn('this fox has no module band recorded yet; pick VHF, UHF or dual-band from the Module dropdown (sent once, kept in the board\'s NVM)');
    return this.ident;
  }
  _label() {
    const mv = this.state.moduleVersion && this.state.moduleVersion !== 'unknown' ? ' · ' + this.state.moduleVersion.replace(/^\+VERSION:/, '') : '';
    this.ident.label = `${this.env.name} · firmware ${this.ident.firmware}${mv}`;
  }

  // ---- configuration (persisted on the board) ----------------------------
  /** band() -> 'vhf'|'uhf'|'dual'|null; band(name) -> sets, persists, and re-reads info. */
  async band(name) {
    if (name == null) { const b = (await this._cmd('band')).body.trim(); return BAND_KEYS.includes(b) ? b : null; }
    if (!BAND_KEYS.includes(name)) this._blocked('band', 'vhf, uhf or dual');
    const r = await this._ok(`band ${name}`, 'band', { timeoutMs: 3000 });
    if (/not persisted/.test(r.body)) this._warn('the band was set for this session only: the board reports no NVM');
    await this.info(); this.ident.module = `sa868-${name}`; this.ident.band = name; this._label();
    return name;
  }
  /** callsign() -> stored string; callsign(cs) -> sets and persists. */
  async callsign(cs) {
    if (cs == null) return (await this._cmd('callsign')).body.trim();
    cs = String(cs).trim().toUpperCase();
    if (!/^[A-Z0-9/]{1,16}$/.test(cs)) this._blocked('callsign', 'A–Z, 0–9 and /, up to 16 characters');
    const r = await this._ok(`callsign ${cs}`, 'callsign', { timeoutMs: 3000 });
    if (/not persisted/.test(r.body)) this._warn('the callsign was set for this session only: the board reports no NVM');
    this.state.callsign = cs; return cs;
  }

  // ---- receiver ----------------------------------------------------------
  /** tune() -> current MHz; tune(f) -> sets and returns the MHz as programmed. */
  async tune(f) {
    if (f == null) { const r = await this._cmd('tune'); return parseFloat(r.body); }
    this._needBand('tune');
    if (!Number.isFinite(f)) this._blocked('tune', 'frequency must be a number (MHz)');
    if (!inBands(f, this.env.moduleBands)) this._blocked('tune', `${f} MHz is outside the ${this.env.name}'s range`);
    const r = await this._ok(`tune ${f.toFixed(4)}`, 'tune', { timeoutMs: 3000 });
    this.state.freq = parseFloat(r.body);
    return this.state.freq;
  }

  /** One reading -> { t, rssi, f }. rssi is -1 when the module did not answer. */
  async rssi() {
    const r = await this._ok('rssi', 'rssi', { timeoutMs: 3000, quiet: true });
    return { t: Date.now(), rssi: parseInt(r.body, 10), f: this.state.freq };
  }

  /**
   * rssi N: N readings at ~10 Hz in one command. Returns
   * { t0, ms: Float32Array (offsets), rssi: Int16Array, f, n }.
   * Cheaper than N round trips through the serial queue.
   */
  async rssiBurst(n = 20) {
    n = Math.min(Math.max(Math.round(n), 1), this.env.rssiBurstMax);
    const t0 = Date.now();
    const r = await this._ok(`rssi ${n}`, 'rssi', { timeoutMs: 3000 + n * 150, quiet: true });
    const ms = [], rssi = [];
    for (const line of r.body.split('\n')) {
      const v = line.trim().split(/\s+/); if (v.length < 2) continue;
      const a = Number(v[0]), b = Number(v[1]); if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      ms.push(a); rssi.push(b);
    }
    return { t0, ms: Float32Array.from(ms), rssi: Int16Array.from(rssi), f: this.state.freq, n: rssi.length };
  }

  /**
   * scan(start, stop, stepKHz): one 'freq rssi' line per channel. The
   * firmware restores the previous frequency afterwards, so state.freq is
   * left alone. Throws if the channel count would exceed the firmware limit.
   */
  async scan(start, stop, stepKHz, { quiet = true } = {}) {
    this._needBand('scan');
    if (!(start <= stop) || !(stepKHz > 0)) this._blocked('scan', 'start must be at or below stop, step above 0');
    if (!inBands(start, this.env.moduleBands) || !inBands(stop, this.env.moduleBands)) this._blocked('scan', `range is outside the ${this.env.name}'s range`);
    const count = Math.round((stop - start) / (stepKHz / 1000)) + 1;
    if (count > this.env.scanMaxChannels) this._blocked('scan', `${count} channels; the firmware limit is ${this.env.scanMaxChannels}`);
    const cmd = `scan ${start.toFixed(4)} ${stop.toFixed(4)} ${stepKHz}`;
    const t = Date.now();
    const r = await this._ok(cmd, 'scan', { timeoutMs: 3000 + count * this.env.scanMsPerChannel, quiet });
    const f = [], rssi = [];
    for (const line of r.body.split('\n')) {
      const v = line.trim().split(/\s+/); if (v.length < 2) continue;
      const a = Number(v[0]), b = Number(v[1]); if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      f.push(a); rssi.push(b);
    }
    if (f.length !== count) this._warn(`scan returned ${f.length} channels, expected ${count}`);
    return { f: Float64Array.from(f), rssi: Int16Array.from(rssi), start, stop, stepKHz, t, ms: r.ms, cmd, n: f.length };
  }

  // ---- settings ----------------------------------------------------------
  async squelch(v) { if (v == null) return parseInt((await this._cmd('squelch')).body, 10); if (!(v >= 0 && v <= 8)) this._blocked('squelch', '0..8'); const r = await this._ok(`squelch ${v}`, 'squelch'); this.state.squelch = parseInt(r.body, 10); return this.state.squelch; }
  async bw(v)      { if (v == null) return parseInt((await this._cmd('bw')).body, 10);      if (v !== 0 && v !== 1)    this._blocked('bw', '0 (12.5 kHz) or 1 (25 kHz)'); const r = await this._ok(`bw ${v}`, 'bw');           this.state.bw = parseInt(r.body, 10);      return this.state.bw; }
  async volume(v)  { if (v == null) return parseInt((await this._cmd('volume')).body, 10);  if (!(v >= 1 && v <= 8))  this._blocked('volume', '1..8');  const r = await this._ok(`volume ${v}`, 'volume');   this.state.volume = parseInt(r.body, 10);  return this.state.volume; }

  /** Re-assert receive on the module. */
  async rx()      { const r = await this._ok('rx', 'rx'); this.state.keyed = false; this.state.foxRunning = false; return r; }
  async led(on)   { return this._ok(`led ${on ? 'on' : 'off'}`, 'led'); }

  /** Raw AT command to the SA868, for the console. Returns the module's reply line. */
  async at(cmd)   { return (await this._cmd(`at ${cmd}`, { timeoutMs: 4000 })).body.trim(); }

  /**
   * End a running `rssi N` or `scan` early. The firmware stops at the next
   * byte it receives; a bare newline is harmless (empty command). The
   * pending command still resolves normally with the partial data.
   */
  async cancel() { try { await this.link._write('\r\n'); } catch {} }

  // ---- transmit ----------------------------------------------------------
  // Every method here is refused on the page before anything is sent when the
  // firmware has reported tx: disabled, and the firmware refuses again on its
  // side (TX_ENABLED, callsign, armed). Nothing is sent unprompted.
  _needTx(what) {
    if (!this.state.txAvailable) this._blocked(what, 'this firmware build has transmit disabled (TX_ENABLED is False in code.py)');
    if (this.state.callsign === 'N0CALL' || !this.state.callsign) this._blocked(what, 'store a callsign first');
  }
  /** txStatus() -> { keyed, left, armed, disabled } from a bare `tx`. */
  async txStatus() {
    const b = (await this._cmd('tx', { timeoutMs: 3000, quiet: true })).body.trim();
    const on = /^on ([\d.]+)/.exec(b);
    this.state.keyed = !!on; this.state.keyedLeft = on ? parseFloat(on[1]) : 0; if (!on) this.state.armed = b === 'armed';
    return { keyed: !!on, left: on ? parseFloat(on[1]) : 0, armed: !!on || b === 'armed', disabled: b === 'disabled' };
  }
  async arm()    { this._needTx('tx arm'); await this._ok('tx arm', 'tx arm', { timeoutMs: 3000 }); this.state.armed = true; return true; }
  async disarm() { const r = await this._cmd('tx disarm', { timeoutMs: 3000 }); this.state.armed = false; this.state.keyed = false; this.state.foxRunning = false; return r.status === STATUS.OK; }
  /** Key the carrier for `seconds` (≤ 60). The firmware unkeys at the deadline on its own. */
  async keyOn(seconds = 10) { this._needTx('tx on'); if (!(seconds > 0 && seconds <= 120)) this._blocked('tx on', '0.1..120 s'); const r = await this._ok(`tx on ${seconds}`, 'tx on', { timeoutMs: 3000 }); this.state.keyed = true; this.state.keyedLeft = parseFloat(r.body.split(/\s+/)[1]) || seconds; return this.state.keyedLeft; }
  async keyOff() { await this._ok('tx off', 'tx off', { timeoutMs: 3000 }); this.state.keyed = false; this.state.keyedLeft = 0; }
  /** One tone on the air; blocks for its duration. */
  async tone(hz, ms) { this._needTx('tone'); if (!(hz >= 300 && hz <= 3000) || !(ms >= 10 && ms <= 5000)) this._blocked('tone', '300..3000 Hz, 10..5000 ms'); return (await this._ok(`tone ${Math.round(hz)} ${Math.round(ms)}`, 'tone', { timeoutMs: 4000 + ms })).body.trim(); }
  /** Air time estimate the firmware uses, so the page can set its timeout. */
  morseSeconds(text) {
    const M = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '/': '-..-.', '?': '..--..', '=': '-...-' };
    const unit = 60 / (this.state.wpm * 50); let units = 0;
    for (const w of String(text).toUpperCase().split(/\s+/)) { for (const c of w) { const m = M[c]; if (m) for (const k of m) units += (k === '.' ? 1 : 3) + 1; units += 2; } units += 4; }
    return units * unit + 0.95;
  }
  /** Send text in Morse; resolves when it is off the air: { result: 'sent'|'aborted', seconds }. */
  async morse(text) {
    this._needTx('morse'); text = String(text).trim();
    if (!text || text.length > 64) this._blocked('morse', '1..64 characters');
    if (!/^[A-Za-z0-9/?= ]+$/.test(text)) this._blocked('morse', 'A–Z, 0–9, / ? = and spaces');
    const est = this.morseSeconds(text);
    const r = await this._ok(`morse ${text}`, 'morse', { timeoutMs: 5000 + est * 1000 });
    const [result, secs] = r.body.trim().split(/\s+/); return { result, seconds: parseFloat(secs) || est };
  }
  async power(v)    { if (v == null) return (await this._cmd('power')).body.trim(); if (!['low', 'high'].includes(v)) this._blocked('power', 'low or high'); const r = await this._ok(`power ${v}`, 'power'); this.state.power = r.body.trim(); return this.state.power; }
  async wpm(v)      { if (v == null) return parseInt((await this._cmd('wpm')).body, 10);  if (!(v >= 5 && v <= 35)) this._blocked('wpm', '5..35');   const r = await this._ok(`wpm ${v}`, 'wpm');   this.state.wpm = parseInt(r.body, 10); return this.state.wpm; }
  async foxdelay(v) { if (v == null) return parseInt((await this._cmd('foxdelay')).body, 10); if (!(v >= 5 && v <= 600)) this._blocked('foxdelay', '5..600 s'); const r = await this._ok(`foxdelay ${v}`, 'foxdelay'); this.state.foxdelay = parseInt(r.body, 10); return this.state.foxdelay; }
  async foxmsg(t)   { if (t == null) return (await this._cmd('foxmsg')).body.trim(); t = String(t).trim().toUpperCase(); if (!t || t.length > 40 || !/^[A-Z0-9/?= ]+$/.test(t)) this._blocked('foxmsg', 'A–Z, 0–9, / ? = and spaces, up to 40'); const r = await this._ok(`foxmsg ${t}`, 'foxmsg'); this.state.foxmsg = r.body.trim(); return this.state.foxmsg; }
  /** foxStatus() -> { running, cycles, nextS } */
  async foxStatus() { const w = (await this._cmd('fox', { timeoutMs: 3000, quiet: true })).body.trim().split(/\s+/); const st = { running: w[0] === 'running', cycles: parseInt(w[1], 10) || 0, nextS: parseInt(w[2], 10) || 0 }; this.state.foxRunning = st.running; this.state.foxCycles = st.cycles; return st; }
  async foxStart()  { this._needTx('fox start'); await this._ok('fox start', 'fox start', { timeoutMs: 3000 }); this.state.foxRunning = true; this.state.foxCycles = 0; return true; }
  /** Stops the beacon. Works mid-cycle: the byte aborts the Morse at the next character. */
  async foxStop()   { const r = await this._ok('fox stop', 'fox stop', { timeoutMs: 8000 }); this.state.foxRunning = false; return parseInt(r.body.split(/\s+/)[1], 10) || 0; }

  /** mic() -> 'pwm'|'line'; mic('line') floats D1 while keyed so a sound card can drive MIC_IN (firmware 0.5.0+). */
  async mic(mode) {
    if (mode == null) { const v = (await this._cmd('mic', { quiet: true })).body.trim(); this.state.mic = v === 'line' ? 'line' : 'pwm'; return this.state.mic; }
    if (!['pwm', 'line'].includes(mode)) this._blocked('mic', 'pwm or line');
    const r = await this._ok(`mic ${mode}`, 'mic'); this.state.mic = r.body.trim(); return this.state.mic;
  }

  // ---- the SQ wire -------------------------------------------------------
  /** sq() -> 'off'|'carrier'|'quiet'; sq(true|false) declares the wire present (persisted on the fox). */
  async sq(on) {
    if (on == null) { const v = (await this._cmd('sq', { quiet: true })).body.trim(); this.state.sqWire = v !== 'off'; this.state.sqCarrier = v === 'carrier' ? true : v === 'quiet' ? false : null; return v; }
    const r = await this._ok(`sq ${on ? 'on' : 'off'}`, 'sq'); this.state.sqWire = !!on; if (!on) this.state.sqCarrier = null; return r.body.trim();
  }
  /**
   * events() -> { now, carrier, edges: [{ ms, on }] } with the fox's own ms
   * ticks: carrier edges the firmware timed on the SQ wire since the last
   * call. Throws DeviceError when the wire is not enabled.
   */
  async events() {
    const r = await this._cmd('events', { timeoutMs: 3000, quiet: true });
    if (/^error:/.test(r.body.trim())) this._blocked('events', r.body.trim().replace(/^error:\s*/, ''));
    const lines = r.body.trim().split(/\r?\n/).filter(Boolean);
    const head = /^now (\d+) (carrier|quiet)/.exec(lines[0] || '');
    if (!head) throw new DeviceError(`events: unexpected reply ${JSON.stringify(lines[0] || '')}`, STATUS.REFUSED);
    const edges = lines.slice(1).map(l => { const m = /^(\d+) ([01])$/.exec(l.trim()); return m ? { ms: +m[1], on: m[2] === '1' } : null; }).filter(Boolean);
    this.state.sqWire = true; this.state.sqCarrier = head[2] === 'carrier';
    return { now: +head[1], carrier: head[2] === 'carrier', edges };
  }

  // ---- raw ---------------------------------------------------------------
  /** Anything else, for the console box. Classified (lastStatus) but not thrown. */
  async raw(cmd, timeoutMs = 25000) { return this._cmd(cmd, { timeoutMs }); }
}

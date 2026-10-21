// shell-link.js — the NanoVNA console protocol, transport-agnostic.
// SPDX-License-Identifier: GPL-2.0-only
//
// Send "cmd\r\n"; the device echoes the command, prints the reply, then the
// prompt "ch>" — usually twice ("ch> \r\nch> "). Rules ported from
// nvnapython core.py: a reply is complete when the buffer, right-trimmed, ends
// with the prompt; then wait a short settle for the doubled prompt and drain.
//
// Subclasses provide _write(string) and call _feed(Uint8Array) as bytes arrive.

export const PROMPT = 'ch>';

export class ShellLink {
  constructor() {
    this.buf = new Uint8Array(0);
    this.waiter = null;
    this.closed = false;
    this._queue = Promise.resolve();   // one command on the wire at a time (see _serial)
    this.dec = new TextDecoder();
    this.enc = new TextEncoder();
    this.onTx = null;      // (cmd) => void          — for the console view
    this.onRx = null;      // (text, {ms}) => void   — raw reply text
    this.onRaw = null;     // (bytes) => void        — every chunk, for debugging framing
  }

  _feed(bytes) {
    const n = new Uint8Array(this.buf.length + bytes.length);
    n.set(this.buf); n.set(bytes, this.buf.length); this.buf = n;
    if (this.onRaw) this.onRaw(bytes);
    if (this.waiter) this.waiter();
  }
  _take() { const b = this.buf; this.buf = new Uint8Array(0); return b; }
  _text(b) { return this.dec.decode(b); }
  _wait(ms) {
    return new Promise(res => {
      const t = setTimeout(() => { this.waiter = null; res(false); }, ms);
      this.waiter = () => { clearTimeout(t); this.waiter = null; res(true); };
    });
  }
  async _flush() { await new Promise(r => setTimeout(r, 15)); this._take(); }

  /**
   * Send a command; resolve with { body, raw, ms }. body has echo and prompts removed.
   *
   * Options added for the tinySA (tsapython 4.0.0 reader rules), both off by default
   * so the NanoVNA behaviour is unchanged:
   *   requireEcho  — a prompt only ends the reply once the command's own echo has
   *                  been seen; anything before the echo is a late reply to an
   *                  earlier command (one that timed out) and is discarded, so it
   *                  is not returned as the answer to this one.
   *   terminators  — extra strings that end a reply when the device prints them
   *                  INSTEAD of a prompt (the tinySA's "Command timeout").
   */
  /**
   * The console answers one command at a time, and a reply to a background
   * poll ("status", "vbat") arriving in the middle of another command's reply
   * corrupts both. Every public call goes through this chain, so callers can
   * fire commands from timers and click handlers without coordinating.
   */
  _serial(fn) { const p = this._queue.then(fn, fn); this._queue = p.catch(() => {}); return p; }
  command(cmd, opts) { return this._serial(() => this._command(cmd, opts)); }
  commandNoPrompt(cmd, waitMs) { return this._serial(() => this._commandNoPrompt(cmd, waitMs)); }
  commandBinary(cmd, n, opts) { return this._serial(() => this._commandBinary(cmd, n, opts)); }

  async _command(cmd, { timeoutMs = 6000, settleMs = 40, quiet = false, requireEcho = false, terminators = [] } = {}) {
    await this._flush();
    if (this.onTx && !quiet) this.onTx(cmd);
    const t0 = performance.now();
    await this._write(cmd + '\r\n');
    let last = performance.now();
    let echoSeen = !requireEcho;
    for (;;) {
      let text = this._text(this.buf);
      if (!echoSeen) {
        // the echo is the command on a line of its own; a bare indexOf would accept "sq" inside a stale "squelch: 3"
        const m = new RegExp('(^|\\n)' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n').exec(text);
        const at = m ? m.index + m[1].length : -1;
        if (at === -1) {
          if (text.replace(/[\s\0]+$/, '').endsWith(PROMPT)) { this._take(); if (this.onRx && !quiet) this.onRx(`(discarded ${text.length} stale bytes)`, { ms: 0, raw: text }); }
        } else {
          if (at > 0) { this.buf = this.buf.slice(this.enc.encode(text.slice(0, at)).length); text = text.slice(at); }
          echoSeen = true;
        }
      }
      const trimmed = text.replace(/[\s\0]+$/, '');
      if (echoSeen && (trimmed.endsWith(PROMPT) || terminators.some(t => trimmed.endsWith(t)))) {
        let more = true; while (more) more = await this._wait(settleMs);
        break;
      }
      const got = await this._wait(Math.max(10, timeoutMs - (performance.now() - last)));
      if (got) last = performance.now();
      else if (performance.now() - last >= timeoutMs) throw new Error(`no "${PROMPT}" prompt after "${cmd}" (${timeoutMs} ms)`);
    }
    const raw = this._text(this._take());
    const ms = performance.now() - t0;
    const body = ShellLink.strip(raw, cmd);
    if (this.onRx && !quiet) this.onRx(body, { ms, raw });
    return { body, raw, ms };
  }

  /** For commands known not to return a prompt (nvnapython: "save N" on the F V2). */
  async _commandNoPrompt(cmd, waitMs = 300) {
    await this._flush();
    if (this.onTx) this.onTx(cmd);
    await this._write(cmd + '\r\n');
    await new Promise(r => setTimeout(r, waitMs));
    const raw = this._text(this._take());
    const body = ShellLink.strip(raw, cmd);
    if (this.onRx) this.onRx(body, { ms: waitMs, raw });
    return { body, raw, ms: waitMs };
  }

  /**
   * Binary reply: skip the echo, read exactly n bytes, swallow the trailing prompt.
   * lengthPrefix (tinySA sd_read): the reply starts with that many bytes of
   * little-endian length, then the data; n is then ignored. A text reply in
   * that position ('err: (4) no file', 'sd_read?') is thrown as an Error.
   */
  async _commandBinary(cmd, n, { timeoutMs = 15000, quiet = false, lengthPrefix = 0 } = {}) {
    await this._flush();
    if (this.onTx && !quiet) this.onTx(`${cmd}  (binary, ${lengthPrefix ? 'length-prefixed' : n + ' bytes'})`);
    const t0 = performance.now();
    await this._write(cmd + '\r\n');
    const echo = this.enc.encode(cmd + '\r\n');
    let last = performance.now(), echoDone = false;
    for (;;) {
      if (!echoDone && this.buf.length >= echo.length) {
        let m = true;
        for (let i = 0; i < echo.length; i++) if (this.buf[i] !== echo[i]) { m = false; break; }
        if (m) { this.buf = this.buf.slice(echo.length); echoDone = true; }
      }
      if (echoDone && lengthPrefix && this.buf.length >= lengthPrefix) {
        const head = this._text(this.buf.slice(0, 64)).replace(/[\s\0]+$/, '');
        if (/^(err:|[a-z_]+\?)/i.test(head) && head.endsWith(PROMPT)) { this._take(); throw new Error(head.replace(/\s*ch>$/, '').trim()); }
        let len = 0; for (let i = lengthPrefix - 1; i >= 0; i--) len = len * 256 + this.buf[i];
        if (len > 64 * 1024 * 1024) { this._take(); throw new Error(`length prefix ${len} is not a file size`); }
        n = len; this.buf = this.buf.slice(lengthPrefix); lengthPrefix = 0;
      }
      if (echoDone && !lengthPrefix && this.buf.length >= n) {
        const payload = this.buf.slice(0, n);
        let more = true; while (more) more = await this._wait(60);
        this._take();
        const ms = performance.now() - t0;
        if (this.onRx && !quiet) this.onRx(`[${n} bytes]`, { ms, raw: '' });
        return { payload, ms };
      }
      const got = await this._wait(Math.max(10, timeoutMs - (performance.now() - last)));
      if (got) last = performance.now();
      else if (performance.now() - last >= timeoutMs) throw new Error(`binary read of ${n} bytes stalled at ${this.buf.length}`);
    }
  }

  static strip(raw, cmd) {
    const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length && lines[0].trim() === cmd.trim()) lines.shift();                       // echo
    while (lines.length && /^\s*(ch>)?\s*$/.test(lines[lines.length - 1])) lines.pop();        // prompts / blanks
    return lines.map(l => l.replace(/^ch>\s*/, '')).join('\n').replace(/\s*ch>\s*$/, '');
  }

  /** Transport info for diagnostics. */
  info() { return 'n/a'; }
  async open() {}
  async close() { this.closed = true; }
  async _write(_s) { throw new Error('ShellLink._write not implemented'); }
}

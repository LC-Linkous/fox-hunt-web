// cw.js — a Morse decoder for demodulated audio.
// SPDX-License-Identifier: GPL-2.0-only
//
// Goertzel at the tone pitch every 10 ms, an adaptive threshold between the
// running noise floor and the running peak, mark / space durations, and an
// element clock that follows the sender (the median of the short marks is a
// dit). Good enough for a fox's ID on FM; weak-signal HF CW is a different
// problem and not what this is for.
//
// feed(Float32Array) with raw samples at the sample rate given to the
// constructor. onText(char) fires per decoded character (' ' for a word
// gap). status() returns what the page shows: tone, WPM, level, threshold.

import { goertzel } from './fft.js';

export const MORSE = { '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z', '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9', '-..-.': '/', '..--..': '?', '-...-': '=', '.-.-.': '+', '--..--': ',', '.-.-.-': '.', '-.-.-.': ';', '---...': ':', '-....-': '-', '.--.-.': '@' };

export class CwDecoder {
  constructor({ sampleRate = 48000, toneHz = 800, autoTone = true, blockMs = 10 } = {}) {
    this.sr = sampleRate; this.toneHz = toneHz; this.autoTone = autoTone;
    this.block = Math.round(sampleRate * blockMs / 1000); this.blockMs = blockMs;
    this.buf = new Float32Array(0);
    this.onText = null;                  // (char) => void
    this.onElement = null;               // ('.'|'-'|' '|'/') => void, for a live display
    // detector state
    this.level = 0; this.floor = 0; this.peak = 0; this.floorDb = -120; this.peakDb = -120; this.on = false; this.blocks = 0;
    this.dit = 80;                       // ms; 15 wpm to start
    this.markMs = 0; this.spaceMs = 0; this.pendingMark = 0; this.symbol = ''; this.flushedChar = true; this.flushedWord = true;
    this.bank = []; for (let f = 400; f <= 1200; f += 50) this.bank.push(f);   // auto-tone search
    this.bankPow = new Float32Array(this.bank.length); this.bankAge = 0;
    this.text = '';
  }
  get wpm() { return 1200 / this.dit; }
  status() { return { toneHz: this.toneHz, wpm: this.wpm, level: 10 * Math.log10(this.level + 1e-12), floor: this.floorDb, peak: this.peakDb, on: this.on, text: this.text }; }
  reset() { this.text = ''; this.symbol = ''; this.markMs = this.spaceMs = this.pendingMark = 0; this.on = false; }

  feed(samples) {
    // append and process whole blocks
    const n = new Float32Array(this.buf.length + samples.length); n.set(this.buf); n.set(samples, this.buf.length); this.buf = n;
    let off = 0;
    while (off + this.block <= this.buf.length) { this._block(off); off += this.block; }
    this.buf = this.buf.slice(off);
  }

  _block(off) {
    // auto-tone: every 5 blocks look for the strongest pitch; move to it only if it is clearly louder
    if (this.autoTone && ++this.bankAge >= 5) {
      this.bankAge = 0; let bi = 0, bp = 0;
      for (let i = 0; i < this.bank.length; i++) { const p = goertzel(this.buf, off, this.block, this.sr, this.bank[i]); this.bankPow[i] = this.bankPow[i] * 0.7 + p * 0.3; if (this.bankPow[i] > bp) { bp = this.bankPow[i]; bi = i; } }
      if (bp > this.floor * 30 && Math.abs(this.bank[bi] - this.toneHz) > 60) { this.toneHz = this.bank[bi]; this.symbol = ''; this.markMs = 0; this.pendingMark = 0; }   // retuned mid-character: that character is lost, not misread
    }
    const p = goertzel(this.buf, off, this.block, this.sr, this.toneHz);
    const lvl = 10 * Math.log10(p + 1e-12);                             // dB; the 10 ms block is the integration
    this.level = p;
    // the first 200 ms only set the floor: no decoding until there is a floor to decode against
    if (++this.blocks <= 20) { this.floorDb = this.blocks === 1 ? lvl : Math.max(this.floorDb, lvl); this.peakDb = this.floorDb; this.floor = p; this.peak = p; return; }
    // floor: tracked between marks only, fast down / slow up; peak: fast up, slow decay (all in dB)
    if (!this.on) this.floorDb = lvl < this.floorDb ? this.floorDb * 0.85 + lvl * 0.15 : Math.min(this.floorDb + 0.3, lvl);
    this.peakDb = lvl > this.peakDb ? lvl : Math.max(this.peakDb - 0.1, this.floorDb + 6);
    this.floor = Math.pow(10, this.floorDb / 10); this.peak = Math.pow(10, this.peakDb / 10);
    const thr = (this.floorDb + this.peakDb) / 2;
    const on = (this.peakDb - this.floorDb) >= 12 && lvl > (this.on ? thr - 3 : thr + 3);   // ≥12 dB between floor and peak to decode at all; 6 dB hysteresis
    if (on === this.on) {
      if (on) this.markMs += this.blockMs;
      else { this.spaceMs += this.blockMs; this._commitMark(); this._spaces(); }
      return;
    }
    // transition
    if (on) {                                                            // space ended
      if (this.pendingMark) {                                            // a dropout inside a mark on FM: glue the two halves
        this.markMs = this.pendingMark + this.spaceMs + this.blockMs; this.pendingMark = 0; this.spaceMs = 0; this.on = true; return;
      }
      this._spaces(true); this.spaceMs = 0; this.markMs = this.blockMs; this.flushedChar = this.flushedWord = false;
    } else {                                                             // mark ended: hold it until the space is long enough to be real
      this.pendingMark = this.markMs; this.markMs = 0; this.spaceMs = this.blockMs;
    }
    this.on = on;
  }
  /** A held mark becomes an element once the space after it has lasted longer than a dropout (0.3 dit, at least 2 blocks). */
  _commitMark() {
    if (!this.pendingMark || this.spaceMs < Math.max(this.blockMs * 2, this.dit * 0.3)) return;
    const markMs = this.pendingMark; this.pendingMark = 0;
    if (markMs >= Math.max(this.blockMs * 2, this.dit * 0.4)) {          // shorter than that is a noise spike, not an element
      const isDit = markMs < this.dit * 2;
      this.symbol += isDit ? '.' : '-'; this.onElement?.(isDit ? '.' : '-');
      if (this.symbol.length > 8) { this.symbol = ''; this.onElement?.('×'); }   // nothing in Morse is that long: noise, dropped
      // follow the sender: a plausible dit (0.5–1.6 dits) or dah (2–4.5 dits) pulls the clock
      const r = markMs / this.dit;
      if ((r > 0.4 && r < 1.6) || (r > 2 && r < 4.5)) this.dit = Math.max(30, Math.min(300, this.dit * 0.75 + (isDit ? markMs : markMs / 3) * 0.25));
    }
  }
  /** Character and word gaps are decided while the space is still running, so text appears without waiting for the next mark. */
  _spaces(ending = false) {
    if (this.on) return;
    if (!this.flushedChar && this.spaceMs >= this.dit * 2.5 && this.symbol) {
      const ch = MORSE[this.symbol] || '¿'; this.symbol = ''; this.flushedChar = true;
      this.text += ch; this.onText?.(ch); this.onElement?.(' ');
    }
    if (!this.flushedWord && this.spaceMs >= this.dit * 6) {
      this.flushedWord = true; if (this.text && !this.text.endsWith(' ')) { this.text += ' '; this.onText?.(' '); this.onElement?.('/'); }
    }
  }
}

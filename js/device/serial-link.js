// serial-link.js — Web Serial transport for ShellLink.
// SPDX-License-Identifier: GPL-2.0-only
//
// Identical to tinysa-web's serial-link.js except for USB_FILTER: the fox's
// XIAO ESP32-C3 enumerates as Espressif's USB-Serial/JTAG device, not an
// STM32 virtual COM port. Identification is still by reply (fox.js identify()).
import { ShellLink } from './shell-link.js';

// Espressif USB-Serial/JTAG (ESP32-C3 / S3 / C6). Narrows the chooser only.
export const USB_FILTER = [{ usbVendorId: 0x303a, usbProductId: 0x1001 }];

export const hasWebSerial = () => 'serial' in navigator;

export class SerialLink extends ShellLink {
  constructor() { super(); this.port = null; this.reader = null; this.writer = null; this.onDrop = null; }

  async open() {
    this.port = await navigator.serial.requestPort({ filters: USB_FILTER });
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this._readLoop();
  }
  async _readLoop() {
    try {
      this.reader = this.port.readable.getReader();
      for (;;) { const { value, done } = await this.reader.read(); if (done) break; this._feed(value); }
    } catch (e) {
      if (!this.closed && this.onDrop) this.onDrop(e);
    }
  }
  _write(s) { return this.writer.write(this.enc.encode(s)); }
  /** Fire-and-forget write for page unload (no await possible). */
  writeSync(s) { try { this.writer.write(this.enc.encode(s)); } catch {} }
  info() {
    try { const i = this.port.getInfo(); return `usb ${i.usbVendorId?.toString(16)}:${i.usbProductId?.toString(16)}`; } catch { return 'n/a'; }
  }
  async close() {
    this.closed = true;
    try { if (this.reader) { await this.reader.cancel(); this.reader.releaseLock(); } } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}

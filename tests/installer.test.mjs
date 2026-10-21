// The REPL installer against a simulated CircuitPython raw REPL.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ShellLink } from '../js/device/shell-link.js';
import { installCodePy, probeRepl, configureFirmware, firmwareVersion } from '../js/device/installer.js';

/** Enough of CircuitPython's REPL to install a file: Ctrl+C/A/B/D, raw-mode exec of the statements the installer sends. */
class FakeRepl extends ShellLink {
  constructor() { super(); this.mode = 'running'; this.code = ''; this.files = new Map(); this.open = null; this.writes = []; }
  _out(s) { this._feed(this.enc.encode(s)); }
  async _write(s) {
    for (const ch of s) {
      // the real board: Ctrl+C stops code.py and prints "Press any key to enter the REPL"; the REPL prompt only comes after another byte
      if (ch === '\x03') { if (this.mode === 'running') { this.mode = 'pressany'; this._out('\r\nKeyboardInterrupt\r\n\r\nCode done running.\r\n\r\nPress any key to enter the REPL. Use CTRL-D to reload.\r\n'); } continue; }
      if (this.mode === 'pressany') { this.mode = 'repl'; this._out('\r\nAdafruit CircuitPython 9.2.0 on 2024-10-28; Seeed Studio XIAO ESP32C3 with ESP32-C3\r\n>>> '); if (ch === '\n' || ch === '\r') continue; }
      if (ch === '\x01') { this.mode = 'raw'; this.code = ''; this._out('\r\nraw REPL; CTRL-B to exit\r\n>'); continue; }
      if (ch === '\x02') { this.mode = 'repl'; this._out('\r\n>>> '); continue; }
      if (ch === '\x04') {
        if (this.mode === 'raw') { this._out('OK' + this._exec(this.code) + '\x04\x04>'); this.code = ''; }
        else if (this.mode === 'repl') { this.mode = 'running'; const f = this.files.get('code.py') || ''; this._out('soft reboot\r\n' + (/FW_NAME = "foxhunt"/.test(f) ? `\r\nfoxhunt ${firmwareVersion(f)} xiao-esp32c3 sa868-unset\r\nreceive only\r\nch> ` : 'Hello from some other code.py\r\n')); }
        continue;
      }
      if (this.mode === 'raw') this.code += ch;
      else if (this.mode === 'repl' && ch === '\n') this._out('>>> ');
    }
  }
  _exec(code) {
    let m;
    if ((m = /^f = open\("([^"]+)", 'w'\)$/.exec(code))) { this.open = m[1]; this.files.set(m[1], ''); return ''; }
    if ((m = /^f\.write\(("(?:[^"\\]|\\.)*")\)$/.exec(code))) { this.files.set(this.open, this.files.get(this.open) + JSON.parse(m[1])); this.writes++; return ''; }
    if (code === 'f.close()') { this.open = null; return ''; }
    if (/os\.rename\("code\.py\.new", "code\.py"\)/.test(code)) { this.files.set('code.py', this.files.get('code.py.new')); this.files.delete('code.py.new'); return `\r\n${this.files.get('code.py').length}\r\n`; }
    if (/sys\.implementation/.test(code)) return '\r\ncircuitpython (10, 0, 0) espressif\r\n';
    return '\r\nTraceback (most recent call last):\r\n  File "<stdin>", line 1\r\nNameError: name \'x\' is not defined\r\n';
  }
}

const FIRMWARE = readFileSync(new URL('../firmware/code.py', import.meta.url), 'utf8');

test('configureFirmware flips exactly the TX gate', () => {
  assert.match(FIRMWARE, /^TX_ENABLED = False$/m);
  const on = configureFirmware(FIRMWARE, { txEnabled: true });
  assert.match(on, /^TX_ENABLED = True$/m); assert.equal(on.length, FIRMWARE.length + 'True'.length - 'False'.length);
  assert.equal(configureFirmware(on, { txEnabled: false }), FIRMWARE);
  assert.throws(() => configureFirmware('print(1)\n'));
  assert.equal(firmwareVersion(FIRMWARE), '0.5.0');
  assert.ok(![...FIRMWARE].some(c => c.charCodeAt(0) > 127), 'firmware must be ASCII so JSON literals are valid Python');
});

test('probeRepl reports the implementation', async () => {
  const link = new FakeRepl();
  assert.equal(await probeRepl(link), 'circuitpython (10, 0, 0) espressif');
});

test('installCodePy writes the whole file in chunks, renames it into place, and sees the new banner', async () => {
  const link = new FakeRepl(); const steps = [];
  const r = await installCodePy(link, FIRMWARE, { onProgress: p => steps.push(p.step), chunk: 500 });
  assert.equal(link.files.get('code.py'), FIRMWARE);
  assert.ok(!link.files.has('code.py.new'));
  assert.ok(link.writes >= Math.ceil(FIRMWARE.length / 500));
  assert.equal(r.version, 'foxhunt 0.5.0 xiao-esp32c3 sa868-unset');
  assert.deepEqual([...new Set(steps)], ['interrupt', 'raw-repl', 'write', 'reboot', 'done']);
});

test('installCodePy reports a firmware that boots but never prompts', async () => {
  const link = new FakeRepl();
  await assert.rejects(installCodePy(link, 'print("hi")\n', { bannerTimeoutMs: 400 }), /did not print its prompt/);
  assert.equal(link.files.get('code.py'), 'print("hi")\n');
});

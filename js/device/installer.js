// installer.js — write code.py to a CircuitPython board through its REPL, over the same serial port.
// SPDX-License-Identifier: GPL-2.0-only
//
// The XIAO ESP32-C3 has no USB drive, so there is nothing to drag a file
// onto; Thonny saves files by talking to the REPL, and so does this. The
// sequence is MicroPython/CircuitPython's raw REPL:
//
//   Ctrl+C Ctrl+C   interrupt whatever is running  → ">>>"
//   Ctrl+A          raw REPL                        → "raw REPL; CTRL-B to exit\r\n>"
//   <python> Ctrl+D execute                          → "OK" … "\x04>"
//   Ctrl+B          back to the normal REPL
//   Ctrl+D          soft reboot: code.py runs
//
// The file goes over in chunks as Python string literals (JSON string
// syntax is valid Python for ASCII text). Works on the ShellLink's raw
// buffer, not its "ch>" command path, because the REPL has no "ch>".

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait until the link's raw buffer contains `needle` (string) or `timeoutMs` passes. Returns the buffer text. */
async function waitFor(link, needle, timeoutMs, { from = 0 } = {}) {
  const t0 = performance.now();
  for (;;) {
    const text = link._text(link.buf);
    if (text.indexOf(needle, from) !== -1) return text;
    const left = timeoutMs - (performance.now() - t0);
    if (left <= 0) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; last output: ${JSON.stringify(text.slice(-120))}`);
    await link._wait(Math.min(250, left));
  }
}
const clear = link => link._take();

/** Can the page talk to a REPL here at all? Interrupts, enters raw mode, runs one expression, leaves. Returns the board's sys.implementation string. */
export async function probeRepl(link) {
  clear(link);
  await link._write('\x03\x03'); await sleep(200); clear(link);
  await link._write('\x01');
  await waitFor(link, 'raw REPL', 3000); clear(link);
  await link._write('import sys\nprint(sys.implementation.name, sys.implementation.version, sys.platform)\n\x04');
  const out = await waitFor(link, '\x04>', 3000);
  await link._write('\x02'); await sleep(100); clear(link);
  const m = /OK([^\x04]*)\x04/.exec(out);
  return m ? m[1].trim() : out.trim();
}

/**
 * Install `text` as code.py and reboot into it. onProgress({ step, pct, note }).
 * Resolves when the new firmware's banner (its "ch>" prompt) has been seen,
 * or throws with where it got stuck. The link stays open either way.
 */
export async function installCodePy(link, text, { onProgress = () => {}, fileName = 'code.py', chunk = 768, bannerTimeoutMs = 15000 } = {}) {
  const prog = (step, pct, note = '') => onProgress({ step, pct, note });
  // 1. interrupt and reach the REPL
  prog('interrupt', 2, 'stopping the running program');
  clear(link);
  await link._write('\x03'); await sleep(150); await link._write('\x03'); await sleep(250);
  await link._write('\r\n'); await waitFor(link, '>>>', 4000).catch(() => { throw new Error('no CircuitPython REPL answered: is CircuitPython on the board? (see the README, "Firmware", step 2)'); });
  clear(link);
  // 2. raw REPL
  prog('raw-repl', 5, 'entering raw REPL');
  await link._write('\x01');
  await waitFor(link, 'raw REPL', 3000); clear(link);
  const exec = async (code, what, timeoutMs = 5000) => {
    clear(link);
    await link._write(code + '\x04');
    const out = await waitFor(link, '\x04>', timeoutMs);
    if (!/OK/.test(out)) throw new Error(`${what}: the REPL did not acknowledge`);
    const err = /OK[^\x04]*\x04([^\x04]*)\x04>/.exec(out);
    if (err && err[1].trim()) throw new Error(`${what}: ${err[1].trim().split('\n').pop()}`);
    return out;
  };
  // 3. write the file in chunks; the old file is replaced only once the new one is complete
  const tmp = fileName + '.new';
  await exec(`f = open(${JSON.stringify(tmp)}, 'w')`, 'open for writing');
  const n = Math.ceil(text.length / chunk);
  for (let i = 0; i < n; i++) {
    const part = text.slice(i * chunk, (i + 1) * chunk);
    await exec(`f.write(${JSON.stringify(part)})`, `writing chunk ${i + 1}/${n}`);
    prog('write', 8 + 80 * (i + 1) / n, `writing ${fileName}: ${Math.round(100 * (i + 1) / n)}%`);
  }
  await exec('f.close()', 'closing');
  await exec(`import os\ntry:\n    os.remove(${JSON.stringify(fileName)})\nexcept OSError:\n    pass\nos.rename(${JSON.stringify(tmp)}, ${JSON.stringify(fileName)})\nprint(os.stat(${JSON.stringify(fileName)})[6])`, 'renaming into place');
  // 4. back to the normal REPL and soft reboot
  prog('reboot', 92, 'rebooting into the new firmware');
  await link._write('\x02'); await sleep(150); clear(link);
  await link._write('\x04');
  const banner = await waitFor(link, 'ch> ', bannerTimeoutMs).catch(() => {
    // show what the board did say: a traceback from code.py is the usual reason
    const said = link._text(link.buf).replace(/\r/g, '').trim();
    const e = new Error('the board rebooted but the firmware did not print its prompt' + (said ? '. It printed:\n' + said.slice(-1200) : ' and printed nothing (is this a CircuitPython board? try Thonny once to see what it says at boot)'));
    e.boardOutput = said; throw e;
  });
  const version = /(fox\w+ \d+\.\d+\.\d+ [^\r\n]+)/.exec(banner);
  await sleep(200); clear(link);
  prog('done', 100, version ? version[1] : 'running');
  return { version: version ? version[1] : null };
}

/** The shipped firmware text with the TX gate set as asked. Throws if the line is not where expected, so a stale page cannot silently ship the wrong gate. */
export function configureFirmware(text, { txEnabled = false } = {}) {
  const re = /^TX_ENABLED = (True|False)$/m;
  if (!re.test(text)) throw new Error('firmware text has no TX_ENABLED line');
  return text.replace(re, `TX_ENABLED = ${txEnabled ? 'True' : 'False'}`);
}
export function firmwareVersion(text) { const m = /^FW_VERSION = "([^"]+)"/m.exec(text); return m ? m[1] : null; }

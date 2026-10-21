// ShellLink framing on its own: prompts split across chunks, stale replies, the echo rule, timeouts.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellLink } from '../js/device/shell-link.js';

/** A link whose "device" is a script: for each written command, the chunks to feed back and when. */
class ScriptLink extends ShellLink {
  constructor(script) { super(); this.script = script; this.written = []; }
  async open() {}
  async close() { this.closed = true; }
  _write(s) {
    this.written.push(s);
    const plan = this.script[s.trim()] || [];
    for (const [delay, text] of plan) setTimeout(() => this._feed(this.enc.encode(text)), delay);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a reply whose prompt is split across chunks is assembled, and the doubled prompt is drained', async () => {
  const l = new ScriptLink({ version: [[5, 'version\r\nfoxhunt 0.5.0 xiao-esp32c3 sa868-vhf\r\nc'], [20, 'h> '], [40, '\r\nch> ']] });
  const r = await l.command('version', { requireEcho: true, settleMs: 60 });
  assert.equal(r.body.trim(), 'foxhunt 0.5.0 xiao-esp32c3 sa868-vhf');
  assert.equal(l.buf.length, 0, 'nothing left over after the settle');
});

test('a late reply to a timed-out command is discarded, not returned as the next answer', async () => {
  const l = new ScriptLink({ slow: [[300, 'slow\r\n42\r\nch> ']], fast: [[5, 'fast\r\n7\r\nch> ']] });
  await assert.rejects(() => l.command('slow', { requireEcho: true, timeoutMs: 60 }), /no "ch>" prompt/);
  await sleep(300);                                   // the stale "slow" reply has now arrived
  const r = await l.command('fast', { requireEcho: true });
  assert.equal(r.body.trim(), '7');
});

test('the echo must be a whole line: "sq" is not found inside a stale "squelch: 3"', async () => {
  const l = new ScriptLink({ sq: [[5, 'squelch: 3\r\nch> '], [30, 'sq\r\nquiet\r\nch> ']] });
  const r = await l.command('sq', { requireEcho: true, settleMs: 20 });
  assert.equal(r.body.trim(), 'quiet');
});

test('commands serialize: a poll fired mid-command waits its turn', async () => {
  const l = new ScriptLink({ a: [[80, 'a\r\nA\r\nch> ']], b: [[5, 'b\r\nB\r\nch> ']] });
  const pa = l.command('a', { requireEcho: true }); const pb = l.command('b', { requireEcho: true });
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(ra.body.trim(), 'A'); assert.equal(rb.body.trim(), 'B');
  assert.deepEqual(l.written.map(w => w.trim()), ['a', 'b']);
});

test('strip() removes echo and prompts and keeps multi-line bodies', () => {
  assert.equal(ShellLink.strip('info\r\nfirmware: foxhunt\r\nboard: x\r\nch> \r\nch> ', 'info').trim().split('\n').length, 2);
});

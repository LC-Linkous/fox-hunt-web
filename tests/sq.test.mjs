// The SQ wire through the device layer: demo link simulates it, Fox parses it.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoLink } from '../js/device/demo-link.js';
import { Fox, DeviceError } from '../js/device/fox.js';

test('sq/events: refused until declared, then edges arrive in fox ticks', async () => {
  const link = new DemoLink({ band: 'vhf' }); const fox = new Fox(link); await fox.identify();
  assert.equal(await fox.sq(), 'off'); assert.equal(fox.state.sqWire, false);
  await assert.rejects(() => fox.events(), DeviceError);
  assert.equal(await fox.sq(true), 'on'); assert.equal(fox.state.sqWire, true);
  await fox.tune(146.565);
  // rewind the simulated wire's "since" so a few keying cycles have happened
  link.sqSince = Date.now() - 100_000;
  const ev = await fox.events();
  assert.ok(ev.now > 0); assert.equal(typeof ev.carrier, 'boolean');
  assert.ok(ev.edges.length >= 4, `edges ${ev.edges.length}`);
  for (let i = 1; i < ev.edges.length; i++) { assert.ok(ev.edges[i].ms > ev.edges[i - 1].ms); assert.notEqual(ev.edges[i].on, ev.edges[i - 1].on); }
  const ons = ev.edges.filter(e => e.on).map(e => e.ms), offs = ev.edges.filter(e => !e.on).map(e => e.ms);
  if (ons.length >= 2) assert.ok(Math.abs((ons[1] - ons[0]) - 40000) <= 100, `period ${ons[1] - ons[0]}`);
  const kv = await fox.info(); assert.match(kv.sq, /^on/); assert.equal(fox.state.sqWire, true);
  // drained: a second call has no edges (or at most one fresh one)
  const ev2 = await fox.events(); assert.ok(ev2.edges.length <= 1);
  assert.equal(await fox.sq(false), 'off'); assert.equal(fox.state.sqCarrier, null);
  await link.close();
});

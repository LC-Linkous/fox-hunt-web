// Bench pair in simulation: a second fox's transmitter is heard by the first.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoLink } from '../js/device/demo-link.js';
import { Fox } from '../js/device/fox.js';

test('a paired simulated beacon pins the receiver on its channel while keyed, and only then', async () => {
  const A = new Fox(new DemoLink({ band: 'vhf' })), B = new Fox(new DemoLink({ band: 'vhf', txEnabled: true, callsign: 'W1AW' }));
  await A.identify(); await B.identify();
  await A.tune(146.6); await B.tune(146.6);           // away from the demo's own foxes
  const quiet = await A.rssi(); assert.ok(quiet.rssi < 60, `quiet ${quiet.rssi}`);
  await B.arm(); await B.keyOn(2);
  const loud = await A.rssi(); assert.ok(loud.rssi > 200, `keyed ${loud.rssi}`);
  await B.tune(146.65);                                 // 50 kHz away: out of the receiver's passband
  const off = await A.rssi(); assert.ok(off.rssi < 60, `off-channel ${off.rssi}`);
  await B.rx();
  await B.tune(146.6); const after = await A.rssi(); assert.ok(after.rssi < 60, `unkeyed ${after.rssi}`);
  await A.link.close(); await B.link.close();
  // closed links leave the air
  const C = new Fox(new DemoLink({ band: 'vhf' })); await C.identify(); await C.tune(146.6);
  assert.ok((await C.rssi()).rssi < 60);
  await C.link.close();
});

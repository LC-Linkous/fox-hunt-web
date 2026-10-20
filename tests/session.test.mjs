// Session save / parse round trip and the replay controller, plus the recorder's location columns.
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../js/ui/recorder.js';
import { sessionBlob, parseSession, createReplay } from '../js/ui/session.js';

function sampleRecorder() {
  const rec = createRecorder(); rec.start();
  rec.addBurst({ t0: 1000, ms: Float32Array.from([0, 100, 200]), rssi: Int16Array.from([30, 31, 200]), f: 146.565, n: 3 }, { lat: 37.54, lon: -77.43, acc: 8, atten_db: 10 });
  rec.addScan({ t: 1500, start: 146.4, stop: 146.45, stepKHz: 25, f: Float64Array.from([146.4, 146.425, 146.45]), rssi: Int16Array.from([28, 90, 31]), n: 3 }, null);
  rec.addReading({ t: 2000, f: 146.565, rssi: 40 }, null);
  return rec;
}

test('session: blob → parse keeps records, stamps and meta', async () => {
  const rec = sampleRecorder();
  const text = await sessionBlob(rec, { app: '0.4.0', device: 'foxhunt 0.3.0 xiao-esp32c3 sa868-dual', band: 'dual', settings: { attenDb: 10 } }).text();
  const s = parseSession(text);
  assert.equal(s.readings.length, 4); assert.equal(s.scans.length, 1);
  assert.equal(s.readings[0].lat, 37.54); assert.equal(s.readings[0].acc, 8); assert.equal(s.readings[3].lat, undefined);
  assert.equal(s.scans[0].f[1], 146.425); assert.ok(s.scans[0].rssi instanceof Int16Array);
  assert.equal(s.meta.band, 'dual'); assert.equal(s.meta.settings.attenDb, 10);
  assert.throws(() => parseSession('{"tool":"tinysa-web"}'));
});

test('recorder: CSV has the location columns, empty when unstamped', () => {
  const rec = sampleRecorder();
  const csv = rec.readingsCsv();
  assert.ok(csv.size > 0);
  return csv.text().then(t => {
    const lines = t.trim().split('\n');
    assert.equal(lines[0], 'timestamp_iso,t_ms,frequency_mhz,rssi,lat,lon,accuracy_m');
    assert.ok(lines[1].endsWith(',146.5650,30,37.54,-77.43,8'), lines[1]);
    assert.ok(lines[4].endsWith(',146.5650,40,,,'), lines[4]);
  });
});

test('replay: events in time order, seek and feed', () => {
  const rec = sampleRecorder();
  const rp = createReplay(); const seen = [];
  rp.onEvent = ev => seen.push(`${ev.kind}@${ev.t}`);
  assert.equal(rp.load(rec.readings, rec.scans), 5);
  assert.equal(rp.start(), 1000); assert.equal(rp.end(), 2000);
  rp.feedTo(3);
  assert.deepEqual(seen, ['reading@1000', 'reading@1100', 'reading@1200']);
  rp.feedTo(5);
  assert.deepEqual(seen.slice(3), ['scan@1500', 'reading@2000']);
  assert.equal(rp.playing, false);
  rec.load(parseSession(JSON.stringify({ tool: 'fox-hunt-web', kind: 'session', readings: rec.readings, scans: rec.scans })));
  assert.equal(rec.readings.length, 4);
});

# Changelog

## v0.6.0 — bearing

- **Bearing capture**: hold, turn, release; 5° bins, lobe centre by
  parabolic interpolation, width at half-way between floor and peak,
  coverage and quality; partial-circle and broad-lobe notes.
- **Heading source**: device compass (`deviceorientationabsolute` on
  Android, `webkitCompassHeading` on iOS after permission) with a manual
  slider fallback and *Mark north*; a heading history so each reading is
  tagged with the heading at its own time; short RSSI bursts while
  capturing.
- **Polar plot** in the Channels window (Bearing tab) and the Hunt panel;
  several captures overlaid, the active one solid, the needle for the
  current heading.
- **Fix** from the last two located captures (flat-earth intersection,
  rejects near-parallel or diverging bearings), with Copy.
- Captures saved in the session. The simulated fox carries a bearing and a
  yagi pattern so the bench demo produces one.
- Tests: 5 bearing tests (34 total).

## v0.5.0 — the hunt

- **Hunt mode** (Bench / Hunt switch): one column, huge RSSI and countdown,
  Start / Seek / Skip / Lock / Pin, attenuator, plot, board, last Morse.
- **Autoseek** over the scan channel list with per-channel floors, margin,
  dwell limit, Skip and Lock; pins what it stops on.
- **Fox cycle timing** with a countdown to the next burst; a burst in
  progress at start is not an onset; "settling" until four bursts.
- **CW identification** pins and labels the tuned channel from a decoded
  callsign.
- **Hunt board** with per-fox last heard, max, cycle, sparkline; saved in
  the session.
- `js/hunt.js` is pure logic; `tests/hunt.test.mjs` drives it with a
  synthetic 12 s / 40 s fox (29 tests total).

## v0.4.1 — renamed to fox-hunt-web

- The project was `fox-demo-web` until here. Firmware reports `foxhunt`
  (0.3.1); the page still accepts `foxdemo`, loads `fox-demo-web` session
  files, and migrates settings from the old key. The repo, Pages URL and
  firmware download path change with the name.

## v0.4.0 — see over time

- **Scan waterfall** (channel × time, one row per scan, tinysa-web palettes)
  as a second view of the Channels window; click a cell to tune. **Heat
  strip** under the signal-strength plot.
- **Sessions**: Save session (readings, scans, settings, fox identity) and
  Load session with replay — scrub bar, play/pause, 1–30×, REPLAY badge,
  Live to return. Readings carry the frequency for the replay readout.
- **Location stamps**: off by default, GPS badge, accuracy and fix age shown,
  stale fixes not used; `lat,lon,accuracy_m` columns in both CSVs and the
  session.
- **Attenuator bookkeeping**: presets and custom dB, logged as `atten_db`,
  marked on the plot, never applied to the byte.
- **Audio transparency**: permission state, requested vs granted processing
  with anything left on flagged in red, and a plain statement of what is
  kept.
- **About page** with the platform table; the no-serial banner names the
  platforms (Android Chrome yes, iOS no).
- Tests: 3 session/replay/recorder tests (24 total).

## v0.3.0 — transmit (gated) and audio decoding

- **Firmware:** `TX_ENABLED` flag (shipped `False`); with it on, `tx
  arm|disarm|on|off`, `tone`, `morse`, `power`, `wpm`, `foxmsg`, `foxdelay`,
  `fox start|stop` behind the callsign gate and per-session arming, every
  key-down with a deadline enforced by the main loop, Morse abortable by any
  serial byte. `rx` stops the beacon. `info` reports the TX state.
- **Page:** Transmit section (hidden when the firmware says `tx: disabled`):
  arm, hold-to-key, test tone, Morse with air-time estimate, beacon
  start/stop, power, WPM, TX badge; receiver and scan pause while on the air.
- **Audio:** sound-card capture via AudioWorklet (AGC/EC/NS off); CW decoder
  (Goertzel, dB-domain floor/peak tracking, adaptive element clock,
  auto-pitch); SSTV decoder for Martin M1/M2, Scottie S1/S2, Robot36 with VIS
  detection and per-line sync tracking, plus the matching encoder; Audio
  window with passband / CW text / picture views; save text and PNG.
- Simulated fox gains a transmitter (1/10 real time) for the demo and tests.
- Tests: 21 device-layer, 7 audio (synthesized Morse in noise; SSTV round
  trips in three modes). Google Fonts dropped: system fonts.

## v0.2.0 — any SA868 band, one firmware

- **Module band is a setting.** `band vhf|uhf|dual` on the firmware, kept in
  the ESP32's NVM; the page's *Module* dropdown reads and writes it. One
  `code.py` for every fox. `tune` and `scan` are refused until it is set.
- **Callsign** stored the same way (`callsign`), ahead of the TX-capable build.
- **Page:** Receiver (tune, presets, bw / squelch / volume, live RSSI at
  ~10 Hz with max hold), Scan (channel list, click a bar to tune, continuous),
  Recording (readings and scans, CSV / JSON), Export (PNG, scan CSV), Fox
  configuration, Settings, the console with log download.
- **Simulated fox** with three signals for the demo and the tests.
- Tests: 10 device-layer tests over the simulated fox's byte stream.
- GitHub Pages deploy; the firmware is served from the page's footer.

## v0.1.0 — receive-only bridge (as fox-rx-web)

- Firmware: `ch>` console, SA868 over UART, `tune`, `rssi [n]`, `scan`,
  `squelch`, `bw`, `volume`, `at`; PTT held high. Dual-band only.
- Device layer: `fox.js`, `models.js`; `PROTOCOL.md`.

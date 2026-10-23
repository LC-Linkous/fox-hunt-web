# Changelog

## v0.11.0 — listen, session completeness, scan the event, release workflow

- **Listen**: the captured audio to this device's speaker or headphones —
  a level slider in Audio and a Listen button on the hunt page. Makes the
  sound-card setup audible on a phone without juggling headphones.
- **Hunt page**: a one-line key for the Start / Seek / Skip / Lock / Pin
  row; the status line no longer repeats the guide; the top bar on a phone
  drops the "Module" label; the simulation button reads "Leave the
  simulation".
- **Sessions** carry carrier edges (SQ wire or quieting), and on load the
  event channels merge into this device's list, the wiring settings come
  across, and the edges rebuild the board's cycle trackers so the
  countdown returns with the session.
- **Scan the event** (Scan & seek): one scan from the lowest event channel
  to the highest in the receiver's band, at the chosen step.
- About: the platform table has audio-in / audio-out columns and the three
  layouts; Pins: the four-pin header proposal (GND, AF_OUT, MIC_IN, 3V3)
  that makes the sound card, an earpiece or a small speaker a plug-in.
- **Release workflow**: a `vX.Y.Z` tag publishes a GitHub release with
  `code.py` and a zip attached and the changelog section as notes.
- The page kit is this project's own now; the byte-identical rule with
  tinysa-web is dropped (tinysa-web v0.5.1 took the `data-app` and echo
  fixes so the tools keep separate state on one origin).
- Tests: session edges/channels/wiring; page tests for Listen and Scan the
  event. 50 node + 26 firmware + 15 page.

## v0.10.1 — hunt guide, wires, small fixes

- **Hunt page**: a "what now" line at the top that follows the state — connect,
  start on the channel, listening for the first burst, FOX IS ON (walk /
  swing / capture), the gap countdown, coming up — and a "?" that opens a
  six-step how-a-hunt-goes.
- **Setup → Wires on this fox**: SQ (firmware), AF_OUT → sound card, sound
  card → MIC_IN. The page shows the matching features: SSTV transmit only
  with the MIC_IN wire; noise quieting drives the countdown only when the
  audio is this fox's own. Audio from any other radio still decodes.
- README: which wire does what, the no-soldering setup (stock fox + a
  handheld's headphone jack into the sound card), phones without a jack
  (OTG hub + USB sound card).
- Event channels: the add row is prefilled and adds on the first click; the
  empty-list note wraps; labels say "Fox", not an event name.
- About: affiliation line corrected.

## v0.10.0 — SSTV transmit, Setup page, noise quieting

- **Firmware 0.5.0**: `mic pwm|line` — in line mode D1 floats while keyed
  so a sound card on the MIC_IN pad is the modulation; `tx on` cap raised to
  120 s for a Martin M1 frame; `tone`/`morse`/`fox start` refused in line
  mode.
- **SSTV transmit** (Transmit → Send a picture): image file, mode, output
  device, preview; `mic line` → key for the frame → play → unkey → `mic
  pwm`; Preview tones without keying; Stop at any point, including during
  the PTT lead.
- **Setup page**: a third top-level mode beside Bench and Hunt. Event
  channels (label + MHz; feed the Receiver presets, scan presets, autoseek
  — "Step the event channels" — and a one-click set of board pins;
  export/import JSON), this fox's stored settings, this page's settings,
  with the firmware installer below. The sidebar is six sections.
- **Noise quieting** (Audio): the 2.5–4 kHz hiss against a slow reference
  as a carrier detector with hysteresis; feeds the burst countdown when no
  SQ wire is declared ("· quieting" in the hunt panel).
- Scan step choices come from the model (12.5/25/50/100 kHz).
- Tests: firmware simulator models the SA868's reply latency; FakeRepl
  models CircuitPython's "Press any key to enter the REPL"; page tests add
  an Android (Pixel 7) touch profile, the Setup page, SSTV transmit, and
  the audio path end to end with Chromium's fake microphone fed by our own
  encoders (CW "W1AW" decoded, a Robot36 frame drawn); `quieting.test.mjs`.
  49 node + 26 firmware + 15 page.

## v0.9.0 — audit, simulated hardware, pins

A critical review of the page and the firmware, with two new test layers
that would have caught what it found.

- **Firmware 0.4.0 fixes** (all in the TX build unless noted):
  - `tone_off()` re-claimed D1 on every unkey (`ValueError: D1 in use`);
    the key-down deadline path would have crashed `code.py` with PTT low.
    `unkey()` now releases PTT first, whatever else fails. `rx` on the
    receive-only build returned that error too.
  - The beacon aborted at its first Morse element on any serial byte — and
    the page polls `tx`/`fox` once a second. A beacon cycle is now a state
    machine stepped from the main loop: the shell answers during a cycle,
    and `fox stop`/`tx off`/`tx disarm`/`rx` end it at the next element.
    `morse` and `tone` stay blocking (the page never sends during them).
  - The page's `\r\n` left the `\n` queued, which `rssi N`, `scan` and
    Morse read as "stop" (receive-only build too: `rssi 10` gave one line).
  - The SQ wire was sampled only between commands; it is now sampled inside
    every wait, so an edge during an `rssi 10` burst is stamped on time.
  - `supervisor.ticks_ms()` wraps after 6.2 days; `ms()` no longer does.
  - `tune`/`scan`/`band` refuse while keyed. `info` retries the SA868
    handshake if it failed at boot. `power` is refused in the RX build.
- **Page fixes**: "Pin strongest" never enabled after a scan; a stale Module
  dropdown could rewrite a different fox's stored band (now only a fox with
  no band is written); a failed connect left a half-connected state; stop
  then start could leave two receiver/scan/seek loops running (generation
  counters); an armed or beaconing fox found at connect is now polled and
  the receiver says why it waits; TX stops a seek; scan and tune refuse while
  keyed; the 1 Hz TX poll no longer overwrites a field being typed in; a
  pinned channel's cycle tracker was fed twice per reading; error loops give
  up after five failures; the installer drains the link first and recovers a
  board left in the raw REPL; identify tolerates the boot banner landing on
  the first command; `pagehide` sends `rx` when keyed; a custom attenuator
  shows in Hunt mode; the firmware section is hidden in Hunt mode.
- **Service worker**: network first with a 4 s budget, cache as the
  fallback, one versioned set — no more mixed old/new modules after a
  deploy, and the installer never flashes a cached previous release.
- **Sidebar regrouped** into seven sections in hunt order: Receiver, Scan &
  seek, Hunt (bearing + board), Audio, Session (recording, location, replay,
  pictures/CSV), Transmit (this fox + a second fox as beacon), Setup (this
  fox + this page). Same controls, same ids.
- **Pins page** (`pins.html`): the XIAO ESP32-C3 and SA868 pin maps as the
  fox uses them, where the AF_OUT and SQ wires go and why D2, how to check
  the wire, the H/L datasheet discrepancy.
- **Tests**: `tests/firmware/` runs the real `code.py` on simulated
  CircuitPython with a simulated SA868 (25 tests, ~10 s); `tests/page/`
  drives the page in headless Chromium against the simulated fox (12
  flows); `tests/shell-link.test.mjs` covers framing; DemoLink can simulate
  a chip reset on open and refuses `power` in the RX build like the
  firmware. CI runs all three layers. 47 node + 25 firmware + 12 page.
- Shared kit (port to tinysa-web/nanovna-web): `<html data-app>` scopes
  localStorage keys and the console download name per tool; ShellLink
  matches the echo as a whole line, not a substring.
- Docs corrected to match: PROTOCOL (ticks, beacon replies, SQ sampling),
  README (TX via the installer, section names), About (compass).

## v0.8.0 — the SQ wire and the bench pair

- **Firmware 0.4.0**: optional SQ wire on `D2` (`sq on|off`, persisted in
  NVM); carrier edges timestamped in the main loop; `events` returns them
  with the fox's clock. Nothing is read on D2 until `sq on`.
- **Page**: SQ wire checkbox and carrier light in Fox configuration; while
  the receiver (or an autoseek dwell) runs, `events` is polled once a
  second and hardware edges feed the cycle tracker (`createEdgeFeeder`:
  clock offset, flutter merge); the hunt panel marks "· SQ wire". RSSI
  readings still keep the floor and peak. Firmware older than 0.4.0 shows
  "needs firmware 0.4.0" and the checkbox stays off.
- **Bench pair**: a second fox on another port as the beacon — callsign,
  arm, tune (or "= receiver"), start/stop its `fox` cycle, key 5 s, tone;
  its commands show as `[B]` in the console. In the simulation a paired
  beacon is heard by the simulated receiver (shared air).
- Simulation: the yagi pattern applies only during a bearing capture or
  with a live compass, so the keyed demo fox is strong out of the box;
  carrier detect follows the same signal model as RSSI.
- "(settling)" now wins over "(irregular)" under four bursts.
- Tests: 41 (SQ through the device layer, hardware-edge cycle timing, the
  simulated pair).

## v0.7.0 — install from the page, offline, phones that scroll

- **Firmware installer** on the page: band, callsign, TX gate; writes
  `code.py` through the CircuitPython raw REPL (`code.py.new` → rename),
  reboots, identifies, applies the settings. Download still there.
- **Offline**: service worker caches the page, scripts and firmware.
- **Phone scrolling**: plots use `touch-action: pan-y` (hold buttons keep
  `none`); resize is debounced and ignores height-only changes (the address
  bar); device-pixel ratio capped at 2 for plots; the hunt-mode timers
  redraw only when something changed — zero canvas work on an idle page.
- Nav: "Other tools" → lc-linkous.github.io/tools. About: running locally
  and offline.
- Tests: 4 installer tests against a simulated raw REPL (38 total).

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

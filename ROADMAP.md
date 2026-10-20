# Roadmap

One page, three jobs: a demo table, a test bench, and a hunter's pocket.
Each release below is useful on its own. Items are sized so one can be an
issue. Decisions already made are at the bottom so they don't get re-argued.

## Platforms (what the About page will say)

| Device | Serial to a fox | Audio decoders | Compass / bearing | Location |
|---|---|---|---|---|
| Laptop / desktop, Chrome or Edge | yes | yes | no compass | coarse (Wi-Fi) |
| Android phone or tablet, Chrome, USB-OTG cable | yes | yes (cable to mic jack, or USB sound card via OTG hub) | yes | GPS |
| ChromeOS | yes | yes | usually no | varies |
| iPhone / iPad (Safari; no other engine allowed) | **no** | yes | after a permission tap | GPS |
| Firefox, any platform | no | yes | varies | varies |

The simulated fox and session replay work everywhere.

## v0.4 — see over time (page only) — shipped

- **Scan waterfall**: channel × time, one row per completed scan, palettes
  from tinysa-web, per-channel max hold; hover reads channel, time, RSSI.
- **RSSI heat strip** under the line plot (the single-channel waterfall).
- **Session save / load / replay**: everything the recorder holds as one
  JSON; a scrub bar replays readings and scans into the windows at 1–10×.
- **Geolocation stamps** on readings and scans: off by default, a visible
  indicator while on, "last fix 4 s ago · ±12 m" next to it, accuracy in
  every stamp; CSV gains `lat,lon,accuracy_m`.
- **About page** (`about.html`): what the page is, the platform table,
  what the firmware can and can't do, the audio and location transparency
  statements, license split, attribution chain.
- Transparency on the Audio panel: constraints requested vs granted
  (`track.getSettings()`), permission state with the fix for "denied", and
  the statement that nothing is kept unless Recording is on.

## v0.5 — the hunt (page only) — shipped

- **Hunt mode**: a mode switch on the one page (Bench / Hunt). Hunt is one
  column, the RSSI readout and the countdown huge, the hunt board under
  them, everything else behind a tap. Bench is the current layout.
- **Autoseek**: step the channel list, stop when RSSI exceeds the running
  floor by a margin, dwell while it stays up, resume on drop or timeout;
  skip and lock buttons; margin and dwell adjustable.
- **Fox cycle timing**: on-time and period from threshold crossings on the
  tuned channel; countdown to the next burst; shown with how many cycles it
  rests on. Resets on retune.
- **CW identification**: while dwelling (or tuned) with audio running, a
  decoded callsign pins the channel with the ID and the time.
- **Hunt board**: pinned foxes — channel, ID, last heard, countdown, RSSI
  sparkline, max; add by hand or from autoseek; reorder; clear.
- **Attenuation bookkeeping**: a dB field with a preset list (0, 3, 6, 10,
  20, 30, 40 and sums), applied as an offset in the log and shown on the
  plot as a step, never to the raw byte; "no attenuator" is the default.

## v0.6 — bearing (phone) — shipped

- **Bearing capture**: hold, rotate, release; RSSI against heading from the
  device compass; polar plot; peak bearing and a width estimate; several
  captures kept and overlaid; a manual "pointing north now" marker for
  devices with no usable compass.
- Compass permission flow (iOS needs a tap; Android doesn't) and a
  calibration hint when heading accuracy is poor.
- Captures stamped with location and saved with the session, so two
  captures from two spots give a fix on paper.

## v0.7 — bench and firmware

- **Bench pair**: two serial ports in one page, A (transmitter, beacon) and
  B (receiver, decoder); the whole chain on dummy loads on one table.
- **SQ wire + `events`**: SA868 pin 1 (carrier detect) to a spare GPIO;
  firmware timestamps edges and returns them on request; autoseek and
  cycle timing use them when present, fall back to polling when not.
  Documented as an optional solder job until the next PCB revision routes
  it.
- **SSTV transmit**: sound card out → MIC pin, firmware keys for the
  duration (`tx on <s>`), page plays the encoded picture. Needs the MIC
  audio path on the board checked for level.
- Firmware `rssi stream` (unprompted, cancel on any byte) if the polled
  rate turns out to limit anything.

## Later / maybe

- Noise-quieting strength metric from audio (works where RSSI saturates).
- WAV capture of a fox ID.
- A small map sketch for bearing fixes (no tiles; just the two lines).
- PD-series SSTV modes.
- Event mode: a channel plan file for a hunt (foxes, frequencies, IDs)
  loaded into the hunt board in one go.

## Decisions

- **Serial on mobile is Android-only.** iOS gets audio, replay and the
  simulated fox. The no-serial banner names the platforms.
- **One page, a mode switch** (Bench / Hunt), not a second HTML file.
- **SQ wire** is an optional upgrade until the PCB revision; every feature
  works without it.
- **Attenuators**: free dB field plus common presets; default none.
- **Bearing capture** is compass-based with a manual north marker as the
  fallback.
- **Transparency**: every browser-side capability the page uses (audio,
  location, compass) is off by default, shows its state, shows what was
  granted, and says what is kept.
- **Firmware ships receive-only** (`TX_ENABLED = False`); nothing in the
  roadmap changes that.

# fox-hunt-web

A browser front end for the DEF CON 34 fox. Plug the fox in over USB, open
the page in Chrome or Edge, click Connect: tune 2 m or 70 cm, watch signal
strength live, scan a list of channels for the one with a fox on it, decode a
fox's Morse ID and SSTV pictures from the audio, log it all to CSV. With the
transmit-enabled firmware and a license, key it, send Morse, and run it as a
beacon. Nothing to install on the computer.

**Use it:** <https://lc-linkous.github.io/fox-hunt-web/>

The page has a *Try without hardware* mode with a simulated fox (three
signals on the air, one of them keyed like a real fox), so it can be previewed
anywhere.

The page is written for one piece of hardware — the Ham Radio Village DC34 fox,
a Seeed XIAO ESP32-C3 driving a NiceRF SA868 — with any of the three SA868
variants NiceRF sells (VHF, UHF, or dual-band). The fox needs this repo's
firmware loaded once; see [Firmware](#firmware) at the bottom.

The firmware ships **receive-only**: `TX_ENABLED = False` at the top of
`code.py`, and with it false nothing in the file can drive PTT low. Setting it
`True` adds the transmit commands behind three more gates (a stored callsign,
arming the session, a timer on every key-down). The board boots in receive
either way. See [Transmit](#transmit).

## How it fits together

The fox's ESP32-C3 is a bridge. The SA868 does the radio work — it is a
complete FM transceiver with a numeric signal-strength readback — and the
ESP32 passes commands and answers between USB and the module's UART.

```
                       DC34 fox
   ┌──────────────────────────────────────────────┐
   │  XIAO ESP32-C3              NiceRF SA868      │
   │  ┌────────────────┐  UART   ┌──────────────┐  │     antenna
   │  │ firmware/      │ 9600 8N1│ FM receiver  ├──┼─────┤
   │  │ code.py        ├────────►│ VHF, UHF or  │  │
   │  │  band, callsign│◄────────┤ both         │  │
   │  │  in NVM        │ AT+RSSI?│              │  │
   │  │ "ch>" console  │         │ AF_OUT ──────┼──┼── (pad, not routed)
   │  └───────┬────────┘         └──────────────┘  │
   │          │ USB CDC                             │
   └──────────┼───────────────────────────────────┘
              │
     Chrome / Edge, Web Serial
   ┌──────────┴───────────────────────┐
   │ fox-hunt-web                     │
   │  js/device/ shell-link.js        │  ← began as tinysa-web's
   │             serial-link.js       │  ← Web Serial, the fox's USB id
   │             fox.js  models.js    │  ← this repo
   │             demo-link.js         │  ← the simulated fox
   │  js/plot/   rssi vs time, scan   │
   │  js/ui/     sidebar, console     │  ← shared kit
   │  CSV / JSON export               │
   └──────────────────────────────────┘
```

- **The firmware speaks the tinySA console shape** — `cmd\r\n` in, echo plus
  reply plus `ch> ` out — so the console framing, console drawer and sidebar
  from [tinysa-web](https://github.com/LC-Linkous/tinysa-web) are reused
  unchanged. What is new is `js/device/fox.js` and `models.js` (what the
  numbers mean), the simulated fox, and the two plots.
- **The contract is `PROTOCOL.md`.** The page, the firmware and the simulated
  fox are all written to it.
- **One firmware for every fox.** The SA868 cannot report which band it is, so
  the band is a setting: pick it once from the *Module* dropdown and the
  firmware keeps it in the ESP32's NVM across reboots and reflashes. The
  tunable range, the fox-frequency presets and the scan defaults follow.
- **Signal strength is the SA868's RSSI byte**, 0–255, uncalibrated and
  roughly logarithmic. It is a relative instrument: good for "warmer / colder"
  and for comparing channels, not a dBm meter. It also saturates close to a
  transmitter, which is why fox hunters carry attenuators.
- **Audio is not on the microcontroller.** The SA868's audio output (module
  pin 3, `AF_OUT`) is not routed on the fox PCB. A wire from that pad to a
  cheap USB sound card gives the computer the demodulated audio, and the
  page decodes CW and SSTV from it with the Web Audio API — any browser, no
  firmware involved. The firmware's `volume` setting is that pad's level.
  See [Audio](#audio).

## What it does (v0.13)

Four tabs in the top bar: **Bench** (the sidebar — Receiver, Scan & seek,
Audio, Session — with the Signal strength, Channels and Audio windows and
the console), **Hunt** (one column for a phone: channel strip, RSSI and
countdown, Seek/Pin/Rec, the plot, bearing capture and the bearings
taken, the board, audio), **Transmit** (this fox, a second fox as the
beacon, SSTV pictures; the Signal strength window and the console stay
visible) and **Setup** (the event's channels, this fox — module band,
callsign, wires — this page, the firmware installer). Transmit is its own
tab so nothing on the bench can key a fox by accident; a red **TX** tag in
the top bar shows what is on the air from any tab, and clicking it goes to
Transmit. Nothing stops a transmission when you switch tabs — a beacon
keeps running while you show the bench.


- **Connect / detect** — reads `version` and `info`, refuses a port that is not
  a fox running this firmware, shows the module's own version string and
  whether it answered its handshake.
- **Module** — the SA868 variant, from the fox or set from the dropdown
  (VHF, UHF, dual-band). Sent once, kept on the board.
- **Receiver** — tune by number or preset (146.565, 433.900, band edges),
  12.5 / 25 kHz bandwidth, squelch 0–8, audio level; live RSSI at ~10 Hz
  plotted against time with max hold; readings per second.
- **Scan** — start / stop / step across either band, drawn as a per-channel
  bar strip with the strongest marked, or as a **waterfall** (one row per
  scan, newest at the top) that shows which channels are alive over minutes;
  click a bar or a cell to tune there; continuous mode; presets ±150 kHz
  around each fox frequency. A heat strip under the signal-strength plot is
  the single-channel version.
- **Hunt mode** — a Bench / Hunt switch in the top bar. Hunt is one
  column: the RSSI readout and the countdown to the next burst huge, Start /
  Seek / Skip / Lock / Pin and the attenuator under them, the signal plot,
  the hunt board, the last decoded Morse. Made for a phone held next to a
  yagi; remembered across loads.
- **Autoseek** — steps the Scan section's channel list like a radio's SEEK:
  stops where RSSI rises over that channel's own learned floor by a margin
  (default 20 counts), listens while it stays up, moves on when it drops or
  after the dwell limit; Skip and Lock; pins what it stops on. Each channel
  keeps its own floor, so a permanently noisy one doesn't keep stopping the
  seek.
- **Fox cycle timing** — from threshold crossings on the tuned channel: how
  long the fox keys and how often; a countdown to the next burst once two
  have been heard (a burst already in progress when listening starts is not
  counted as an onset). Shown in the Receiver section and, huge, in Hunt.
- **CW identification** — a callsign decoded by the audio path while tuned
  pins and labels that channel on the board.
- **Hunt board** — the foxes in play: frequency, ID, last heard, max, next
  burst with the period, a trend sparkline, tune and unpin. Pin from the
  receiver, from a scan's strongest channel, by typing a frequency, or let
  autoseek do it. Saved with the session, including each fox's learned
  cycle.
- **Bearing** — with a directional antenna: hold *Capture*, turn through a
  full circle, release. RSSI against heading is binned and plotted on a
  polar chart (the Channels window's Bearing tab, and the Hunt panel); the
  lobe's centre is the bearing, with a width and a note when the circle
  was partial or the lobe broad. Heading comes from the device compass
  (Android Chrome and, after a tap, iOS) or from a manual heading slider on
  anything without one; *Mark north* calibrates a relative sensor or trims
  an absolute one. Every reading is tagged with the heading at its own
  moment, not the moment the burst came back. Captures are listed with
  their location; two captures with location from different places give a
  fix (lat/lon, distance, crossing angle) with a Copy button. Saved with
  the session. The simulated fox carries a bearing, so the slider "turns" a
  simulated yagi on the bench.
- **Attenuator bookkeeping** — a preset list (3–40 dB) or a custom value.
  The RSSI byte is logged as read; the attenuation goes in its own column
  and a change marks the plot and resets max hold. Default: none.
- **Recording and sessions** — timestamped readings and scans, saved as CSV
  (`timestamp_iso,t_ms,frequency_mhz,rssi,lat,lon,accuracy_m`) or as one
  session JSON with the settings and the fox's identity. **Load session**
  replays it into the windows with a scrub bar at 1–30×; the fox is left
  alone, a REPLAY badge shows, and *Live* returns to it.
- **Location** — off by default. When on, a GPS badge shows, the fix's
  accuracy and age are displayed, a fix older than 15 s is not used, and
  lat/lon/accuracy stamp every reading and scan.
- **Pictures and CSV** (under Session) — PNG of either plot, CSV of the scan on screen.
- **Setup** — firmware and module versions, which RSSI command the module
  speaks, whether NVM is present, the callsign and the SQ wire (all kept on
  the board); then the page's own settings.
- **Console** — the raw serial exchange, resizable drawer, command history,
  log download (commands only, or commands + replies, timestamped). The `at`
  command passes a line straight to the SA868 so you can watch the module
  answer.
- **Audio** — pick the sound-card input, start; the Audio window shows the
  passband spectrum with the CW pitch and the SSTV tones marked, the decoded
  Morse text with its element stream, and the SSTV picture as it draws.
  CW: Goertzel detector, adaptive threshold, follows the sender's speed and
  (optionally) pitch; save the text. SSTV: Martin M1/M2, Scottie S1/S2,
  Robot36 from the VIS header, per-line sync tracking; save the PNG.
- **Transmit** (TX-enabled firmware only) — arm, hold-to-key with a timer,
  test tone, Morse from text with the air time shown, the fox beacon
  (message and interval, runs on the board), power low/high, WPM. The
  receiver and scan pause while anything is on the air.
- **Settings** — dark / light, trace colours, waterfall palette, heat strip,
  seconds of history on screen, RSSI axis, amateur-allocations-only tuning
  (off: the module's full range).
- **Firmware installer** at the bottom of the page: pick the SA868 band and
  an optional callsign, tick transmit if licensed, and *Install on the fox
  over USB*. The page writes `code.py` through CircuitPython's REPL on the
  serial port (what Thonny does), as `code.py.new` renamed into place so a
  failed transfer leaves the old firmware alone, reboots, waits for the new
  prompt, then applies the band and callsign. *Download code.py* gives the
  same file for Thonny.
- **Offline**: after one visit over HTTPS or localhost a service worker
  keeps the page, scripts and firmware cached; hunts rarely have signal.
- **About** (`about.html`) — what works on which device, what the firmware
  can and can't do, what the page keeps and asks for, running it locally.

See `ROADMAP.md` for what comes next: SSTV transmit, and what hardware
testing turns up.

## Hardware

Exactly one board, exactly these pins. This is the dc34fox pin map; the
firmware is not configurable because it is not meant to be general.

| Function | XIAO pin | GPIO | In this firmware |
|---|---|---|---|
| PTT | `D3` | GPIO05 | held **high** (receive) |
| PD | `D4` | GPIO06 | held high (module awake) |
| HL | `D5` | GPIO07 | low (unused in receive) |
| UART RX (from SA868) | `D7` | GPIO20 | 9600 8N1 |
| UART TX (to SA868) | `D6` | GPIO21 | 9600 8N1 |
| MIC | `D1` | GPIO03 | held low (unused in receive) |
| Status LED | `D10` | GPIO10 | on when the module answered |
| SQ (optional wire) | `D2` | GPIO04 | pulled-up input, only after `sq on` |

| SA868 fitted | Module range | Page default (amateur) | Fox frequency |
|---|---|---|---|
| VHF | 134–174 MHz | 144–148 MHz | 146.565 |
| UHF | 400–480 MHz | 420–450 MHz | 433.900 |
| dual-band | both | both | both |

Connect the antenna (or a dummy load) before powering the board, every time.

### Which wire does what

Nothing on the page needs a soldering iron. A stock fox over USB gives
everything in the Receiver, Scan & seek, Hunt and Session sections — RSSI,
scans, autoseek, the burst countdown (from RSSI thresholds), bearings, the
board, recording and replay — and, with the TX build, keying, tones, Morse
and the beacon. Each wire adds a layer, and the page shows the matching
features once you tick the wire under Setup → *Wires on this fox*:

| Wire | Adds | Without it |
|---|---|---|
| **SQ** (pin 1 → D2) | hardware-timed carrier edges: an exact burst countdown | the countdown comes from RSSI thresholds (fine for a fox that keys hard) |
| **AF_OUT** (pin 3 → sound card in) | CW ID decoding, SSTV decoding and noise quieting *from this fox's receiver* | the Audio section still works from **any other radio** — see below |
| **MIC_IN** (sound card out → pin 18) | SSTV pictures *from* this fox (TX build) | no SSTV transmit; the beacon and Morse still work (the firmware makes those tones itself) |

**The audio input does not have to come from the fox.** The decoders take
whatever the sound card hears. A handheld tuned to the fox's channel with
its headphone jack into the sound card gives the CW ID, SSTV pictures and
the quieting readout on the page, while the fox does RSSI and the
countdown over USB beside it. That is the no-soldering way to get the
whole page: a stock fox, a Baofeng, and a USB sound card. The one thing it
cannot do is tie the audio to the fox's channel for the countdown (the
*AF_OUT* tick does that), because the page cannot know what the handheld
is tuned to.

### AF_OUT for the audio decoders

The SA868's pin 3, `AF_OUT`, is not connected on the fox PCB. Solder a wire
to the pad and run it, with a ground, to a USB sound card's line or mic
input through a 10 kΩ series resistor (the pad gives about 700 mV into
200 Ω; a mic input wants less). Set the sound card's input gain so the
page's *Level* readout sits around −20 to −6 dBFS during a signal, and set
the fox's `volume` (Receiver section) to taste. The browser needs microphone
permission once; after that the input shows up by name in the Audio section.
The audio path is independent of the serial link, so it also works with any
other receiver's speaker jack.

### The SQ wire for exact cycle timing

The SA868's pin 1, `SQ`, is low while the squelch is open. It is not
routed either. A wire from that pad to the XIAO's `D2` lets the firmware
(0.4.0+) time every carrier edge itself; the page then polls `events`
once a second while the receiver runs and the *Next burst* countdown comes
from hardware-timed onsets instead of RSSI threshold crossings. Tick
**SQ wire soldered to D2** under Setup once, it is
kept on the board, and the carrier light next to it follows the pin.
Leave it unticked on a fox without the wire: D2 is never read then. The
fox's `squelch` setting decides what counts as a carrier.

### Bench pair

Two foxes on two USB ports, both on dummy loads, a few feet apart: one is
the receiver (connected with the Connect button, everything on the page),
the other the **beacon**, paired from the Bench pair section. The beacon
fox needs the transmit-capable firmware (install it with *Transmit
commands* ticked), a stored callsign, and the arm checkbox; then *Start
beacon* runs its `fox` cycle, *Key 5 s* a bare carrier, *Tone* a test
tone, and *= receiver* tunes it to wherever the receiver is. The receiver
hears it like any fox: cycle timing, autoseek, the board, the CW decoder
on the audio path, all without leaving the bench. Its commands show in the
console prefixed `[B]`. In the simulation, *Pair a second fox* gives a
simulated beacon the simulated receiver hears.

## Layout

```
┌───────────────────────────────────────────────────────────────────┐
│ fox-hunt-web [Connect] [Try without hardware] Module ▾  ● status  │
├────────────┬──────────────────────────────────────────────────────┤
│ Receiver   │ ┌ Signal strength ────────────┐ ┌ Channels ────────┐ │
│  freq Tune │ │ RSSI vs time, max hold      │ │ bar per channel, │ │
│  presets   │ │                             │ │ strongest marked │ │
│  bw sq vol │ └─────────────────────────────┘ └──────────────────┘ │
│  [Start]   ├──────────────────────────────────────────────────────┤
│  now · max │ Fox console ▲                  Log ▾ [⤓][copy]       │
│ Scan       │ > rssi 10                                            │
│ Recording  │ 0 41 / 101 43 / …  (1.1 s)                           │
│ Export     │ ┌──────────────────────────┐ [Send]                  │
│ Fox config │ │ type a command           │                         │
│ Settings   │                                                      │
└────────────┴──────────────────────────────────────────────────────┘
```

## What's in the repo

| Path | What it is |
|---|---|
| `index.html` | markup only; native ES modules, no build step |
| `PROTOCOL.md` | the serial contract between the page and the firmware |
| `firmware/code.py` | CircuitPython firmware for the fox (the download in the page's footer) |
| `js/device/shell-link.js`, `serial-link.js` | console framing, Web Serial transport |
| `js/device/fox.js`, `models.js` | the device API and the three band envelopes |
| `js/device/installer.js` | writes `code.py` through the CircuitPython raw REPL and reboots into it |
| `sw.js` | the offline cache |
| `js/device/demo-link.js` | the simulated fox: same byte stream, three signals, a simulated transmitter at 1/10 real time |
| `js/plot/rssi.js`, `scan.js`, `waterfall.js`, `audio.js` | the plots; `palettes.js` is tinysa-web's |
| `js/hunt.js` | cycle timing, autoseek decisions, the board, callsign matching — no DOM, no device |
| `js/bearing.js`, `js/ui/compass.js`, `js/plot/polar.js` | bearing captures and the two-bearing fix; the heading source with manual fallback; the polar plot |
| `js/ui/session.js`, `geo.js` | session save/parse and replay; location stamps |
| `about.html` | platforms, what the firmware does, what the page keeps |
| `ROADMAP.md` | the plan, with the decisions recorded |
| `js/audio/capture.js`, `fft.js`, `cw.js`, `sstv.js` | sound-card capture, FFT/Goertzel, the Morse decoder, the SSTV decoder and encoder |
| `js/ui/`, `css/` | sidebar, console, settings, recorder, export; styles |
| `tests/device.test.mjs`, `audio.test.mjs`, `session.test.mjs`, `hunt.test.mjs`, `bearing.test.mjs`, `installer.test.mjs` | the device layer over the simulated fox; the decoders against synthesized audio; session round trip and replay; the hunt logic against a synthetic fox; bearing captures against a synthetic yagi sweep and a two-bearing fix; the installer against a simulated raw REPL (`node --test`) |
| `.github/workflows/pages.yml` | publishes the page and the firmware to GitHub Pages |
| `.github/workflows/tests.yml` | syntax-checks every module and runs the tests |

`js/device/shell-link.js`, `js/ui/sidebar.js`, `js/ui/console.js`,
`js/ui/export.js`, `js/plot/common.js`, `js/plot/palettes.js`,
`css/theme.css`, `css/layout.css` and `css/components.css` began as copies
of tinysa-web's page kit — the console framing, the sidebar, the plot base
— and are this project's own now. `<html data-app="fox-hunt-web">` keeps
this page's localStorage separate from the other tools when they share an
origin.

## Talking to the fox without the page

Any serial terminal works (any baud, line ending `\r\n`). The firmware echoes
the line and ends every reply with `ch> `.

```
ch> version
foxhunt 0.2.0 xiao-esp32c3 sa868-dual
ch> tune 146.565
146.5650
ch> rssi
42
ch> scan 146.400 146.600 25
146.4000 31
146.4250 30
…
ch> at AT+VERSION
+VERSION:SA868S-...
```

Full command list in [PROTOCOL.md](PROTOCOL.md), or type `help`. Thonny
works too (it is how the fox is normally programmed); you'll see each line
twice because Thonny echoes locally and so does the firmware, and Ctrl+C still
drops you to the REPL.

## On a phone

Chrome for Android has Web Serial: a USB-OTG adapter (or a C-to-C cable on
a phone that does host mode) into the fox's USB-C, open the page, Connect,
pick the fox in the chooser. The fox draws under 100 mA in receive. The
*Hunt* in the top bar gives the one-column layout for one-handed use;
A phone without a headphone jack can still do audio: a USB-C hub (an OTG
hub with two or more ports) carries the fox and a USB sound card at once,
and Android treats the sound card as a microphone and a speaker. Bluetooth
audio is not a substitute — its processing and latency wreck Morse timing
and SSTV tones. *Setup* is the set-once page: the event's channels (they become the
presets, the scan presets, the autoseek list and a one-click set of board
pins; export/import as JSON), this fox's stored settings, this page's
settings, and the firmware installer. iPhones and iPads cannot connect (no Web Serial in
Safari, and Apple allows no other engine); they get the audio decoders, the
simulated fox and session replay. The About page has the full table.

## Transmit

Off by default, on purpose. To turn it on, install the firmware again from
the Firmware section with *Transmit commands* ticked (or, by hand, change
`TX_ENABLED = False` to `True` at the top of `firmware/code.py` and save it
to the board). Then, in this order:

1. Store your callsign (Setup section). The firmware refuses to
   arm while it is `N0CALL`, and every beacon cycle sends it first.
2. Tick the arming box in the Transmit section. That sends `tx arm`; it
   lasts until you disconnect or the board reboots.
3. Key, send a tone, send Morse, or start the beacon.

What the firmware enforces, regardless of the page:

- Every key-down has a deadline: `tx on` defaults to 10 s (cap 60); Morse and
  beacon cycles key for the text's air time plus 2 s. The main loop unkeys
  at the deadline whatever the host is doing, including if the USB cable
  falls out mid-sentence.
- The beacon stops itself if the transmitter stops being allowed (disarm,
  `rx`), and a byte on the serial port aborts a Morse transmission at the
  next character, so `fox stop` works mid-cycle.
- `rx` is always safe: stops the beacon, unkeys, PTT high. The page sends
  it on disconnect.

What the page does on top: the Key button is hold-to-key (release sends
`tx off`; the deadline is the backstop), the receiver and scan loops pause
while anything is on the air, the TX badge pulses, and the Transmit
section is hidden entirely when the firmware reports `tx: disabled`.

The beacon firmware in `dc34fox` is still the simpler thing for a hunt: it
needs no computer. This one is for the bench, for a fox you can stop and
retune from the page, and for the day the SSTV encoder gets an audio path.

### Sending a picture (SSTV)

Transmit → *Send a picture*: pick an image, a mode (Robot36 36 s through
Martin M1 114 s), the sound card the page should play through, and *Send*.
The page tells the fox `mic line` so its own tone pin floats, keys it for
the frame, plays the encoded tones out of the sound card into the SA868's
`MIC_IN` pad (pin 18), unkeys, and puts the mic back to `pwm`. *Preview
tones* plays the same audio without keying, for checking the wiring or
feeding the decoder through a loopback. Set the sound card's output level
so the SA868 is not over-deviated: start low, decode it on the bench pair,
raise until the picture is clean. Firmware 0.5.0+.

### Recording the audio, and tuning the decoders

Audio → *Record audio* captures what the sound card hears to a WAV; *Open
a WAV* runs a file back through the decoders, as fast as it can or in real
time with *Listen* on. The decoders were written against synthetic signals
and a real fox on FM is the thing they need to be tuned to: when the CW
text comes out wrong, record a minute that includes a couple of bursts,
save it, and attach it to an issue — it becomes a test. The decoded log
(one line per burst: time, frequency, pitch, speed, text; *Save log*) is
the other half of that report.

Voice on the channel decodes as junk, by design: the decoder reports any
tone-shaped thing it hears. Judge it on the fox's Morse, not on someone
talking.

### Noise quieting

Audio → *Noise quieting*: with the fox's squelch at 0, an FM receiver's
hiss (the 2.5–4 kHz part of the audio) drops when a carrier arrives,
modulated or not. The page tracks that drop in dB against a slow noise
reference and reports carrier / quiet with hysteresis (on above 8 dB, off
below 4). When the SQ wire is not declared, those edges feed the burst
countdown, so a fox with only the AF_OUT wire still gets hardware-grade
cycle timing — from the audio instead of a pin. Shown in the Audio section;
the hunt panel marks "· quieting".

## Audio

Capture runs through an `AudioWorklet` with echo cancellation, automatic
gain and noise suppression off (all three destroy Morse timing and SSTV
tones). The Audio section shows the permission state, what was asked for,
and what the browser actually granted — a setting left on is flagged in
red, because that is the usual reason a decoder "doesn't work". Audio is
decoded in memory and never stored. Both decoders run on every block; the
Audio window's three tabs show the passband, the Morse text, and the
picture.

- **CW** — a Goertzel detector at the pitch (800 Hz by default, the dc34fox
  tone), a 10 ms block, a threshold halfway between the running noise floor
  and the running peak with 6 dB of hysteresis, and an element clock that
  follows the sender. It needs about 12 dB between floor and peak to decode
  at all, and it drops rather than guesses the character during which the
  pitch moved. Expect clean copy of a fox ID; expect nothing from weak HF
  signals, which is not what it is for.
- **SSTV** — VIS header (1900 Hz leader, 1200 Hz start bit, eight bits at
  1100/1300 Hz, parity checked), then the mode's line timing from one table
  that the encoder in the tests is also built from. Each line's 1200 Hz
  sync pulse is found near where the timing predicts it and the decoder
  re-anchors there, so a sound-card clock a little off does not slant the
  picture. Pixel frequency is read with a 1–3 ms Hann window zero-padded
  into a 512-point FFT and parabolic interpolation.

Both are tested against synthesized audio (`tests/audio.test.mjs`): a
Morse ID in 15 dB of noise, and Martin M1, Scottie S2 and Robot36 pictures
encoded and decoded through the same tables, with a mean pixel error bound.

## Safety behaviour

- Shipped firmware: `TX_ENABLED = False`. PTT is set high before anything
  else and never set low; the transmit commands answer with an error.
- With transmit enabled: boots in receive, unarmed; callsign gate; arming
  per session; a deadline on every key-down enforced by the main loop.
- Loading this firmware replaces the beacon firmware. The board and
  callsign settings stay in NVM across the swap.
- The page sends `rx` on disconnect when transmit is available, so a page
  closed mid-beacon leaves a silent fox.

## Firmware

The fox needs `firmware/code.py` from this repo loaded once. The XIAO
ESP32-C3 has no USB drive, so the file goes in over the serial port through
CircuitPython's REPL. Every fox is assumed to be running CircuitPython
already (the stock DC34 fox is); a bare board needs that first —
[dc34fox, Step 1](https://github.com/HamRadioVillage/dc34fox#step-1--flash-circuitpython).

**From the page (Chrome or Edge, any OS):** scroll to *Firmware for the
fox*, pick the SA868 fitted, optionally a callsign, tick transmit only if
licensed, and click *Install on the fox over USB*. The chooser lists the
fox; the page interrupts the running program, writes the file, reboots,
and connects to the new firmware. About 20 seconds. If a fox is already
connected to the page, that connection is used.

**By hand (Thonny):** *Download code.py*, open it in Thonny with the
interpreter set to *CircuitPython (generic)* on the fox's port, *File →
Save As… → CircuitPython device* as exactly `code.py`, Ctrl+D. A healthy
first boot prints `foxhunt 0.5.0 xiao-esp32c3 sa868-unset` then `ch> `.
Disconnect Thonny (it holds the port), then connect here and pick the
module.

Going back to the stock beacon: save `dc34fox`'s `code.py` over it with
Thonny. The band and callsign stay in NVM for the next time.

## Running it yourself

Static files, no build step: serve the folder and open it.

```
python -m http.server 8000
# then open http://localhost:8000/
```

Web Serial works on `localhost`, so a real fox can be used this way; module
scripts don't load from `file://`. On your own host, Web Serial, the
microphone, location and the compass all need HTTPS. The tests need
Node 22: `node --test 'tests/**/*.test.mjs'`.

### Releasing

A release is a tag: `git tag v0.11.0 && git push --tags`. The release
workflow checks the tag against `APP_VERSION` in `js/main.js`, takes that
version's section of `CHANGELOG.md` as the notes, and attaches `code.py`
(also as `foxhunt-firmware-<fw version>.py`) and a zip of the page, so the
footer's "latest release" link always has a firmware to download. Before
tagging: `FW_VERSION` in `firmware/code.py`, `FW_NEEDED` in `js/main.js`,
`FIRMWARE_FLOOR` in `js/device/models.js` (if the protocol changed) and the
simulated fox's `version` reply agree; the three test layers pass; the
changelog has the entry. The Pages workflow stamps the footer date from the
commit.

## Contributing

Bug reports and hunt-day oddities welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) and the issue templates. Attach a console
log (Fox console → Log → commands + replies → Download) to anything
protocol-related; it is the diagnostic.

## License

The page (`index.html`, `js/`, `css/`) is **GPL-2.0-only**, the same as
tinysa-web and nanovna-web, where its page kit came from.

The firmware (`firmware/code.py`) is **GPL-3.0-only**: it is written to the
dc34fox board, follows that firmware's pin map and module setup, and the
attribution chain for the fox hardware is GPL-3.0
([HamRadioVillage/dc34fox](https://github.com/HamRadioVillage/dc34fox) ←
[c0ldbru/fox](https://github.com/c0ldbru/fox) ← Bradan Lane STUDIO ←
[N8HR/YAFB](https://github.com/N8HR/YAFB)). The two halves are separate
programs that talk over a serial port, which is why they can carry different
licenses.

fox-hunt-web is not affiliated with the Ham Radio Village, NiceRF, or Seeed.
A license is not required to receive; it is required to transmit, and this
build cannot.

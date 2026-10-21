# fox-hunt-web serial protocol

The contract between `index.html` and `firmware/code.py`. Anything that
changes here changes in both.

## Transport

- USB serial on the XIAO ESP32-C3 (the chip's USB-Serial/JTAG port, VID:PID
  `303a:1001`). Any baud rate works; the page opens it at 115200.
- One command per line, terminated by `\r\n`. The firmware echoes the
  command line, prints zero or more reply lines, then the prompt `ch> `
  (with a trailing space, no newline). This is the tinySA console shape,
  so `js/device/shell-link.js` is used unchanged.
- The firmware sends nothing unprompted after the boot banner. Opening the
  port can reset the chip (the ESP32's USB-serial handshake lines), in which
  case the banner arrives about a second after connect; the page's `identify`
  retries `version` once to ride that out.
- A byte arriving in the middle of `rssi N` or `scan` ends that command
  early; the prompt still follows. The page uses this to cancel.
- Do not send `0x03` (Ctrl+C): CircuitPython interprets it as an
  interrupt and drops to the REPL. The page never does.

## Reply conventions

| Reply starts with | Meaning |
|---|---|
| `usage:` | the arguments were wrong; nothing changed |
| `error:` | the module refused, is not responding, or a setting is missing; nothing changed |
| `name?` | `name` is not a command in this build |
| anything else | success; the reply is the answer |

## Identity

### `version`
One line: `foxhunt 0.3.0 xiao-esp32c3 sa868-dual`. Fields are firmware
name, firmware version, board, radio module. The module field is
`sa868-vhf`, `sa868-uhf`, `sa868-dual`, or `sa868-unset` when the band has
never been set on this board. The page refuses a port whose first field is
not `foxhunt` and whose board is not `xiao-esp32c3`.

### `info`
`key: value` lines: `firmware`, `board`, `module` (with `connected` or
`NOT RESPONDING`), `module_version` (the SA868's own `AT+VERSION` reply,
or `unknown`), `band`, `bands` (the tunable ranges in MHz), `callsign`,
`freq`, `bw`, `squelch`, `volume`, `rssi_cmd`, `nvm` (`yes`/`no`), `ptt` (`rx`, or `TX keyed 4.2 s left`), `tx`
(`available` or `disabled`), `armed`, `power`, `wpm`, `tone`, `foxmsg`,
`foxdelay`, `fox` (`running (3 cycles)` / `stopped (0 cycles)`), `sq` (`off`,
`on carrier` or `on quiet`; the SQ wire, firmware 0.4.0+).

### `help`
Two lines: the receive commands, then the transmit commands or the note
that they are disabled.

## Configuration (persisted in NVM)

The board's non-volatile memory keeps these across reboots and across
re-saving `code.py`, so a fox is configured once.

### `band [vhf|uhf|dual]`
No argument: the current band, or `unset`. With an argument: records which
SA868 variant is fitted and persists it; the receive frequency moves to that
band's fox default (146.565 or 433.900 MHz) if it was out of range. `tune`
and `scan` are refused with `error: module band not set` until this has been
done once. The module cannot report its own band, which is why this is a
setting; the page's *Module* dropdown sends it.

### `callsign [CALL]`
No argument: the stored callsign, `N0CALL` when unset. With an argument:
stores it (A–Z, 0–9, `/`, up to 16 characters). The transmit commands
refuse to arm while it is `N0CALL`, and every beacon cycle sends it first.

On a board without NVM the reply carries ` (not persisted: no nvm)` and the
setting lasts until the next reboot.

## Receiver

### `tune [MHz]`
No argument: prints the current receive frequency. With an argument:
retunes (bandwidth and squelch unchanged, no CTCSS/CDCSS) and prints the
frequency as programmed. Refused outside the set band's range (134–174
and/or 400–480 MHz); the page further narrows this to the amateur
allocations by default.

### `rssi [count]`
No argument: one line, the module's RSSI byte (0–255), or `-1` if the
module did not answer. With `count` (1–200): `count` lines of
`ms rssi`, where `ms` is milliseconds since the first reading, at about
10 Hz. The byte is uncalibrated and roughly logarithmic; treat it as
relative.

### `scan {start_MHz} {stop_MHz} {step_kHz}`
Retunes to each channel in turn, waits 60 ms, reads RSSI, prints
`freq rssi` per channel, then returns to the frequency it had before.
At most 128 channels, all inside the set band. Budget about 150 ms per
channel.

### `squelch [0-8]`, `bw [0|1]`, `volume [1-8]`
Query (no argument) or set. `bw` 0 = 12.5 kHz, 1 = 25 kHz. `volume`
sets the SA868's audio output level, which is what reaches the AF_OUT
pad; `squelch` 0 is open.

### `at {AT command}`
Passes the rest of the line to the SA868 verbatim and prints its reply
line, or `(no reply)`. For the console. Nothing the module accepts over
AT can key the transmitter; PTT is a pin.

### `rx`
Back to receive: stops the beacon, unkeys, re-asserts PTT high and PD high.
Prints `rx`. Safe to send at any time.

### `led on|off`
The status LED. After boot it is on when the SA868 answered the
handshake.

## The SQ wire (firmware 0.4.0+)

The SA868's pin 1, `SQ`, goes low while the squelch is open, i.e. while a
carrier is on the tuned channel. It is not routed on the fox PCB; a wire
from that pad to the XIAO's `D2` (GPIO04) lets the firmware time carrier
edges itself, which is exact where RSSI polling is ±100 ms and
threshold-dependent. Off by default so a fox without the wire never reads
a floating pin.

### `sq [on|off]`
Without an argument: `off`, `carrier` or `quiet`. `sq on` declares the wire
present (D2 becomes a pulled-up input; persisted in NVM, byte 28/29) and
`sq off` releases it. Prints the new state, with `(not persisted: no nvm)`
appended when NVM is unavailable.

### `events`
The carrier edges seen since the last `events`, oldest first, then clears
them. First line `now {ticks_ms} carrier|quiet` gives the fox's own
millisecond tick and the live level; each following line is
`{ticks_ms} 1|0` (1 = carrier began, 0 = carrier ended). The fox keeps
the last 64 edges; poll at least once a minute during a busy hunt. Ticks
are the fox's milliseconds since boot (`supervisor.ticks_ms()`, corrected
so they never wrap) and have nothing to do with wall time; the host
subtracts the `now` line from its own clock. Refused with `error:` while
`sq` is off. The pin is sampled every few ms everywhere the firmware waits
— the main loop, inside an `rssi N` burst, a scan, a Morse cycle — so an
edge is stamped when it happened, not when the current command finished.
Squelch flutter at a burst's edges appears as short pairs the host should
merge.

## Transmit

Gated three ways, all in the firmware:

1. `TX_ENABLED` at the top of `code.py` must be `True`. Shipped `False`.
   With it `False`, every command below replies `error: transmit commands
   are not enabled in this firmware build (TX_ENABLED is False)`, and nothing
   in the file drives PTT low. `info` reports `tx: disabled`.
2. A callsign other than `N0CALL` must be stored (`callsign`).
3. The session must be armed with `tx arm`. Arming does not survive a
   reboot; the board always boots in receive, unarmed.

On top of that every key-down has a deadline (`tx on` default 10 s, cap
60 s; `morse` and `fox` key for the air time of the text plus 2 s) and the
main loop unkeys at the deadline regardless of what the host does. The
page never relies on itself to unkey.

Replies during a transmission: `morse` and `tone` are blocking; the reply
arrives when the air time is over, and the page sets its timeout from the
text length and WPM. A byte arriving during `morse` aborts it at the next
element (the reply is `aborted`), so a human at a terminal can stop it with
Enter; the page never sends anything while one of its own commands is
pending. A beacon (`fox start`) cycle is different: its Morse is stepped
from the main loop, so the shell keeps answering `info`, `tx`, `fox`, `rssi`
and the rest while a cycle is on the air (the page polls `tx` and `fox` once
a second), and `fox stop`, `tx off`, `tx disarm` or `rx` end the cycle at
the next element.

### `tx`
`disabled`, `off`, `armed`, or `on 4.2` (seconds left on the current key-down).

### `tx arm` / `tx disarm`
Arms (reply `armed`) or disarms, which also stops the beacon and unkeys
(reply `off`). Arming refuses while the callsign is `N0CALL`.

### `tx on [seconds]` / `tx off`
Keys PTT for `seconds` (default 10, at most 60), carrier only, no audio;
reply `on 10.0`. `tx off` unkeys at once. The page's Key button is press =
`tx on 10`, release = `tx off`.

### `tone {Hz} {ms}`
Keys, sends one tone (300–3000 Hz, 10–5000 ms) on the MIC pin, unkeys.
Reply `sent 800 Hz 500 ms`. For checking the audio path with a receiver.

### `morse {text}`
Keys, sends the text (up to 64 characters; A–Z, 0–9, `/ ? =`) at `wpm`
with the `tone` pitch, unkeys. Reply `sent 7.3` or `aborted 7.3` (the air
time in seconds). The text does not get the callsign prepended; that is
the caller's job, and the page's Morse box defaults to it.

### `power low|high`
The SA868's HL pin: `low` is about 25 dBm, `high` about 2 W. Boots `low`.

### `wpm [5-35]`, `foxmsg [text]`, `foxdelay [5-600]`
Query or set. `foxmsg` is up to 40 characters of A–Z, 0–9, `/ ? =` and
spaces; each beacon cycle sends `<callsign> <foxmsg>`. `foxdelay` is the
gap between cycles in seconds. Not persisted; the page sends them.

### `fox [start|stop]`
No argument: `running 3 12` (cycles sent, seconds to the next) or
`stopped 3 0`. `start` runs the beacon from the main loop: the first
cycle begins immediately, then every `foxdelay` seconds; the status LED is
on during a cycle. `stop` ends it and unkeys. The beacon also stops by
itself if the transmitter stops being allowed (disarm, `rx`).

## The SA868 side

9600 8N1 on the XIAO's hardware UART (D6 out, D7 in). Commands the
firmware sends, and the reply it expects:

| Sent | Expected |
|---|---|
| `AT+DMOCONNECT` | `+DMOCONNECT:0` |
| `AT+VERSION` | `+VERSION:...` (optional) |
| `AT+DMOSETGROUP=bw,txf,rxf,0000,sq,0000` | `+DMOSETGROUP:0` |
| `AT+DMOSETVOLUME=n` | `+DMOSETVOLUME:0` |
| `AT+RSSI?` (or `RSSI?` on older module firmware) | `RSSI=nnn` |

The firmware tries `AT+RSSI?` first at boot and falls back to `RSSI?`;
`info` reports which one it settled on.

## Walk-through

```
ch> version
foxhunt 0.3.0 xiao-esp32c3 sa868-unset
ch> tune 146.565
error: module band not set; send `band vhf|uhf|dual` first
ch> band dual
dual
ch> version
foxhunt 0.3.0 xiao-esp32c3 sa868-dual
ch> tune 146.565
146.5650
ch> rssi
42
ch> rssi 3
0 41
101 43
202 42
ch> scan 146.400 146.600 25
146.4000 31
146.4250 30
146.4500 33
146.4750 29
146.5000 31
146.5250 30
146.5500 61
146.5750 88
146.6000 44
ch> callsign W1AW
W1AW
ch> tx on
error: transmit commands are not enabled in this firmware build (TX_ENABLED is False)
ch> bogus
bogus?
ch>
```

With `TX_ENABLED = True`:

```
ch> tx on
error: not armed; send `tx arm` first
ch> tx arm
armed
ch> morse W1AW FOX
sent 9.8
ch> foxdelay 20
20
ch> fox start
running
ch> fox
running 1 14
ch> fox stop
stopped 1
ch> tx disarm
off
```

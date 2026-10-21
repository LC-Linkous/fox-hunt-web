# code.py -- fox-hunt-web firmware (CircuitPython)
# SPDX-License-Identifier: GPL-3.0-only
#
# SAVE TO THE BOARD AS code.py (that exact name auto-runs at boot).
#
# Turns the DEF CON 34 fox (Seeed XIAO ESP32-C3 + NiceRF SA868) into a
# host-controlled receiver. The board boots with the SA868 in RECEIVE and
# holds it there; this build never drives PTT low.
#
# The USB serial console becomes a command shell with a "ch>" prompt, one
# command per line, so the browser page talks to it with the same framing
# it uses for the tinySA. Type `help` from any serial terminal.
#
# One firmware for every fox: the fitted SA868 band (VHF, UHF or dual) is
# a setting the page sets once with `band`, kept in the chip's NVM across
# reboots. The callsign is kept the same way for the TX-capable build.
#
# Hardware and pin map: HamRadioVillage/dc34fox (GPL-3.0). The SA868 AT
# command set is from the NiceRF SA868 datasheet. Ctrl+C in Thonny still
# drops to the REPL; the page never sends it.

import sys
import time
import board
import busio
import digitalio
import pwmio
import supervisor

# ---------------------------------------------------------------- TX gate
# False: receive-only build. Nothing in this file can drive PTT low, the
# transmit commands answer with an error, and no license is needed.
# True: the transmit commands exist. They still refuse until a real
# callsign is stored (`callsign`) and the session is armed (`tx arm`),
# every key-down has a timer, and the board boots in receive either way.
# You need an amateur radio license to set this to True and key an antenna.
TX_ENABLED = False

try:
    import microcontroller
    NVM = microcontroller.nvm
except (ImportError, AttributeError):
    NVM = None

FW_NAME = "foxhunt"
FW_VERSION = "0.4.0"
BOARD_NAME = "xiao-esp32c3"

# ---------------------------------------------------------------- pin map
# Same pins as the dc34fox firmware. Nothing here is configurable on
# purpose: this build targets exactly one board.
PTT_Pin = board.D3          # GPIO05  low = TX, high = RX  (held high)
PD_Pin  = board.D4          # GPIO06  high = module awake
HL_Pin  = board.D5          # GPIO07  low = low power (irrelevant in RX)
RX_Pin  = board.D7          # GPIO20  UART in from the SA868
TX_Pin  = board.D6          # GPIO21  UART out to the SA868
MIC_Pin = board.D1          # GPIO03  audio into the module (unused in RX)
LED_Pin = board.D10         # status LED
SQ_Pin  = board.D2          # GPIO04  optional wire from the SA868's SQ pad (pin 1): low = carrier

# SA868 AF_OUT (module pin 3) is not routed on the fox PCB. Audio for the
# page comes from a wire on that pad to a USB sound card, not from here.
# SA868 SQ (pin 1, squelch detect, low when a carrier opens the squelch) is
# not routed either; a wire from that pad to D2 lets this firmware time
# carrier edges itself (`events`). Off until `sq on` is stored, so a fox
# without the wire never reads a floating pin.

# ---------------------------------------------------------------- bands
# The three SA868 variants NiceRF sells. Which one is fitted cannot be
# read back from the module, so it is a setting (see `band`).
BANDS = {
    "vhf":  ((134.0, 174.0),),
    "uhf":  ((400.0, 480.0),),
    "dual": ((134.0, 174.0), (400.0, 480.0)),
}
BAND_CODES = {"vhf": 1, "uhf": 2, "dual": 3}
BAND_DEFAULT_FREQ = {"vhf": 146.565, "uhf": 433.900, "dual": 146.565}

RSSI_BURST_MAX = 200        # readings per `rssi N`
RSSI_BURST_PERIOD_MS = 100  # ~10 Hz; the UART round trip is ~30 ms
SCAN_MAX_CHANNELS = 128
SCAN_SETTLE_MS = 60         # after a retune, before reading RSSI

TX_KEY_DEFAULT_S = 10       # `tx on` with no argument
TX_KEY_MAX_S = 60           # hard cap on any key-down
TX_MORSE_MAX = 64           # characters per `morse`
TX_PTT_LEAD_MS = 750        # key-up to first tone (the dc34fox value)

# ---------------------------------------------------------------- NVM
# Byte layout, all optional (the magic byte guards each field):
#   0: 0xF0 magic   1: band code
#   8: 0xF1 magic   9: callsign length   10..25: callsign (ASCII)
NVM_BAND_AT, NVM_BAND_MAGIC = 0, 0xF0
NVM_CALL_AT, NVM_CALL_MAGIC, NVM_CALL_MAX = 8, 0xF1, 16
NVM_SQ_AT, NVM_SQ_MAGIC = 28, 0xF2       # 28: magic  29: 1 = SQ wire present
CALLSIGN_PLACEHOLDER = "N0CALL"


def nvm_read_band():
    try:
        if NVM and NVM[NVM_BAND_AT] == NVM_BAND_MAGIC:
            for k, v in BAND_CODES.items():
                if v == NVM[NVM_BAND_AT + 1]:
                    return k
    except Exception:
        pass
    return None


def nvm_write_band(name):
    try:
        if NVM:
            NVM[NVM_BAND_AT:NVM_BAND_AT + 2] = bytes((NVM_BAND_MAGIC, BAND_CODES[name]))
            return True
    except Exception:
        pass
    return False


def nvm_read_callsign():
    try:
        if NVM and NVM[NVM_CALL_AT] == NVM_CALL_MAGIC:
            n = NVM[NVM_CALL_AT + 1]
            if 0 < n <= NVM_CALL_MAX:
                return bytes(NVM[NVM_CALL_AT + 2:NVM_CALL_AT + 2 + n]).decode("ascii")
    except Exception:
        pass
    return CALLSIGN_PLACEHOLDER


def nvm_write_callsign(cs):
    try:
        if NVM:
            b = cs.encode("ascii")
            NVM[NVM_CALL_AT:NVM_CALL_AT + 2 + len(b)] = bytes((NVM_CALL_MAGIC, len(b))) + b
            return True
    except Exception:
        pass
    return False


def nvm_read_sq():
    try:
        return bool(NVM and NVM[NVM_SQ_AT] == NVM_SQ_MAGIC and NVM[NVM_SQ_AT + 1] == 1)
    except Exception:
        return False


def nvm_write_sq(on):
    try:
        if NVM:
            NVM[NVM_SQ_AT:NVM_SQ_AT + 2] = bytes((NVM_SQ_MAGIC, 1 if on else 0))
            return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------- state
state = {
    "band": nvm_read_band(),    # None until the page (or a terminal) sets it
    "callsign": nvm_read_callsign(),
    "freq": 146.565,
    "bw": 1,                    # 0 = 12.5 kHz, 1 = 25 kHz
    "squelch": 3,               # 0-8
    "volume": 5,                # 1-8
    "rssi_cmd": "AT+RSSI?",     # settled at boot (SA818-style "RSSI?" fallback)
    "module_version": "",
    "connected": False,
    # transmit (only meaningful when TX_ENABLED)
    "armed": False,
    "keyed_until": 0,           # ticks_ms when the current key-down ends; 0 = unkeyed
    "power": "low",             # HL pin: low (~25 dBm) or high (~2 W)
    "wpm": 12,
    "tone": 800,
    "foxmsg": "FOX",            # sent as "<callsign> <foxmsg>" each cycle
    "foxdelay": 30,             # seconds between cycles
    "fox_running": False,
    "fox_next": 0,
    "fox_cycles": 0,
    # the SQ wire
    "sq_on": nvm_read_sq(),
    "sq_level": None,           # True = carrier (pin low), updated by the main loop
    "sq_events": [],            # [(ticks_ms, 1|0)] edges since the last `events`, newest last
}
SQ_EVENTS_MAX = 64
if state["band"]:
    state["freq"] = BAND_DEFAULT_FREQ[state["band"]]


def module_name():
    return "sa868-" + (state["band"] or "unset")


def band_ranges():
    return BANDS.get(state["band"], ())


def band_text():
    return " ".join("%g-%g" % r for r in band_ranges()) + " MHz" if band_ranges() else "unset"


# ---------------------------------------------------------------- helpers
def init_pin(pin, value):
    p = digitalio.DigitalInOut(pin)
    p.direction = digitalio.Direction.OUTPUT
    p.value = value
    return p


_TICKS_PERIOD = 1 << 29             # supervisor.ticks_ms() wraps here (about 6.2 days)
_tick_last = 0
_tick_base = 0


def ms():
    """Milliseconds since boot that never wrap, so every deadline is a plain compare."""
    global _tick_last, _tick_base
    t = supervisor.ticks_ms()
    if t < _tick_last:
        _tick_base += _TICKS_PERIOD
    _tick_last = t
    return _tick_base + t


def delay(ms_):
    """Sleep `ms_`, sampling the SQ wire every few ms on the way (sq_poll is a no-op without the wire)."""
    end = ms() + ms_
    while True:
        left = end - ms()
        if left <= 0:
            break
        time.sleep(min(left, 4) / 1000)
        sq_poll()


def in_band(f):
    for lo, hi in band_ranges():
        if lo <= f <= hi:
            return True
    return False


# ---------------------------------------------------------------- SA868
# One UART, 9600 8N1. Every AT command gets one reply line ending in
# \r\n. Replies arrive within a few tens of ms.

def module_cmd(cmd, timeout_ms=400):
    """Send one line to the SA868, return its reply line ('' on timeout)."""
    while uart.in_waiting:           # drop anything stale
        uart.read(uart.in_waiting)
    uart.write(bytes(cmd + "\r\n", "ascii"))
    t0 = ms()
    buf = b""
    while (ms() - t0) < timeout_ms:
        if uart.in_waiting:
            buf += uart.read(uart.in_waiting)
            if b"\n" in buf:
                break
        else:
            delay(2)
    try:
        return buf.decode("ascii").strip()
    except UnicodeError:
        return ""


def module_set_group():
    """Program bandwidth, frequency (RX = TX, no tones), squelch."""
    f = state["freq"]
    return module_cmd("AT+DMOSETGROUP=%d,%.4f,%.4f,0000,%d,0000"
                      % (state["bw"], f, f, state["squelch"]))


def module_set_volume():
    return module_cmd("AT+DMOSETVOLUME=%d" % state["volume"])


def module_rssi():
    """Return the RSSI byte (0-255) or -1 if the module did not answer."""
    r = module_cmd(state["rssi_cmd"], timeout_ms=300)
    if r.startswith("RSSI="):
        try:
            return int(r[5:])
        except ValueError:
            return -1
    return -1


def module_connect():
    """Handshake and settle which RSSI spelling this module speaks."""
    ok = False
    for _ in range(3):
        if module_cmd("AT+DMOCONNECT", timeout_ms=600).startswith("+DMOCONNECT"):
            ok = True
            break
        delay(200)
    state["connected"] = ok
    if not ok:
        return False
    v = module_cmd("AT+VERSION", timeout_ms=400)
    state["module_version"] = v if v else "unknown"
    # SA868 datasheet: AT+RSSI?  Older SA818 firmware: RSSI?
    if not module_cmd("AT+RSSI?").startswith("RSSI="):
        if module_cmd("RSSI?").startswith("RSSI="):
            state["rssi_cmd"] = "RSSI?"
    if state["band"]:
        module_set_group()
    module_set_volume()
    return True


# ---------------------------------------------------------------- transmit
MORSE_MAP = {
    'A': ".-", 'B': "-...", 'C': "-.-.", 'D': "-..", 'E': ".", 'F': "..-.",
    'G': "--.", 'H': "....", 'I': "..", 'J': ".---", 'K': "-.-", 'L': ".-..",
    'M': "--", 'N': "-.", 'O': "---", 'P': ".--.", 'Q': "--.-", 'R': ".-.",
    'S': "...", 'T': "-", 'U': "..-", 'V': "...-", 'W': ".--", 'X': "-..-",
    'Y': "-.--", 'Z': "--..", '0': "-----", '1': ".----", '2': "..---",
    '3': "...--", '4': "....-", '5': ".....", '6': "-....", '7': "--...",
    '8': "---..", '9': "----.", '/': "-..-.", '?': "..--..", '=': "-...-",
}

sound_pwm = None


def tone_on(freq):
    """PWM square wave into the SA868's MIC pin (the dc34fox method)."""
    global mic, sound_pwm
    freq = int(freq)
    if mic:
        mic.deinit()
        mic = None
    if not sound_pwm:
        sound_pwm = pwmio.PWMOut(MIC_Pin, frequency=freq, variable_frequency=True)
        sound_pwm.duty_cycle = 65535 // 2
    else:
        sound_pwm.frequency = freq


def tone_off():
    """Release the PWM and give D1 back to the plain low output. Safe to call when no tone is on."""
    global mic, sound_pwm
    if sound_pwm:
        sound_pwm.deinit()
        sound_pwm = None
    if mic is None:                 # tone_on() released it; claim it again (claiming twice raises)
        mic = init_pin(MIC_Pin, False)


def key(seconds):
    """Drive PTT low for up to `seconds`. The main loop unkeys at the deadline."""
    seconds = max(0.1, min(float(seconds), TX_KEY_MAX_S))
    state["keyed_until"] = ms() + int(seconds * 1000)
    ptt.value = False


def unkey():
    """PTT high first, whatever else fails; then the tone path, then the Morse machine."""
    ptt.value = True
    state["keyed_until"] = 0
    morse_abort()
    try:
        tone_off()
    except Exception:
        pass


def keyed():
    return state["keyed_until"] != 0


def keyed_left_s():
    return max(0, state["keyed_until"] - ms()) / 1000 if keyed() else 0


def tx_allowed():
    """Reason the transmitter may not be used right now, or '' if it may."""
    if not TX_ENABLED:
        return "transmit commands are not enabled in this firmware build (TX_ENABLED is False)"
    if state["callsign"] == CALLSIGN_PLACEHOLDER:
        return "no callsign stored; set one with `callsign` first"
    if not state["armed"]:
        return "not armed; send `tx arm` first"
    if not state["band"]:
        return "module band not set; send `band vhf|uhf|dual` first"
    if not state["connected"]:
        return "the SA868 did not answer its handshake"
    return ""


# The Morse sender is a small state machine, stepped by morse_step(). The
# beacon steps it from the main loop, so the shell keeps answering `info`,
# `tx` and `fox` while a cycle is on the air (the page polls those once a
# second) and a stop command ends the cycle at the next element. The
# `morse` and `tone` commands step it locally until it finishes.
morse = {"elems": [], "i": 0, "next_at": 0, "on": False, "active": False, "result": ""}


def morse_plan(text):
    """[(tone_on, ms), ...] for `text` at the current WPM, without the PTT lead and tail."""
    unit = 60000 / (state["wpm"] * 50)
    elems = []
    first_word = True
    for word in text.upper().split():
        chars = [MORSE_MAP[c] for c in word if c in MORSE_MAP]
        if not chars:
            continue
        if not first_word:
            elems.append((False, unit * 4))
        first_word = False
        for ch in chars:
            for mark in ch:
                elems.append((True, unit if mark == '.' else unit * 3))
                elems.append((False, unit))
            elems.append((False, unit * 2))
    return elems


def morse_start(text, keydown_s):
    """Key up and begin sending `text`; morse_step() does the rest."""
    morse["elems"] = [(False, TX_PTT_LEAD_MS)] + morse_plan(text) + [(False, 200)]
    morse["i"] = 0
    morse["on"] = False
    morse["active"] = True
    morse["result"] = ""
    key(keydown_s)
    morse["next_at"] = ms()


def morse_step():
    """Advance the sender if its current element has elapsed. Unkeys itself at the end."""
    if not morse["active"]:
        return
    if not keyed():                 # the deadline (or a stop) took PTT away: finish quietly
        morse_finish("aborted")
        return
    if ms() < morse["next_at"]:
        return
    if morse["i"] >= len(morse["elems"]):
        morse_finish("sent")
        return
    on, dur = morse["elems"][morse["i"]]
    morse["i"] += 1
    if on and not morse["on"]:
        tone_on(state["tone"])
    elif not on and morse["on"]:
        tone_off()
    morse["on"] = on
    morse["next_at"] = ms() + int(dur)


def morse_finish(result):
    morse["active"] = False
    morse["on"] = False
    morse["result"] = result
    if keyed():
        ptt.value = True
        state["keyed_until"] = 0
    tone_off()


def morse_abort():
    """Called by unkey(): stop sending without touching PTT (unkey already did)."""
    if morse["active"]:
        morse["active"] = False
        morse["on"] = False
        morse["result"] = "aborted"


def send_morse(text, keydown_s):
    """Blocking form for the `morse` command: step until done. A keypress from a human aborts."""
    morse_start(text, keydown_s)
    while morse["active"]:
        morse_step()
        if supervisor.runtime.serial_bytes_available:
            unkey()
            break
        delay(2)
    return morse["result"]


def morse_seconds(text):
    """Air time of `text` at the current WPM, plus lead and tail, in seconds."""
    unit = 60.0 / (state["wpm"] * 50)
    units = 0
    for word in text.upper().split():
        for c in word:
            for mark in MORSE_MAP.get(c, ""):
                units += (1 if mark == '.' else 3) + 1
            units += 2
        units += 4
    return units * unit + (TX_PTT_LEAD_MS + 200) / 1000


def fox_cycle():
    """Begin one beacon cycle: callsign + message in Morse. The main loop steps it and schedules the next."""
    text = "%s %s" % (state["callsign"], state["foxmsg"])
    morse_start(text, morse_seconds(text) + 2)
    led.value = True


def fox_cycle_done():
    """Called by the main loop when a cycle's Morse has finished."""
    state["fox_cycles"] += 1
    state["fox_next"] = ms() + state["foxdelay"] * 1000
    led.value = state["connected"]


# ---------------------------------------------------------------- SQ wire
sq = None


def sq_setup():
    """Pull-up input on D2 when the wire is declared present; released otherwise."""
    global sq
    if state["sq_on"] and sq is None:
        sq = digitalio.DigitalInOut(SQ_Pin)
        sq.direction = digitalio.Direction.INPUT
        sq.pull = digitalio.Pull.UP
        state["sq_level"] = not sq.value
    elif not state["sq_on"] and sq is not None:
        sq.deinit()
        sq = None
        state["sq_level"] = None
        state["sq_events"] = []


def sq_poll():
    """Called every main-loop pass: records carrier edges with the tick they were seen."""
    if sq is None:
        return
    level = not sq.value            # low = carrier
    if level != state["sq_level"]:
        state["sq_level"] = level
        state["sq_events"].append((ms(), 1 if level else 0))
        if len(state["sq_events"]) > SQ_EVENTS_MAX:
            state["sq_events"].pop(0)


# ---------------------------------------------------------------- shell
PROMPT = "ch> "


def out(line=""):
    sys.stdout.write(line + "\r\n")


def prompt():
    sys.stdout.write(PROMPT)


_inbuf = ""


def read_command():
    """Non-blocking: return a complete line (without EOL) or None."""
    global _inbuf
    while supervisor.runtime.serial_bytes_available:
        c = sys.stdin.read(1)
        if c == "\r" or c == "\n":
            if _inbuf == "" and c == "\n":
                continue            # a lone \n, or the \n of a pair that arrived late
            line = _inbuf
            _inbuf = ""
            if c == "\r" and supervisor.runtime.serial_bytes_available:
                c2 = sys.stdin.read(1)
                if c2 != "\n":
                    _inbuf = c2     # not a pair: keep the byte for the next line
            # the \n of a \r\n pair is swallowed here, not left in the buffer: the
            # burst, scan and Morse loops treat any pending byte as "stop"
            return line
        if c in ("\x08", "\x7f"):   # backspace for humans in a terminal
            _inbuf = _inbuf[:-1]
            continue
        if len(_inbuf) < 120:
            _inbuf += c
    return None


# ---------------------------------------------------------------- commands
# Each handler gets the argument list and prints its reply. The shell
# prints the echo before and the prompt after. A handler that refuses
# prints a line starting with "usage:" or "error:" so the page can tell.

def need_band():
    """True (and prints the error) when no band has been set yet."""
    if state["band"]:
        return False
    out("error: module band not set; send `band vhf|uhf|dual` first")
    return True


def cmd_version(args):
    out("%s %s %s %s" % (FW_NAME, FW_VERSION, BOARD_NAME, module_name()))


def cmd_info(args):
    if not state["connected"]:
        module_connect()            # a module that was slow to power up gets another chance
    out("firmware: %s %s" % (FW_NAME, FW_VERSION))
    out("board: %s" % BOARD_NAME)
    out("module: %s %s" % (module_name(), "connected" if state["connected"] else "NOT RESPONDING"))
    out("module_version: %s" % state["module_version"])
    out("band: %s" % (state["band"] or "unset"))
    out("bands: %s" % band_text())
    out("callsign: %s" % state["callsign"])
    out("freq: %.4f" % state["freq"])
    out("bw: %d" % state["bw"])
    out("squelch: %d" % state["squelch"])
    out("volume: %d" % state["volume"])
    out("rssi_cmd: %s" % state["rssi_cmd"])
    out("nvm: %s" % ("yes" if NVM else "no"))
    out("sq: %s" % ("on %s" % ("carrier" if state["sq_level"] else "quiet") if state["sq_on"] else "off"))
    out("ptt: %s" % ("TX keyed %.1f s left" % keyed_left_s() if keyed() else "rx"))
    out("tx: %s" % ("available" if TX_ENABLED else "disabled"))
    out("armed: %s" % ("yes" if state["armed"] else "no"))
    out("power: %s" % state["power"])
    out("wpm: %d" % state["wpm"])
    out("tone: %d" % state["tone"])
    out("foxmsg: %s" % state["foxmsg"])
    out("foxdelay: %d" % state["foxdelay"])
    out("fox: %s (%d cycles)" % ("running" if state["fox_running"] else "stopped", state["fox_cycles"]))


def cmd_help(args):
    out("commands: version info help band callsign tune rssi scan squelch bw volume at rx led sq events")
    if TX_ENABLED:
        out("transmit: tx arm|disarm|on [s]|off  tone {Hz} {ms}  morse {text}  power low|high  wpm {n}  foxmsg {text}  foxdelay {s}  fox start|stop")
    else:
        out("transmit: disabled in this build (TX_ENABLED is False)")


def cmd_band(args):
    """band -> current. band vhf|uhf|dual -> set and persist."""
    if not args:
        out(state["band"] or "unset")
        return
    name = args[0].lower()
    if name not in BANDS:
        out("usage: band vhf|uhf|dual")
        return
    if keyed():
        out("error: keyed; send `tx off` first")
        return
    changed = name != state["band"]
    state["band"] = name
    if changed or not in_band(state["freq"]):
        state["freq"] = BAND_DEFAULT_FREQ[name]
    persisted = nvm_write_band(name)
    if state["connected"]:
        module_set_group()
    out("%s%s" % (name, "" if persisted else " (not persisted: no nvm)"))


def cmd_callsign(args):
    """callsign -> current. callsign {CALL} -> set and persist (A-Z 0-9 /)."""
    if not args:
        out(state["callsign"])
        return
    cs = args[0].upper()
    if len(cs) > NVM_CALL_MAX or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/" for c in cs):
        out("usage: callsign {A-Z 0-9 /, up to %d}" % NVM_CALL_MAX)
        return
    state["callsign"] = cs
    persisted = nvm_write_callsign(cs)
    out("%s%s" % (cs, "" if persisted else " (not persisted: no nvm)"))


def cmd_tune(args):
    if not args:
        out("%.4f" % state["freq"])
        return
    if need_band():
        return
    try:
        f = float(args[0])
    except ValueError:
        out("usage: tune {MHz}")
        return
    if not in_band(f):
        out("error: %.4f MHz is outside %s" % (f, band_text()))
        return
    if keyed():
        out("error: keyed; send `tx off` first")
        return
    state["freq"] = f
    r = module_set_group()
    if r.startswith("+DMOSETGROUP:0"):
        out("%.4f" % f)
    else:
        out("error: module replied '%s'" % r)


def cmd_rssi(args):
    """rssi -> one reading. rssi N -> N lines of 'ms rssi' at ~10 Hz."""
    n = 1
    if args:
        try:
            n = int(args[0])
        except ValueError:
            out("usage: rssi [count]")
            return
        if n < 1 or n > RSSI_BURST_MAX:
            out("usage: rssi [1..%d]" % RSSI_BURST_MAX)
            return
    if n == 1:
        out("%d" % module_rssi())
        return
    t0 = ms()
    for i in range(n):
        tick = ms()
        out("%d %d" % (tick - t0, module_rssi()))
        spent = ms() - tick
        if spent < RSSI_BURST_PERIOD_MS:
            delay(RSSI_BURST_PERIOD_MS - spent)
        if supervisor.runtime.serial_bytes_available:
            break                   # any keypress stops a burst


def cmd_scan(args):
    """scan {start} {stop} {step_kHz} -> one 'freq rssi' line per channel."""
    if len(args) != 3:
        out("usage: scan {start_MHz} {stop_MHz} {step_kHz}")
        return
    if need_band():
        return
    try:
        start, stop, step = float(args[0]), float(args[1]), float(args[2])
    except ValueError:
        out("usage: scan {start_MHz} {stop_MHz} {step_kHz}")
        return
    if step <= 0 or stop < start:
        out("usage: start <= stop, step > 0")
        return
    if not (in_band(start) and in_band(stop)):
        out("error: range is outside %s" % band_text())
        return
    if keyed():
        out("error: keyed; send `tx off` first")
        return
    count = int((stop - start) / (step / 1000.0) + 0.5) + 1
    if count > SCAN_MAX_CHANNELS:
        out("error: %d channels; the limit is %d" % (count, SCAN_MAX_CHANNELS))
        return
    keep = state["freq"]
    for i in range(count):
        f = start + i * step / 1000.0
        state["freq"] = f
        module_set_group()
        delay(SCAN_SETTLE_MS)
        out("%.4f %d" % (f, module_rssi()))
        if supervisor.runtime.serial_bytes_available:
            break
    state["freq"] = keep
    module_set_group()


def _int_setting(args, key, lo, hi, name):
    if not args:
        out("%d" % state[key])
        return False
    try:
        v = int(args[0])
    except ValueError:
        out("usage: %s {%d..%d}" % (name, lo, hi))
        return False
    if v < lo or v > hi:
        out("usage: %s {%d..%d}" % (name, lo, hi))
        return False
    state[key] = v
    return True


def _group_reply(key, r):
    out("%d" % state[key] if r.startswith("+DMOSETGROUP:0") else "error: module replied '%s'" % r)


def cmd_squelch(args):
    if _int_setting(args, "squelch", 0, 8, "squelch"):
        _group_reply("squelch", module_set_group())


def cmd_bw(args):
    if _int_setting(args, "bw", 0, 1, "bw"):
        _group_reply("bw", module_set_group())


def cmd_volume(args):
    if _int_setting(args, "volume", 1, 8, "volume"):
        r = module_set_volume()
        out("%d" % state["volume"] if r.startswith("+DMOSETVOLUME:0") else "error: module replied '%s'" % r)


def cmd_at(args):
    """at {raw AT command} -> the module's reply line, for the console."""
    if not args:
        out("usage: at {AT+...}")
        return
    r = module_cmd(" ".join(args), timeout_ms=1500)
    out(r if r else "(no reply)")


def cmd_rx(args):
    """Back to receive: stops the beacon, unkeys, re-asserts PTT high and PD high."""
    state["fox_running"] = False
    unkey()
    pd.value = True
    out("rx")


def cmd_led(args):
    if not args or args[0] not in ("on", "off"):
        out("usage: led on|off")
        return
    led.value = args[0] == "on"
    out(args[0])


def tx_refuse():
    why = tx_allowed()
    if why:
        out("error: " + why)
    return bool(why)


def cmd_tx(args):
    """tx -> status. tx arm|disarm. tx on [s] / tx off."""
    if not args:
        if not TX_ENABLED:
            out("disabled")
        elif keyed():
            out("on %.1f" % keyed_left_s())
        else:
            out("armed" if state["armed"] else "off")
        return
    w = args[0].lower()
    if not TX_ENABLED:
        out("error: transmit commands are not enabled in this firmware build (TX_ENABLED is False)")
        return
    if w == "arm":
        if state["callsign"] == CALLSIGN_PLACEHOLDER:
            out("error: no callsign stored; set one with `callsign` first")
            return
        state["armed"] = True
        out("armed")
    elif w == "disarm":
        state["armed"] = False
        state["fox_running"] = False
        unkey()
        out("off")
    elif w == "on":
        if tx_refuse():
            return
        secs = TX_KEY_DEFAULT_S
        if len(args) > 1:
            try:
                secs = float(args[1])
            except ValueError:
                out("usage: tx on [seconds]")
                return
        if secs > TX_KEY_MAX_S:
            out("usage: tx on [1..%d]" % TX_KEY_MAX_S)
            return
        key(secs)
        out("on %.1f" % keyed_left_s())
    elif w == "off":
        unkey()
        out("off")
    else:
        out("usage: tx [arm|disarm|on [s]|off]")


def cmd_tone(args):
    """tone {Hz} {ms}: key, send one tone, unkey. For checking the audio path."""
    if len(args) != 2:
        out("usage: tone {Hz} {ms}")
        return
    try:
        hz, dur = int(args[0]), int(args[1])
    except ValueError:
        out("usage: tone {Hz} {ms}")
        return
    if not (300 <= hz <= 3000) or not (10 <= dur <= 5000):
        out("usage: tone {300..3000} {10..5000}")
        return
    if tx_refuse():
        return
    key(TX_PTT_LEAD_MS / 1000 + dur / 1000 + 0.5)
    delay(TX_PTT_LEAD_MS)
    tone_on(hz)
    delay(dur)
    tone_off()
    delay(100)
    unkey()
    out("sent %d Hz %d ms" % (hz, dur))


def cmd_morse(args):
    """morse {text}: key, send the text in Morse at `wpm`, unkey."""
    if not args:
        out("usage: morse {text}")
        return
    text = " ".join(args)
    if len(text) > TX_MORSE_MAX:
        out("usage: morse text up to %d characters" % TX_MORSE_MAX)
        return
    if tx_refuse():
        return
    out("%s %.1f" % (send_morse(text, morse_seconds(text) + 2), morse_seconds(text)))


def cmd_power(args):
    if not args:
        out(state["power"])
        return
    w = args[0].lower()
    if w not in ("low", "high"):
        out("usage: power low|high")
        return
    if not TX_ENABLED:
        out("error: transmit commands are not enabled in this firmware build (TX_ENABLED is False)")
        return
    state["power"] = w
    hl.value = (w == "high")
    out(w)


def cmd_wpm(args):
    if _int_setting(args, "wpm", 5, 35, "wpm"):
        out("%d" % state["wpm"])


def cmd_foxmsg(args):
    if not args:
        out(state["foxmsg"])
        return
    text = " ".join(args).upper()
    if len(text) > 40 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/?= " for c in text):
        out("usage: foxmsg {A-Z 0-9 / ? = and spaces, up to 40}")
        return
    state["foxmsg"] = text
    out(text)


def cmd_foxdelay(args):
    if _int_setting(args, "foxdelay", 5, 600, "foxdelay"):
        out("%d" % state["foxdelay"])


def cmd_fox(args):
    """fox -> status. fox start|stop: the beacon loop, run by the main loop."""
    if not args:
        out("%s %d %d" % ("running" if state["fox_running"] else "stopped", state["fox_cycles"], max(0, state["fox_next"] - ms()) // 1000 if state["fox_running"] else 0))
        return
    w = args[0].lower()
    if w == "start":
        if tx_refuse():
            return
        state["fox_running"] = True
        state["fox_cycles"] = 0
        state["fox_next"] = ms()            # first cycle right away
        out("running")
    elif w == "stop":
        state["fox_running"] = False
        unkey()
        out("stopped %d" % state["fox_cycles"])
    else:
        out("usage: fox [start|stop]")


def cmd_sq(args):
    """sq -> level. sq on|off -> declare the wire present (persisted)."""
    if not args:
        out("off" if not state["sq_on"] else ("carrier" if state["sq_level"] else "quiet"))
        return
    w = args[0].lower()
    if w not in ("on", "off"):
        out("usage: sq on|off")
        return
    state["sq_on"] = (w == "on")
    persisted = nvm_write_sq(state["sq_on"])
    sq_setup()
    out("%s%s" % (w, "" if persisted else " (not persisted: no nvm)"))


def cmd_events(args):
    """events -> 'now {ticks} carrier|quiet' then one '{ticks} 1|0' line per carrier edge since the last call."""
    if not state["sq_on"]:
        out("error: the SQ wire is not enabled; send `sq on` once it is soldered to D2")
        return
    out("now %d %s" % (ms(), "carrier" if state["sq_level"] else "quiet"))
    for t, lvl in state["sq_events"]:
        out("%d %d" % (t, lvl))
    state["sq_events"] = []


COMMANDS = {
    "version": cmd_version,
    "info": cmd_info,
    "help": cmd_help,
    "band": cmd_band,
    "callsign": cmd_callsign,
    "tune": cmd_tune,
    "rssi": cmd_rssi,
    "scan": cmd_scan,
    "squelch": cmd_squelch,
    "bw": cmd_bw,
    "volume": cmd_volume,
    "at": cmd_at,
    "rx": cmd_rx,
    "led": cmd_led,
    "sq": cmd_sq,
    "events": cmd_events,
    # transmit: all refused unless TX_ENABLED, a callsign is stored, and `tx arm` was sent
    "tx": cmd_tx,
    "tone": cmd_tone,
    "morse": cmd_morse,
    "power": cmd_power,
    "wpm": cmd_wpm,
    "foxmsg": cmd_foxmsg,
    "foxdelay": cmd_foxdelay,
    "fox": cmd_fox,
}


def dispatch(line):
    words = line.strip().split()
    if not words:
        return
    name = words[0].lower()
    handler = COMMANDS.get(name)
    if handler is None:
        out("%s?" % name)             # the tinySA's "unknown command" shape
        return
    handler(words[1:])


# ---------------------------------------------------------------- setup
uart = busio.UART(TX_Pin, RX_Pin, baudrate=9600, timeout=0.05)

ptt = init_pin(PTT_Pin, True)       # RX, and it stays that way
pd = init_pin(PD_Pin, True)
hl = init_pin(HL_Pin, False)
mic = init_pin(MIC_Pin, False)
led = init_pin(LED_Pin, False)

delay(800)                          # module power-up
module_connect()
sq_setup()

out("")
out("%s %s %s %s" % (FW_NAME, FW_VERSION, BOARD_NAME, module_name()))
if not state["connected"]:
    out("** SA868 did not answer the handshake; check the module power **")
elif not state["band"]:
    out("SA868 ready; module band not set yet (band vhf|uhf|dual)")
else:
    out("SA868 ready, receiving on %.4f MHz (%s)" % (state["freq"], state["band"]))
if TX_ENABLED:
    out("transmit enabled: boots in receive; `callsign`, then `tx arm`, before any TX command")
else:
    out("receive only: PTT is held high. type help.")
prompt()

led.value = state["connected"]      # steady LED = module answered

# ---------------------------------------------------------------- loop
while True:
    sq_poll()
    # key-down deadline: nothing stays keyed past its timer, whatever the host does
    if keyed() and ms() >= state["keyed_until"]:
        unkey()
    # the beacon's Morse is stepped from here, so the shell answers during a cycle
    if morse["active"]:
        morse_step()
        if not morse["active"] and state["fox_running"]:
            fox_cycle_done()
            if morse["result"] == "aborted":
                state["fox_running"] = False
    elif state["fox_running"] and not keyed() and ms() >= state["fox_next"]:
        if tx_allowed():
            state["fox_running"] = False
        else:
            fox_cycle()
    line = read_command()
    if line is None:
        delay(5)
        continue
    out(line)                       # echo, as the console framing expects
    try:
        dispatch(line)
    except Exception as e:          # keep the shell alive
        out("error: %s" % e)
    prompt()

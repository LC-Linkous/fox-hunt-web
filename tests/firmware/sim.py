"""Simulated hardware for firmware/code.py: runs the real firmware on the desk.

The firmware is executed unmodified, with its `import board / busio / digitalio /
pwmio / supervisor / microcontroller / time / sys` resolved to the fakes here:

  - a virtual clock (time.sleep advances it; supervisor.ticks_ms reads it) so a
    `rssi 100` burst or a Morse beacon takes milliseconds of real time;
  - a fake SA868 on the UART that answers the AT commands the way the module
    does and models what is on the air (carriers by frequency and strength,
    keyed on a schedule), so RSSI, scans and the SQ pin all agree;
  - pins the tests can read (PTT, PD, LED, MIC/PWM) and drive (the SQ wire);
  - an NVM bytearray that survives a simulated reboot;
  - a console: the test writes a line, reads back everything up to `ch> `.

SPDX-License-Identifier: GPL-2.0-only
"""
import os
import queue
import threading
import time as real_time

FIRMWARE = os.path.join(os.path.dirname(__file__), '..', '..', 'firmware', 'code.py')


class VirtualClock:
    """Milliseconds that advance when the firmware sleeps, not when the wall clock does."""
    def __init__(self):
        self.ms = 1000.0
        self.lock = threading.Lock()

    def sleep(self, s):
        with self.lock:
            self.ms += s * 1000.0
        real_time.sleep(0.0002)     # let the test thread run


class Pin:
    """digitalio.DigitalInOut: an output the test can read, or an input the sim drives."""
    def __init__(self, sim, name):
        self.sim, self.name = sim, name
        self.direction = None
        self.pull = None
        self._value = False
        self.deinited = False
        sim.pins[name] = self
        sim.pin_log.append((name, 'init'))

    @property
    def value(self):
        if self.direction == 'in':
            return self.sim.input_level(self.name)
        return self._value

    @value.setter
    def value(self, v):
        v = bool(v)
        if self._value != v:
            self.sim.pin_log.append((self.name, round(self.sim.clock.ms), v))
        self._value = v

    def deinit(self):
        self.deinited = True
        self.sim.pins.pop(self.name, None)


class PWM:
    def __init__(self, sim, pin, frequency=440, duty_cycle=0, variable_frequency=False):
        self.sim, self.pin, self.frequency, self.duty_cycle = sim, pin, frequency, duty_cycle
        self.deinited = False
        sim.pwm = self
        sim.tone_log.append(('on', round(sim.clock.ms), frequency))

    def deinit(self):
        self.deinited = True
        self.sim.tone_log.append(('off', round(self.sim.clock.ms)))
        if self.sim.pwm is self:
            self.sim.pwm = None


class SA868:
    """The module on the UART. Models what is on the air so RSSI, scans and SQ agree."""
    def __init__(self, sim, rssi_cmd='AT+RSSI?', answer=True, version='+VERSION:SA868S-VHF/UHF_V1.6'):
        self.sim = sim
        self.rssi_cmd = rssi_cmd
        self.answer = answer
        self.version = version
        self.rx = b''               # bytes the firmware has sent us, not yet a line
        self.tx = b''               # our reply bytes waiting for the firmware
        self.freq = None
        self.bw = 1
        self.squelch = 3
        self.volume = 5
        self.log = []               # every AT line received
        self.carriers = []          # dicts: f, rssi, on (s), period (s), phase (s); on=None → continuous
        self.floor = 28

    # --- what the firmware sees as busio.UART -------------------------------
    @property
    def in_waiting(self):
        return len(self.tx)

    def read(self, n):
        out, self.tx = self.tx[:n], self.tx[n:]
        return out

    def write(self, b):
        self.rx += b
        while b'\n' in self.rx:
            line, self.rx = self.rx.split(b'\n', 1)
            self._handle(line.decode('ascii', 'replace').strip())

    def _reply(self, s):
        if self.answer:
            self.tx += (s + '\r\n').encode('ascii')

    def _handle(self, cmd):
        self.log.append(cmd)
        if cmd == 'AT+DMOCONNECT':
            self._reply('+DMOCONNECT:0')
        elif cmd == 'AT+VERSION':
            self._reply(self.version)
        elif cmd.startswith('AT+DMOSETGROUP='):
            p = cmd.split('=', 1)[1].split(',')
            self.bw, self.freq, self.squelch = int(p[0]), float(p[2]), int(p[4])
            self._reply('+DMOSETGROUP:0')
        elif cmd.startswith('AT+DMOSETVOLUME='):
            self.volume = int(cmd.split('=', 1)[1])
            self._reply('+DMOSETVOLUME:0')
        elif cmd == self.rssi_cmd:
            self._reply('RSSI=%d' % self.rssi_now())
        elif cmd in ('AT+RSSI?', 'RSSI?'):
            pass                    # the other spelling: no reply, like a module that does not know it
        else:
            self._reply('+ERROR')

    # --- the air -------------------------------------------------------------
    def strength(self, f=None, at_ms=None):
        f = self.freq if f is None else f
        at = self.sim.clock.ms if at_ms is None else at_ms
        if f is None:
            return 0
        v = 0
        for c in self.carriers:
            if c.get('on') is not None:
                t = at / 1000.0
                if ((t + c.get('phase', 0)) % c['period']) >= c['on']:
                    continue
            d = abs(f - c['f']) * 1000
            half = 12.5 if self.bw else 6.25
            sel = 1 if d <= half else max(0, 1 - (d - half) / (half * 1.5))
            v = max(v, c['rssi'] * sel)
        return v

    def rssi_now(self):
        return int(max(self.floor, self.strength()))

    def squelch_open(self, at_ms=None):
        """Pin 1 (Audio ON / SQ): low while the signal clears the squelch setting."""
        return self.strength(at_ms=at_ms) > 32 + 8 * self.squelch


class Sim:
    """One firmware run on simulated hardware. Use `Sim.boot()`; talk with `cmd()`."""
    def __init__(self, tx_enabled=False, nvm=None, module=None, sq_wired=False):
        self.clock = VirtualClock()
        self.pins = {}
        self.pin_log = []
        self.tone_log = []
        self.pwm = None
        self.nvm = bytearray(8192) if nvm is None else nvm
        self.module = module or SA868(self)
        self.sq_wired = sq_wired        # a wire from the module's pin 1 to D2
        self.sq_override = None         # the test can force the D2 level
        self.stdin = queue.Queue()
        self.stdout = b''
        self.stdout_lock = threading.Lock()
        self.tx_enabled = tx_enabled
        self.thread = None
        self.error = None
        self.globals = None

    # --- what the firmware sees -----------------------------------------------
    def input_level(self, pin_name):
        if pin_name == 'D2':
            if self.sq_override is not None:
                return self.sq_override
            if not self.sq_wired:
                return True         # pulled up, nothing attached
            return not self.module.squelch_open()
        return True

    def _modules(self):
        sim = self

        class _Board:
            pass
        board = _Board()
        for n in ('D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'):
            setattr(board, n, n)

        class _Direction:
            INPUT, OUTPUT = 'in', 'out'

        class _Pull:
            UP, DOWN = 'up', 'down'

        class _DigitalIO:
            Direction, Pull = _Direction, _Pull

            @staticmethod
            def DigitalInOut(pin):
                if pin in sim.pins and not sim.pins[pin].deinited:
                    raise ValueError('%s in use' % pin)        # CircuitPython refuses to claim a pin twice
                return Pin(sim, pin)

        class _PWMIO:
            @staticmethod
            def PWMOut(pin, frequency=440, duty_cycle=0, variable_frequency=False):
                if pin in sim.pins and not sim.pins[pin].deinited:
                    raise ValueError('%s in use' % pin)
                return PWM(sim, pin, frequency, duty_cycle, variable_frequency)

        class _UARTFactory:
            @staticmethod
            def UART(tx, rx, baudrate=9600, timeout=0.05):
                sim.uart_pins = (tx, rx, baudrate)
                return sim.module

        class _Runtime:
            @property
            def serial_bytes_available(self):
                return not sim.stdin.empty()

        class _Supervisor:
            runtime = _Runtime()

            @staticmethod
            def ticks_ms():
                return int(sim.clock.ms) & 0x1FFFFFFF      # CircuitPython wraps at 2**29

        class _Microcontroller:
            nvm = sim.nvm

        class _Time:
            @staticmethod
            def sleep(s):
                sim.clock.sleep(s)

            @staticmethod
            def monotonic():
                return sim.clock.ms / 1000.0

        class _Stdin:
            @staticmethod
            def read(n=1):
                c = sim.stdin.get()
                if c is STOP:
                    raise StopSim()
                return c

        class _Stdout:
            @staticmethod
            def write(s):
                with sim.stdout_lock:
                    sim.stdout += s.encode('utf-8')

        class _Sys:
            stdin, stdout = _Stdin(), _Stdout()

            class implementation:
                name, version = 'circuitpython', (9, 2, 0)
            platform = 'ESP32-C3'

        return {'board': board, 'busio': _UARTFactory, 'digitalio': _DigitalIO, 'pwmio': _PWMIO,
                'supervisor': _Supervisor, 'microcontroller': _Microcontroller, 'time': _Time, 'sys': _Sys}

    # --- running ---------------------------------------------------------------
    @classmethod
    def boot(cls, **kw):
        sim = cls(**kw)
        sim.start()
        sim.banner = sim.wait_prompt(real_timeout=5)
        return sim

    def start(self):
        with open(FIRMWARE, encoding='utf-8') as fh:
            src = fh.read()
        if self.tx_enabled:
            src = src.replace('TX_ENABLED = False', 'TX_ENABLED = True', 1)
        mods = self._modules()
        real_import = __import__

        def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name in mods:
                return mods[name]
            return real_import(name, globals, locals, fromlist, level)

        import builtins
        g = {'__name__': 'code', '__builtins__': dict(vars(builtins), __import__=fake_import)}
        self.globals = g
        code = compile(src, 'code.py', 'exec')

        def run():
            try:
                exec(code, g)
            except StopSim:
                pass
            except BaseException as e:    # noqa: BLE001 - report, the test asserts on it
                self.error = e
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def stop(self):
        """End the firmware thread: the next console read raises StopSim inside it."""
        self.stdin.put(STOP)

    # --- the console -------------------------------------------------------------
    def send(self, line):
        for ch in line + '\r\n':
            self.stdin.put(ch)

    def take(self):
        with self.stdout_lock:
            out, self.stdout = self.stdout, b''
        return out.decode('utf-8', 'replace')

    def wait_prompt(self, real_timeout=3.0):
        """Everything printed up to and including the next `ch> `."""
        t0 = real_time.time()
        while True:
            with self.stdout_lock:
                i = self.stdout.find(b'ch> ')
                if i != -1:
                    out, self.stdout = self.stdout[:i + 4], self.stdout[i + 4:]
                    return out.decode('utf-8', 'replace')
            if self.error:
                raise RuntimeError('firmware died: %r' % (self.error,))
            if real_time.time() - t0 > real_timeout:
                raise TimeoutError('no prompt; output so far: %r' % self.stdout[-200:])
            real_time.sleep(0.001)

    def cmd(self, line, real_timeout=3.0):
        """Send one command; return its reply lines (echo and prompt stripped)."""
        self.take()
        self.send(line)
        out = self.wait_prompt(real_timeout)
        lines = out.replace('\r\n', '\n').split('\n')
        assert lines[0] == line, 'echo expected %r, got %r' % (line, lines[0])
        body = [l for l in lines[1:] if l not in ('', 'ch> ')]
        return body

    def one(self, line, **kw):
        body = self.cmd(line, **kw)
        return body[0] if body else ''

    def kv(self):
        d = {}
        for l in self.cmd('info'):
            k, _, v = l.partition(':')
            d[k.strip()] = v.strip()
        return d

    @property
    def state(self):
        return self.globals['state']

    def pin(self, name):
        return self.pins[name]

    def idle(self, ms):
        """Let the main loop run for `ms` of virtual time (the firmware is idle, sleeping 5 ms a pass)."""
        target = self.clock.ms + ms
        t0 = real_time.time()
        while self.clock.ms < target:
            if real_time.time() - t0 > 10:
                raise TimeoutError('firmware stopped advancing the clock')
            real_time.sleep(0.001)


class StopSim(BaseException):
    pass


class _Stop:
    pass


STOP = _Stop()

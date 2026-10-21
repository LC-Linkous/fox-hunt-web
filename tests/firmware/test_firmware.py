"""The real firmware on simulated hardware. Run: python3 -m unittest discover -s tests/firmware -v
SPDX-License-Identifier: GPL-2.0-only
"""
import unittest
from sim import Sim, SA868


class Boot(unittest.TestCase):
    def test_boots_in_receive_with_band_unset(self):
        sim = Sim.boot()
        banner = sim.take()
        self.assertIn('foxhunt 0.5.0 xiao-esp32c3 sa868-unset', sim.one('version'))
        self.assertTrue(sim.pin('D3').value, 'PTT must be high (receive) after boot')
        self.assertTrue(sim.pin('D4').value, 'PD high: module awake')
        self.assertTrue(sim.pin('D10').value, 'LED on: module answered')
        self.assertEqual(sim.uart_pins[:2], ('D6', 'D7'))
        self.assertIn('AT+DMOCONNECT', sim.module.log)
        self.assertNotIn('D2', sim.pins, 'D2 is not touched until `sq on`')
        kv = sim.kv()
        self.assertEqual(kv['band'], 'unset'); self.assertEqual(kv['nvm'], 'yes'); self.assertEqual(kv['tx'], 'disabled'); self.assertEqual(kv['sq'], 'off')
        self.assertEqual(kv['rssi_cmd'], 'AT+RSSI?')
        sim.stop()

    def test_module_not_answering(self):
        sim = Sim.boot(module=None)
        sim.module.answer = False
        sim.stop()
        sim2 = Sim(); sim2.module.answer = False; sim2.start()
        self.assertIn('did not answer', sim2.wait_prompt(5))
        self.assertFalse(sim2.pin('D10').value)
        self.assertIn('NOT RESPONDING', sim2.kv()['module'])
        self.assertEqual(sim2.one('rssi'), '-1')
        sim2.stop()

    def test_old_rssi_spelling_is_detected(self):
        sim = Sim(); sim.module = SA868(sim, rssi_cmd='RSSI?'); sim.start(); sim.wait_prompt(5)
        self.assertEqual(sim.kv()['rssi_cmd'], 'RSSI?')
        sim.cmd('band vhf')
        self.assertEqual(sim.one('rssi'), '28')
        sim.stop()

    def test_unknown_command_and_usage_shapes(self):
        sim = Sim.boot()
        self.assertEqual(sim.one('frobnicate'), 'frobnicate?')
        self.assertTrue(sim.one('band xyz').startswith('usage:'))
        self.assertTrue(sim.one('tune 146.5').startswith('error:'))   # band not set
        self.assertEqual(sim.cmd(''), [])
        sim.stop()


class Persistence(unittest.TestCase):
    def test_band_callsign_sq_survive_a_reboot(self):
        sim = Sim.boot()
        self.assertEqual(sim.one('band uhf'), 'uhf')
        self.assertEqual(sim.one('callsign w1aw'), 'W1AW')
        self.assertEqual(sim.one('sq on'), 'on')
        self.assertIn('433.9000', sim.one('tune'))
        nvm = sim.nvm; sim.stop()
        sim2 = Sim.boot(nvm=nvm)
        kv = sim2.kv()
        self.assertEqual(kv['band'], 'uhf'); self.assertEqual(kv['callsign'], 'W1AW'); self.assertTrue(kv['sq'].startswith('on'))
        self.assertIn('D2', sim2.pins); self.assertEqual(sim2.pin('D2').direction, 'in'); self.assertEqual(sim2.pin('D2').pull, 'up')
        self.assertIn('AT+DMOSETGROUP=1,433.9000,433.9000,0000,3,0000', sim2.module.log)
        sim2.stop()

    def test_callsign_validation(self):
        sim = Sim.boot()
        self.assertTrue(sim.one('callsign toolongcallsign12345').startswith('usage:'))
        self.assertTrue(sim.one('callsign w1-aw').startswith('usage:'))
        self.assertEqual(sim.one('callsign'), 'N0CALL')
        sim.stop()


class Receiver(unittest.TestCase):
    def setUp(self):
        self.sim = Sim.boot(); self.sim.cmd('band dual')
        self.sim.module.carriers = [{'f': 146.565, 'rssi': 210, 'on': 12, 'period': 40, 'phase': 0}, {'f': 433.9, 'rssi': 140}]

    def tearDown(self):
        self.sim.stop()

    def test_tune_rejects_out_of_band_and_programs_the_module(self):
        s = self.sim
        self.assertEqual(s.one('tune 146.52'), '146.5200')
        self.assertEqual(s.module.freq, 146.52)
        self.assertTrue(s.one('tune 300').startswith('error:'))
        self.assertEqual(s.module.freq, 146.52, 'a refused tune must not touch the module')
        self.assertEqual(s.one('tune 433.9'), '433.9000')
        self.assertEqual(s.one('rssi'), '140')

    def test_rssi_burst_timing_and_abort(self):
        s = self.sim; s.cmd('tune 433.9')
        lines = s.cmd('rssi 5')
        self.assertEqual(len(lines), 5)
        ticks = [int(l.split()[0]) for l in lines]
        self.assertEqual(ticks[0], 0)
        for a, b in zip(ticks, ticks[1:]):
            self.assertTrue(95 <= b - a <= 110, 'burst period %d' % (b - a))
        self.assertTrue(all(l.split()[1] == '140' for l in lines))
        self.assertTrue(s.one('rssi 0').startswith('usage:')); self.assertTrue(s.one('rssi 201').startswith('usage:'))
        # a byte during a long burst stops it
        s.take(); s.send('rssi 200'); s.send('')
        out = s.wait_prompt(5)
        self.assertLess(out.count('\n'), 60)

    def test_scan_restores_the_tuned_frequency(self):
        s = self.sim; s.cmd('tune 146.565')
        lines = s.cmd('scan 146.500 146.600 25')
        self.assertEqual(len(lines), 5)
        freqs = [float(l.split()[0]) for l in lines]
        self.assertEqual(freqs, [146.5, 146.525, 146.55, 146.575, 146.6])
        self.assertEqual(s.module.freq, 146.565, 'tuned frequency restored after the scan')
        self.assertTrue(s.one('scan 146.5 146.6 0').startswith('usage:'))
        self.assertTrue(s.one('scan 400 480 100').startswith('error:'))    # > 128 channels
        self.assertTrue(s.one('scan 200 210 25').startswith('error:'))     # out of band

    def test_squelch_bw_volume_reach_the_module(self):
        s = self.sim
        self.assertEqual(s.one('squelch 5'), '5'); self.assertEqual(s.module.squelch, 5)
        self.assertEqual(s.one('bw 0'), '0'); self.assertEqual(s.module.bw, 0)
        self.assertEqual(s.one('volume 8'), '8'); self.assertEqual(s.module.volume, 8)
        self.assertTrue(s.one('volume 9').startswith('usage:'))
        self.assertTrue(s.one('squelch 9').startswith('usage:'))

    def test_at_passthrough(self):
        s = self.sim
        self.assertEqual(s.one('at AT+VERSION'), '+VERSION:SA868S-VHF/UHF_V1.6')
        self.assertEqual(s.one('at AT+NOPE'), '+ERROR')


class SqWire(unittest.TestCase):
    def test_events_timestamps_carrier_edges(self):
        sim = Sim.boot(sq_wired=True); sim.cmd('band vhf'); sim.cmd('tune 146.565')
        sim.module.carriers = [{'f': 146.565, 'rssi': 210, 'on': 2, 'period': 5, 'phase': 0}]
        self.assertTrue(sim.one('events').startswith('error:'), 'refused until the wire is declared')
        self.assertEqual(sim.one('sq on'), 'on')
        sim.idle(11000)                                     # two full cycles
        lines = sim.cmd('events')
        self.assertTrue(lines[0].startswith('now '), lines)
        edges = [(int(a), int(b)) for a, b in (l.split() for l in lines[1:])]
        self.assertGreaterEqual(len(edges), 4, edges)
        levels = [b for _, b in edges]
        for x, y in zip(levels, levels[1:]):
            self.assertNotEqual(x, y, 'edges alternate')
        ons = [t for t, b in edges if b == 1]
        if len(ons) >= 2:
            self.assertTrue(abs((ons[1] - ons[0]) - 5000) <= 20, 'period %d' % (ons[1] - ons[0]))
        offs = [t for t, b in edges if b == 0]
        if ons and offs and offs[0] > ons[0]:
            self.assertTrue(abs((offs[0] - ons[0]) - 2000) <= 20, 'on time %d' % (offs[0] - ons[0]))
        self.assertEqual(len(sim.cmd('events')), 1, 'drained')
        self.assertEqual(sim.one('sq off'), 'off')
        self.assertNotIn('D2', sim.pins, 'released')
        sim.stop()

    def test_events_ring_is_bounded(self):
        sim = Sim.boot(sq_wired=True); sim.cmd('band vhf'); sim.cmd('tune 146.565'); sim.cmd('sq on')
        sim.module.carriers = [{'f': 146.565, 'rssi': 210, 'on': 0.05, 'period': 0.1, 'phase': 0}]
        sim.idle(20000)                                     # ~400 edges
        lines = sim.cmd('events')
        self.assertLessEqual(len(lines) - 1, 64)
        sim.stop()


class TransmitGates(unittest.TestCase):
    def test_rx_only_build_refuses_everything(self):
        sim = Sim.boot()
        sim.cmd('band vhf'); sim.cmd('callsign w1aw')
        for c in ('tx arm', 'tx on', 'tone 800 100', 'morse test', 'fox start', 'power high'):
            self.assertTrue(sim.one(c).startswith('error:'), c)
        self.assertEqual(sim.one('tx'), 'disabled')
        self.assertTrue(sim.pin('D3').value, 'PTT never went low')
        self.assertFalse(any(e[0] == 'D3' and len(e) == 3 and e[2] is False for e in sim.pin_log))
        sim.stop()

    def test_tx_build_gates_in_order(self):
        sim = Sim.boot(tx_enabled=True)
        self.assertTrue(sim.pin('D3').value, 'still boots in receive')
        self.assertIn('no callsign', sim.one('tx arm'))
        sim.cmd('callsign w1aw')
        self.assertIn('not armed', sim.one('tx on 1'))
        self.assertEqual(sim.one('tx arm'), 'armed')
        self.assertIn('band not set', sim.one('tx on 1'))
        sim.cmd('band vhf')
        self.assertTrue(sim.one('tx on 121').startswith('usage:'))
        sim.stop()

    def test_key_down_deadline_is_enforced_by_the_board(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm')
        self.assertEqual(sim.one('tx on 2'), 'on 2.0')
        self.assertFalse(sim.pin('D3').value, 'PTT low while keyed')
        self.assertTrue(sim.one('tx').startswith('on '))
        sim.idle(2200)
        self.assertTrue(sim.pin('D3').value, 'unkeyed by the main loop at the deadline, with no host command')
        self.assertEqual(sim.one('tx'), 'armed')
        # tx off ends it early; disarm unkeys too
        sim.cmd('tx on 10'); self.assertFalse(sim.pin('D3').value); sim.cmd('tx off'); self.assertTrue(sim.pin('D3').value)
        sim.cmd('tx on 10'); sim.cmd('tx disarm'); self.assertTrue(sim.pin('D3').value); self.assertEqual(sim.one('tx'), 'off')
        sim.stop()

    def test_morse_keys_tones_and_unkeys(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm'); sim.cmd('wpm 20')
        r = sim.one('morse e', real_timeout=10)
        self.assertTrue(r.startswith('sent'), r)
        self.assertTrue(sim.pin('D3').value, 'unkeyed after the text')
        ons = [e for e in sim.tone_log if e[0] == 'on']
        self.assertEqual(len(ons), 1, 'E is one dit')
        self.assertEqual(ons[0][2], 800)
        self.assertIsNone(sim.pwm, 'PWM released')
        self.assertIn('D1', sim.pins, 'MIC back to a plain low output')
        sim.stop()

    def test_beacon_runs_from_the_main_loop_and_stops_on_a_byte(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm'); sim.cmd('wpm 25'); sim.cmd('foxdelay 5'); sim.cmd('foxmsg fox')
        self.assertEqual(sim.one('fox start'), 'running')
        sim.idle(8000)                                     # one cycle (W1AW FOX at 25 wpm ≈ 5.5 s) stepped from the loop
        self.assertGreaterEqual(sim.state['fox_cycles'], 1)
        self.assertTrue(sim.pin('D3').value, 'between cycles the board is in receive')
        st = sim.one('fox'); self.assertTrue(st.startswith('running '), st)
        r = sim.one('fox stop', real_timeout=10); self.assertTrue(r.startswith('stopped'), r)
        self.assertFalse(sim.state['fox_running']); self.assertTrue(sim.pin('D3').value)
        sim.stop()

    def test_rx_is_safe_any_time(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm'); sim.cmd('fox start')
        sim.cmd('tx on 30')
        self.assertEqual(sim.one('rx', real_timeout=10), 'rx')
        self.assertTrue(sim.pin('D3').value); self.assertFalse(sim.state['fox_running']); self.assertTrue(sim.pin('D4').value)
        sim.stop()


if __name__ == '__main__':
    unittest.main()


class Clock(unittest.TestCase):
    def test_deadlines_survive_the_ticks_ms_wrap(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm')
        sim.clock.ms = (1 << 29) - 1500                     # 1.5 s before supervisor.ticks_ms() wraps to 0
        sim.cmd('tx on 3')
        self.assertFalse(sim.pin('D3').value)
        sim.idle(2000)                                      # the wrap passes while keyed
        self.assertFalse(sim.pin('D3').value, 'still keyed: the deadline is 1 s away, not 6 days')
        sim.idle(1500)
        self.assertTrue(sim.pin('D3').value, 'unkeyed on time across the wrap')
        self.assertIn('now ', sim.one('sq on') and sim.one('events'))
        sim.stop()


class AuditRegressions(unittest.TestCase):
    """What the review found: each of these crashed or misbehaved on the real board."""

    def test_rx_and_unkey_never_reclaim_d1(self):
        sim = Sim.boot()
        self.assertEqual(sim.one('rx'), 'rx')                   # was `error: D1 in use`
        self.assertEqual(sim.one('rx'), 'rx')
        sim.stop()

    def test_beacon_survives_the_pages_polls_and_stops_on_command(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm'); sim.cmd('wpm 25'); sim.cmd('foxdelay 5')
        sim.cmd('fox start')
        sim.idle(300)
        self.assertFalse(sim.pin('D3').value, 'keyed for the first cycle')
        # the page polls info / tx / fox about once a second while a cycle is on the air
        for _ in range(3):
            kv = sim.kv(); self.assertTrue(kv['fox'].startswith('running'), kv['fox'])
            self.assertTrue(sim.one('tx').startswith('on '))
            self.assertTrue(sim.one('fox').startswith('running'))
            sim.idle(1000)
        self.assertTrue(sim.state['fox_running'], 'polls must not abort the beacon')
        sim.idle(9000)
        self.assertGreaterEqual(sim.state['fox_cycles'], 1, 'a cycle completed with the shell answering throughout')
        self.assertTrue(len([e for e in sim.tone_log if e[0] == 'on']) > 20, 'W1AW FOX is many marks')
        # a stop mid-cycle unkeys at once
        for _ in range(40):                                    # wait for the next cycle to key
            if not sim.pin('D3').value:
                break
            sim.idle(250)
        self.assertFalse(sim.pin('D3').value, 'second cycle keyed')
        self.assertTrue(sim.one('fox stop').startswith('stopped'))
        self.assertTrue(sim.pin('D3').value); self.assertFalse(sim.state['fox_running']); self.assertIsNone(sim.pwm)
        sim.stop()

    def test_sq_edges_inside_a_burst_are_stamped_when_they_happen(self):
        sim = Sim.boot(sq_wired=True); sim.cmd('band vhf'); sim.cmd('tune 146.565'); sim.cmd('sq on')
        t0 = sim.clock.ms
        # a 1 s carrier starting 0.5 s into a 3 s rssi burst
        sim.module.carriers = [{'f': 146.565, 'rssi': 210, 'on': 1, 'period': 1000, 'phase': -((t0 + 500) / 1000.0)}]
        sim.cmd('events')
        lines = sim.cmd('rssi 30', real_timeout=10)
        self.assertEqual(len(lines), 30)
        ev = sim.cmd('events')
        edges = [(int(a), int(b)) for a, b in (l.split() for l in ev[1:])]
        self.assertEqual([b for _, b in edges], [1, 0], edges)
        on_t, off_t = edges[0][0], edges[1][0]
        self.assertLessEqual(abs(on_t - (t0 + 500)) , 120, 'onset within a loop step of the truth, not at the end of the burst: %d vs %d' % (on_t, t0 + 500))
        self.assertLessEqual(abs((off_t - on_t) - 1000), 20)
        sim.stop()

    def test_no_retune_while_keyed(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm'); sim.cmd('tx on 5')
        for c in ('tune 146.52', 'scan 146.5 146.6 25', 'band uhf'):
            self.assertIn('keyed', sim.one(c), c)
        self.assertEqual(sim.module.freq, 146.565)
        sim.cmd('tx off'); self.assertEqual(sim.one('tune 146.52'), '146.5200')
        sim.stop()

    def test_module_that_wakes_late_is_picked_up_by_info(self):
        sim = Sim(); sim.module.answer = False; sim.start(); sim.wait_prompt(5)
        self.assertIn('NOT RESPONDING', sim.kv()['module'])
        sim.module.answer = True
        self.assertIn('connected', sim.kv()['module'])
        sim.stop()


class MicLine(unittest.TestCase):
    def test_line_mode_releases_d1_while_keyed_and_refuses_tones(self):
        sim = Sim.boot(tx_enabled=True); sim.cmd('callsign w1aw'); sim.cmd('band vhf'); sim.cmd('tx arm')
        self.assertEqual(sim.one('mic'), 'pwm')
        self.assertEqual(sim.one('mic line'), 'line'); self.assertEqual(sim.kv()['mic'], 'line')
        self.assertIn('line mode', sim.one('tone 800 100')); self.assertIn('line mode', sim.one('morse e')); self.assertIn('line mode', sim.one('fox start'))
        self.assertEqual(sim.one('tx on 90'), 'on 90.0', 'SSTV-length key-down allowed')
        self.assertNotIn('D1', sim.pins, 'D1 floats while keyed in line mode')
        self.assertIn('keyed', sim.one('mic pwm'))
        sim.cmd('tx off')
        self.assertIn('D1', sim.pins); self.assertFalse(sim.pin('D1').value, 'D1 back to a low output after unkey')
        self.assertEqual(sim.one('mic pwm'), 'pwm')
        self.assertTrue(sim.one('tx on 121').startswith('usage:'))
        sim.stop()

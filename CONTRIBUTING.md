# Contributing to fox-hunt-web

Thanks for helping. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first.

Unlike the tinySA and NanoVNA pages, this project owns both ends of the
cable: the firmware on the fox and the page in the browser. The contract
between them is `PROTOCOL.md`, and the simulated fox in
`js/device/demo-link.js` is the third copy of it. A protocol change touches
all three and bumps `FW_VERSION`.

## Ways to contribute

- **A fox that doesn't connect or misreads RSSI** — *Bug report* template.
  Attach the console log (Fox console → Log → commands + replies → Download);
  it shows exactly what the firmware and the SA868 said.
- **An SA868 that answers differently** — the `at` command in the console lets
  you poke the module directly. If `AT+RSSI?` or `AT+VERSION` come back in a
  shape the firmware doesn't handle, paste the exchange.
- **Ideas** — *Feature request* template.
- **Docs** — README, PROTOCOL.md. No hardware needed.
- **Code** — see below.

## The shape of the code

Native ES modules, no build step. The README has the directory map; the
short version:

- `firmware/code.py` — single-file CircuitPython. Pins are fixed; the board
  is the DC34 fox. With `TX_ENABLED = False` (as shipped) nothing in it
  drives PTT low; a change that keys the transmitter outside `key()` with
  its deadline, or without `tx_allowed()` having said yes, will not be
  merged.
- `js/device/` — the library layer. `shell-link.js` and `serial-link.js` are
  the console protocol and Web Serial transport; `fox.js` is the device API;
  `models.js` the three band envelopes; `demo-link.js` the simulated fox.
- `js/audio/` — capture, FFT/Goertzel, the CW and SSTV decoders. Pure
  classes fed Float32 blocks; the tests feed them synthesized audio.
- `js/plot/` — canvas renderers, pure functions of their arguments.
- `js/ui/` — sidebar, console, settings, recorder, export.
- `js/main.js` — state and wiring. Nothing else touches the DOM by id.

`shell-link.js`, `js/ui/sidebar.js`, `js/ui/console.js`, `js/ui/export.js`,
`js/plot/common.js`, `css/theme.css`, `css/layout.css` and
`css/components.css` are kept byte-identical to tinysa-web. A change to one
of those goes to both repos the same day. `serial-link.js` differs from
tinysa-web's by the USB filter only.

## Running the tests

Three layers, none of which needs a fox:

```
node --test tests/*.test.mjs                 # device layer and pure logic, against the simulated fox
cd tests/firmware && python3 -m unittest -v  # the real firmware/code.py on simulated CircuitPython + SA868
node --test tests/page/page.test.mjs         # the page in headless Chromium (npm i playwright; npx playwright install chromium)
```

The device tests drive `Fox` over the simulated fox's byte stream, so a
changed reply shape or a command the page sends that the firmware no longer
has fails here. The firmware tests execute `firmware/code.py` unmodified
with `board`, `busio`, `digitalio`, `pwmio`, `supervisor`, `microcontroller`,
`time` and `sys` replaced by `tests/firmware/sim.py`: a virtual clock, a
fake SA868 that answers the AT commands and models what is on the air, pins
the test can read or drive (including refusing to claim a pin twice, as
CircuitPython does), an NVM that survives a simulated reboot, and a console.
Add a firmware test for every new command and a page test for every new
control. The page tests skip when Playwright is missing locally and fail in
CI (`REQUIRE_BROWSER=1`).

The three shared-kit files carry one small addition over tinysa-web's copy
until it is ported there: `<html data-app="…">` scopes the sidebar/console
localStorage keys and the console download name per tool (`sidebar.js`
exports `APP`), and `shell-link.js` matches a command's echo as a whole line
rather than a substring.

## Licenses

The page is GPL-2.0-only; the firmware is GPL-3.0-only. Keep the SPDX line
at the top of every file you add.

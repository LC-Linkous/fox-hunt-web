<!-- One logical change per PR, please. -->

## Summary

Closes #

## What this touches

- [ ] Firmware (`firmware/code.py`) — a protocol change here needs PROTOCOL.md and the simulated fox too
- [ ] Device layer (`js/device/fox.js`, `models.js`)
- [ ] Simulated fox (`js/device/demo-link.js`)
- [ ] Views / plotting
- [ ] Recording / export
- [ ] Shared kit (`shell-link.js`, `sidebar.js`, `console.js`, `layout.css`, `components.css`) — must stay byte-identical to tinysa-web; apply the same change there
- [ ] Docs / PROTOCOL.md / CHANGELOG

## How it was tested

- [ ] `node --test 'tests/**/*.test.mjs'` passes
- [ ] Simulated fox: connect → set band → tune → start receiver → scan → click a bar → record → each export → disconnect
- [ ] Light **and** dark mode checked (plot changes)
- [ ] Real fox — `version` line and SA868 variant:
- [ ] If the firmware changed: `FW_VERSION`, `FIRMWARE_FLOOR` and the footer agree

## Checklist

- [ ] No new literal colours — everything from the CSS variables
- [ ] No new dependencies, no build step
- [ ] The firmware still never drives PTT low
- [ ] CHANGELOG.md updated

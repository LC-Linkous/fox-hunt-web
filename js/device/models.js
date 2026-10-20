// models.js — the fox board and its three possible SA868 bands.
// SPDX-License-Identifier: GPL-2.0-only
//
// Same shape as tinysa-web's models.js (MODELS, DEFAULT_MODEL,
// identifyDevice) so main.js and the sidebar code carry across. One board
// (the DC34 fox: XIAO ESP32-C3 + SA868), three module variants. Which one
// is fitted is a firmware setting (`band`), not something the module can
// report, so the page's Module dropdown both reads and writes it.

export const BOARD = 'xiao-esp32c3';
export const FW_NAME = 'foxhunt';
/** The firmware's name before the project was renamed; still accepted. */
export const FW_NAME_OLD = 'foxdemo';

const COMMON = {
  board: BOARD,
  stepsKHz: [12.5, 25],
  rssiBurstMax: 200,          // firmware limits (PROTOCOL.md)
  scanMaxChannels: 128,
  scanMsPerChannel: 150,
  rssiRange: [0, 255],        // the RSSI byte: uncalibrated; this is only the plot range
  commands: new Set(['version', 'info', 'help', 'band', 'callsign', 'tune', 'rssi', 'scan', 'squelch', 'bw', 'volume', 'at', 'rx', 'led']),
  reserved: new Set(['tx', 'morse', 'fox']),
};

export const MODELS = {
  'sa868-vhf': {
    ...COMMON, key: 'sa868-vhf', band: 'vhf', name: 'SA868 VHF (2 m)',
    moduleBands: [[134.0, 174.0]],
    hamBands: [[144.0, 148.0]],          // US amateur allocation the module covers
    defaultFreq: 146.565, foxFreqs: [146.565],
    scanDefault: { start: 146.400, stop: 146.700, stepKHz: 12.5 },
  },
  'sa868-uhf': {
    ...COMMON, key: 'sa868-uhf', band: 'uhf', name: 'SA868 UHF (70 cm)',
    moduleBands: [[400.0, 480.0]],
    hamBands: [[420.0, 450.0]],
    defaultFreq: 433.900, foxFreqs: [433.900],
    scanDefault: { start: 433.700, stop: 434.100, stepKHz: 12.5 },
  },
  'sa868-dual': {
    ...COMMON, key: 'sa868-dual', band: 'dual', name: 'SA868 dual-band (2 m + 70 cm)',
    moduleBands: [[134.0, 174.0], [400.0, 480.0]],
    hamBands: [[144.0, 148.0], [420.0, 450.0]],
    defaultFreq: 146.565, foxFreqs: [146.565, 433.900],
    scanDefault: { start: 146.400, stop: 146.700, stepKHz: 12.5 },
  },
};
/** The board before `band` has been set: nothing is tunable yet. */
export const UNSET_MODEL = {
  ...COMMON, key: 'sa868-unset', band: null, name: 'SA868 (band not set)',
  moduleBands: [], hamBands: [], defaultFreq: null, foxFreqs: [],
  scanDefault: { start: 146.400, stop: 146.700, stepKHz: 12.5 },
};

export const DEFAULT_MODEL = 'sa868-dual';
export const BAND_KEYS = ['vhf', 'uhf', 'dual'];
export const modelForBand = band => MODELS[`sa868-${band}`] || UNSET_MODEL;

/** The oldest firmware this page is written for. */
export const FIRMWARE_FLOOR = [0, 3, 0];

/** Parse "0.3.0" into [0, 3, 0]; null if it isn't three integers. */
export function parseVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function buildAtLeast(build, floor) {
  if (!build) return false;
  for (let i = 0; i < 3; i++) {
    if (build[i] > floor[i]) return true;
    if (build[i] < floor[i]) return false;
  }
  return true;
}

/**
 * From the `version` reply: "foxhunt 0.3.0 xiao-esp32c3 sa868-dual".
 * Returns { ok, key, band, firmware, build, board, module, reason }.
 * ok is false when the port is not a fox running this firmware. An unset
 * band is ok (key 'sa868-unset'); the page then asks for the band.
 */
export function identifyDevice(versionBody) {
  const w = String(versionBody || '').trim().split(/\s+/);
  const out = { ok: false, key: UNSET_MODEL.key, band: null, firmware: '', build: null, board: '', module: '', reason: '' };
  if (w[0] !== FW_NAME && w[0] !== FW_NAME_OLD) { out.reason = 'that port did not answer like fox-hunt-web firmware'; return out; }
  out.firmware = w[1] || '';
  out.build = parseVersion(out.firmware);
  out.board = w[2] || '';
  out.module = w[3] || '';
  if (out.board !== BOARD) { out.reason = `firmware reports board "${out.board}"; this page only knows the ${BOARD} fox`; return out; }
  const m = /^sa868-(vhf|uhf|dual|unset)$/.exec(out.module);
  if (!m) { out.reason = `firmware reports module "${out.module}"; this page only knows the SA868 variants`; return out; }
  out.band = m[1] === 'unset' ? null : m[1];
  out.key = modelForBand(out.band).key;
  out.ok = true;
  return out;
}

/** Is f (MHz) inside any of the bands? */
export function inBands(f, bands) {
  return bands.some(([lo, hi]) => f >= lo && f <= hi);
}
/** Which band (index into bands) f falls in, or -1. */
export function bandIndex(f, bands) { return bands.findIndex(([lo, hi]) => f >= lo && f <= hi); }

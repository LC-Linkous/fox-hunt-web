// settings.js — persisted user settings (localStorage) and the Settings panel.
// SPDX-License-Identifier: GPL-2.0-only
// Same shape as tinysa-web's settings.js; the keys are this page's.

import { PALETTES, DEFAULT_PALETTE, cssGradient } from '../plot/palettes.js';

const KEY = 'fox-hunt-web.settings';
const DEFAULTS = {
  theme: 'dark',          // 'dark' | 'light'
  traces: 'instrument',   // trace colour scheme, shared with tinysa-web's theme.css
  windowS: 60,            // seconds of RSSI history on screen
  rssiLo: 0, rssiHi: 255, // the RSSI axis
  hamOnly: true,          // keep tuning inside the amateur allocations
  rawBytes: false,        // echo every received chunk in the console
  palette: DEFAULT_PALETTE,   // waterfall and heat-strip colours
  heatStrip: true,        // the strip under the RSSI plot
  attenDb: 0,             // attenuator in line, dB; bookkeeping only (see the Receiver section)
  mode: 'bench',          // 'bench' | 'hunt' layout
  seekMargin: 20, seekDwell: 30, seekPin: true,
};

export const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || localStorage.getItem('fox-demo-web.settings') || '{}')); } catch {}   // the old key: the project's name before v0.5

export function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} }

export function applyTheme() {
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.theme);
  root.setAttribute('data-traces', settings.traces);
}
export const rssiRange = () => [Math.min(settings.rssiLo, settings.rssiHi - 10), settings.rssiHi];

/** Wire the settings form. onChange(key) is called after any change. */
export function initSettingsPanel(form, onChange) {
  const sel = form.querySelector('[name=palette]');
  sel.innerHTML = Object.entries(PALETTES).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  const swatch = form.querySelector('.palette-swatch');
  const refresh = () => {
    sel.value = settings.palette; swatch.style.background = cssGradient(settings.palette);
    form.querySelector(`[name=theme][value=${settings.theme}]`).checked = true;
    form.querySelector(`[name=traces][value=${settings.traces}]`).checked = true;
    form.querySelector('[name=windowS]').value = String(settings.windowS);
    form.querySelector('[name=rssiLo]').value = settings.rssiLo;
    form.querySelector('[name=rssiHi]').value = settings.rssiHi;
    for (const k of ['hamOnly', 'rawBytes', 'heatStrip']) form.querySelector(`[name=${k}]`).checked = settings[k];
  };
  refresh();
  form.addEventListener('change', e => {
    const el = e.target, n = el.name; if (!n) return;
    if (el.type === 'checkbox') settings[n] = el.checked;
    else if (n === 'windowS') settings[n] = parseInt(el.value, 10) || 60;
    else if (n === 'rssiLo' || n === 'rssiHi') settings[n] = Math.min(255, Math.max(0, parseInt(el.value, 10) || 0));
    else settings[n] = el.value;
    save(); applyTheme(); swatch.style.background = cssGradient(settings.palette); onChange(n);
  });
  form.addEventListener('submit', e => e.preventDefault());
}

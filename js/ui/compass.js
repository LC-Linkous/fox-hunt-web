// compass.js — the device heading, from the compass when there is one, else a manual north.
// SPDX-License-Identifier: GPL-2.0-only
//
// Android Chrome: 'deviceorientationabsolute' gives alpha relative to north.
// iOS Safari: 'deviceorientation' with webkitCompassHeading, after a
// permission tap. Anything else (a laptop): no heading; the page offers a
// manual heading slider and a "pointing north now" button that calibrates
// a relative gyro alpha when one exists. State and accuracy are reported so
// the page can show them next to the plot; nothing starts until asked.
import { headingFromAlpha } from '../bearing.js';

export const hasOrientation = () => 'DeviceOrientationEvent' in window;

export function createCompass({ onChange } = {}) {
  const c = { on: false, source: 'none', heading: NaN, accuracy: null, offset: 0, manual: NaN, error: null, lastAlpha: NaN, permission: 'unknown', history: [] };
  // every heading the page uses is remembered for a few seconds, so a reading
  // taken 400 ms ago can be tagged with where the antenna pointed then
  const remember = () => { const h = c.current(); if (Number.isFinite(h)) { const now = Date.now(); c.history.push({ t: now, h }); while (c.history.length && now - c.history[0].t > 8000) c.history.shift(); } };
  const change = () => { remember(); onChange?.(); };
  const onAbs = e => { if (!Number.isFinite(e.alpha)) return; c.source = 'absolute'; c.lastAlpha = e.alpha; c.heading = headingFromAlpha(e.alpha, c.offset); c.accuracy = e.webkitCompassAccuracy ?? null; change(); };
  const onRel = e => {
    if (Number.isFinite(e.webkitCompassHeading)) { c.source = 'ios'; c.heading = (e.webkitCompassHeading + c.offset + 360) % 360; c.accuracy = e.webkitCompassAccuracy ?? null; change(); return; }
    if (c.source === 'absolute' || !Number.isFinite(e.alpha)) return;
    c.source = e.absolute ? 'absolute' : 'relative'; c.lastAlpha = e.alpha; c.heading = headingFromAlpha(e.alpha, c.offset); change();
  };
  c.start = async () => {
    if (c.on) return; c.error = null;
    if (!hasOrientation()) { c.source = 'none'; c.on = true; change(); return; }
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') { const r = await DeviceOrientationEvent.requestPermission(); c.permission = r; if (r !== 'granted') { c.error = 'compass permission refused'; change(); return; } }
      else c.permission = 'granted';
    } catch (e) { c.error = 'compass permission: ' + e.message; change(); return; }
    window.addEventListener('deviceorientationabsolute', onAbs); window.addEventListener('deviceorientation', onRel);
    c.on = true; change();
    setTimeout(() => { if (c.on && !Number.isFinite(c.heading)) { c.source = 'none'; change(); } }, 1500);   // no events: no sensor
  };
  c.stop = () => { window.removeEventListener('deviceorientationabsolute', onAbs); window.removeEventListener('deviceorientation', onRel); c.on = false; c.heading = NaN; change(); };
  /** The heading to use: the sensor's when it has one, else the manual slider. */
  c.current = () => Number.isFinite(c.heading) && c.source !== 'none' ? c.heading : c.manual;
  /** Heading at time t (ms), interpolated on the circle between remembered headings; the current one if t is newer than the history. */
  c.at = t => {
    const H = c.history; if (!H.length) return c.current();
    if (t >= H[H.length - 1].t) return H[H.length - 1].h; if (t <= H[0].t) return H[0].h;
    let i = H.length - 1; while (i > 0 && H[i - 1].t > t) i--;
    const a = H[i - 1], b = H[i], u = (t - a.t) / Math.max(1, b.t - a.t); let d = ((b.h - a.h) % 360 + 540) % 360 - 180;
    return ((a.h + d * u) % 360 + 360) % 360;
  };
  c.setManual = h => { c.manual = ((h % 360) + 360) % 360; change(); };
  /** "I'm pointing north now": for a relative sensor this calibrates it; for an absolute one it trims declination/mounting error. */
  c.markNorth = () => { if (Number.isFinite(c.lastAlpha)) { c.offset = (c.offset - headingFromAlpha(c.lastAlpha, c.offset) + 360) % 360; c.heading = headingFromAlpha(c.lastAlpha, c.offset); } else c.manual = 0; change(); };
  c.text = () => !c.on ? 'off' : c.error ? c.error : c.source === 'none' ? 'no compass here: use the heading slider' : `${c.source === 'relative' ? 'gyro (relative; mark north first)' : 'compass'}${c.accuracy != null ? ` · ±${Math.round(c.accuracy)}°` : ''}${c.offset ? ` · trim ${Math.round(c.offset)}°` : ''}`;
  return c;
}

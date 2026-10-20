// geo.js — location stamps for the log. Off by default; visible when on.
// SPDX-License-Identifier: GPL-2.0-only
//
// watchPosition while enabled; stamp() returns the last fix if it is fresh
// enough, with its accuracy, or null. The page shows the fix age and
// accuracy next to the indicator so a stale fix is never mistaken for a
// current one.

export const hasGeolocation = () => 'geolocation' in navigator;

export function createGeo({ onChange, maxAgeMs = 15000 } = {}) {
  const geo = { on: false, fix: null, error: null, watchId: null };
  geo.start = () => {
    if (!hasGeolocation() || geo.on) return;
    geo.on = true; geo.error = null; onChange?.();
    geo.watchId = navigator.geolocation.watchPosition(
      p => { geo.fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, t: p.timestamp || Date.now() }; geo.error = null; onChange?.(); },
      e => { geo.error = e.code === 1 ? 'location permission denied' : e.code === 2 ? 'position unavailable' : 'location timed out'; onChange?.(); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  };
  geo.stop = () => { if (geo.watchId != null) navigator.geolocation.clearWatch(geo.watchId); geo.watchId = null; geo.on = false; geo.fix = null; onChange?.(); };
  geo.ageMs = () => geo.fix ? Date.now() - geo.fix.t : null;
  /** { lat, lon, acc } for a record, or null if off / no fresh fix. */
  geo.stamp = () => (geo.on && geo.fix && geo.ageMs() <= maxAgeMs) ? { lat: +geo.fix.lat.toFixed(6), lon: +geo.fix.lon.toFixed(6), acc: Math.round(geo.fix.acc) } : null;
  geo.text = () => !geo.on ? 'off' : geo.error ? geo.error : !geo.fix ? 'waiting for a fix…' : `±${Math.round(geo.fix.acc)} m · ${Math.round(geo.ageMs() / 1000)} s ago${geo.ageMs() > maxAgeMs ? ' (stale, not stamping)' : ''}`;
  return geo;
}

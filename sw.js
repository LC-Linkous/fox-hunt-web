// sw.js — offline cache for the hunt: the page, its scripts, the firmware.
// SPDX-License-Identifier: GPL-2.0-only
//
// Network first, cache as the fallback. The whole shell is cached as one
// versioned set at install, so a page never runs with a mix of old and new
// modules (a fresh index.html against a stale main.js would break on an id
// or an import); with the network there, every file comes from the server;
// without it, every file comes from the same cached set. The firmware file
// is fetched the same way, so the installer never flashes a previous release
// while the network is reachable.
const CACHE = 'fox-hunt-web-v0.10.1';
const SHELL = ['./', 'index.html', 'about.html', 'pins.html', 'sw.js', 'firmware/code.py', 'PROTOCOL.md',
  'css/theme.css', 'css/layout.css', 'css/components.css', 'css/fox.css',
  'js/main.js', 'js/fmt.js', 'js/hunt.js', 'js/bearing.js',
  'js/device/shell-link.js', 'js/device/serial-link.js', 'js/device/demo-link.js', 'js/device/fox.js', 'js/device/models.js', 'js/device/installer.js',
  'js/plot/common.js', 'js/plot/palettes.js', 'js/plot/rssi.js', 'js/plot/scan.js', 'js/plot/waterfall.js', 'js/plot/audio.js', 'js/plot/polar.js',
  'js/ui/sidebar.js', 'js/ui/console.js', 'js/ui/export.js', 'js/ui/settings.js', 'js/ui/recorder.js', 'js/ui/session.js', 'js/ui/geo.js', 'js/ui/compass.js',
  'js/audio/capture.js', 'js/audio/fft.js', 'js/audio/cw.js', 'js/audio/sstv.js', 'js/audio/playout.js', 'js/audio/quieting.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      // a hunt's network is often there but barely: give it four seconds, then use the cache
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(e.request, { cache: 'no-cache', signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch {
      return (await c.match(e.request)) || Response.error();
    }
  })());
});

// sw.js — offline cache for the hunt: the page, its scripts, the firmware. Stale-while-revalidate.
// SPDX-License-Identifier: GPL-2.0-only
const CACHE = 'fox-hunt-web-v0.7.0';
const SHELL = ['./', 'index.html', 'about.html', 'sw.js', 'firmware/code.py', 'PROTOCOL.md',
  'css/theme.css', 'css/layout.css', 'css/components.css', 'css/fox.css',
  'js/main.js', 'js/fmt.js', 'js/hunt.js', 'js/bearing.js',
  'js/device/shell-link.js', 'js/device/serial-link.js', 'js/device/demo-link.js', 'js/device/fox.js', 'js/device/models.js', 'js/device/installer.js',
  'js/plot/common.js', 'js/plot/palettes.js', 'js/plot/rssi.js', 'js/plot/scan.js', 'js/plot/waterfall.js', 'js/plot/audio.js', 'js/plot/polar.js',
  'js/ui/sidebar.js', 'js/ui/console.js', 'js/ui/export.js', 'js/ui/settings.js', 'js/ui/recorder.js', 'js/ui/session.js', 'js/ui/geo.js', 'js/ui/compass.js',
  'js/audio/capture.js', 'js/audio/fft.js', 'js/audio/cw.js', 'js/audio/sstv.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

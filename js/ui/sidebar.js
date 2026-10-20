// sidebar.js — accordion sections; one open at a time, remembered.
// SPDX-License-Identifier: GPL-2.0-only

export function initSidebar(root) {
  const sections = [...root.querySelectorAll('section[data-section]')];
  const KEY = 'nanovna-web.section';
  let current = localStorage.getItem(KEY) || sections[0].dataset.section;
  function open(name) {
    current = name;
    for (const s of sections) { const on = s.dataset.section === name; s.classList.toggle('open', on); s.querySelector('h2 button').setAttribute('aria-expanded', String(on)); }
    try { localStorage.setItem(KEY, name || ''); } catch {}
  }
  // clicking the open section's header collapses it (the "−")
  for (const s of sections) s.querySelector('h2 button').addEventListener('click', () => open(current === s.dataset.section ? null : s.dataset.section));
  open(sections.some(s => s.dataset.section === current) ? current : sections[0].dataset.section);

  // drag the right edge to resize; width remembered
  const handle = document.getElementById('sidebarHandle');
  const WKEY = 'nanovna-web.sidebarW';
  const setW = w => document.documentElement.style.setProperty('--sidebar-w', Math.max(240, Math.min(560, w)) + 'px');
  const savedW = parseInt(localStorage.getItem(WKEY) || '', 10); if (savedW) setW(savedW);
  if (handle) {
    let dragging = false, x0 = 0, w0 = 0;
    handle.addEventListener('pointerdown', e => { dragging = true; x0 = e.clientX; w0 = root.getBoundingClientRect().width; handle.setPointerCapture(e.pointerId); handle.classList.add('active'); });
    handle.addEventListener('pointermove', e => { if (dragging) setW(w0 + (e.clientX - x0)); });
    handle.addEventListener('pointerup', () => { dragging = false; handle.classList.remove('active'); try { localStorage.setItem(WKEY, String(Math.round(root.getBoundingClientRect().width))); } catch {} });
    handle.addEventListener('dblclick', () => { setW(300); try { localStorage.removeItem(WKEY); } catch {} });
  }
  return { open };
}

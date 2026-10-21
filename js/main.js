// main.js — application state and wiring. Everything else is a module.
// SPDX-License-Identifier: GPL-2.0-only
import { Fox } from './device/fox.js';
import { SerialLink, hasWebSerial } from './device/serial-link.js';
import { DemoLink } from './device/demo-link.js';
import { BAND_KEYS, inBands } from './device/models.js';
import { fmtMHz, peakIndex } from './fmt.js';
import { renderRssi } from './plot/rssi.js';
import { renderScan } from './plot/scan.js';
import { renderAudio } from './plot/audio.js';
import { renderScanWaterfall, WATERFALL_ROWS } from './plot/waterfall.js';
import { buildLut } from './plot/palettes.js';
import { sessionBlob, parseSession, pickFile, createReplay } from './ui/session.js';
import { createGeo, hasGeolocation } from './ui/geo.js';
import { createCycleTracker, createSeeker, createBoard, createEdgeFeeder, findCallsigns } from './hunt.js';
import { createCapture as createBearingCapture, restoreCapture, fixFromBearings, distanceBetween } from './bearing.js';
import { createCompass } from './ui/compass.js';
import { renderPolar } from './plot/polar.js';
import { installCodePy, configureFirmware, firmwareVersion } from './device/installer.js';
import { createCapture, listInputs, hasAudioCapture } from './audio/capture.js';
import { CwDecoder } from './audio/cw.js';
import { SstvDecoder, MODES as SSTV_MODES, encodeSstv } from './audio/sstv.js';
import { createPlayout, listOutputs, fitImage, hasPlayout } from './audio/playout.js';
import { createQuieting } from './audio/quieting.js';
import { cssVar } from './plot/common.js';
import { settings, applyTheme, initSettingsPanel, rssiRange, save as saveSettings } from './ui/settings.js';
import { initConsole } from './ui/console.js';
import { initSidebar } from './ui/sidebar.js';
import { download, stamp, canvasPng } from './ui/export.js';
import { createRecorder } from './ui/recorder.js';

const APP_VERSION = '0.10.1';
const FW_NEEDED = '0.5.0';
const BURST = 10;                 // readings per `rssi N` while the receiver runs (~1 s of data per round trip)
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- state
const state = {
  fox: null, demo: false,
  samples: [], max: -1, events: [], live: false, scanning: false, scanLoop: false,
  scan: null, hover: null, rate: null,
  keyed: false, foxRunning: false, txPoll: null, connecting: false,
  gen: { live: 0, scan: 0, seek: 0 },   // bumped on every stop: a loop that wakes from an await with a stale generation exits
  audio: { view: 'spectrum', running: false, cw: null, sstv: null, picture: false },
  scanView: 'bars', rows: [], rowsF: null, wfHover: null, lut: null, replaying: false,
  seeking: false, seekDwelling: false, cycle: createCycleTracker(), lastId: null,
  captures: [], capturing: null, lastFix: null,
};
const board = createBoard();
const pair = {};   // the bench pair's second fox; filled in below
const sstvTx = { playout: createPlayout(), image: null, samples: null, mode: null, busy: false };   // SSTV transmit, wired up below
const seeker = createSeeker();
state.lut = buildLut(settings.palette);
const chart = { dirty: true };

applyTheme();
$('appVersion').textContent = 'v' + APP_VERSION; $('fwNeed').textContent = FW_NEEDED;
initSidebar($('sidebar'));
const con = initConsole({ log: $('log'), form: $('sendForm'), input: $('sendInput'), handle: $('conHandle'), drawer: $('console'), clearBtn: $('conClear'), copyBtn: $('conCopy'), dlBtn: $('conDl'), dlMode: $('conDlMode') }, sendManual);
const recorder = createRecorder();
initSettingsPanel($('settingsForm'), key => { if (key === 'hamOnly') applyModel(); if (key === 'palette') state.lut = buildLut(settings.palette); chart.dirty = true; });
const geo = createGeo({ onChange: () => { $('geoText').textContent = geo.text(); $('geoText').classList.toggle('err', !!geo.error); $('geoBadge').hidden = !geo.on; $('geoChk').checked = geo.on; } });
if (!hasGeolocation()) { $('geoChk').disabled = true; $('geoText').textContent = 'not available in this browser'; }
$('geoChk').addEventListener('change', () => geo[$('geoChk').checked ? 'start' : 'stop']());
setInterval(() => { if (geo.on) $('geoText').textContent = geo.text(); }, 1000);
// attenuator bookkeeping: a setting, a column in the log, a mark on the plot
const attenSel = $('attenSel'), attenCustom = $('attenCustom');
function applyAtten() { const presets = [...attenSel.options].map(o => o.value); const v = String(settings.attenDb); if (presets.includes(v)) { attenSel.value = v; attenCustom.hidden = true; } else { attenSel.value = 'custom'; attenCustom.hidden = false; attenCustom.value = settings.attenDb; } }
attenSel.addEventListener('change', () => { if (attenSel.value === 'custom') { attenCustom.hidden = false; attenCustom.focus(); return; } setAtten(parseInt(attenSel.value, 10)); });
attenCustom.addEventListener('change', () => setAtten(Math.max(0, Math.min(120, parseInt(attenCustom.value, 10) || 0))));
function setAtten(db) { if (db === settings.attenDb) return; settings.attenDb = db; saveSettings(); applyAtten(); state.events.push({ t: Date.now(), label: `${db} dB` }); state.max = -1; $('rssiMax').textContent = '—'; chart.dirty = true; if (state.fox) con.dim(`attenuator: ${db} dB in line (logged, not applied to the byte)`); }
applyAtten();
if (!hasWebSerial()) { $('noSerial').hidden = false; $('connectBtn').disabled = true; }

// ---------------------------------------------------------------- status / model
function setStatus(text, cls) { $('statusText').textContent = text; $('status').className = 'status ' + (cls || ''); }
function allowedBands() { const m = state.fox?.env; if (!m) return []; return settings.hamOnly ? m.hamBands : m.moduleBands; }
const bandsText = bands => bands.map(([a, b]) => `${a}–${b}`).join(' and ') + ' MHz';

/** Fill the presets, limits and hints from the connected fox's envelope. */
function applyModel() {
  const fox = state.fox, m = fox?.env, set = !!fox?.bandSet;
  const bands = allowedBands();
  $('bandHint').textContent = !fox ? 'Tunable range appears once a fox is connected.' : !set ? 'Pick the SA868 fitted to this fox from the Module dropdown; the frequency range follows.' : `Tunable: ${bandsText(bands)}${settings.hamOnly ? ' (amateur allocations; widen under Setup)' : ' (the module\'s full range)'}.`;
  $('bandSel').classList.toggle('needs-attention', !!fox && !set);
  if (fox) $('bandSel').value = set ? fox.state.band : 'auto';
  if (bands.length) { $('freq').min = bands[0][0]; $('freq').max = bands[bands.length - 1][1]; }
  // frequency presets: fox frequencies, then each band's bottom edge
  const pills = $('presets'); pills.innerHTML = '';
  const ev = channels().filter(c => inBands(c.f, m?.moduleBands || []));
  const foxF = ev.length ? ev.map(c => ({ f: c.f, label: `${c.f.toFixed(3)} ${c.label}`.trim() })) : (m?.foxFreqs || []).map(f => ({ f, label: `${f.toFixed(3)} fox` }));
  const presets = set ? [...foxF, ...bands.map(([a]) => ({ f: a, label: `${a.toFixed(3)}` }))] : [];
  for (const p of presets) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = p.label; b.title = 'Enter and tune'; b.addEventListener('click', () => { $('freq').value = p.f.toFixed(4); tune(); }); pills.appendChild(b); }
  // scan presets: a window around each fox frequency
  const sp = $('scanPresets'); sp.innerHTML = '';
  for (const f of (set ? foxF.map(x => x.f) : [])) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = `${f.toFixed(3)} ±150 kHz`; b.addEventListener('click', () => { $('scanStart').value = (f - 0.15).toFixed(4); $('scanStop').value = (f + 0.15).toFixed(4); updateScanCount(); }); sp.appendChild(b); }
  { const sel = $('scanStep'), keep = sel.value, steps = (m?.stepsKHz || [12.5, 25, 50, 100]); if ([...sel.options].map(o => o.value).join() !== steps.join()) { sel.innerHTML = steps.map(k => `<option value="${k}">${k} kHz</option>`).join(''); sel.value = steps.map(String).includes(keep) ? keep : '12.5'; } }
  if (set && m.scanDefault && !inBands(parseFloat($('scanStart').value), m.moduleBands)) { $('scanStart').value = m.scanDefault.start.toFixed(4); $('scanStop').value = m.scanDefault.stop.toFixed(4); }
  if (set && !inBands(parseFloat($('freq').value), m.moduleBands)) $('freq').value = m.defaultFreq.toFixed(4);
  // fox configuration panel
  $('fwVersion').textContent = fox ? `${fox.ident.firmware}${fox.ident.build && fox.ident.firmware !== FW_NEEDED ? ` (page written for ${FW_NEEDED})` : ''}` : '—';
  $('fwModule').textContent = fox ? `${fox.ident.module}${fox.state.moduleConnected === false ? ' — not responding' : ''}` : '—';
  $('fwModuleVersion').textContent = fox ? (fox.state.moduleVersion || '—') : '—';
  $('fwRssiCmd').textContent = fox ? (fox.state.rssiCmd || '—') : '—';
  $('fwNvm').textContent = fox ? (fox.state.nvm ? 'yes' : fox.state.nvm === false ? 'no (settings last until reboot)' : '—') : '—';
  $('sqWire').checked = !!fox?.state.sqWire; showSq();
  if (fox) $('callsign').value = fox.state.callsign === 'N0CALL' ? '' : fox.state.callsign;
  $('tunedNow').textContent = set && Number.isFinite(fox.state.freq) ? fmtMHz(fox.state.freq) : '—';
  applyTx();
  if (fox?.state.armed) startTxPoll(); else stopTxPoll();   // a reload while armed or beaconing: keep watching it
  setEnabled(!!fox);
  updateScanCount();
}
/** The Transmit section reflects the firmware's gates: available, callsign, armed. */
function applyTx() {
  const fox = state.fox, avail = !!fox?.state.txAvailable, cs = fox?.state.callsign || '';
  $('txDisabledNote').hidden = !fox || avail; $('txControls').hidden = !avail;
  $('rxBadge').hidden = !fox || avail; $('rxBadge').textContent = 'RX only';
  if (!avail) { $('txBadge').hidden = true; return; }
  const armed = !!fox.state.armed, hasCall = cs && cs !== 'N0CALL';
  $('txCallsign').textContent = hasCall ? cs : 'not set — store one under Setup';
  $('txArm').checked = armed; $('txArm').disabled = !hasCall;
  $('txState').textContent = fox.state.keyed ? `keyed, ${fox.state.keyedLeft.toFixed(1)} s left` : armed ? 'armed' : 'disarmed';
  ['txPower', 'txWpm', 'keyBtn', 'toneBtn', 'morseText', 'morseBtn', 'foxMsg', 'foxDelay', 'foxBtn'].forEach(id => $(id).disabled = !armed);
  const quiet = id => document.activeElement !== $(id);   // a field being typed in keeps what is typed
  if (quiet('txPower')) $('txPower').value = fox.state.power; if (quiet('txWpm')) $('txWpm').value = fox.state.wpm;
  if (!$('foxMsg').value) $('foxMsg').value = fox.state.foxmsg; if (quiet('foxDelay')) $('foxDelay').value = fox.state.foxdelay;
  if (!$('morseText').value && hasCall) $('morseText').value = `${cs} FOX`;
  state.foxRunning = fox.state.foxRunning; state.keyed = fox.state.keyed;
  const fb = $('foxBtn'); fb.textContent = state.foxRunning ? 'Stop beacon' : 'Start beacon'; fb.setAttribute('aria-pressed', String(state.foxRunning)); fb.classList.toggle('running', state.foxRunning);
  $('foxStatusLine').textContent = state.foxRunning ? `running, ${fox.state.foxCycles} cycles` : `stopped${fox.state.foxCycles ? `, ${fox.state.foxCycles} cycles sent` : ''}`;
  $('txBadge').hidden = !(state.keyed || state.foxRunning);
  morseEstimate(); sstvTxEnable();
}
function setEnabled(on) {
  const set = on && state.fox.bandSet;
  ['tuneBtn', 'liveBtn', 'oneBtn', 'scanBtn', 'scanLoopBtn', 'maxResetBtn', 'pinBtn', 'seekBtn', 'hLiveBtn', 'hSeekBtn', 'hPinBtn'].forEach(id => $(id).disabled = !set);
  ['seekSkipBtn', 'seekLockBtn', 'hSkipBtn', 'hLockBtn'].forEach(id => $(id).disabled = !set || !state.seeking);
  $('pinPeakBtn').disabled = !set || !state.scan;
  ['captureBtn', 'hCaptureBtn'].forEach(id => $(id).disabled = !set);
  ['bwSel', 'sqSel', 'volSel', 'callsign', 'callsignBtn'].forEach(id => $(id).disabled = !on);
  $('sqWire').disabled = !on || !state.fox.ident.build || state.fox.ident.build[1] < 4;   // `sq`/`events` arrived in firmware 0.4.0
  con.setEnabled(on);
  $('rxBadge').hidden = !on;
  $('demoBtn').disabled = on && !state.demo;
  $('demoBtn').classList.toggle('demo-active', on && state.demo); $('demoBtn').setAttribute('aria-pressed', String(on && state.demo));
  $('demoBtn').textContent = on && state.demo ? 'Simulated fox (click to leave)' : 'Try without hardware';
  $('connectBtn').textContent = on ? 'Disconnect' : 'Connect to fox';
  $('connectBtn').disabled = !hasWebSerial() && !state.demo ? true : (on && state.demo);
  $('tunePeakBtn').disabled = !set || !state.scan;
  updateHunt();
}

// ---------------------------------------------------------------- connect
async function connect(demo) {
  if (state.fox || state.connecting) return;
  state.connecting = true; $('connectBtn').disabled = true; $('demoBtn').disabled = true;
  const sel = $('bandSel').value;
  const link = demo ? new DemoLink({ band: sel === 'auto' ? 'dual' : sel, txEnabled: true, callsign: 'N0CALL' }) : new SerialLink();
  link.onTx = cmd => con.tx(cmd);
  link.onRx = (body, meta) => con.reply(body, meta);
  link.onRaw = bytes => { if (settings.rawBytes) con.dim('rx ' + bytes.length + ' B: ' + JSON.stringify(new TextDecoder().decode(bytes)).slice(0, 200)); };
  if (!demo) link.onDrop = e => { con.err('port error: ' + e.message); disconnect(true); };
  const fox = new Fox(link);
  fox.onWarning = t => con.err('warning: ' + t);
  try {
    await link.open();
    if (demo) con.dim('simulated fox ready (no hardware): foxes on 146.565 (keyed) and 433.900 (continuous)');
    await fox.identify();
    // the dropdown sets the band only on a fox that has none; a fox that already knows its module is believed
    if (sel !== 'auto' && !fox.bandSet) { con.dim(`setting the module band to ${sel} (kept on the board)`); await fox.band(sel); }
    else if (sel !== 'auto' && sel !== fox.state.band) con.dim(`this fox is stored as ${fox.state.band}; the dropdown now shows that. Change it there if the module really is ${sel}.`);
    state.fox = fox; state.demo = demo; state.sqFeeder = null;
    applyModel(); updateHeading();
    setStatus(`${demo ? 'Simulated' : 'Connected'} · ${fox.ident.label}`, demo ? 'demo' : 'ok');
    if (!fox.bandSet) setStatus(`${demo ? 'Simulated' : 'Connected'} · band not set — pick the module ↑`, 'err');
    chart.dirty = true;
  } catch (e) {
    con.err('connect failed: ' + e.message); setStatus('Connection failed — ' + e.message, 'err');
    state.fox = null; state.demo = false;
    try { await link.close(); } catch {}
    applyModel();
  } finally { state.connecting = false; $('connectBtn').disabled = !navigator.serial; $('demoBtn').disabled = false; }
}
async function disconnect(silent) {
  if (!state.fox) return;
  stopLive(); stopScanLoop(); stopTxPoll(); stopSeek();
  if (!silent && state.fox.state.txAvailable) { try { await state.fox.rx(); } catch {} }   // beacon off, unkeyed, before the port closes
  const fox = state.fox; state.fox = null; state.demo = false; state.sqFeeder = null;
  $('bandSel').value = 'auto';   // the next fox is read, not overwritten
  if (!silent) await fox.link.close(); else try { await fox.link.close(); } catch {}
  if (pair.fox && pair.demo) await pairDrop(false);   // a simulated beacon has no air to be heard on once its receiver is gone
  setStatus('Not connected', ''); applyModel(); chart.dirty = true;
}
$('connectBtn').addEventListener('click', () => state.fox ? disconnect() : connect(false));
// a page closed or reloaded mid-TX: the firmware's own deadline unkeys within 60 s; this asks for receive right away where the browser still allows a write
window.addEventListener('pagehide', () => { for (const f of [state.fox, pair.fox]) if (f?.state.txAvailable && (f.state.keyed || f.state.foxRunning)) { try { f.link.writeSync?.('rx\r\n'); } catch {} } });
$('demoBtn').addEventListener('click', () => state.fox ? disconnect() : connect(true));
$('bandSel').addEventListener('change', async () => {
  const v = $('bandSel').value; if (!state.fox || v === 'auto') return;
  stopLive(); stopScanLoop(); stopSeek(); state.cycle = createCycleTracker(); state.sqFeeder = null;
  try {
    await state.fox.band(v); con.dim(`module band set to ${v}`); setStatus(`${state.demo ? 'Simulated' : 'Connected'} · ${state.fox.ident.label}`, state.demo ? 'demo' : 'ok');
    // the other band's readings and channels no longer apply
    state.samples = []; state.events = []; state.max = -1; state.scan = null; state.hover = null;
    $('rssiNow').textContent = '—'; $('rssiMax').textContent = '—'; $('scanPeak').textContent = '—'; $('scanTime').textContent = '—'; $('scanHead').textContent = 'RSSI per channel';
    ['pngScanBtn', 'scanCsvBtn'].forEach(id => $(id).disabled = true);
    if (state.fox.env.scanDefault) { $('scanStart').value = state.fox.env.scanDefault.start.toFixed(4); $('scanStop').value = state.fox.env.scanDefault.stop.toFixed(4); }
    $('freq').value = state.fox.env.defaultFreq.toFixed(4);
  }
  catch (e) { con.err(e.message); }
  applyModel(); chart.dirty = true;
});

// ---------------------------------------------------------------- receiver
function requestedFreq() {
  const f = parseFloat($('freq').value); const bands = allowedBands();
  if (!Number.isFinite(f)) throw new Error('enter a frequency in MHz');
  if (!inBands(f, bands)) throw new Error(`${f} MHz is outside ${bandsText(bands)}${settings.hamOnly ? ' — widen the range in Settings for the module\'s full span' : ''}`);
  return f;
}
async function tune() {
  const fox = state.fox; if (!fox || !fox.bandSet) return;
  if (state.keyed || state.foxRunning) { con.err('tune: the transmitter is keyed; stop it first'); return; }
  try { const f = await fox.tune(requestedFreq()); $('freq').value = f.toFixed(4); $('tunedNow').textContent = fmtMHz(f); state.events.push({ t: Date.now(), label: fmtMHz(f) }); state.max = -1; $('rssiMax').textContent = '—'; state.cycle = board.get(f)?.cycle || createCycleTracker(); updateHunt(); chart.dirty = true; }
  catch (e) { con.err('tune: ' + e.message); }
}
$('tuneBtn').addEventListener('click', tune);
$('freq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tune(); } });
$('bwSel').addEventListener('change', async () => { try { await state.fox?.bw(parseInt($('bwSel').value, 10)); } catch (e) { con.err(e.message); } });
$('sqSel').addEventListener('change', async () => { try { await state.fox?.squelch(parseInt($('sqSel').value, 10)); } catch (e) { con.err(e.message); } });
$('volSel').addEventListener('change', async () => { try { await state.fox?.volume(parseInt($('volSel').value, 10)); } catch (e) { con.err(e.message); } });

function takeSample(t, rssi, f) {
  state.samples.push({ t, rssi, f }); if (state.samples.length > 20000) state.samples.shift(); chart.huntDirty = true;
  if (f != null) { if (board.get(f)?.cycle !== state.cycle) state.cycle.feed(t, rssi); board.note(f, t, rssi); }   // a pinned channel's tracker is fed by the board
  if (state.capturing && rssi >= 0) { const h = compass.at(t); if (Number.isFinite(h)) { state.capturing.add(h, rssi); state.liveBearing = { h, r: rssi }; } }
  if (rssi > state.max) state.max = rssi;
  $('rssiNow').textContent = rssi >= 0 ? String(rssi) : 'no reply'; $('rssiNow').classList.toggle('dim', rssi < 0);
  $('rssiMax').textContent = state.max >= 0 ? String(state.max) : '—'; $('rssiMax').classList.remove('dim');
  chart.dirty = true;
}
// ---------------------------------------------------------------- the SQ wire
/** Carrier light and label from fox.state; the cycle tracker is told who owns its on/off. */
function showSq() {
  const fox = state.fox, on = !!fox?.state.sqWire, c = fox?.state.sqCarrier;
  $('sqDot').className = 'sq-dot' + (on ? (c ? ' carrier' : ' quiet') : '');
  $('sqLevel').textContent = !fox ? '' : !on ? (fox.ident.build && fox.ident.build[1] < 4 ? 'needs firmware 0.4.0' : 'off') : c ? 'carrier' : 'quiet';
  state.cycle.hardware = on;
}
$('sqWire').addEventListener('change', async () => {
  const fox = state.fox; if (!fox) return;
  try { await fox.sq($('sqWire').checked); con.dim(`sq ${$('sqWire').checked ? 'on: carrier edges now come from the wire' : 'off: cycle timing from RSSI thresholds'}`); state.sqFeeder = null; }
  catch (e) { con.err('sq: ' + e.message); $('sqWire').checked = !!fox.state.sqWire; }
  showSq(); chart.huntDirty = true;
});
/** One `events` round: hardware edges into the current channel's cycle tracker. Called about once a second while the receiver runs. */
async function pollEvents() {
  const fox = state.fox; if (!fox?.state.sqWire) return;
  if (!state.sqFeeder || state.sqFeeder.tracker !== state.cycle) { state.sqFeeder = createEdgeFeeder(state.cycle); state.sqFeeder.tracker = state.cycle; state.cycle.hardware = true; }
  const ev = await fox.events();
  state.sqFeeder.sync(ev.now);
  const n = state.sqFeeder.feed(ev.edges);
  state.sqFeeder.apply(ev.carrier, ev.now);
  if (n) chart.huntDirty = true;
  showSq();
}
async function liveLoop() {
  const gen = ++state.gen.live;
  for (const id of ['liveBtn', 'hLiveBtn']) { const b = $(id); b.textContent = 'Stop receiver'; b.classList.add('running'); b.setAttribute('aria-pressed', 'true'); }
  let got = 0, since = performance.now(), failures = 0;
  while (state.live && state.fox && state.gen.live === gen) {
    if (state.scanning || state.keyed || state.foxRunning) { if (state.foxRunning) $('hStatus').textContent = 'receiver paused: this fox is running as a beacon (stop it in Transmit)'; await new Promise(r => setTimeout(r, 100)); continue; }   // a scan has the receiver retuning; TX has it keyed
    try {
      const burst = await state.fox.rssiBurst(state.capturing ? 3 : BURST);   // short bursts while a bearing is being captured: the antenna is moving
      for (let i = 0; i < burst.n; i++) takeSample(burst.t0 + burst.ms[i], burst.rssi[i], burst.f);
      recorder.addBurst(burst, stampFor());
      if (state.fox.state.sqWire) await pollEvents();
      got += burst.n; failures = 0; const dt = (performance.now() - since) / 1000; if (dt > 2) { state.rate = got / dt; $('rateNow').textContent = state.rate.toFixed(1) + ' / s'; got = 0; since = performance.now(); }
    } catch (e) { con.err('rssi: ' + e.message); if (++failures >= 5) { con.err('receiver stopped: five errors in a row (is the fox still there?)'); break; } await new Promise(r => setTimeout(r, 500)); }
  }
  if (state.gen.live === gen) stopLive();
}
function stopLive() { state.live = false; state.gen.live++; for (const id of ['liveBtn', 'hLiveBtn']) { const b = $(id); b.textContent = 'Start receiver'; b.classList.remove('running'); b.setAttribute('aria-pressed', 'false'); } $('rateNow').textContent = '—'; }
function startLive() { if (!state.fox?.bandSet || state.live) return; if (state.replaying) exitReplay(); stopSeek(); state.live = true; $('hStatus').textContent = `receiver running on ${fmtMHz(state.fox.state.freq)} · the countdown appears after two bursts`; liveLoop(); }
$('liveBtn').addEventListener('click', () => { if (state.live) { stopLive(); state.fox?.cancel(); } else startLive(); });
$('hLiveBtn').addEventListener('click', () => { if (state.live) { stopLive(); state.fox?.cancel(); } else startLive(); });
$('oneBtn').addEventListener('click', async () => { try { const r = await state.fox.rssi(); takeSample(r.t, r.rssi, r.f); recorder.addReading(r, stampFor()); } catch (e) { con.err(e.message); } });
/** What every record carries besides the reading: the attenuation and, when on and fresh, the location. */
function stampFor() { const g = geo.stamp() || {}; return settings.attenDb ? { ...g, atten_db: settings.attenDb } : g; }
$('maxResetBtn').addEventListener('click', () => { state.max = -1; $('rssiMax').textContent = '—'; chart.dirty = true; });

// ---------------------------------------------------------------- scan
function scanParams() {
  const start = parseFloat($('scanStart').value), stop = parseFloat($('scanStop').value), stepKHz = parseFloat($('scanStep').value);
  const count = Number.isFinite(start) && Number.isFinite(stop) && stop >= start ? Math.round((stop - start) / (stepKHz / 1000)) + 1 : 0;
  return { start, stop, stepKHz, count };
}
function updateScanCount() {
  const { count } = scanParams(); const max = state.fox?.env.scanMaxChannels || 128, per = state.fox?.env.scanMsPerChannel || 150;
  $('scanCount').textContent = count ? `${count} channel${count === 1 ? '' : 's'}, about ${Math.max(1, Math.round(count * per / 1000))} s${count > max ? ` — over the firmware limit of ${max}` : ''}` : 'enter a start at or below the stop';
  $('scanCount').classList.toggle('err', count > max);
}
['scanStart', 'scanStop', 'scanStep'].forEach(id => $(id).addEventListener('input', updateScanCount));
async function doScan() {
  const fox = state.fox; if (!fox || !fox.bandSet || state.scanning) return;
  if (state.keyed || state.foxRunning) { con.err('scan: the transmitter is keyed; stop it first'); return; }
  if (state.replaying) exitReplay(); if (state.seeking) stopSeek();
  const { start, stop, stepKHz } = scanParams();
  state.scanning = true; $('scanBtn').disabled = true; $('scanBtn').textContent = 'Scanning…'; $('scanBtn').classList.add('busy');
  try {
    const s = await fox.scan(start, stop, stepKHz, { quiet: state.scanLoop });
    acceptScan(s); recorder.addScan(s, stampFor());
  } catch (e) { con.err('scan: ' + e.message); }
  finally { state.scanning = false; $('scanBtn').disabled = !state.fox?.bandSet || state.scanLoop; $('scanBtn').textContent = 'Scan once'; $('scanBtn').classList.remove('busy'); }
}
/** A scan (live or replayed) lands here: the bars, the peak readout, and a waterfall row when the grid matches. */
function acceptScan(s) {
  state.scan = s;
  const sameGrid = state.rowsF && state.rowsF.length === s.n && Math.abs(state.rowsF[0] - s.f[0]) < 1e-6 && Math.abs(state.rowsF[s.n - 1] - s.f[s.n - 1]) < 1e-6;
  if (!sameGrid) { state.rows = []; state.rowsF = s.f.slice(); }
  state.rows.unshift({ t: s.t, rssi: s.rssi.slice() }); if (state.rows.length > WATERFALL_ROWS) state.rows.pop();
  const p = peakIndex(s.rssi);
  $('scanPeak').textContent = p >= 0 ? `${fmtMHz(s.f[p])} · ${s.rssi[p]}` : '—';
  $('scanTime').textContent = `${s.ms ? (s.ms / 1000).toFixed(1) + ' s · ' : ''}${s.n} ch`;
  $('scanHead').textContent = `${s.n} channels, ${s.start.toFixed(4)}–${s.stop.toFixed(4)} MHz, step ${s.stepKHz} kHz${state.scanView === 'waterfall' ? ` · ${state.rows.length} scan${state.rows.length === 1 ? '' : 's'}` : ''}`;
  ['tunePeakBtn', 'pinPeakBtn', 'pngScanBtn', 'scanCsvBtn'].forEach(id => $(id).disabled = false);
  chart.dirty = true;
}
function setScanView(v) { state.scanView = v; document.querySelectorAll('[data-scan-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scanView === v))); $('scanCanvas').style.cursor = v === 'bars' ? 'pointer' : 'crosshair'; if (state.scan) acceptScanHead(); chart.dirty = true; }
function acceptScanHead() { const s = state.scan; $('scanHead').textContent = `${s.n} channels, ${s.start.toFixed(4)}–${s.stop.toFixed(4)} MHz, step ${s.stepKHz} kHz${state.scanView === 'waterfall' ? ` · ${state.rows.length} scan${state.rows.length === 1 ? '' : 's'}` : ''}`; }
document.querySelectorAll('[data-scan-view]').forEach(b => b.addEventListener('click', () => setScanView(b.dataset.scanView)));
async function scanLoop() {
  const gen = ++state.gen.scan;
  const b = $('scanLoopBtn'); b.textContent = 'Stop scanning'; b.classList.add('running'); b.setAttribute('aria-pressed', 'true'); $('scanBtn').disabled = true;
  while (state.scanLoop && state.fox && state.gen.scan === gen) { await doScan(); await new Promise(r => setTimeout(r, 200)); }
  if (state.gen.scan === gen) stopScanLoop();
}
function stopScanLoop() { state.scanLoop = false; state.gen.scan++; const b = $('scanLoopBtn'); b.textContent = 'Scan continuously'; b.classList.remove('running'); b.setAttribute('aria-pressed', 'false'); $('scanBtn').disabled = !state.fox?.bandSet; }
$('scanBtn').addEventListener('click', doScan);
$('scanLoopBtn').addEventListener('click', () => { if (state.scanLoop) { stopScanLoop(); state.fox?.cancel(); } else if (state.fox?.bandSet) { state.scanLoop = true; scanLoop(); } });
$('tunePeakBtn').addEventListener('click', () => { const s = state.scan; if (!s) return; const p = peakIndex(s.rssi); if (p >= 0) { $('freq').value = s.f[p].toFixed(4); tune(); } });
$('pinPeakBtn').addEventListener('click', () => { const s = state.scan; if (!s) return; const p = peakIndex(s.rssi); if (p >= 0) { board.pin(s.f[p], { label: 'scan' }); con.dim(`pinned ${s.f[p].toFixed(4)} MHz from the scan`); } });


// ---------------------------------------------------------------- hunt: mode, seek, board, countdown
function setMode(m) {
  if (!['bench', 'hunt', 'setup'].includes(m)) m = 'bench';
  settings.mode = m; saveSettings(); chart.huntDirty = true; polarDirty = true;
  document.body.classList.toggle('hunt', m === 'hunt'); document.body.classList.toggle('setup', m === 'setup');
  $('huntPanel').hidden = m !== 'hunt'; $('setupPanel').hidden = m !== 'setup';
  for (const [id, v] of [['modeBench', 'bench'], ['modeHunt', 'hunt'], ['modeSetup', 'setup']]) $(id).setAttribute('aria-pressed', String(m === v));
  if (m === 'setup') renderChannels();
  updateHunt(); chart.dirty = true;
}
$('hHelpBtn').addEventListener('click', () => { const h = $('hHelp'); h.hidden = !h.hidden; $('hHelpBtn').setAttribute('aria-expanded', String(!h.hidden)); });
$('modeBench').addEventListener('click', () => setMode('bench')); $('modeHunt').addEventListener('click', () => setMode('hunt')); $('modeSetup').addEventListener('click', () => setMode('setup'));

// ---------------------------------------------------------------- event channels
// The event's frequencies, kept in settings.channels: [{ label, f }]. They feed the
// Receiver presets, the scan presets, the autoseek list and the board.
const chanNote = t => { $('chanNote').textContent = t; };
function channels() { return (settings.channels || []).filter(c => Number.isFinite(c.f)); }
function saveChannels(list) { settings.channels = list.map(c => ({ label: String(c.label || '').slice(0, 24), f: +(+c.f).toFixed(4) })).sort((a, b) => a.f - b.f); saveSettings(); renderChannels(); applyModel(); }
function renderChannels() {
  const tb = $('chanBody'); tb.innerHTML = ''; const list = channels();
  for (const [i, c] of list.entries()) {
    const tr = document.createElement('tr');
    const tdL = document.createElement('td'); const inL = document.createElement('input'); inL.type = 'text'; inL.value = c.label; inL.maxLength = 24; inL.setAttribute('aria-label', 'Label'); inL.addEventListener('change', () => { list[i].label = inL.value; saveChannels(list); }); tdL.appendChild(inL);
    const tdF = document.createElement('td'); const inF = document.createElement('input'); inF.type = 'number'; inF.step = '0.0125'; inF.value = c.f.toFixed(4); inF.setAttribute('aria-label', 'MHz'); inF.addEventListener('change', () => { const f = parseFloat(inF.value); if (Number.isFinite(f)) { list[i].f = f; saveChannels(list); } }); tdF.appendChild(inF);
    const tdX = document.createElement('td'); const rm = document.createElement('button'); rm.className = 'btn small'; rm.textContent = '×'; rm.title = 'Remove'; rm.addEventListener('click', () => { list.splice(i, 1); saveChannels(list); }); tdX.appendChild(rm);
    tr.append(tdL, tdF, tdX); tb.appendChild(tr);
  }
  if (!list.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 3; td.className = 'hint'; td.textContent = 'none yet — add the event\'s frequencies, or take the fox defaults'; tr.appendChild(td); tb.appendChild(tr); }
}
// which wires this fox has (browser-side; the firmware only knows about SQ)
function applyWires() {
  $('wireAudioIn').checked = !!settings.wireAudioIn; $('wireAudioOut').checked = !!settings.wireAudioOut;
  $('audioSource').textContent = settings.wireAudioIn ? 'Audio source: this fox\'s AF_OUT wire — decoders and noise quieting apply to the channel the fox is tuned to.' : 'Audio source: any receiver\'s headphone or speaker jack into the sound card (a handheld on the fox\'s channel works). Tick "AF_OUT → sound card" under Setup if the wire is on this fox, so quieting can drive the countdown.';
  sstvTxEnable();
}
for (const id of ['wireAudioIn', 'wireAudioOut']) $(id).addEventListener('change', () => { settings[id] = $(id).checked; saveSettings(); applyWires(); if (id === 'wireAudioIn' && !settings.wireAudioIn && state.cycle.source === 'audio') { state.cycle.hardware = false; state.cycle.source = null; } });
$('chanAddBtn').addEventListener('click', () => {
  const f = parseFloat($('chanFreq').value); if (!Number.isFinite(f)) { chanNote('enter a frequency in MHz'); return; }
  const list = channels(); if (list.some(c => Math.abs(c.f - f) < 1e-6)) { chanNote('already listed'); return; }
  list.push({ label: $('chanLabel').value.trim() || `Fox ${list.length + 1}`, f }); saveChannels(list); $('chanLabel').value = `Fox ${list.length + 1}`; $('chanFreq').value = (f + 0.025).toFixed(4); chanNote(`added ${f.toFixed(4)}`);
});
$('chanFreq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('chanAddBtn').click(); } });
$('chanDefaultsBtn').addEventListener('click', () => { const list = channels(); for (const [label, f] of [['Fox 2 m', 146.565], ['Fox 70 cm', 433.9]]) if (!list.some(c => Math.abs(c.f - f) < 1e-6)) list.push({ label, f }); saveChannels(list); });
$('chanPinAllBtn').addEventListener('click', () => { let n = 0; for (const c of channels()) { if (!board.get(c.f)) n++; board.pin(c.f, { label: c.label }); } chanNote(`${n} pinned (${channels().length} on the board)`); });
$('chanSeekBtn').addEventListener('click', () => { settings.seekChannels = true; $('seekChans').checked = true; saveSettings(); chanNote(channels().length ? 'autoseek will step the event channels (until a scan range is chosen in Scan & seek)' : 'no channels to seek'); });
$('chanExportBtn').addEventListener('click', () => download(`fox-channels-${stamp()}.json`, new Blob([JSON.stringify({ tool: 'fox-hunt-web', channels: channels() }, null, 2)], { type: 'application/json' })));
$('chanImportBtn').addEventListener('click', async () => {
  const text = await pickFile(); if (!text) return;
  try { const o = JSON.parse(text); const list = (Array.isArray(o) ? o : o.channels || []).map(c => ({ label: c.label || '', f: parseFloat(c.f ?? c.mhz ?? c.freq) })).filter(c => Number.isFinite(c.f)); if (!list.length) throw new Error('no channels in that file'); saveChannels(list); chanNote(`${list.length} channels loaded`); }
  catch (e) { chanNote('import failed: ' + e.message); }
});
// attenuator select in the hunt panel mirrors the Receiver one
$('hAtten').addEventListener('change', () => setAtten(parseInt($('hAtten').value, 10)));

const seekMargin = $('seekMargin'), seekDwell = $('seekDwell'), seekPin = $('seekPin');
seekMargin.value = settings.seekMargin; seekDwell.value = settings.seekDwell; seekPin.checked = settings.seekPin;
$('seekChans').checked = !!settings.seekChannels; $('seekChans').addEventListener('change', () => { settings.seekChannels = $('seekChans').checked; saveSettings(); });
seekMargin.addEventListener('change', () => { settings.seekMargin = Math.max(5, parseInt(seekMargin.value, 10) || 20); seeker.margin = settings.seekMargin; saveSettings(); });
seekDwell.addEventListener('change', () => { settings.seekDwell = Math.max(5, parseInt(seekDwell.value, 10) || 30); seeker.dwellMs = settings.seekDwell * 1000; saveSettings(); });
seekPin.addEventListener('change', () => { settings.seekPin = seekPin.checked; saveSettings(); });

/** Channel list for the seek: the Scan section's start / stop / step. */
function seekChannels() {
  if (settings.seekChannels) { const ev = channels().filter(c => inBands(c.f, state.fox?.env.moduleBands || [])).map(c => c.f); if (ev.length) return ev; }
  const { start, stop, stepKHz, count } = scanParams(); if (!count || count > 128) return []; const ch = []; for (let i = 0; i < count; i++) ch.push(+(start + i * stepKHz / 1000).toFixed(4)); return ch;
}
function seekStatus(t) { $('seekStatus').textContent = t; if (state.seeking) $('hStatus').textContent = t; }
async function seekLoop() {
  const fox = state.fox, gen = ++state.gen.seek;
  for (const id of ['seekBtn', 'hSeekBtn']) { const b = $(id); b.textContent = 'Stop seek'; b.classList.add('running'); b.setAttribute('aria-pressed', 'true'); }
  ['seekSkipBtn', 'seekLockBtn', 'hSkipBtn', 'hLockBtn'].forEach(id => $(id).disabled = false);
  let tuned = null, failures = 0;
  while (state.seeking && state.fox === fox && state.gen.seek === gen) {
    try {
      const f = seeker.channel(); if (f == null) { seekStatus('no channels: set a scan range first'); break; }
      if (f !== tuned) { await fox.tune(f); tuned = f; $('freq').value = f.toFixed(4); $('tunedNow').textContent = fmtMHz(f); state.cycle = board.get(f)?.cycle || createCycleTracker(); if (!state.seekDwelling) state.events.push({ t: Date.now(), label: fmtMHz(f) }); }
      const burst = await fox.rssiBurst(state.seekDwelling ? 10 : 3);
      if (state.seekDwelling && fox.state.sqWire) await pollEvents();
      let last = null;
      for (let i = 0; i < burst.n; i++) { const t = burst.t0 + burst.ms[i]; takeSample(t, burst.rssi[i], f); last = seeker.feed(t, burst.rssi[i]); if (last.action !== 'stay') break; }
      recorder.addBurst(burst, stampFor());
      if (!last) continue;
      if (last.action === 'found') {
        state.seekDwelling = true; state.max = -1;
        if (settings.seekPin) board.pin(f, { label: 'seek' });
        seekStatus(`stopped on ${f.toFixed(4)} MHz: ${Math.round(last.over)} over its floor of ${Math.round(last.floor)}${capture.running ? ' · listening for an ID' : ''}`); con.dim(`seek: carrier on ${f.toFixed(4)} MHz`);
      } else if (last.action === 'lost') {
        state.seekDwelling = false; seekStatus(`${tuned.toFixed(4)} MHz: ${last.why}; moving on`); updateLockUi();
      } else if (last.action === 'step') {
        seekStatus(`seeking… ${f.toFixed(4)} MHz quiet (floor ${Math.round(last.floor)})`);
      } else if (state.seekDwelling) {
        const st = state.cycle.status(); seekStatus(`on ${f.toFixed(4)} MHz · ${Math.round(last.over)} over floor${seeker.locked != null ? ' · locked' : ''}${st.cycles >= 2 ? ` · cycle ${(st.periodMs / 1000).toFixed(0)} s` : ''}`);
      }
      updateHunt(); failures = 0;
    } catch (e) { con.err('seek: ' + e.message); if (++failures >= 5) { con.err('seek stopped: five errors in a row'); break; } await new Promise(r => setTimeout(r, 500)); }
  }
  if (state.gen.seek === gen) stopSeek();
}
function stopSeek() {
  state.gen.seek++;
  if (!state.seeking && !$('seekBtn').classList.contains('running')) return;
  state.seeking = false; state.seekDwelling = false; seeker.unlock();
  for (const id of ['seekBtn', 'hSeekBtn']) { const b = $(id); b.textContent = 'Seek'; b.classList.remove('running'); b.setAttribute('aria-pressed', 'false'); }
  ['seekSkipBtn', 'seekLockBtn', 'hSkipBtn', 'hLockBtn'].forEach(id => $(id).disabled = true); updateLockUi();
  $('seekStatus').textContent = '';
}
function startSeek() {
  if (!state.fox?.bandSet || state.seeking) return;
  if (state.replaying) exitReplay(); stopLive(); stopScanLoop();
  const ch = seekChannels(); if (!ch.length) { const { count } = scanParams(); con.err(count > 128 ? `seek: the scan range is ${count} channels; seek takes up to 128 (widen the step or narrow the range)` : 'seek: set a scan range first'); return; }
  seeker.setChannels(ch); seeker.margin = settings.seekMargin; seeker.dwellMs = settings.seekDwell * 1000;
  state.seeking = true; state.seekDwelling = false; seekLoop();
}
for (const id of ['seekBtn', 'hSeekBtn']) $(id).addEventListener('click', () => state.seeking ? (stopSeek(), state.fox?.cancel()) : startSeek());
for (const id of ['seekSkipBtn', 'hSkipBtn']) $(id).addEventListener('click', () => { if (!state.seeking) return; seeker.skip(); state.seekDwelling = false; updateLockUi(); state.fox?.cancel(); });
function updateLockUi() { for (const id of ['seekLockBtn', 'hLockBtn']) { const b = $(id); b.setAttribute('aria-pressed', String(seeker.locked != null)); b.textContent = seeker.locked != null ? 'Unlock' : 'Lock'; } }
for (const id of ['seekLockBtn', 'hLockBtn']) $(id).addEventListener('click', () => { if (!state.seeking) return; if (seeker.locked != null) seeker.unlock(); else { seeker.lock(seeker.channel()); state.seekDwelling = true; } updateLockUi(); });

// pinning
for (const id of ['pinBtn', 'hPinBtn']) $(id).addEventListener('click', () => { const f = state.fox?.state.freq; if (f == null) return; board.pin(f, { label: 'manual' }); con.dim(`pinned ${f.toFixed(4)} MHz`); });
$('boardAddBtn').addEventListener('click', () => { const f = parseFloat($('boardFreq').value); if (Number.isFinite(f)) { board.pin(f, { label: 'manual' }); $('boardFreq').value = ''; } });
$('boardClearBtn').addEventListener('click', () => board.clear());
const fmtAgoShort = t => t == null ? '—' : (() => { const s = (Date.now() - t) / 1000; return s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${(s / 60).toFixed(0)} m` : `${(s / 3600).toFixed(1)} h`; })();
const fmtCountdown = (st, now) => !st.nextAt ? '—' : (() => { const s = (st.nextAt - now) / 1000; return st.on ? 'ON AIR' : s <= 0 ? 'now' : s < 60 ? `${Math.ceil(s)} s` : `${Math.floor(s / 60)}:${String(Math.ceil(s % 60)).padStart(2, '0')}`; })();
function renderBoard() {
  const list = board.list(), now = Date.now();
  for (const [bodyId, emptyId] of [['boardBody', 'boardEmpty'], ['hBoardBody', 'hBoardEmpty']]) {
    const tb = $(bodyId); tb.innerHTML = ''; $(emptyId).hidden = list.length > 0;
    for (const x of list) {
      const st = x.cycle.status(now), tr = document.createElement('tr'); if (st.on) tr.className = 'on';
      const tuned = state.fox?.state.freq != null && Math.abs(state.fox.state.freq - x.f) < 1e-6;
      tr.innerHTML = `<td>${x.f.toFixed(4)}${tuned ? ' ◂' : ''}</td><td class="${x.id ? 'id' : ''}">${x.id || (x.label || '')}</td><td>${fmtAgoShort(x.lastHeard)}</td><td>${x.max >= 0 ? x.max : '—'}</td><td>${fmtCountdown(st, now)}${st.cycles >= 2 ? `<span class="hint"> /${(st.periodMs / 1000).toFixed(0)} s</span>` : ''}</td><td></td><td></td>`;
      const sp = document.createElement('canvas'); sp.className = 'spark'; sp.width = 72; sp.height = 18; drawSpark(sp, x.spark); tr.children[5].appendChild(sp);
      const t = document.createElement('button'); t.type = 'button'; t.textContent = '↗'; t.title = 'Tune here'; t.addEventListener('click', () => { $('freq').value = x.f.toFixed(4); tune(); });
      const r = document.createElement('button'); r.type = 'button'; r.textContent = '×'; r.title = 'Unpin'; r.addEventListener('click', () => board.unpin(x.f));
      tr.children[6].append(t, r); tb.appendChild(tr);
    }
  }
}
function drawSpark(c, a) { const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height); if (!a.length) return; const [lo, hi] = rssiRange(); ctx.strokeStyle = cssVar('--trace'); ctx.lineWidth = 1; ctx.beginPath(); a.forEach((v, i) => { const x = i / Math.max(1, a.length - 1) * c.width, y = c.height - 1 - Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * (c.height - 2); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
board.onChange = renderBoard;
/** The hunt panel and the Receiver kv: readout, countdown, cycle. Called often; cheap. */
/** The "what now" line at the top of the hunt page: one step at a time, from the state. */
function huntGuide(st, live, last, sLeft) {
  const g = $('hGuide'), fox = state.fox; let step, text, on = false;
  if (!fox) { step = 1; text = 'Connect a fox (or try the simulated one), then Start receiver on the fox\'s channel — or Seek to find it.'; }
  else if (!fox.bandSet) { step = 1; text = 'Pick the SA868 fitted to this fox from the Module dropdown.'; }
  else if (state.capturing) { step = 4; on = true; text = 'Turn a full circle, slowly, then release. The polar plot fills as you go.'; }
  else if (state.seeking && !state.seekDwelling) { step = 1; text = 'Seeking: stepping the channels. It stops where a signal rises over that channel\'s floor.'; }
  else if (!live) { step = 1; text = `Start receiver to listen on ${fmtMHz(fox.state.freq)}${channels().length > 1 ? ', or Seek to step the event channels' : ''}.`; }
  else if (st.on) { step = 3; on = true; text = `FOX IS ON — walk toward the warmer number; with a yagi, swing it and note where RSSI peaks (max ${state.max}). Hold Capture for a bearing.`; }
  else if (st.cycles === 0) { step = 2; text = `Listening on ${fmtMHz(fox.state.freq)}. RSSI ${last?.rssi >= 0 ? last.rssi : '—'} is the floor; the fox keying will jump it. Stay here until it does.`; }
  else if (st.cycles === 1) { step = 2; text = 'One burst heard. One more and the countdown will say when the next comes — stay on the channel.'; }
  else if (sLeft != null && sLeft > 8) { step = 3; text = `Gap: ${Math.round(sLeft)} s until the fox keys again. Move toward the last peak now; be still and ready when it comes back.`; }
  else if (sLeft != null) { step = 3; text = 'Coming up — be still, antenna ready, eyes on the number.'; }
  else { step = 2; text = 'Listening.'; }
  g.classList.toggle('on', on); $('hGuideStep').textContent = String(step); $('hGuideText').textContent = text;
}
function updateHunt() {
  const now = Date.now(), st = state.cycle.status(now), last = state.samples[state.samples.length - 1];
  const live = (state.live || state.seeking) && last && now - last.t < 3000;
  $('hRssi').textContent = live ? (last.rssi >= 0 ? String(last.rssi) : '—') : '—'; $('hRssi').classList.toggle('dim', !live);
  $('hFreq').textContent = state.fox ? `${state.fox.state.freq != null ? fmtMHz(state.fox.state.freq) : 'not tuned'}${state.max >= 0 ? ` · max ${state.max}` : ''}${settings.attenDb ? ` · ${settings.attenDb} dB atten` : ''}` : 'not connected';
  const cd = fmtCountdown(st, now), sLeft = st.nextAt ? (st.nextAt - now) / 1000 : null;
  $('hCountdown').textContent = cd; $('hCountdown').className = 'huge' + (st.on ? ' now' : sLeft != null && sLeft < 5 ? ' soon' : st.nextAt ? '' : ' dim');
  $('hCycle').textContent = st.cycles >= 2 ? `on ${(st.onMs / 1000).toFixed(0)} s every ${(st.periodMs / 1000).toFixed(0)} s · from ${st.cycles} bursts${st.cycles < 4 ? ' (settling)' : st.spread > 0.4 ? ' (irregular)' : ''}${st.hardware ? (state.cycle.source === 'audio' ? ' · quieting' : ' · SQ wire') : ''}` : st.cycles === 1 ? 'one burst heard; the period needs a second' : 'listen on a channel to learn the fox\'s cycle';
  huntGuide(st, live, last, sLeft);
  $('cycleNow').textContent = st.cycles >= 2 ? `${(st.onMs / 1000).toFixed(0)} s on / ${(st.periodMs / 1000).toFixed(0)} s · ${st.cycles} bursts` : st.cycles === 1 ? '1 burst' : '—';
  $('cycleNext').textContent = cd;
  { const sel = $('hAtten'), v = String(settings.attenDb); let o = [...sel.options].find(x => x.value === v);
    if (!o) { o = sel.querySelector('option[data-custom]') || sel.appendChild(Object.assign(document.createElement('option'), { dataset: { custom: '1' } })); o.dataset.custom = '1'; o.value = v; o.textContent = `${v} dB (custom)`; }
    sel.value = v; }
  if (settings.mode === 'hunt' && (chart.huntDirty || live)) { chart.huntDirty = false; const a = fit($('huntCanvas')); if (a) renderRssi(a.ctx, a.W, a.H, state.samples, { windowS: Math.min(settings.windowS, 120), range: rssiRange(), maxHold: state.max >= 0 ? state.max : null, freq: state.fox?.state.freq, events: state.events, lut: settings.heatStrip ? state.lut : null, attenDb: settings.attenDb }); }
}
// the half-second tick only does work while something is happening; an idle page on a phone stays idle
setInterval(() => { const busy = state.live || state.seeking || state.replaying || state.capturing || board.list().some(x => x.cycle.status().nextAt); if (busy || chart.huntDirty) updateHunt(); if (busy && board.list().length) renderBoard(); }, 500);


// ---------------------------------------------------------------- bearing
const compass = createCompass({ onChange: () => { $('compassText').textContent = compass.text(); $('compassText').classList.toggle('err', !!compass.error); for (const id of ['compassBtn', 'hCompassBtn']) $(id).setAttribute('aria-pressed', String(compass.on && compass.source !== 'none')); updateHeading(); } });
compass.setManual(settings.manualHeading); $('headingSlider').value = settings.manualHeading; $('hHeadingSlider').value = settings.manualHeading;
function updateHeading() {
  const h = compass.current(), src = compass.on && compass.source !== 'none' && Number.isFinite(compass.heading) ? 'compass' : 'manual';
  const t = Number.isFinite(h) ? `${Math.round(h)}° (${src})` : '—';
  $('headingText').textContent = t; $('hHeading').textContent = 'heading ' + t;
  // the simulated fox has a yagi on it, but only while a bearing is being captured or a real compass is live;
  // otherwise the demo hears everything as if on a whip, so the keyed fox is strong out of the box
  if (state.fox?.link && 'heading' in state.fox.link) state.fox.link.heading = (state.capturing || (compass.on && compass.source !== 'none')) && Number.isFinite(h) ? h : null;
  if (state.scanView === 'bearing') chart.dirty = true;
}
for (const id of ['headingSlider', 'hHeadingSlider']) $(id).addEventListener('input', () => { const v = parseInt($(id).value, 10) || 0; settings.manualHeading = v; saveSettings(); compass.setManual(v); for (const o of ['headingSlider', 'hHeadingSlider']) if (o !== id) $(o).value = v; updateHeading(); });
for (const id of ['compassBtn', 'hCompassBtn']) $(id).addEventListener('click', async () => { if (compass.on) compass.stop(); else { await compass.start(); if (compass.source === 'none') con.dim('no compass on this device: the heading slider is used'); } updateHeading(); });
for (const id of ['northBtn', 'hNorthBtn']) $(id).addEventListener('click', () => { compass.markNorth(); for (const o of ['headingSlider', 'hHeadingSlider']) $(o).value = Math.round(compass.manual || 0); con.dim('north marked'); updateHeading(); });

function captureList() { return state.captures.map((c, i) => ({ cap: c, label: c.label || `#${i + 1}`, active: c === state.capturing || (!state.capturing && i === state.captures.length - 1) })); }
const captureNote = t => { $('captureStatus').textContent = t; $('hBearingText').textContent = t; };
function beginCapture() {
  if (!state.fox?.bandSet || state.capturing) return;
  if (!state.live && !state.seeking) startLive();
  if (!Number.isFinite(compass.current())) { captureNote('no heading: turn the compass on or drag the heading slider'); return; }
  const c = createBearingCapture({ t: Date.now(), geo: geo.stamp(), freq: state.fox.state.freq }); c.label = `#${state.captures.length + 1}`;
  state.capturing = c; state.liveBearing = null; updateHeading();
  for (const id of ['captureBtn', 'hCaptureBtn']) { $(id).setAttribute('aria-pressed', 'true'); $(id).textContent = 'Capturing — turn a full circle'; }
  if (settings.mode === 'bench') setScanView('bearing');
  captureNote('turning… release when you have been all the way round');
}
function endCapture() {
  const c = state.capturing; if (!c) return; state.capturing = null; updateHeading();
  for (const id of ['captureBtn', 'hCaptureBtn']) { $(id).setAttribute('aria-pressed', 'false'); $(id).textContent = 'Hold to capture'; }
  const r = c.analyze();
  if (!r.ok && c.samples.length < 6) { captureNote(`too short (${c.samples.length} readings): hold while turning`); chart.dirty = true; return; }
  state.captures.push(c); renderBearings(); polarDirty = true;
  captureNote(r.ok ? `bearing ${Math.round(r.bearing)}° ±${Math.round(r.width / 2)}° on ${c.freq?.toFixed(4) ?? '?'} MHz${c.geo ? '' : ' · no location: turn it on for a fix'}${r.why ? ' · ' + r.why : ''}` : `no bearing: ${r.why}`);
  con.dim(`bearing capture ${c.label}: ${r.ok ? Math.round(r.bearing) + '°' : 'no lobe'} from ${c.samples.length} readings over ${r.coverage}°`);
  chart.dirty = true;
}
for (const id of ['captureBtn', 'hCaptureBtn']) { const b = $(id); b.addEventListener('pointerdown', e => { if (b.disabled) return; b.setPointerCapture(e.pointerId); beginCapture(); }); for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, endCapture); }
function renderBearings() {
  const tb = $('bearingBody'); tb.innerHTML = ''; $('bearingEmpty').hidden = state.captures.length > 0;
  state.captures.forEach((c, i) => {
    const r = c.analyze(), tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(c.t).toLocaleTimeString()}</td><td>${c.freq?.toFixed(4) ?? '—'}</td><td>${r.ok ? Math.round(r.bearing) + '°' : '—'}</td><td>${r.ok ? '±' + Math.round(r.width / 2) + '°' : r.why}</td><td>${c.geo ? `±${c.geo.acc} m` : 'no location'}</td><td></td>`;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Remove'; x.addEventListener('click', () => { state.captures.splice(i, 1); renderBearings(); chart.dirty = true; });
    tr.children[5].appendChild(x); tb.appendChild(tr);
  });
  // a fix from the last two captures that have a location and a bearing
  const good = state.captures.filter(c => c.geo && c.analyze().ok).slice(-2);
  state.lastFix = good.length === 2 ? fixFromBearings({ geo: good[0].geo, bearing: good[0].analyze().bearing }, { geo: good[1].geo, bearing: good[1].analyze().bearing }) : null;
  if (good.length < 2) $('fixText').textContent = 'needs two captures with location from different places';
  else if (!state.lastFix) $('fixText').textContent = `no fix: the two bearings (${Math.round(good[0].analyze().bearing)}°, ${Math.round(good[1].analyze().bearing)}°) are too close to parallel or point apart — move further sideways`;
  else { const f = state.lastFix, here = geo.stamp(); $('fixText').textContent = `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)} · ${Math.round(f.distB)} m from the second spot · bearings cross at ${Math.round(f.angle)}°${here ? ` · ${Math.round(distanceBetween(here, f))} m from here` : ''}`; }
  $('fixCopyBtn').disabled = !state.lastFix;
}
$('fixCopyBtn').addEventListener('click', async () => { if (!state.lastFix) return; try { await navigator.clipboard.writeText(`${state.lastFix.lat.toFixed(5)}, ${state.lastFix.lon.toFixed(5)}`); $('fixCopyBtn').textContent = 'Copied'; setTimeout(() => $('fixCopyBtn').textContent = 'Copy fix', 1200); } catch { con.err('clipboard unavailable'); } });
$('bearingClearBtn').addEventListener('click', () => { state.captures = []; renderBearings(); polarDirty = true; chart.dirty = true; });
let polarDirty = true, lastPolarHeading = NaN;
setInterval(() => {
  if (settings.mode !== 'hunt') return;
  const h = compass.current(); if (state.capturing || polarDirty || (Number.isFinite(h) && Math.abs(h - lastPolarHeading) >= 1)) { polarDirty = false; lastPolarHeading = h; const a = fit($('hPolar')); if (a) renderPolar(a.ctx, a.W, a.H, captureList(), { heading: h, range: rssiRange(), live: state.capturing ? state.liveBearing : null }); }
}, 200);

// CW identification: a callsign decoded while tuned pins and labels that channel
function noteDecoded() {
  const f = state.fox?.state.freq; if (f == null) return;
  const tail = cwDec.text.slice(-60), calls = findCallsigns(tail); if (!calls.length) return;
  const call = calls[calls.length - 1];
  if (state.lastId && state.lastId.call === call && Math.abs(state.lastId.f - f) < 1e-6 && Date.now() - state.lastId.t < 60000) return;
  state.lastId = { call, f, t: Date.now() };
  board.pin(f, { id: call, label: 'ID' }); board.identify(f, call);
  con.dim(`ID: ${call} on ${f.toFixed(4)} MHz`); seekStatus(`${f.toFixed(4)} MHz identified as ${call}`);
}
$('hAudioBtn').addEventListener('click', () => $('audioBtn').click());

// ---------------------------------------------------------------- recording / export
recorder.onChange = () => {
  $('recReadings').textContent = String(recorder.readings.length); $('recScans').textContent = String(recorder.scans.length);
  const any = recorder.count() > 0; ['recReadingsBtn', 'recScansBtn', 'recJsonBtn', 'recClearBtn'].forEach(id => $(id).disabled = !any);
  $('recBadge').hidden = !recorder.on; const b = $('recBtn'); b.textContent = recorder.on ? 'Stop recording' : 'Start recording'; b.setAttribute('aria-pressed', String(recorder.on)); b.classList.toggle('running', recorder.on);
};
$('recBtn').addEventListener('click', () => recorder.on ? recorder.stop() : recorder.start());
$('recReadingsBtn').addEventListener('click', () => download(`fox-readings-${stamp()}.csv`, recorder.readingsCsv()));
$('recScansBtn').addEventListener('click', () => download(`fox-scans-${stamp()}.csv`, recorder.scansCsv()));
$('recJsonBtn').addEventListener('click', () => download(`fox-session-${stamp()}.json`, sessionBlob(recorder, { app: APP_VERSION, device: state.fox?.ident.version || null, band: state.fox?.state.band || null, settings: { ...settings }, board: board.serialize(), bearings: state.captures.map(c => ({ ...c.serialize(), label: c.label })) })));
$('recClearBtn').addEventListener('click', () => recorder.clear());

// ---------------------------------------------------------------- replay
// A loaded session replays through the same acceptors the live fox uses; the
// fox itself is left alone, and Live puts the windows back on it.
const replay = createReplay();
const clipSlider = $('clipSlider'), clipPos = $('clipPos');
const fmtClock = t => new Date(t).toLocaleTimeString();
replay.onEvent = ev => { if (ev.kind === 'reading') takeSample(ev.t, ev.rssi, ev.f); else acceptScan({ ...ev, ms: 0 }); };
replay.onPos = (t, i, n) => { clipSlider.value = i; clipPos.textContent = n ? `${fmtClock(t)} · ${i} / ${n}` : 'live'; };
replay.onEnd = () => { $('clipPlayBtn').textContent = 'Play'; $('clipPlayBtn').setAttribute('aria-pressed', 'false'); };
function enterReplay(name) {
  stopLive(); stopScanLoop(); stopSeek(); state.cycle = createCycleTracker();
  state.replaying = true; document.body.classList.add('replaying'); $('replayBadge').hidden = false; $('sessName').textContent = name;
  state.samples = []; state.events = []; state.max = -1; state.scan = null; state.rows = []; state.rowsF = null;
  clipSlider.disabled = false; clipSlider.max = replay.events.length; $('clipPlayBtn').disabled = false; $('clipExitBtn').disabled = false;
  replay.seek(0); chart.dirty = true;
}
function exitReplay() {
  replay.stop(); state.replaying = false; document.body.classList.remove('replaying'); $('replayBadge').hidden = true; $('sessName').textContent = 'A loaded session replays into the windows; the fox is left alone.';
  state.samples = []; state.events = []; state.max = -1; state.scan = null; state.rows = []; state.rowsF = null;
  clipSlider.disabled = true; clipSlider.value = 0; clipSlider.max = 0; $('clipPlayBtn').disabled = true; $('clipExitBtn').disabled = true; clipPos.textContent = 'live';
  $('clipPlayBtn').textContent = 'Play'; $('clipPlayBtn').setAttribute('aria-pressed', 'false'); chart.dirty = true;
}
$('sessLoadBtn').addEventListener('click', async () => {
  const text = await pickFile(); if (!text) return;
  try {
    const sess = parseSession(text);
    recorder.stop(); recorder.load(sess);
    const n = replay.load(sess.readings, sess.scans);
    if (!n) throw new Error('the session has no readings or scans');
    if (sess.meta.settings?.attenDb != null) { settings.attenDb = sess.meta.settings.attenDb; applyAtten(); }
    if (sess.meta.board?.length) board.restore(sess.meta.board);
    if (sess.meta.bearings?.length) { state.captures = sess.meta.bearings.map(o => { const c = restoreCapture(o); c.label = o.label; return c; }); renderBearings(); }
    enterReplay(`${n} records · ${sess.meta.device || 'unknown fox'} · saved ${sess.meta.savedAt ? new Date(sess.meta.savedAt).toLocaleString() : '?'}`);
    con.dim(`session loaded: ${sess.readings.length} readings, ${sess.scans.length} scans`);
  } catch (e) { con.err('load session: ' + e.message); }
});
clipSlider.addEventListener('input', () => { replay.pause(); $('clipPlayBtn').textContent = 'Play'; $('clipPlayBtn').setAttribute('aria-pressed', 'false'); const i = parseInt(clipSlider.value, 10); state.samples = []; state.events = []; state.max = -1; state.scan = null; state.rows = []; state.rowsF = null; replay.i = 0; replay.feedTo(i); chart.dirty = true; });
$('clipPlayBtn').addEventListener('click', () => { if (replay.playing) { replay.pause(); $('clipPlayBtn').textContent = 'Play'; $('clipPlayBtn').setAttribute('aria-pressed', 'false'); } else { if (replay.i >= replay.events.length) { state.samples = []; state.events = []; state.max = -1; state.scan = null; state.rows = []; state.rowsF = null; } replay.play(); $('clipPlayBtn').textContent = 'Pause'; $('clipPlayBtn').setAttribute('aria-pressed', 'true'); } });
$('clipSpeed').addEventListener('change', () => { replay.speed = parseFloat($('clipSpeed').value) || 1; if (replay.playing) { replay.pause(); replay.play(); } });
$('clipExitBtn').addEventListener('click', exitReplay);
$('pngRssiBtn').addEventListener('click', () => canvasPng($('rssiCanvas'), `fox-rssi-${stamp()}.png`));
$('pngScanBtn').addEventListener('click', () => canvasPng($('scanCanvas'), `fox-scan-${stamp()}.png`));
$('scanCsvBtn').addEventListener('click', () => { const s = state.scan; if (!s) return; const rows = ['frequency_mhz,rssi']; for (let i = 0; i < s.n; i++) rows.push(`${s.f[i].toFixed(4)},${s.rssi[i]}`); download(`fox-scan-${stamp()}.csv`, new Blob([rows.join('\n') + '\n'], { type: 'text/csv' })); });

// ---------------------------------------------------------------- fox configuration
$('callsignBtn').addEventListener('click', async () => {
  const fox = state.fox; if (!fox) return;
  try { const cs = await fox.callsign($('callsign').value); $('foxStatus').textContent = `callsign ${cs} stored on the board`; $('foxStatus').classList.remove('err'); $('morseText').value = ''; applyTx(); }
  catch (e) { $('foxStatus').textContent = e.message; $('foxStatus').classList.add('err'); }
});


// ---------------------------------------------------------------- transmit
// Every action here goes through fox.js, which refuses on the page when the
// firmware said tx: disabled, and the firmware refuses again on its side.
const txErr = e => { $('txStatus').textContent = e.message; $('txStatus').classList.add('err'); con.err(e.message); };
const txNote = t => { $('txStatus').textContent = t; $('txStatus').classList.remove('err'); };
function morseEstimate() { const fox = state.fox, t = $('morseText').value.trim(); $('morseEst').textContent = fox && t ? `About ${fox.morseSeconds(t).toFixed(1)} s on the air at ${fox.state.wpm} wpm. Nothing is prepended: put your callsign in the text.` : 'Air time appears as you type. Nothing is prepended: put your callsign in the text.'; }
$('morseText').addEventListener('input', morseEstimate);
$('txArm').addEventListener('change', async () => {
  const fox = state.fox; if (!fox) return;
  try { if ($('txArm').checked) { await fox.arm(); txNote('armed: the Key, Morse and beacon controls are live'); startTxPoll(); } else { await fox.disarm(); txNote('disarmed'); stopTxPoll(); } }
  catch (e) { txErr(e); $('txArm').checked = false; }
  applyTx();
});
$('txPower').addEventListener('change', async () => { try { await state.fox.power($('txPower').value); } catch (e) { txErr(e); } });
$('txWpm').addEventListener('change', async () => { try { await state.fox.wpm(parseInt($('txWpm').value, 10)); morseEstimate(); } catch (e) { txErr(e); } });
// hold-to-key: press sends tx on 10, release sends tx off; the firmware's own 10 s deadline is the backstop
const keyBtn = $('keyBtn');
let keyHeld = false;
keyBtn.addEventListener('pointerdown', async e => {
  if (keyBtn.disabled) return; keyBtn.setPointerCapture(e.pointerId); keyHeld = true;
  stopLive(); stopScanLoop(); stopSeek();
  try { const left = await state.fox.keyOn(10); keyBtn.setAttribute('aria-pressed', 'true'); keyBtn.textContent = 'KEYED — release to stop'; state.keyed = true; $('txBadge').hidden = false; $('keyTimer').textContent = `${left.toFixed(0)} s max`; }
  catch (err) { txErr(err); keyHeld = false; }
});
const keyRelease = async () => { if (!keyHeld) return; keyHeld = false; try { await state.fox.keyOff(); } catch (err) { txErr(err); } keyBtn.setAttribute('aria-pressed', 'false'); keyBtn.textContent = 'Hold to key'; state.keyed = false; $('keyTimer').textContent = ''; applyTx(); };
keyBtn.addEventListener('pointerup', keyRelease); keyBtn.addEventListener('pointercancel', keyRelease); keyBtn.addEventListener('lostpointercapture', keyRelease);
$('toneBtn').addEventListener('click', async () => { stopLive(); stopSeek(); state.fox?.cancel(); try { $('toneBtn').disabled = true; txNote(await state.fox.tone(800, 500)); } catch (e) { txErr(e); } finally { $('toneBtn').disabled = !state.fox?.state.armed; } });
$('morseBtn').addEventListener('click', async () => {
  const fox = state.fox, text = $('morseText').value.trim(); if (!fox || !text) return;
  stopLive(); stopScanLoop(); stopSeek();
  $('morseBtn').disabled = true; $('morseBtn').textContent = 'On the air…'; state.keyed = true; $('txBadge').hidden = false;
  try { const r = await fox.morse(text); txNote(`${r.result}: "${text.toUpperCase()}", ${r.seconds.toFixed(1)} s`); }
  catch (e) { txErr(e); }
  finally { $('morseBtn').disabled = !fox.state.armed; $('morseBtn').textContent = 'Send'; state.keyed = false; applyTx(); }
});
$('foxBtn').addEventListener('click', async () => {
  const fox = state.fox; if (!fox) return;
  try {
    if (state.foxRunning) { const n = await fox.foxStop(); txNote(`beacon stopped after ${n} cycle${n === 1 ? '' : 's'}`); }
    else {
      stopLive(); stopScanLoop(); stopSeek();
      await fox.foxmsg($('foxMsg').value); await fox.foxdelay(parseInt($('foxDelay').value, 10)); await fox.wpm(parseInt($('txWpm').value, 10));
      await fox.foxStart(); txNote(`beacon running: "${fox.state.callsign} ${fox.state.foxmsg}" every ${fox.state.foxdelay} s`); startTxPoll();
    }
  } catch (e) { txErr(e); }
  applyTx();
});
/** While armed, read `tx` and `fox` once a second so auto-unkey and beacon cycles show on the page. */
function startTxPoll() { stopTxPoll(); state.txPoll = setInterval(async () => { const fox = state.fox; if (!fox || !fox.state.armed || state.scanning) return; try { await fox.txStatus(); if (state.foxRunning || fox.state.foxRunning) await fox.foxStatus(); } catch {} applyTx(); }, 1000); }
function stopTxPoll() { if (state.txPoll) { clearInterval(state.txPoll); state.txPoll = null; } }

// ---------------------------------------------------------------- SSTV transmit
// Picture → encoder → sound card out → SA868 MIC_IN. The fox is keyed for the frame with `mic line`.
const sstvTxNote = (t, err = false) => { $('sstvTxNote').textContent = t; $('sstvTxNote').classList.toggle('err', err); };
function sstvTxEnable() {
  $('sstvTxBlock').hidden = !settings.wireAudioOut; $('sstvTxOff').hidden = !!settings.wireAudioOut;
  const fox = state.fox, ok = !!fox?.state.txAvailable && fox.state.armed && hasPlayout() && (fox.ident.build?.[1] ?? 0) >= 5;
  ['sstvFile', 'sstvTxMode'].forEach(id => $(id).disabled = !fox);
  $('sstvSendBtn').disabled = !ok || !sstvTx.image || sstvTx.busy;
  $('sstvPreviewBtn').disabled = !sstvTx.image || sstvTx.busy || !hasPlayout();
  $('sstvStopBtn').disabled = !sstvTx.busy;
  if (fox && fox.state.txAvailable && (fox.ident.build?.[1] ?? 0) < 5) sstvTxNote('needs firmware 0.5.0 (`mic line`); install it from the Firmware section');
}
async function sstvOutputs() { try { const outs = await listOutputs(); const sel = $('sstvOut'), keep = sel.value; sel.innerHTML = '<option value="">Default output</option>' + outs.map(o => `<option value="${o.id}">${o.label}</option>`).join(''); sel.value = outs.some(o => o.id === keep) ? keep : ''; } catch {} }
function sstvTxRender() {
  const mode = SSTV_MODES[parseInt($('sstvTxMode').value, 10)]; sstvTx.mode = mode; sstvTx.samples = null;
  const cv = $('sstvTxPreview'); cv.width = mode.width; cv.height = mode.height;
  if (!sstvTx.image) { const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height); return; }
  const fit = fitImage(sstvTx.image, mode.width, mode.height); cv.getContext('2d').drawImage(fit.canvas, 0, 0); sstvTx.rgba = fit.rgba;
  sstvTxNote(`${mode.name}, ${mode.width}×${mode.height}, about ${Math.round(frameSeconds(mode))} s on the air`);
}
function frameSeconds(mode) { let ms = 300 + 10 + 300 + 30 + 8 * 30 + 30 + (mode.preMs || 0); for (let y = 0; y < mode.height; y++) for (const sgm of mode.segments(y)) ms += sgm.ms; return ms / 1000; }
function sstvEncode() { if (!sstvTx.samples) { sstvTxNote('encoding…'); sstvTx.samples = encodeSstv(sstvTx.mode, sstvTx.rgba, { sampleRate: 48000, amplitude: 0.5 }); } return sstvTx.samples; }
$('sstvFile').addEventListener('change', async () => {
  const f = $('sstvFile').files?.[0]; if (!f) return;
  try { const img = new Image(); img.src = URL.createObjectURL(f); await img.decode(); sstvTx.image = img; sstvTxRender(); sstvOutputs(); }
  catch (e) { sstvTxNote('could not read that picture: ' + e.message, true); }
  sstvTxEnable();
});
$('sstvTxMode').addEventListener('change', () => { sstvTxRender(); sstvTxEnable(); });
const sstvProgress = (p, total) => { $('sstvTxProgress').hidden = false; $('sstvTxFill').style.width = (p * 100).toFixed(1) + '%'; sstvTxNote(`${Math.round(p * total)} / ${Math.round(total)} s`); };
$('sstvPreviewBtn').addEventListener('click', async () => {
  if (sstvTx.busy || !sstvTx.image) return; sstvTx.busy = true; sstvTxEnable();
  try { const smp = sstvEncode(); await sstvTx.playout.play(smp, 48000, { deviceId: $('sstvOut').value, onProgress: sstvProgress }); sstvTxNote('preview done (nothing was keyed)'); }
  catch (e) { sstvTxNote(e.message, true); }
  finally { sstvTx.busy = false; $('sstvTxProgress').hidden = true; sstvTxEnable(); }
});
$('sstvSendBtn').addEventListener('click', async () => {
  const fox = state.fox; if (!fox || sstvTx.busy || !sstvTx.image) return;
  sstvTx.busy = true; sstvTx.stopAsked = false; sstvTxEnable(); stopLive(); stopScanLoop(); stopSeek();
  const smp = sstvEncode(), secs = smp.length / 48000;
  let keyed = false;
  try {
    await fox.mic('line');
    await fox.keyOn(Math.min(120, secs + 2)); keyed = true; state.keyed = true; $('txBadge').hidden = false; applyTx();
    await new Promise(r => setTimeout(r, 750));                       // PTT lead, like the Morse path
    const done = sstvTx.stopAsked ? false : await sstvTx.playout.play(smp, 48000, { deviceId: $('sstvOut').value, onProgress: sstvProgress });
    sstvTxNote(done ? `sent: ${sstvTx.mode.name}, ${Math.round(secs)} s` : 'stopped');
  } catch (e) { sstvTxNote(e.message, true); con.err('sstv: ' + e.message); }
  finally {
    if (keyed) { try { await fox.keyOff(); } catch {} }
    try { await fox.mic('pwm'); } catch {}
    state.keyed = false; sstvTx.busy = false; $('sstvTxProgress').hidden = true; applyTx(); sstvTxEnable();
  }
});
$('sstvStopBtn').addEventListener('click', () => { sstvTx.stopAsked = true; sstvTx.playout.stop(); });
sstvTxRender();

// ---------------------------------------------------------------- bench pair
// A second fox, on its own port, as the beacon. Its commands go through the
// same Fox class and the same gates; the console shows them prefixed [B].
Object.assign(pair, { fox: null, demo: false, timer: null });
const pairNote = t => { $('pairNote').textContent = t; $('pairNote').classList.remove('err'); };
const pairErr = e => { $('pairNote').textContent = e.message || String(e); $('pairNote').classList.add('err'); con.err('[B] ' + (e.message || e)); };
function showPair() {
  const b = pair.fox, on = !!b;
  $('pairControls').hidden = !on; $('pairBtn').hidden = on;
  $('pairStatus').textContent = on ? `${pair.demo ? 'simulated' : 'paired'} · ${b.ident.label}` : 'not paired';
  if (!on) return;
  $('pairIdent').textContent = `${b.ident.module}${b.state.moduleConnected === false ? ' — not responding' : ''}`;
  $('pairFw').textContent = b.ident.firmware;
  $('pairFreq').textContent = Number.isFinite(b.state.freq) ? fmtMHz(b.state.freq) : '—';
  $('pairTx').textContent = !b.state.txAvailable ? 'disabled in this build (install the TX firmware on it)' : b.state.callsign === 'N0CALL' ? 'needs a callsign' : b.state.armed ? (b.state.keyed ? `keyed, ${b.state.keyedLeft.toFixed(1)} s left` : 'armed') : 'not armed';
  $('pairCallsign').value = b.state.callsign === 'N0CALL' ? '' : b.state.callsign;
  $('pairArm').checked = b.state.armed; $('pairArm').disabled = !b.state.txAvailable || b.state.callsign === 'N0CALL';
  if (!$('pairFreqIn').value && Number.isFinite(b.state.freq)) $('pairFreqIn').value = b.state.freq.toFixed(4);
  if (document.activeElement !== $('pairMsg') && !$('pairMsg').value) $('pairMsg').value = b.state.foxmsg || 'FOX';
  if (document.activeElement !== $('pairDelay')) $('pairDelay').value = b.state.foxdelay || 30;
  const live = b.state.txAvailable && b.state.armed;
  ['pairFoxBtn', 'pairKeyBtn', 'pairToneBtn'].forEach(id => $(id).disabled = !live);
  $('pairFoxBtn').textContent = b.state.foxRunning ? 'Stop beacon' : 'Start beacon'; $('pairFoxBtn').setAttribute('aria-pressed', String(b.state.foxRunning)); $('pairFoxBtn').classList.toggle('running', b.state.foxRunning);
}
async function pairConnect() {
  if (pair.fox) return;
  const demo = state.demo;   // a simulated receiver gets a simulated beacon; a real one gets a port chooser
  const a = state.fox;
  const link = demo ? new DemoLink({ band: a?.state.band || 'dual', txEnabled: true, callsign: 'N0CALL' }) : new SerialLink();
  link.onTx = cmd => con.tx('[B] ' + cmd); link.onRx = (body, meta) => con.reply(body, meta);
  if (!demo) link.onDrop = e => { con.err('[B] port error: ' + e.message); pairDrop(true); };
  const b = new Fox(link); b.onWarning = t => con.err('[B] warning: ' + t);
  try {
    await link.open(); await b.identify();
    if (!demo && a && a.link?.port && link.port === a.link.port) throw new Error('that is the receiver\'s port; pick the other fox');
    if (!b.bandSet && a?.state.band) { con.dim(`[B] setting the module band to ${a.state.band}`); await b.band(a.state.band); }
    pair.fox = b; pair.demo = demo; $('pairFreqIn').value = '';
    if (a?.bandSet && Number.isFinite(a.state.freq) && b.bandSet) { try { await b.tune(a.state.freq); } catch {} }
    showPair();
    pairNote(demo ? 'a simulated beacon: when it keys, the simulated receiver hears it on its frequency (Morse at 1/10 real time)' : b.state.txAvailable ? 'paired. Store a callsign if it has none, arm, then start the beacon or key it' : 'paired, but this fox runs the receive-only build: install the firmware with "Transmit commands" ticked to use it as the beacon');
    startPairPoll();
  } catch (e) { pairErr(e); try { await link.close(); } catch {} }
}
async function pairDrop(silent) {
  const b = pair.fox; if (!b) return; stopPairPoll();
  if (!silent && b.state.txAvailable) { try { await b.rx(); } catch {} }
  pair.fox = null; pair.demo = false;
  try { await b.link.close(); } catch {}
  showPair(); pairNote(silent ? 'the beacon fox dropped off' : 'unpaired');
}
function startPairPoll() { stopPairPoll(); pair.timer = setInterval(async () => { const b = pair.fox; if (!b) return; try { if (b.state.foxRunning) { const st = await b.foxStatus(); $('pairFoxLine').textContent = st.running ? `running · ${st.cycles} cycle${st.cycles === 1 ? '' : 's'} · next in ${st.nextS} s` : `stopped after ${st.cycles} cycles`; if (!st.running) showPair(); } else if (b.state.armed) { const t = await b.txStatus(); $('pairTx').textContent = t.keyed ? `keyed, ${t.left.toFixed(1)} s left` : 'armed'; } } catch (e) { /* the next tick tries again */ } }, 1500); }
function stopPairPoll() { if (pair.timer) clearInterval(pair.timer); pair.timer = null; }
$('pairBtn').addEventListener('click', pairConnect);
$('pairDropBtn').addEventListener('click', () => pairDrop(false));
$('pairCallsignBtn').addEventListener('click', async () => { const b = pair.fox; if (!b) return; try { const cs = await b.callsign($('pairCallsign').value.trim().toUpperCase() || 'N0CALL'); pairNote(`callsign on the beacon: ${cs}`); showPair(); } catch (e) { pairErr(e); } });
$('pairArm').addEventListener('change', async () => { const b = pair.fox; if (!b) return; try { if ($('pairArm').checked) { await b.arm(); pairNote('beacon armed'); } else { await b.disarm(); pairNote('beacon disarmed'); } } catch (e) { pairErr(e); } showPair(); });
async function pairTune(f) { const b = pair.fox; if (!b) return; try { const t = await b.tune(f); $('pairFreqIn').value = t.toFixed(4); pairNote(`beacon on ${fmtMHz(t)}`); showPair(); } catch (e) { pairErr(e); } }
$('pairTuneBtn').addEventListener('click', () => pairTune(parseFloat($('pairFreqIn').value)));
$('pairFollowBtn').addEventListener('click', () => { const f = state.fox?.state.freq; if (Number.isFinite(f)) pairTune(f); });
$('pairFoxBtn').addEventListener('click', async () => {
  const b = pair.fox; if (!b) return;
  try {
    if (b.state.foxRunning) { const n = await b.foxStop(); $('pairFoxLine').textContent = `stopped after ${n} cycle${n === 1 ? '' : 's'}`; pairNote('beacon stopped'); }
    else { await b.foxmsg($('pairMsg').value); await b.foxdelay(parseInt($('pairDelay').value, 10)); await b.foxStart(); $('pairFoxLine').textContent = 'running'; pairNote(`beacon running: "${b.state.callsign} ${b.state.foxmsg}" every ${b.state.foxdelay} s — start the receiver on ${fmtMHz(b.state.freq)} to watch it`); }
  } catch (e) { pairErr(e); }
  showPair();
});
$('pairKeyBtn').addEventListener('click', async () => { const b = pair.fox; if (!b) return; try { await b.keyOn(5); pairNote('beacon keyed for 5 s'); } catch (e) { pairErr(e); } showPair(); });
$('pairToneBtn').addEventListener('click', async () => { const b = pair.fox; if (!b) return; try { await b.tone(800, 500); pairNote('tone sent'); } catch (e) { pairErr(e); } });
showPair();

// ---------------------------------------------------------------- audio
const capture = createCapture();
const cwDec = new CwDecoder({ sampleRate: 48000, toneHz: 800, autoTone: true });
const sstvDec = new SstvDecoder({ sampleRate: 48000 });
state.audio.cw = cwDec; state.audio.sstv = sstvDec;
if (!hasAudioCapture()) { $('audioBtn').disabled = true; $('audioInfo').textContent = 'no audio capture in this browser'; }
async function fillInputs() { const list = await listInputs(); const sel = $('audioDev'); const cur = sel.value; sel.innerHTML = '<option value="">Default input</option>' + list.map(d => `<option value="${d.id}">${d.label}</option>`).join(''); sel.value = cur; }
fillInputs(); $('audioRefresh').addEventListener('click', fillInputs);
async function audioPermission() { try { const p = await navigator.permissions.query({ name: 'microphone' }); const t = { granted: 'granted', denied: 'denied — allow the microphone for this site (the lock icon by the address bar), then reload', prompt: 'not asked yet; the browser asks when audio starts' }[p.state] || p.state; $('audioPerm').textContent = t; $('audioPerm').classList.toggle('err', p.state === 'denied'); p.onchange = audioPermission; } catch { $('audioPerm').textContent = 'the browser asks when audio starts'; } }
audioPermission();
/** What the browser granted versus what was asked for; anything unexpected is shown in red. */
function audioGranted() {
  const t = capture.stream?.getAudioTracks()[0]; if (!t) return;
  const g = t.getSettings(); const bad = [];
  if (g.echoCancellation) bad.push('echo cancellation ON'); if (g.autoGainControl) bad.push('auto gain ON'); if (g.noiseSuppression) bad.push('noise suppression ON');
  const got = `got: echo cancellation ${g.echoCancellation ? 'ON' : 'off'}, auto gain ${g.autoGainControl ? 'ON' : 'off'}, noise suppression ${g.noiseSuppression ? 'ON' : 'off'}, ${g.channelCount || '?'} ch, ${g.sampleRate || capture.sampleRate} Hz`;
  $('audioProc').textContent = got + (bad.length ? ` — ${bad.join(', ')}: the decoders will struggle; change the input device or its OS settings` : ' — as asked');
  $('audioProc').classList.toggle('err', bad.length > 0);
  if (bad.length) con.err('audio: the browser left ' + bad.join(', ') + '; decoding may be unreliable');
}
capture.onLevel = db => { $('audioLevel').textContent = `${db.toFixed(0)} dBFS${db > -1 ? ' — clipping, turn the sound card input down' : db < -40 ? ' — low, turn it up' : ''}`; };
// noise quieting: the hiss as a carrier detector (Audio section toggle)
const quiet = createQuieting({ sampleRate: 48000 });
let quietFeeder = null, quietShown = 0;   // edges into whichever cycle tracker is current, like the SQ wire's, when no SQ wire is declared
quiet.onChange = (t, on, db) => {
  $('quietText').textContent = `${on ? 'carrier' : 'quiet'} · ${db.toFixed(0)} dB`;
  if (state.fox?.state.sqWire || !state.fox || !settings.wireAudioIn) return;   // only this fox's own audio says anything about its channel
  if (!quietFeeder || quietFeeder.tracker !== state.cycle) { quietFeeder = createEdgeFeeder(state.cycle); quietFeeder.tracker = state.cycle; quietFeeder.sync(0, 0); }
  state.cycle.hardware = true; state.cycle.source = 'audio';
  quietFeeder.feed([{ ms: t, on }]); quietFeeder.apply(on, t); chart.huntDirty = true;
};
$('quietChk').checked = !!settings.quieting;
$('quietChk').addEventListener('change', () => { settings.quieting = $('quietChk').checked; saveSettings(); quiet.reset(); $('quietText').textContent = settings.quieting ? (capture.running ? 'listening' : 'start audio') : 'off'; if (!settings.quieting && state.cycle.source === 'audio') { state.cycle.hardware = false; state.cycle.source = null; } });
capture.onBlock = (block, sr) => {
  if (cwDec.sr !== sr) { cwDec.sr = sr; cwDec.block = Math.round(sr * cwDec.blockMs / 1000); }
  if (sstvDec.sr !== sr) sstvDec.sr = sr;
  cwDec.autoTone = $('cwAuto').checked && sstvDec.state !== 'image';   // a picture's tones are not a CW pitch
  cwDec.feed(block); sstvDec.feed(block);
  if (settings.quieting) { if (quiet.sampleRate !== sr) { quiet.sampleRate = sr; quiet.reset(); } quiet.feed(block, Date.now()); if (Date.now() - quietShown > 250) { quietShown = Date.now(); $('quietText').textContent = `${quiet.on ? 'carrier' : 'quiet'} · ${quiet.quietingDb.toFixed(0)} dB`; } }
  chart.dirty = true;
};
cwDec.onText = ch => { const el = $('cwDecoded'); el.textContent = (el.textContent + ch).slice(-2000); $('cwSaveBtn').disabled = false; $('hCwText').textContent = el.textContent.slice(-80); if (ch === ' ') noteDecoded(); };
cwDec.onElement = e => { const el = $('cwElements'); el.textContent = (el.textContent + (e === ' ' ? ' ' : e === '/' ? ' / ' : e)).slice(-400); };
$('cwTone').addEventListener('change', () => { cwDec.toneHz = parseInt($('cwTone').value, 10) || 800; });
$('cwAuto').addEventListener('change', () => { cwDec.autoTone = $('cwAuto').checked; });
$('cwClearBtn').addEventListener('click', () => { cwDec.reset(); $('cwDecoded').textContent = ''; $('cwElements').textContent = ''; });
$('cwSaveBtn').addEventListener('click', () => download(`fox-cw-${stamp()}.txt`, new Blob([$('cwDecoded').textContent + '\n'], { type: 'text/plain' })));
const sstvCanvas = $('sstvCanvas');
sstvDec.onStatus = t => { $('sstvStatus').textContent = t; $('sstvCaption').textContent = t; };
sstvDec.onLine = y => {
  const m = sstvDec.mode; if (sstvCanvas.width !== m.width || sstvCanvas.height !== m.height) { sstvCanvas.width = m.width; sstvCanvas.height = m.height; }
  if (y % 4 === 3 || y === m.height - 1) { const ctx = sstvCanvas.getContext('2d'); const img = new ImageData(sstvDec.image.slice(0, (y + 1) * m.width * 4), m.width, y + 1); ctx.putImageData(img, 0, 0); }
  state.audio.picture = true; $('sstvSaveBtn').disabled = false;
};
sstvDec.onImage = () => { setAudioView('sstv'); $('sstvCaption').textContent = `${sstvDec.mode.name}, ${sstvDec.mode.width}×${sstvDec.mode.height}, ${new Date().toLocaleTimeString()}`; };
$('sstvSaveBtn').addEventListener('click', () => canvasPng(sstvCanvas, `fox-sstv-${stamp()}.png`));
$('sstvResetBtn').addEventListener('click', () => { sstvDec.reset(); });
$('audioBtn').addEventListener('click', async () => {
  const b = $('audioBtn');
  if (capture.running) { await capture.stop(); $('hAudioBtn').textContent = 'Audio off'; $('hAudioBtn').setAttribute('aria-pressed', 'false'); b.textContent = 'Start audio'; b.classList.remove('running'); b.setAttribute('aria-pressed', 'false'); $('audioInfo').textContent = '—'; $('audioHead').textContent = 'from the sound card'; $('audioProc').textContent = 'asks for: echo cancellation off, auto gain off, noise suppression off, mono, 48 kHz'; $('audioProc').classList.remove('err'); chart.dirty = true; return; }
  try {
    await capture.start($('audioDev').value || undefined);
    cwDec.sr = capture.sampleRate; cwDec.block = Math.round(capture.sampleRate * cwDec.blockMs / 1000); cwDec.toneHz = parseInt($('cwTone').value, 10) || 800; sstvDec.sr = capture.sampleRate;
    b.textContent = 'Stop audio'; b.classList.add('running'); b.setAttribute('aria-pressed', 'true'); $('hAudioBtn').textContent = 'Audio on'; $('hAudioBtn').setAttribute('aria-pressed', 'true');
    $('audioInfo').textContent = `${capture.deviceLabel || 'input'} · ${capture.sampleRate} Hz`; $('audioHead').textContent = capture.deviceLabel || 'from the sound card';
    fillInputs(); audioPermission(); audioGranted(); con.dim(`audio: ${capture.deviceLabel || 'input'} at ${capture.sampleRate} Hz; CW and SSTV decoders running`);
  } catch (e) { con.err('audio: ' + e.message); $('audioInfo').textContent = e.name === 'NotAllowedError' ? 'microphone permission refused' : e.message; }
});
function setAudioView(v) { state.audio.view = v; $('audioWrap').dataset.view = v; $('cwText').hidden = v !== 'cw'; $('sstvView').hidden = v !== 'sstv'; document.querySelectorAll('[data-audio-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.audioView === v))); chart.dirty = true; }
document.querySelectorAll('[data-audio-view]').forEach(b => b.addEventListener('click', () => setAudioView(b.dataset.audioView)));
setInterval(() => { if (capture.running) { const st = cwDec.status(); $('cwWpm').textContent = `${st.wpm.toFixed(0)} wpm · ${Math.round(st.toneHz)} Hz`; $('cwSignal').textContent = st.peak - st.floor > 6 ? `${(st.peak - st.floor).toFixed(0)} dB over the floor${st.on ? ' · key down' : ''}` : 'no tone'; chart.dirty = true; } }, 250);


// ---------------------------------------------------------------- firmware installer
// Writes this page's code.py to the fox through CircuitPython's REPL on the
// serial port (what Thonny does), reboots into it, then applies the band and
// callsign chosen above. Only this project's firmware is ever written.
let fwText = null;
async function loadFirmwareText() { if (fwText) return fwText; const r = await fetch('firmware/code.py', { cache: 'no-cache' }); if (!r.ok) throw new Error(`could not fetch firmware/code.py (${r.status})`); fwText = await r.text(); $('fwVersionText').textContent = `firmware ${firmwareVersion(fwText) || '?'} · ${(fwText.length / 1024).toFixed(1)} kB`; return fwText; }
loadFirmwareText().catch(e => { $('fwVersionText').textContent = e.message; });
const fwNote = (t, err = false) => { $('fwStatus').textContent = t; $('fwStatus').classList.toggle('err', err); };
$('fwDownloadBtn').addEventListener('click', async () => {
  try { const text = configureFirmware(await loadFirmwareText(), { txEnabled: $('fwTx').checked }); download('code.py', new Blob([text], { type: 'text/x-python' })); fwNote(`downloaded code.py with TX_ENABLED = ${$('fwTx').checked ? 'True' : 'False'}; save it to the fox with Thonny, or use Install.`); }
  catch (e) { fwNote(e.message, true); }
});
$('fwInstallBtn').addEventListener('click', async () => {
  const btn = $('fwInstallBtn'); if (btn.disabled) return;
  if (!hasWebSerial()) { fwNote('this browser has no Web Serial; download code.py and use Thonny', true); return; }
  const tx = $('fwTx').checked;
  if (tx && !confirm('Install with the transmit commands enabled?\n\nThis needs an amateur radio license. The board still boots in receive and refuses to key until a callsign is stored and the session is armed.')) return;
  let text; try { text = configureFirmware(await loadFirmwareText(), { txEnabled: tx }); } catch (e) { fwNote(e.message, true); return; }
  btn.disabled = true; $('fwProgress').hidden = false; $('fwFill').style.width = '0%';
  const prog = p => { $('fwFill').style.width = p.pct + '%'; $('fwNote').textContent = p.note; };
  // use the open connection if there is one; otherwise open a port just for this
  stopLive(); stopScanLoop(); stopSeek(); stopTxPoll();
  let link = state.fox?.link, opened = false;
  const wasDemo = state.demo;
  try {
    if (wasDemo) throw new Error('the simulated fox has nothing to install onto; connect a real fox first (or leave it disconnected and Install opens the port chooser)');
    if (!link) { link = new SerialLink(); link.onRaw = b => { if (settings.rawBytes) con.dim('rx ' + b.length + ' B: ' + JSON.stringify(new TextDecoder().decode(b)).slice(0, 200)); }; await link.open(); opened = true; con.dim('installer: port opened'); }
    else { con.dim('installer: using the open connection'); if (state.fox) await state.fox.cancel(); await link._queue; }   // nothing of ours still waiting on the wire
    fwNote('installing…');
    const r = await installCodePy(link, text, { onProgress: prog });
    con.dim(`installer: ${r.version || 'rebooted'}`);
    // the firmware is up: identify it, then apply the settings from the form
    const fox = new Fox(link); fox.onWarning = t => con.err('warning: ' + t);
    link.onTx = cmd => con.tx(cmd); link.onRx = (body, meta) => con.reply(body, meta);
    if (!opened) { state.fox = null; }                                  // the old Fox object described the old firmware
    await fox.identify();
    state.fox = fox; state.demo = false;
    const band = $('fwBand').value, cs = $('fwCallsign').value.trim();
    if (band) { await fox.band(band); con.dim(`installer: band set to ${band}`); }
    if (cs) { await fox.callsign(cs); con.dim(`installer: callsign ${cs.toUpperCase()} stored`); }
    applyModel(); updateHeading();
    setStatus(`Connected · ${fox.ident.label}`, 'ok'); if (!fox.bandSet) setStatus('Connected · band not set — pick the module ↑', 'err');
    fwNote(`installed ${r.version || 'the firmware'}${band ? `, band ${band}` : ''}${cs ? `, callsign ${cs.toUpperCase()}` : ''}. The fox is connected and ready.`);
    chart.dirty = true;
  } catch (e) {
    fwNote('install failed: ' + e.message, true); con.err('installer: ' + e.message);
    // the board may be sitting in the raw REPL: leave it (Ctrl+B) and reboot (Ctrl+D) so whatever code.py is there runs
    try { await link._write('\x02'); await new Promise(r => setTimeout(r, 150)); await link._write('\x04'); await new Promise(r => setTimeout(r, 2500)); link._take(); } catch {}
    if (opened) { try { await link.close(); } catch {} }
    else if (state.fox) { try { await state.fox.identify(); applyModel(); } catch (e2) { con.err('the fox did not come back after the failed install: ' + e2.message); await disconnect(true); } }
  } finally { btn.disabled = false; setTimeout(() => { $('fwProgress').hidden = true; }, 1500); }
});

// ---------------------------------------------------------------- console
async function sendManual(cmd) {
  if (!state.fox) { con.err('not connected'); return; }
  if (/\x03/.test(cmd)) { con.err('Ctrl+C is never sent: it would drop the fox to the REPL'); return; }
  try { await state.fox.raw(cmd); if (/^(band|callsign|tune|bw|squelch|volume|tx|fox|power|wpm|foxmsg|foxdelay|rx|sq)\b/i.test(cmd)) { await state.fox.info(); applyModel(); } } catch (e) { con.err(e.message); }
}

// ---------------------------------------------------------------- drawing
let scanGeom = null, wfGeom = null;
function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = canvas.clientWidth, H = canvas.clientHeight;   // capped: a 3× phone screen is not worth 9× the pixels on a plot
  if (!W || !H) return null;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}
function draw() {
  const r = fit($('rssiCanvas'));
  if (r) renderRssi(r.ctx, r.W, r.H, state.samples, { windowS: settings.windowS, range: rssiRange(), maxHold: state.max >= 0 ? state.max : null, freq: state.replaying ? (state.samples[state.samples.length - 1]?.f ?? null) : state.fox?.state.freq, events: state.events, lut: settings.heatStrip ? state.lut : null, attenDb: settings.attenDb });
  const s = fit($('scanCanvas'));
  if (s) { if (state.scanView === 'bearing') { renderPolar(s.ctx, s.W, s.H, captureList(), { heading: compass.current(), range: rssiRange(), live: state.capturing ? state.liveBearing : null }); scanGeom = null; wfGeom = null; } else if (state.scanView === 'waterfall') { wfGeom = renderScanWaterfall(s.ctx, s.W, s.H, state.rows, state.rowsF, { lut: state.lut, range: rssiRange(), hover: state.wfHover }); scanGeom = null; } else { scanGeom = renderScan(s.ctx, s.W, s.H, state.scan, { range: rssiRange(), hover: state.hover, tuned: state.fox?.state.freq }); wfGeom = null; } }
  if (state.audio.view === 'spectrum') { const a = fit($('audioCanvas')); if (a) { const st = cwDec.status(); renderAudio(a.ctx, a.W, a.H, capture.running ? capture.spectrum() : null, { toneHz: st.toneHz, cwOn: st.on, cwFloor: st.floor, cwPeak: st.peak, cwLevel: st.level }); } }
  $('pngRssiBtn').disabled = !state.samples.length;
}
function frame() { if (chart.dirty) { chart.dirty = false; draw(); } requestAnimationFrame(frame); }
requestAnimationFrame(frame);
// a phone's address bar collapsing during a scroll fires resize with the width unchanged: not a reason to redraw
let lastW = window.innerWidth, resizeT = null;
window.addEventListener('resize', () => { if (window.innerWidth === lastW) return; clearTimeout(resizeT); resizeT = setTimeout(() => { lastW = window.innerWidth; chart.dirty = true; }, 120); });
// live redraw while the receiver runs so the time axis keeps moving
setInterval(() => { if (state.live) chart.dirty = true; }, 250);

// scan canvas: hover shows the channel, click tunes to it
const scanCanvas = $('scanCanvas'), tip = $('scanTip');
scanCanvas.addEventListener('pointermove', e => {
  const rect = scanCanvas.getBoundingClientRect();
  if (state.scanView === 'bearing') return;
  if (state.scanView === 'waterfall') {
    if (!wfGeom || !state.rows.length) return;
    const col = wfGeom.colAt(e.clientX - rect.left), row = wfGeom.rowAt(e.clientY - rect.top);
    state.wfHover = col == null || row == null ? null : { col, row }; chart.dirty = true;
    if (!state.wfHover) { tip.style.display = 'none'; return; }
    const r = state.rows[row]; tip.style.display = 'block'; tip.style.left = (e.clientX - rect.left) + 'px'; tip.style.top = (e.clientY - rect.top) + 'px';
    tip.textContent = `${state.rowsF[col].toFixed(4)} MHz · ${fmtClock(r.t)} · RSSI ${r.rssi[col] >= 0 ? r.rssi[col] : 'no reply'}`;
    return;
  }
  if (!scanGeom || !state.scan) return;
  const i = scanGeom.indexAt(e.clientX - rect.left);
  if (i !== state.hover) { state.hover = i; chart.dirty = true; }
  if (i == null) { tip.style.display = 'none'; return; }
  tip.style.display = 'block'; tip.style.left = (e.clientX - rect.left) + 'px'; tip.style.top = (e.clientY - rect.top) + 'px';
  tip.textContent = `${state.scan.f[i].toFixed(4)} MHz · RSSI ${state.scan.rssi[i] >= 0 ? state.scan.rssi[i] : 'no reply'} · click to tune`;
});
scanCanvas.addEventListener('pointerleave', () => { state.hover = null; state.wfHover = null; tip.style.display = 'none'; chart.dirty = true; });
scanCanvas.addEventListener('click', e => {
  if (state.scanView === 'bearing') return;
  if (state.scanView === 'waterfall') { if (wfGeom && state.wfHover && state.rowsF) { $('freq').value = state.rowsF[state.wfHover.col].toFixed(4); tune(); } return; }
  if (!scanGeom || !state.scan) return;
  const rect = scanCanvas.getBoundingClientRect(); const i = scanGeom.indexAt(e.clientX - rect.left);
  if (i != null) { $('freq').value = state.scan.f[i].toFixed(4); tune(); }
});

applyModel(); applyWires();
setMode(settings.mode === 'hunt' ? 'hunt' : 'bench'); renderBoard(); renderBearings(); updateHeading();

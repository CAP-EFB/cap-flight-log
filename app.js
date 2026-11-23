'use strict';

/* =========================================================================
   Mission Log — offline CAP observer mission log
   All data stays in the browser (IndexedDB with a localStorage mirror).
   ========================================================================= */

const APP_VERSION = '1.33.0';
const STATE_KEY = 'observer-log-state-v1';
const STATE_MIRROR_LIMIT = 2000000;
const DB_NAME = 'observer-log';
const DB_STORE = 'kv';

const TIME_DEFS = [
  { key: 'engineStart', label: 'Engine Start', kind: 'engine-start' },
  { key: 'wheelsUp',    label: 'Wheels Up',    kind: 'wheels-up' },
  { key: 'inArea',      label: 'In Area',      kind: 'in-area' },
  { key: 'outOfArea',   label: 'Out of Area',  kind: 'out-of-area' },
  { key: 'wheelsDown',  label: 'Wheels Down',  kind: 'wheels-down' },
  { key: 'shutDown',    label: 'Shut Down',    kind: 'shut-down' }
];

const KIND_TO_TIMEKEY = {
  'engine-start': 'engineStart',
  'wheels-up': 'wheelsUp',
  'in-area': 'inArea',
  'out-of-area': 'outOfArea',
  'wheels-down': 'wheelsDown',
  'shut-down': 'shutDown'
};

// Checkpoint buttons, in flight order. `icon` is the inside of a 24×24 stroked SVG.
const QUICK = [
  { kind: 'engine-start', label: 'Engine Start',   // power symbol
    icon: '<path d="M12 3v8"/><path d="M7.1 6.6a7.5 7.5 0 1 0 9.8 0"/>' },
  { kind: 'wheels-up',    label: 'Wheels Up',      // climbing away from the runway
    icon: '<path d="M3 20h18"/><path d="M5 16 18 6"/><path d="M11.5 5.5H18.5V12.5"/>' },
  { kind: 'in-area',      label: 'In Area',        // arrow into the search box
    icon: '<path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/><path d="M3 12h11"/><path d="m10 8 4 4-4 4"/>' },
  { kind: 'on-target',    label: 'On Target',      // crosshair
    icon: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>' },
  { kind: 'out-of-area',  label: 'Out of Area',    // arrow leaving the search box
    icon: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/><path d="M10 12h11"/><path d="m17 8 4 4-4 4"/>' },
  { kind: 'wheels-down',  label: 'Wheels Down',    // descending to the runway
    icon: '<path d="M3 20h18"/><path d="M5 5 18 15"/><path d="M18.5 8.5V15.5H11.5"/>' },
  { kind: 'shut-down',    label: 'Shut Down',      // stop
    icon: '<circle cx="12" cy="12" r="9"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>' }
];

const STANDARD_FREQS = [
  ['Flight Watch', '122.0'],
  ['Wx Briefing', '800-WX-BRIEF'],
  ['Flight Service', '122.2'],
  ['CAP Natl Ops', '888.211.1812'],
  ['Air-to-Air', '122.75 / 122.85'],
  ['CAP Ops Fax Back', '334.953.2599'],
  ['Multicom', '122.9 / 123.1'],
  ['AFRCC (missions only)', '804.764.8117']
];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* ---------- tiny helpers ---------- */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] == null) cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

/* ---------- time helpers ---------- */

function nowZ() {
  const d = new Date();
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}

function nowMinutes() {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function normTime(value) {
  let digits = String(value == null ? '' : value).toUpperCase().replace(/[^0-9]/g, '').slice(0, 4);
  if (!digits) return '';
  if (digits.length <= 2) return digits.padStart(4, '0');
  if (digits.length === 3) return '0' + digits;
  return digits;
}

function isValidTime(value) {
  if (!/^\d{4}$/.test(value)) return false;
  const h = Number(value.slice(0, 2));
  const m = Number(value.slice(2));
  return h >= 0 && h < 24 && m >= 0 && m < 60;
}

function timeToMin(value) {
  if (!isValidTime(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
}

function diffMin(from, to) {
  const a = timeToMin(from);
  const b = timeToMin(to);
  if (a == null || b == null) return null;
  return (b - a + 1440) % 1440;
}

function addMinutes(value, minutes) {
  const base = timeToMin(value);
  if (base == null) return '';
  const total = ((base + Number(minutes)) % 1440 + 1440) % 1440;
  return pad2(Math.floor(total / 60)) + pad2(total % 60);
}

function fmtZ(value) {
  return isValidTime(value) ? value + 'Z' : '—';
}

function fmtDuration(minutes) {
  if (minutes == null) return '—';
  if (minutes < 60) return minutes + 'm';
  return Math.floor(minutes / 60) + 'h ' + pad2(minutes % 60) + 'm';
}

function fmtDateZ(date) {
  const d = date || new Date();
  return pad2(d.getUTCDate()) + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) +
    'Z ' + MONTHS[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(-2);
}

function fmtClock(date) {
  const d = date || new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ---------- numbers / coordinates ---------- */

function num(value) {
  const n = parseFloat(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fmtDecimal(value, places) {
  if (value == null || !Number.isFinite(value)) return '';
  return value.toFixed(places == null ? 1 : places);
}

function parseCoord(raw, isLat, defaultHemisphere) {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase();
  if (!s) return null;

  let sign = 1;
  let explicitSign = false;

  // leading hemisphere, e.g. N35 12.3
  if (/^[NSEW]/.test(s)) {
    if (s[0] === 'S' || s[0] === 'W') sign = -1;
    explicitSign = true;
    s = s.slice(1).trim();
  }
  // trailing hemisphere, e.g. 35 12.3 N
  const trailing = s.match(/([NSEW])\s*$/);
  if (trailing) {
    if (trailing[1] === 'S' || trailing[1] === 'W') sign = -1;
    else sign = 1;
    explicitSign = true;
    s = s.slice(0, trailing.index).trim();
  }

  s = s.replace(/[°º]/g, ' ').replace(/['′’]/g, ' ').replace(/["″”]/g, ' ')
       .replace(/\s+/g, ' ').trim();
  if (!s) return null;

  let deg;
  let min = 0;

  if (s.includes(' ')) {
    const parts = s.split(' ');
    deg = parseFloat(parts[0]);
    min = parseFloat(parts[1]);
    if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
    if (parts.length > 3) return null;
    if (parts.length === 3) {
      // degrees, minutes and seconds, e.g. 35 30 15
      const sec = parseFloat(parts[2]);
      if (!Number.isFinite(sec) || sec < 0 || sec >= 60 || min !== Math.trunc(min)) return null;
      min += sec / 60;
    }
    if (deg < 0) {
      sign = -1;
      explicitSign = true;
      deg = Math.abs(deg);
    }
  } else {
    const value = parseFloat(s);
    if (!Number.isFinite(value)) return null;
    if (value < 0) {
      sign = -1;
      explicitSign = true;
    }
    const intPart = String(Math.abs(value)).split('.')[0];
    if (intPart.length >= 4) {
      // aviation DDMM.mmm (e.g. 3512.345)
      deg = Math.trunc(Math.abs(value) / 100);
      min = Math.abs(value) - deg * 100;
    } else {
      deg = Math.abs(value);
    }
  }

  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  if (min < 0 || min >= 60) return null;

  if (!explicitSign && (defaultHemisphere === 'S' || defaultHemisphere === 'W')) {
    sign = -1;
  }

  const absolute = Math.abs(deg) + min / 60;
  const max = isLat ? 90 : 180;
  if (absolute > max) return null;

  return sign * absolute;
}

function parseLat(raw) {
  return parseCoord(raw, true, 'N');
}

function parseLon(raw) {
  return parseCoord(raw, false, 'W');
}

/* Every coordinate in the app is shown, stored and printed one way: hemisphere,
   degrees and decimal minutes — N 35° 30.00′, W 80° 15.00′ (longitude degrees are not
   padded to three digits). Entry is looser
   (see parseCoord); a valid entry is rewritten in this form. */
function fmtCoord(value, isLat) {
  if (value == null || !Number.isFinite(value)) return '';
  const hemisphere = isLat ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  const absolute = Math.abs(value);
  let deg = Math.floor(absolute);
  let min = Math.round((absolute - deg) * 6000) / 100;
  if (min >= 60) {
    deg += 1;
    min = 0;
  }
  return hemisphere + ' ' + String(deg).padStart(2, '0') + '° ' + min.toFixed(2).padStart(5, '0') + '′';
}

/* The same position the other two ways a GPS or chart may show it: signed
   decimal degrees, and degrees, minutes and seconds. */
function fmtCoordDecimal(value) {
  return value.toFixed(5) + '°';
}

function fmtCoordDms(value, isLat) {
  const hemisphere = isLat ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  const tenths = Math.round(Math.abs(value) * 36000);          // tenths of a second
  const deg = Math.floor(tenths / 36000);
  const min = Math.floor((tenths - deg * 36000) / 600);
  const sec = (tenths - deg * 36000 - min * 600) / 10;
  return hemisphere + ' ' + String(deg).padStart(2, '0') + '° ' + pad2(min) + '′ ' +
    sec.toFixed(1).padStart(4, '0') + '″';
}

/* Help line under a coordinate field: every format the field is not already showing. */
function coordHelpText(raw, isLat) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { text: 'Decimal minutes, decimal degrees or D M S', error: false };
  const parsed = isLat ? parseLat(text) : parseLon(text);
  if (parsed == null) return { text: 'Not a valid ' + (isLat ? 'latitude' : 'longitude'), error: true };
  const standard = fmtCoord(parsed, isLat);
  const parts = [fmtCoordDecimal(parsed), fmtCoordDms(parsed, isLat)];
  if (text !== standard) parts.unshift(standard);
  return { text: parts.join('  ·  '), error: false };
}

/* Typed text in standard form when it parses, untouched when it does not. */
function normCoordText(raw, isLat) {
  const text = String(raw == null ? '' : raw).trim();
  const parsed = isLat ? parseLat(text) : parseLon(text);
  return parsed == null ? text : fmtCoord(parsed, isLat);
}

function coordPair(latRaw, lonRaw) {
  const lat = parseLat(latRaw);
  const lon = parseLon(lonRaw);
  if (lat == null || lon == null) return '';
  return fmtCoord(lat, true) + '  ' + fmtCoord(lon, false);
}

/* ---------- GPS ---------- */

/* ---------- native shell ----------
   In the iPad app (Capacitor) GPS, sharing and files go through native plugins;
   in a browser the same calls fall back to the web APIs. */
const NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
// registerPlugin comes from vendor/capacitor.js, which only the app build loads.
const registerNativePlugin = NATIVE
  ? ((window.capacitorExports && window.capacitorExports.registerPlugin) || window.Capacitor.registerPlugin)
  : null;
const Native = NATIVE ? {
  Geolocation: registerNativePlugin('Geolocation'),
  Share: registerNativePlugin('Share'),
  Filesystem: registerNativePlugin('Filesystem'),
  Keyboard: registerNativePlugin('Keyboard'),
  App: registerNativePlugin('App'),
  Haptics: registerNativePlugin('Haptics'),
  LocalNotifications: registerNativePlugin('LocalNotifications'),
  StatusBar: registerNativePlugin('StatusBar'),
  SplashScreen: registerNativePlugin('SplashScreen'),
  // our own Swift plugin in ios/App/App/MissionLogPlugin.swift
  MissionLog: registerNativePlugin('MissionLog')
} : null;

// A short tap felt in the hand: a checkpoint or reading was recorded.
function haptic(style) {
  if (!NATIVE) return;
  Native.Haptics.impact({ style: style || 'MEDIUM' }).catch(() => {});
}

/* ---------- OPS check reminder ----------
   A notification at the next OPS check time, so it reaches the crew while
   ForeFlight is on screen or the iPad is locked. Only while the sortie is
   running: after Engine Start, before Shut Down. */
const OPS_NOTIFICATION_ID = 3001;
let opsPermissionAsked = false;

function opsReminderDue(log) {
  const l = log || activeLog();
  if (!sortieReady(l) || !l.times.engineStart.time || l.times.shutDown.time) return null;
  const due = nextOpsDue(l) || (isValidTime(l.times.engineStart.time)
    ? addMinutes(l.times.engineStart.time, state.settings.opsInterval || 30) : '');
  const at = utcDateNear(due);
  return at && at.getTime() > Date.now() + 5000 ? at : null;
}

// An HHMM Zulu time as the nearest actual moment (within 12 hours of now).
function utcDateNear(hhmm) {
  if (!isValidTime(hhmm)) return null;
  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4))));
  if (at.getTime() < now.getTime() - 12 * 3600000) at.setUTCDate(at.getUTCDate() + 1);
  if (at.getTime() > now.getTime() + 12 * 3600000) at.setUTCDate(at.getUTCDate() - 1);
  return at;
}

/* ---------- Live Activity ----------
   From Engine Start to Shut Down the Lock Screen and Dynamic Island show the
   sortie: phase, time since wheels up, the next OPS check and the CAP grid. */
/* ---------- flight recorder ----------
   From Engine Start to Shut Down the sortie's track is recorded. In the app
   the native recorder keeps going in the background (ForeFlight in front, iPad
   locked) and writes to a file; the log copies it in when the app is open. In
   a browser, points come from the live GPS while the page is on screen. */
let trackSortieId = null;
let trackPullTimer = null;
const saveQuiet = () => save(true);

function sortieRunning(log) {
  return !!(log && sortieReady(log) && !log.closed && isValidTime(log.times.engineStart.time) && !log.times.shutDown.time);
}

async function pullTrack(log) {
  if (!NATIVE || !log) return;
  try {
    const result = await Native.MissionLog.readTrack({ sortieId: log.id });
    const points = (result && result.points) || [];
    if (points.length >= log.track.length) {
      log.track = points;
      saveQuiet();
      if (positionMap) drawTrackOnMap();
    }
  } catch (err) {
    console.warn('could not read the track', err);
  }
}

async function syncTrackRecorder() {
  if (!state) return;
  const recording = trackSortieId ? state.logs.find(l => l.id === trackSortieId) : null;
  if (trackSortieId && (!recording || !sortieRunning(recording) || !state.settings.recordTrack)) {
    if (NATIVE) {
      await Native.MissionLog.stopTrack().catch(() => {});
      await pullTrack(recording);
    }
    trackSortieId = null;
  }
  const log = activeLog();
  if (!trackSortieId && state.settings.recordTrack && sortieRunning(log)) {
    trackSortieId = log.id;
    if (NATIVE) await Native.MissionLog.startTrack({ sortieId: log.id }).catch(err => console.warn('recorder', err));
  }
  renderGpsChip();
  clearInterval(trackPullTimer);
  trackPullTimer = trackSortieId && NATIVE
    ? setInterval(() => pullTrack(state.logs.find(l => l.id === trackSortieId)), 60000)
    : null;
}

// Browser fallback: a point every 10 s and 100 m from the live GPS.
function recordWebTrackPoint(fix) {
  if (NATIVE || !trackSortieId || !fix || fix.accuracy > 200) return;
  const log = state.logs.find(l => l.id === trackSortieId);
  if (!log) return;
  const last = log.track[log.track.length - 1];
  if (last && (fix.at - last[0] < 10000 || distanceMetres(last[1], last[2], fix.lat, fix.lon) < 100)) return;
  log.track.push([fix.at, fix.lat, fix.lon, -9999, Math.round(fix.accuracy), -1, -1]);
  saveQuiet();
  if (positionMap) drawTrackOnMap();
}

function distanceMetres(lat1, lon1, lat2, lon2) {
  const r = 6371000, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function trackStats(log) {
  const t = log.track;
  if (!t.length) return null;
  let metres = 0;
  for (let i = 1; i < t.length; i++) metres += distanceMetres(t[i - 1][1], t[i - 1][2], t[i][1], t[i][2]);
  const alts = t.map(p => p[3]).filter(a => a > -9000);
  return {
    points: t.length,
    nm: metres / 1852,
    minutes: Math.round((t[t.length - 1][0] - t[0][0]) / 60000),
    maxAltFt: alts.length ? Math.round(Math.max(...alts) * 3.28084) : null,
    from: t[0][0],
    to: t[t.length - 1][0]
  };
}

function trackGPX(log) {
  const time = ms => new Date(ms).toISOString();
  const pts = log.track.map(p => `      <trkpt lat="${p[1].toFixed(6)}" lon="${p[2].toFixed(6)}">` +
    (p[3] > -9000 ? `<ele>${p[3].toFixed(1)}</ele>` : '') + `<time>${time(p[0])}</time></trkpt>`).join('\n');
  const name = (missionOf(log).number || 'Mission') + ' sortie ' + (log.sortie || '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mission Log" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

function trackCardHTML(log) {
  const stats = trackStats(log);
  const recording = trackSortieId === log.id;
  return `<section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Flight track</h2>${recording ? '<span class="rec-dot">REC</span>' : ''}</div>
        <span class="muted small">${state.settings.recordTrack ? 'Recorded from Engine Start to Shut Down' : 'Recording is off in Settings'}</span>
      </div>
      ${stats ? `<div class="totals" style="grid-template-columns:repeat(4,1fr);margin-top:0;padding-top:0;border-top:0">
        <div class="total"><div class="tl">Distance</div><div class="tv">${stats.nm.toFixed(1)} NM</div></div>
        <div class="total"><div class="tl">Duration</div><div class="tv">${fmtDuration(stats.minutes)}</div></div>
        <div class="total"><div class="tl">Max altitude</div><div class="tv">${stats.maxAltFt == null ? '—' : stats.maxAltFt.toLocaleString() + ' ft'}</div></div>
        <div class="total"><div class="tl">Points</div><div class="tv">${stats.points}</div></div>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" data-act="track-map">Show on chart</button>
        <button class="btn small" data-act="track-gpx">Export GPX</button>
      </div>` : `<div class="empty"><strong>No track yet</strong>${recording ? 'Recording. Points appear here every minute.' : 'The track is recorded automatically once Engine Start is logged.'}</div>`}
    </section>`;
}

let sortieActivityOn = false;
let lastActivityGrid = '';

function sortiePhase(t) {
  if (t.wheelsDown.time) return 'Landed';
  if (t.outOfArea.time) return 'Returning';
  if (t.inArea.time) return 'In search area';
  if (t.wheelsUp.time) return 'Airborne';
  return 'Engine running';
}

function syncSortieActivity() {
  if (!NATIVE || !state) return;
  const log = activeLog();
  const t = log.times;
  const running = sortieReady(log) && isValidTime(t.engineStart.time) && !t.shutDown.time;
  if (!running) {
    if (sortieActivityOn) Native.MissionLog.endSortieActivity().catch(() => {});
    sortieActivityOn = false;
    return;
  }
  const fix = freshFix();
  const grid = fix ? capGridName(fix.lat, fix.lon) : '';
  lastActivityGrid = grid;
  const airborne = t.wheelsUp.time && !t.wheelsDown.time ? utcDateNear(t.wheelsUp.time) : null;
  const ops = opsReminderDue(log);
  Native.MissionLog.updateSortieActivity({
    mission: missionOf(log).number || '',
    sortie: sortieLabel(log, missionSorties(log).indexOf(log)),
    callsign: log.callsign || '',
    phase: sortiePhase(t),
    airborneSince: airborne ? airborne.getTime() : 0,
    nextOpsDue: ops ? ops.getTime() : 0,
    grid
  }).then(result => { sortieActivityOn = !!(result && result.running); }).catch(() => {});
}

async function scheduleOpsReminder() {
  if (!NATIVE || !state) return;
  try {
    await Native.LocalNotifications.cancel({ notifications: [{ id: OPS_NOTIFICATION_ID }] });
    const at = opsReminderDue();
    if (!at) return;
    let perm = await Native.LocalNotifications.checkPermissions();
    if (perm.display !== 'granted' && !opsPermissionAsked) {
      opsPermissionAsked = true;
      perm = await Native.LocalNotifications.requestPermissions();
    }
    if (perm.display !== 'granted') return;
    const log = activeLog();
    await Native.LocalNotifications.schedule({ notifications: [{
      id: OPS_NOTIFICATION_ID,
      title: 'OPS check due',
      body: (log.callsign ? log.callsign + ' · ' : '') + 'Report OPS normal, fuel and altimeter.',
      schedule: { at, allowWhileIdle: true },
      sound: 'default'
    }] });
  } catch (err) {
    console.warn('OPS reminder not scheduled', err);
  }
}

/* ---------- files opened from other apps ----------
   ForeFlight's Send To and AirDrop can hand Mission Log a flight plan (.fpl),
   a shared sortie or a backup (.json). */
/* Text from a file's bytes. ForeFlight writes its FPL files as UTF-16 with a
   byte-order mark, so the encoding comes from the BOM; without one, UTF-8, or
   Windows-1252 if that fails. */
function decodeTextBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
  // UTF-16 without a BOM: every other byte of ASCII text is zero
  if (b.length > 3 && b[0] !== 0 && b[1] === 0 && b[3] === 0) return new TextDecoder('utf-16le').decode(b);
  if (b.length > 3 && b[0] === 0 && b[2] === 0 && b[1] !== 0) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch (_) {
    return new TextDecoder('windows-1252').decode(b);
  }
}

function base64ToBytes(base64) {
  const binary = atob(String(base64).replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function openSharedFile(url) {
  try {
    const name = decodeURIComponent(String(url).split('/').pop() || 'file');
    // read the bytes (no encoding: base64), then decode whatever the file uses
    const read = await Native.Filesystem.readFile({ path: url });
    const text = typeof read.data === 'string'
      ? decodeTextBytes(base64ToBytes(read.data))
      : decodeTextBytes(new Uint8Array(await read.data.arrayBuffer()));
    if (/\.fpl$/i.test(name) || /<flight-plan/i.test(text.slice(0, 600))) {
      if (!sortieReady()) {
        toast('Add the mission and a sortie first, then open the flight plan again');
        return;
      }
      if (activeTab !== 'plan') switchTab('plan');
      const parsed = parseFplWaypoints(text);
      fplImport = { name, points: parsed.points, rule: parsed.rule };
      fplImportSheet();
    } else {
      importBackupText(text);
    }
  } catch (err) {
    console.warn('could not open shared file', err);
    toast('Could not open that file');
  }
}

// Native set-up that needs the app to be running: status bar, keyboard bar,
// splash screen, and files handed over by other apps.
function startNative() {
  if (!NATIVE) return;
  Native.StatusBar.setStyle({ style: 'DARK' }).catch(() => {});     // light text on the navy header
  Native.Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => {});   // previous / next / Done
  Native.App.addListener('appUrlOpen', event => { if (event && event.url) openSharedFile(event.url); });
  Native.App.getLaunchUrl().then(launch => { if (launch && launch.url) openSharedFile(launch.url); }).catch(() => {});
  setTimeout(() => Native.SplashScreen.hide().catch(() => {}), 150);
  scheduleOpsReminder();
  syncSortieActivity();
  Native.MissionLog.trackStatus().then(status => {
    if (status && status.sortieId) trackSortieId = status.sortieId;
    syncTrackRecorder();
    const log = state.logs.find(l => l.id === trackSortieId);
    if (log) pullTrack(log);
  }).catch(() => syncTrackRecorder());
}

/* While the on-screen keyboard is up, the tab bar steps aside so it does not
   ride up over the form. The app is told by the keyboard plugin; a browser is
   detected from the visual viewport shrinking. */
function setKeyboardOpen(open) {
  document.body.classList.toggle('keyboard-open', !!open);
}
if (NATIVE) {
  Native.Keyboard.addListener('keyboardWillShow', () => setKeyboardOpen(true));
  Native.Keyboard.addListener('keyboardWillHide', () => setKeyboardOpen(false));
} else if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    setKeyboardOpen(window.innerHeight - window.visualViewport.height > 150);
  });
}

function geoAvailable() {
  return NATIVE || (!!navigator.geolocation && window.isSecureContext);
}

// Plugin errors are messages; turn them into the web API's error codes.
function nativeGeoError(err) {
  const message = String((err && (err.message || err.code)) || err || '');
  return { code: /denied|permission|not authori/i.test(message) ? 1 : /time ?out/i.test(message) ? 3 : 2, message };
}

const geo = {
  getCurrentPosition(ok, fail, options) {
    if (!NATIVE) return navigator.geolocation.getCurrentPosition(ok, fail, options);
    Native.Geolocation.getCurrentPosition(options).then(ok, err => fail(nativeGeoError(err)));
    return undefined;
  },
  // Returns an id for clearWatch (a promise of one in the app).
  watchPosition(ok, fail, options) {
    if (!NATIVE) return navigator.geolocation.watchPosition(ok, fail, options);
    return Native.Geolocation.watchPosition(options, (position, err) => {
      if (err) fail(nativeGeoError(err));
      else if (position) ok(position);
    });
  },
  clearWatch(id) {
    if (!NATIVE) return navigator.geolocation.clearWatch(id);
    Promise.resolve(id).then(callbackId => Native.Geolocation.clearWatch({ id: callbackId })).catch(() => {});
    return undefined;
  }
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

let lastGpsFix = null;
let gpsWarned = false;

function hhmmFromMs(ms) {
  const d = new Date(ms || Date.now());
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}

function gpsStatusText(fix) {
  return 'GPS ±' + Math.round(fix.accuracy) + ' m · ' + fmtZ(hhmmFromMs(fix.at));
}

function requestGps(force) {
  if (!force && lastGpsFix && Date.now() - lastGpsFix.at < 30000) {
    return Promise.resolve(lastGpsFix);
  }
  return new Promise((resolve, reject) => {
    if (!NATIVE && !window.isSecureContext) {
      reject({ code: 2, secure: true });
      return;
    }
    if (!geoAvailable()) {
      reject({ code: 2, unsupported: true });
      return;
    }
    geo.getCurrentPosition(
      position => {
        const fix = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          at: position.timestamp || Date.now()
        };
        fix.seen = Date.now();
        lastGpsFix = fix;
        resolve(fix);
      },
      error => reject(error),
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 15000 }
    );
  });
}

/* ---------- live GPS ----------
   While it is switched on, the app keeps listening for positions so the header
   can show whether there is a fix and how good it is, and so new entries start
   at the current position. */

const GPS_FRESH_MS = 20000;
let gpsWatchId = null;
let gpsState = 'off';   // off | searching | on | denied | unavailable

// The live position, if one arrived recently enough to call current.
function freshFix() {
  return lastGpsFix && Date.now() - (lastGpsFix.seen || lastGpsFix.at) < GPS_FRESH_MS ? lastGpsFix : null;
}

function startGpsWatch() {
  if (gpsWatchId != null) return;
  if (!geoAvailable()) {
    gpsState = 'unavailable';
    renderGpsChip();
    return;
  }
  gpsState = 'searching';
  renderGpsChip();
  gpsWatchId = geo.watchPosition(
    position => {
      lastGpsFix = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
        at: position.timestamp || Date.now(),
        seen: Date.now()
      };
      gpsState = 'on';
      renderGpsChip();
      updatePositionSheet();
      recordWebTrackPoint(lastGpsFix);
      if (sortieActivityOn && capGridName(lastGpsFix.lat, lastGpsFix.lon) !== lastActivityGrid) syncSortieActivity();
    },
    error => {
      if (error && error.code === 1) {
        stopGpsWatch();
        gpsState = 'denied';
      } else if (gpsState !== 'on') {
        gpsState = 'searching';
      }
      renderGpsChip();
    },
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 }
  );
}

function stopGpsWatch() {
  if (gpsWatchId != null && geoAvailable()) geo.clearWatch(gpsWatchId);
  gpsWatchId = null;
  gpsState = 'off';
  renderGpsChip();
}

/* ---------- CAP conventional grid ----------
   Sectional grid limits from the CAP Mission Aircrew Reference Text, Volume I
   (June 2024), Table 8-1: [id, north, south, west, east] in degrees, west
   longitudes positive. Each chart is cut into 15-minute grids numbered from 1 at
   its north-west corner, eastwards along a row, then the next row south. Where
   two charts overlap, the western-most chart's numbers are the ones used. */
const CAP_SECTIONALS = [
  ['SEA', 49, 44.5, 125, 117], ['GTF', 49, 44.5, 117, 109], ['BIL', 49, 44.5, 109, 101],
  ['MSP', 49, 44.5, 101, 93], ['GRB', 48.25, 44, 93, 85], ['LHN', 48, 44, 85, 77],
  ['MON', 48, 44, 77, 69], ['HFX', 48, 44, 69, 61], ['LMT', 44.5, 40, 125, 117],
  ['SLC', 44.5, 40, 117, 109], ['CYS', 44.5, 40, 109, 101], ['OMA', 44.5, 40, 101, 93],
  ['ORD', 44, 40, 93, 85], ['DET', 44, 40, 85, 77], ['NYC', 44, 40, 77, 69],
  ['SFO', 40, 36, 125, 118], ['LAS', 40, 35.75, 118, 111], ['DEN', 40, 35.75, 111, 104],
  ['ICT', 40, 36, 104, 97], ['MKC', 40, 36, 97, 90], ['STL', 40, 36, 91, 84],
  ['CVG', 40, 36, 85, 78], ['DCA', 40, 36, 79, 72], ['LAX', 36, 32, 121.5, 115],
  ['PHX', 35.75, 31.25, 116, 109], ['ABQ', 36, 32, 109, 102], ['DFW', 36, 32, 102, 95],
  ['MEM', 36, 32, 95, 88], ['ATL', 36, 32, 88, 81], ['CLT', 36, 32, 81, 75],
  ['ELP', 32, 28, 109, 103], ['SAT', 32, 28, 103, 97], ['HOU', 32, 28, 97, 91],
  ['MSY', 32, 28, 91, 85], ['JAX', 32, 28, 85, 79], ['BRO', 28, 24, 103, 97],
  ['MIA', 28, 24, 83, 77]
];

// CAP grid for a position, e.g. "SEA 171 B": sectional, grid number, quarter
// (A north-west, B north-east, C south-west, D south-east). Empty outside the
// gridded charts. A point exactly on a grid line goes to the grid north or west of it.
function capGridName(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const lonW = -lon;
  let chart = null;
  for (const c of CAP_SECTIONALS) {
    if (lat <= c[1] && lat >= c[2] && lonW <= c[3] && lonW >= c[4] && (!chart || c[3] > chart[3])) chart = c;
  }
  if (!chart) return '';
  const [id, north, , west, east] = chart;
  // position in 7.5-minute steps from the chart's north-west corner
  const eighth = value => Math.max(0, Math.ceil(Math.round(value * 8 * 1e6) / 1e6) - 1);
  const down = eighth(north - lat);
  const across = eighth(west - lonW);
  const cols = Math.round((west - east) * 4);
  const number = Math.floor(down / 2) * cols + Math.floor(across / 2) + 1;
  const quarter = 'ABCD'[(down % 2) * 2 + (across % 2)];
  return id + ' ' + number + ' ' + quarter;
}

/* CAP standardized latitude/longitude cell, e.g. "36102ADB" (MART Vol. I §8.8.1).
   The digits name the one-degree block by its south-east corner (36N 102W covers
   36–37N, 102–103W). Each letter then halves it again — 30, 15 and 7.5 minutes —
   with A north-west, B north-east, C south-west, D south-east. North latitude and
   west longitude only. */
function capCellName(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 0 || lon > 0) return '';
  const lonW = -lon;
  const blockLat = Math.floor(lat);
  const blockLon = Math.floor(lonW);
  const eighth = value => Math.min(7, Math.max(0, Math.ceil(Math.round(value * 8 * 1e6) / 1e6) - 1));
  const down = eighth(blockLat + 1 - lat);        // 7.5-minute steps from the north edge
  const across = eighth(blockLon + 1 - lonW);     // and from the west edge
  let letters = '';
  for (const shift of [2, 1, 0]) {
    letters += 'ABCD'[((down >> shift) & 1) * 2 + ((across >> shift) & 1)];
  }
  return pad2(blockLat) + String(blockLon).padStart(3, '0') + letters;
}

/* ---------- position sheet ----------
   Tapping the GPS readout in the header: the position in large type, in every
   format, with the CAP grid and cell, on the FAA sectional chart. For
   reference, not navigation. Chart tiles come from the FAA's public tile
   service and need a connection, unless the sortie saved them (Offline maps). */
const SECTIONAL_TILES = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}';

/* Maps for the chart and the sketch pad: the FAA sectional, and the USGS
   National Map's topographic map and shaded relief. All three allow their
   tiles in a canvas, so a sketch page can keep a picture of them. */
const CHART_LAYERS = {
  sectional: { label: 'Sectional', short: 'Sectional', url: SECTIONAL_TILES, minNative: 8, maxNative: 12,
    source: 'FAA sectional', attribution: 'FAA AIS · not for navigation' },
  topo: { label: 'Topographic', short: 'Topo', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    minNative: 0, maxNative: 16, source: 'USGS topographic map', attribution: 'USGS The National Map · not for navigation' },
  // elevation-tinted hillshade from USGS 3DEP, drawn to order for each tile
  terrain: { label: 'Terrain', short: 'Terrain', exportUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage',
    rendering: 'Hillshade Elevation Tinted',
    minNative: 0, maxNative: 16, source: 'USGS 3DEP terrain', attribution: 'USGS 3DEP · not for navigation' }
};

const EARTH_HALF = Math.PI * 6378137;   // half the Web Mercator world, metres

// A Web Mercator box (metres) drawn as a w×h image by an ArcGIS image server.
function chartExportUrl(chart, bbox, w, h) {
  return chart.exportUrl + '?bbox=' + bbox.map(v => v.toFixed(1)).join(',') +
    '&bboxSR=3857&imageSR=3857&size=' + w + ',' + h + '&format=jpg&f=image' +
    '&renderingRule=' + encodeURIComponent(JSON.stringify({ rasterFunction: chart.rendering }));
}

function chartLayerKey() {
  return CHART_LAYERS[state && state.settings.chartLayer] ? state.settings.chartLayer : 'sectional';
}

// One tile of a chart layer: the map server's own tile, or for an image
// server the picture of that tile's box.
function chartTileUrl(layer, z, x, y) {
  const chart = CHART_LAYERS[layer];
  if (chart.exportUrl) {
    const size = 2 * EARTH_HALF / Math.pow(2, z);
    const minX = -EARTH_HALF + x * size;
    const maxY = EARTH_HALF - y * size;
    return chartExportUrl(chart, [minX, maxY - size, minX + size, maxY], 256, 256);
  }
  return chart.url.replace('{z}', z).replace('{y}', y).replace('{x}', x);
}

/* ---------- maps saved for offline use ----------
   Brief › Offline maps downloads the tiles around a sortie's search area,
   entry and exit points and ForeFlight route into the app's own storage. The
   chart and the sketch pad look there first, then the network, then a saved
   tile from a few zoom levels up, enlarged, so the map never goes blank where
   it was saved. Tiles are shared between sorties; the list of what each
   sortie saved is kept beside them. */
const MAP_DB = 'mission-log-maps';
// the tile zooms saved for each map: the sectional's own detail stops at 12
const MAP_ZOOMS = { sectional: [8, 12], topo: [6, 14], terrain: [6, 13] };
const MAP_MARGIN_NM = 10;
const MAP_AROUND_ME_NM = 25;
const SECTIONAL_CYCLE_DAYS = 56;   // the FAA replaces the sectional every 56 days
let mapDbPromise = null;
let savedMapAreas = {};            // "sortieId:layer" → what was saved (no tile list)
let mapSaveJob = null;             // the download in progress, if any

function openMapDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!mapDbPromise) {
    mapDbPromise = new Promise(resolve => {
      let req;
      try {
        req = indexedDB.open(MAP_DB, 1);
      } catch (_) {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
        if (!db.objectStoreNames.contains('areas')) db.createObjectStore('areas');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return mapDbPromise;
}

// Run fn(stores…) in one transaction; resolves with fn's result once it commits.
async function mapTx(names, mode, fn) {
  const db = await openMapDb();
  if (!db) throw new Error('no storage');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
    result = fn(...names.map(name => tx.objectStore(name)));
  });
}

const idbReq = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function tileKey(layer, z, x, y) {
  return layer + '/' + z + '/' + x + '/' + y;
}

// A saved tile as a Blob, or null.
async function savedTile(key) {
  try {
    const db = await openMapDb();
    if (!db) return null;
    const rec = await idbReq(db.transaction('tiles').objectStore('tiles').get(key));
    return rec && rec.data ? new Blob([rec.data], { type: rec.type || 'image/png' }) : null;
  } catch (_) {
    return null;
  }
}

function loadImage(src, cors) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';   // the map servers allow it, so a canvas can be saved
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed'));
    img.src = src;
  });
}

async function blobImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* Draw tile z/x/y of a layer into ctx at (dx, dy), size px square: the saved
   tile, else the network's, else a saved tile from up to five zoom levels
   up, enlarged. Resolves to where it came from, or '' when nothing drew. */
async function drawChartTile(ctx, layer, z, x, y, dx, dy, size) {
  const saved = await savedTile(tileKey(layer, z, x, y));
  if (saved) {
    try {
      ctx.drawImage(await blobImage(saved), dx, dy, size, size);
      return 'saved';
    } catch (_) { /* a broken record: try the network */ }
  }
  if (navigator.onLine !== false) {
    try {
      ctx.drawImage(await loadImage(chartTileUrl(layer, z, x, y), true), dx, dy, size, size);
      return 'network';
    } catch (_) { /* no signal, or no tile there */ }
  }
  for (let d = 1; d <= 5 && z - d >= 0; d++) {
    const blob = await savedTile(tileKey(layer, z - d, x >> d, y >> d));
    if (!blob) continue;
    try {
      const img = await blobImage(blob);
      const part = img.width / Math.pow(2, d);
      const sx = (x - ((x >> d) << d)) * part;
      const sy = (y - ((y >> d) << d)) * part;
      ctx.drawImage(img, sx, sy, part, part, dx, dy, size, size);
      return 'enlarged';
    } catch (_) { /* keep looking */ }
  }
  return '';
}

// On a Retina screen each tile is drawn at half size from one zoom level
// deeper (detectRetina), so the chart stays sharp instead of stretched.
const ChartTileLayer = window.L ? L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    drawChartTile(tile.getContext('2d'), this.options.chartKey, this._getZoomForUrl(), coords.x, coords.y, 0, 0, 256)
      .then(from => done(from ? null : new Error('no tile'), tile));
    return tile;
  }
}) : null;

function chartTileLayer(key) {
  const chart = CHART_LAYERS[key];
  const retina = (window.devicePixelRatio || 1) > 1.4;
  return new ChartTileLayer('', {
    chartKey: key,
    detectRetina: true,
    minNativeZoom: chart.minNative ? (retina ? chart.minNative - 1 : chart.minNative) : 0,
    maxNativeZoom: retina ? chart.maxNative - 1 : chart.maxNative,
    minZoom: 5, maxZoom: 15,
    keepBuffer: 3,
    attribution: chart.attribution
  });
}

/* What a sortie's offline maps cover: the search area (filled in), the entry
   and exit points and the ForeFlight route, 10 nm around each. With none of
   those, 25 nm around where the iPad is. */
function offlineMapShape(log) {
  const pts = [];
  const corners = SAR_CORNERS.map(([key]) => [parseLat(log.sar.corners[key].lat), parseLon(log.sar.corners[key].lon)])
    .filter(([lat, lon]) => lat != null && lon != null);
  const boxes = [];
  if (corners.length >= 2) {
    const lats = corners.map(c => c[0]);
    const lons = corners.map(c => c[1]);
    boxes.push({ north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lons), west: Math.min(...lons) });
  }
  [log.entry, log.exit].forEach(p => {
    const lat = parseLat(p.lat);
    const lon = parseLon(p.lon);
    if (lat != null && lon != null) pts.push([lat, lon]);
  });
  const route = log.fpl && Array.isArray(log.fpl.points) ? log.fpl.points.map(p => [p[0], p[1]]) : [];
  const parts = [];
  if (boxes.length) parts.push('the search area');
  if (pts.length) parts.push(pts.length > 1 ? 'the entry and exit points' : 'the entry or exit point');
  if (route.length) parts.push('the ForeFlight route');
  if (parts.length) {
    return { boxes, points: pts, route, margin: MAP_MARGIN_NM,
      label: parts.join(parts.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1') + ', plus ' + MAP_MARGIN_NM + ' nm around' };
  }
  const fix = freshFix() || lastGpsFix;
  if (fix) return { boxes: [], points: [[fix.lat, fix.lon]], route: [], margin: MAP_AROUND_ME_NM, label: MAP_AROUND_ME_NM + ' nm around your position' };
  return null;
}

// The tiles at zoom z covering a shape: [[x, y], …].
function shapeTiles(shape, z) {
  const n = Math.pow(2, z);
  const seen = new Set();
  const out = [];
  const tileOf = (lat, lon) => {
    const p = mercatorPx(Math.max(-85, Math.min(85, lat)), lon, z);
    return [p.x / 256, p.y / 256];
  };
  // the margin in tiles at a latitude: a Mercator tile is cos(lat) shorter on the ground
  const marginTiles = lat => shape.margin * 1852 / Math.cos(lat * Math.PI / 180) / (2 * EARTH_HALF / n);
  const addRect = (x0, y0, x1, y1) => {
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(n - 1, Math.floor(x1)); x++) {
      for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(n - 1, Math.floor(y1)); y++) {
        const key = x + '/' + y;
        if (!seen.has(key)) { seen.add(key); out.push([x, y]); }
      }
    }
  };
  const addAround = (lat, lon) => {
    const [x, y] = tileOf(lat, lon);
    const m = marginTiles(lat);
    addRect(x - m, y - m, x + m, y + m);
  };
  shape.boxes.forEach(b => {
    const [x0, y0] = tileOf(b.north, b.west);
    const [x1, y1] = tileOf(b.south, b.east);
    const m = marginTiles(Math.max(Math.abs(b.north), Math.abs(b.south)));
    addRect(x0 - m, y0 - m, x1 + m, y1 + m);
  });
  shape.points.forEach(([lat, lon]) => addAround(lat, lon));
  shape.route.forEach((p, i) => {
    addAround(p[0], p[1]);
    const next = shape.route[i + 1];
    if (!next) return;
    // walk the leg in steps of a quarter of the margin
    const [ax, ay] = tileOf(p[0], p[1]);
    const [bx, by] = tileOf(next[0], next[1]);
    const len = Math.hypot(bx - ax, by - ay);
    const step = Math.max(0.25, marginTiles(p[0]) / 4);
    const count = Math.min(5000, Math.ceil(len / step));
    for (let s = 1; s < count; s++) {
      const f = s / count;
      addAround(p[0] + (next[0] - p[0]) * f, p[1] + (next[1] - p[1]) * f);
    }
  });
  return out;
}

function offlineMapTiles(layer, shape) {
  const [lo, hi] = MAP_ZOOMS[layer];
  const tiles = [];
  for (let z = lo; z <= hi; z++) shapeTiles(shape, z).forEach(([x, y]) => tiles.push([z, x, y]));
  return tiles;
}

// PNG or JPEG by its first bytes (the FAA labels its tiles as plain data).
function imageType(data) {
  const b = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return '';
}

function fmtBytes(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function areaKey(sortieId, layer) {
  return sortieId + ':' + layer;
}

// Read what every sortie saved into memory (without the tile lists), and
// drop the maps of sorties that no longer exist.
async function loadSavedMapAreas() {
  try {
    const db = await openMapDb();
    if (!db) return;
    const list = await idbReq(db.transaction('areas').objectStore('areas').getAll());
    savedMapAreas = {};
    const orphans = [];
    list.forEach(area => {
      if (!state.logs.some(l => l.id === area.sortieId)) { orphans.push(area); return; }
      const { tiles, ...meta } = area;
      savedMapAreas[areaKey(area.sortieId, area.layer)] = meta;
    });
    if (orphans.length) await pruneSavedMaps();
    renderOfflineMapsCard();
  } catch (err) {
    console.warn('saved maps unavailable', err);
  }
}

// Delete the saved areas of sorties that are gone, and every tile no
// remaining area uses.
async function pruneSavedMaps() {
  try {
    const db = await openMapDb();
    if (!db) return;
    const areas = await idbReq(db.transaction('areas').objectStore('areas').getAll());
    const keep = new Set();
    const gone = [];
    areas.forEach(area => {
      if (state.logs.some(l => l.id === area.sortieId)) (area.tiles || []).forEach(k => keep.add(k));
      else gone.push(areaKey(area.sortieId, area.layer));
    });
    const tileKeys = await idbReq(db.transaction('tiles').objectStore('tiles').getAllKeys());
    await mapTx(['areas', 'tiles'], 'readwrite', (areaStore, tileStore) => {
      gone.forEach(key => areaStore.delete(key));
      tileKeys.forEach(key => { if (!keep.has(key)) tileStore.delete(key); });
    });
    gone.forEach(key => { delete savedMapAreas[key]; });
  } catch (err) {
    console.warn('could not tidy saved maps', err);
  }
}

async function deleteOfflineMap(log, layer) {
  try {
    await mapTx(['areas'], 'readwrite', areas => areas.delete(areaKey(log.id, layer)));
    delete savedMapAreas[areaKey(log.id, layer)];
    await pruneSavedMaps();
  } catch (err) {
    console.warn(err);
  }
  renderOfflineMapsCard();
  toast(CHART_LAYERS[layer].label + ' map deleted from this iPad');
}

/* Download a sortie's tiles for one map. Tiles saved in the last day are
   kept (so Save again after a break picks up where it stopped); everything
   else is fetched again. */
async function saveOfflineMap(log, layer) {
  if (mapSaveJob) { toast('Already saving a map'); return; }
  const shape = offlineMapShape(log);
  if (!shape) { toast('Fill in the search area or share the flight plan first'); return; }
  const tiles = offlineMapTiles(layer, shape);
  const guess = tiles.length * (layer === 'sectional' ? 30000 : 22000);
  if (tiles.length > 3000 && !confirm('That is ' + tiles.length.toLocaleString() + ' map tiles, about ' + fmtBytes(guess) +
    '. Save them on this iPad?')) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const abort = new AbortController();
  const job = mapSaveJob = { sortieId: log.id, layer, total: tiles.length, done: 0, missing: 0, abort };
  renderOfflineMapsCard();
  const keys = [];
  let bytes = 0;
  let lastPaint = 0;
  const now = Date.now();
  let i = 0;
  const worker = async () => {
    while (i < tiles.length && !abort.signal.aborted) {
      const [z, x, y] = tiles[i++];
      const key = tileKey(layer, z, x, y);
      try {
        const db = await openMapDb();
        const have = await idbReq(db.transaction('tiles').objectStore('tiles').get(key));
        if (have && now - have.at < 86400000) {
          keys.push(key);
          bytes += have.data.byteLength;
        } else {
          const res = await fetch(chartTileUrl(layer, z, x, y), { mode: 'cors', signal: abort.signal });
          if (res.ok) {
            const data = await res.arrayBuffer();
            const type = imageType(data);
            if (type) {
              await mapTx(['tiles'], 'readwrite', store => store.put({ data, type, at: Date.now() }, key));
              keys.push(key);
              bytes += data.byteLength;
            }
          } else if (res.status !== 404) {
            job.missing++;   // 404: the map has nothing there (off the chart's edge)
          }
        }
      } catch (_) {
        if (!abort.signal.aborted) job.missing++;
      }
      job.done++;
      if (Date.now() - lastPaint > 250) { lastPaint = Date.now(); renderOfflineMapsCard(); }
    }
  };
  // the terrain server draws each tile to order; ask it more gently
  await Promise.all(Array.from({ length: layer === 'terrain' ? 3 : 6 }, worker));
  mapSaveJob = null;

  if (abort.signal.aborted) {
    renderOfflineMapsCard();
    toast('Stopped saving the ' + CHART_LAYERS[layer].label + ' map · what was downloaded is kept until you delete it or save again');
    if (keys.length) await recordArea(log, layer, shape, keys, bytes, job.total - keys.length);
    return;
  }
  if (!keys.length) {
    renderOfflineMapsCard();
    toast('Could not download the ' + CHART_LAYERS[layer].label + ' map · check the connection');
    return;
  }
  await recordArea(log, layer, shape, keys, bytes, job.missing);
  toast(CHART_LAYERS[layer].label + ' map saved for offline use · ' + fmtBytes(bytes) +
    (job.missing ? ' · ' + job.missing + (job.missing === 1 ? ' tile' : ' tiles') + ' missing, Save again to retry' : ''));
}

async function recordArea(log, layer, shape, keys, bytes, missing) {
  const area = { sortieId: log.id, layer, savedAt: Date.now(), count: keys.length, bytes, missing, label: shape.label, tiles: keys };
  try {
    await mapTx(['areas'], 'readwrite', areas => areas.put(area, areaKey(log.id, layer)));
    const { tiles, ...meta } = area;
    savedMapAreas[areaKey(log.id, layer)] = meta;
    await pruneSavedMaps();   // a smaller area this time frees the old tiles
  } catch (err) {
    console.warn(err);
    toast('Could not save the map · the iPad may be out of storage');
  }
  renderOfflineMapsCard();
}

function savedMapAge(area) {
  return Math.floor((Date.now() - area.savedAt) / 86400000);
}

// The line under the chart: what it is, and whether this sortie saved it.
function chartNoteText(layer) {
  const log = activeSortie();
  const area = log && savedMapAreas[areaKey(log.id, layer)];
  const chart = CHART_LAYERS[layer];
  if (area) return chart.source + ' · saved for offline use ' + new Date(area.savedAt).toLocaleDateString() + ' · for reference, not navigation';
  return chart.source + ' · for reference, not navigation · save it on Brief › Offline maps to use it with no signal';
}

function offlineMapsInner(log) {
  const shape = offlineMapShape(log);
  const rows = Object.keys(CHART_LAYERS).map(layer => {
    const chart = CHART_LAYERS[layer];
    const area = savedMapAreas[areaKey(log.id, layer)];
    const job = mapSaveJob && mapSaveJob.sortieId === log.id && mapSaveJob.layer === layer ? mapSaveJob : null;
    let status;
    let buttons;
    if (job) {
      const pct = job.total ? Math.round(job.done / job.total * 100) : 0;
      status = `Saving… ${job.done.toLocaleString()} of ${job.total.toLocaleString()} tiles
        <div class="map-progress"><span style="width:${pct}%"></span></div>`;
      buttons = '<button type="button" class="btn small" data-act="offline-map-stop">Stop</button>';
    } else if (area) {
      const age = savedMapAge(area);
      const stale = layer === 'sectional' && age >= SECTIONAL_CYCLE_DAYS;
      status = `Saved ${esc(new Date(area.savedAt).toLocaleDateString())} · ${area.count.toLocaleString()} tiles · ${fmtBytes(area.bytes)}` +
        (area.missing ? ` · <span class="warn-text">${area.missing} missing</span>` : '') +
        `<div class="muted small">${esc(area.label)}</div>` +
        (stale ? `<div class="warn-text small">Saved ${age} days ago. The FAA replaces the sectional every 56 days; save it again for the current chart.</div>` : '');
      buttons = `<button type="button" class="btn small" data-act="offline-map-save" data-value="${layer}" ${mapSaveJob || !shape ? 'disabled' : ''}>Save again</button>
        <button type="button" class="btn small danger" data-act="offline-map-delete" data-value="${layer}">Delete</button>`;
    } else {
      status = '<span class="muted">Not saved</span>';
      buttons = `<button type="button" class="btn small${layer === 'sectional' ? ' primary' : ''}" data-act="offline-map-save" data-value="${layer}" ${mapSaveJob || !shape ? 'disabled' : ''}>Save</button>`;
    }
    return `<div class="map-row">
        <div class="map-row-text"><strong>${esc(chart.label)}</strong><div class="small">${status}</div></div>
        <div class="map-row-btns">${buttons}</div>
      </div>`;
  }).join('');
  const what = shape
    ? `Covers ${esc(shape.label)}.`
    : 'Fill in the search area, the entry or exit point, or share the flight plan from ForeFlight to choose what to save.';
  return `<div class="note-strip" style="margin-top:0;margin-bottom:10px">
      Save the maps for this sortie before you leave, so the chart and the sketch pad show them with no signal. ${what}
      Saved maps stay on this iPad and are not in backups. Not for navigation.
    </div>${rows}`;
}

function offlineMapsCardHTML(log) {
  return `<section class="card" id="offline-maps">
      <div class="card-head"><div class="head-left"><h2>Offline maps</h2></div></div>
      <div id="offline-maps-body">${offlineMapsInner(log)}</div>
    </section>`;
}

// Repaint the card in place (it changes while a download runs).
function renderOfflineMapsCard() {
  const body = $('#offline-maps-body');
  const log = activeSortie();
  if (body && log) body.innerHTML = offlineMapsInner(log);
  const note = $('#pos-note');
  if (note) note.textContent = chartNoteText(chartLayerKey());
}

let positionMap = null;

// The zoom that shows the FAA chart at 100%: one chart pixel per screen pixel.
// The FAA's most detailed tiles are level 12; a Retina screen draws them one
// level earlier at half size.
function chartFullZoom() {
  return (window.devicePixelRatio || 1) > 1.4 ? 11 : 12;
}

// Leaving Fly: drop the map (its element goes with the view).
function closePositionView() {
  if (positionMap) positionMap.remove();
  positionMap = null;
  document.documentElement.classList.remove('fly-open');
}

function positionFixHTML(fix) {
  if (!fix) {
    return `<div class="pos-none">No current GPS fix.${lastGpsFix ? ' Showing the last one, from ' + esc(fmtZ(hhmmFromMs(lastGpsFix.at))) + '.' : ''}</div>`;
  }
  const grid = capGridName(fix.lat, fix.lon);
  const cell = capCellName(fix.lat, fix.lon);
  return `<div class="pos-big mono">
      <div>${esc(fmtCoord(fix.lat, true))}</div>
      <div>${esc(fmtCoord(fix.lon, false))}</div>
    </div>
    <div class="pos-facts">
      <div><span>Grid</span><b class="mono">${esc(grid || '—')}</b></div>
      <div><span>Cell</span><b class="mono">${esc(cell || '—')}</b></div>
      <div><span>Accuracy</span><b>±${Math.round(fix.accuracy)} m</b></div>
      <div><span>Fix</span><b class="mono">${esc(fmtZ(hhmmFromMs(fix.at)))}</b></div>
    </div>
    <div class="pos-other mono">${esc(fmtCoordDecimal(fix.lat))}, ${esc(fmtCoordDecimal(fix.lon))}  ·  ${esc(fmtCoordDms(fix.lat, true))}  ${esc(fmtCoordDms(fix.lon, false))}</div>`;
}

// Build the chart into Fly's map element.
function mountFlyMap() {
  const fix = freshFix() || lastGpsFix;
  if (positionMap) positionMap.remove();
  positionMap = null;
  document.documentElement.classList.add('fly-open');
  placeFlyShell();
  if (!window.L || !$('#pos-map')) return;
  const log = activeLog();
  const center = fix ? [fix.lat, fix.lon] : [39.5, -98.35];
  // The FAA serves the sectional at tile zooms 8–12 (12 is the chart's own
  // detail); the USGS maps go to 16.
  const map = L.map('pos-map', {
    zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 15, zoomSnap: 1
  }).setView(center, fix ? chartFullZoom() : 5);
  const tiles = chartTileLayer(chartLayerKey()).addTo(map);
  // CAP grid over the chart: 15-minute grid lines with their numbers, and the
  // 7.5-minute quarters dashed when zoomed in. Redrawn for what is on screen.
  const gridLayer = L.layerGroup().addTo(map);
  const drawGrid = () => {
    gridLayer.clearLayers();
    const zoom = map.getZoom();
    if (zoom < 7) return;
    const b = map.getBounds();
    const step = 0.25;
    const quarter = zoom >= 10;
    CAP_SECTIONALS.forEach(([id, north, south, westW, eastW]) => {
      const west = -westW;
      const east = -eastW;
      const s0 = Math.max(south, b.getSouth()), n0 = Math.min(north, b.getNorth());
      const w0 = Math.max(west, b.getWest()), e0 = Math.min(east, b.getEast());
      if (s0 >= n0 || w0 >= e0) return;
      const lines = [];
      const inc = quarter ? step / 2 : step;
      for (let lat = Math.ceil(s0 / inc) * inc; lat <= n0 + 1e-9; lat += inc) {
        const major = Math.abs(lat / step - Math.round(lat / step)) < 1e-6;
        lines.push([[[lat, w0], [lat, e0]], major]);
      }
      for (let lon = Math.ceil(w0 / inc) * inc; lon <= e0 + 1e-9; lon += inc) {
        const major = Math.abs(lon / step - Math.round(lon / step)) < 1e-6;
        lines.push([[[s0, lon], [n0, lon]], major]);
      }
      lines.forEach(([pts, major]) => L.polyline(pts, {
        color: '#7a1fa2', weight: major ? 1.6 : 0.8, opacity: major ? 0.85 : 0.6,
        dashArray: major ? null : '4 4', interactive: false
      }).addTo(gridLayer));
      if (zoom < 9) return;
      // a number in each 15-minute grid, using the CAP rule for overlapping charts
      for (let top = Math.ceil(s0 / step) * step + step; top <= n0 + 1e-9; top += step) {
        for (let left = Math.floor(w0 / step) * step; left < e0 - 1e-9; left += step) {
          const name = capGridName(top - 0.01, left + 0.01);
          if (!name || !name.startsWith(id + ' ')) continue;
          L.marker([top - step / 2, left + step / 2], {
            interactive: false,
            icon: L.divIcon({ className: 'grid-label', html: esc(name.replace(/ [ABCD]$/, '')), iconSize: null })
          }).addTo(gridLayer);
        }
      }
    });
  };
  map.on('moveend', drawGrid);
  drawGrid();

  // the sortie's search area, when its corners are set
  const corners = ['nw', 'ne', 'se', 'sw'].map(key => {
    const c = log.sar.corners[key];
    const lat = parseLat(c.lat);
    const lon = parseLon(c.lon);
    return lat != null && lon != null ? [lat, lon] : null;
  });
  const area = corners.every(Boolean)
    ? L.polygon(corners, { color: '#e0662b', weight: 2, fillOpacity: 0.08, dashArray: '6 4' }).addTo(map)
    : null;
  const accuracy = L.circle(center, { radius: fix ? fix.accuracy : 0, color: '#1877cc', weight: 1, fillOpacity: 0.12 });
  const dot = L.circleMarker(center, { radius: 8, color: '#fff', weight: 3, fillColor: '#1877cc', fillOpacity: 1 });
  if (fix) { accuracy.addTo(map); dot.addTo(map); }
  positionMap = { map, tiles, dot, accuracy, follow: !!fix, logId: log.id, trackLine: null, checkpoints: null, plan: null, tail: null,
    remove: () => map.remove() };
  // with no position yet, show the flight so far, the plan or the search area
  drawTrackOnMap(!fix);
  if (!fix && !positionMap.trackLine && !positionMap.plan && area) map.fitBounds(area.getBounds(), { padding: [40, 40], maxZoom: chartFullZoom() });
  pullTrack(log);
  map.on('dragstart', () => { if (positionMap) positionMap.follow = false; });
  setTimeout(() => map.invalidateSize(), 60);
}

// A checkpoint you add yourself (+ Checkpoint): a flag.
const CUSTOM_CHECKPOINT_ICON = '<path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6"/>';

// Where a checkpoint was stamped: its own position, or else the track point
// nearest in time (within two minutes).
function checkpointPosition(log, entry) {
  const lat = parseLat(entry.lat);
  const lon = parseLon(entry.lon);
  if (lat != null && lon != null) return [lat, lon];
  if (!entry.createdAt || !log.track.length) return null;
  let best = null;
  log.track.forEach(p => {
    const gap = Math.abs(p[0] - entry.createdAt);
    if (!best || gap < best.gap) best = { gap, p };
  });
  return best && best.gap <= 120000 ? [best.p[1], best.p[2]] : null;
}

// The track, with each checkpoint marked by its Fly button's icon, over the
// ForeFlight plan the search area came from.
function drawTrackOnMap(fit) {
  if (!positionMap || !window.L) return;
  const log = activeLog();
  const pts = log.track.map(p => [p[1], p[2]]);
  if (positionMap.trackLine) positionMap.trackLine.remove();
  if (positionMap.checkpoints) positionMap.checkpoints.remove();
  if (positionMap.plan) positionMap.plan.remove();
  // the ForeFlight plan, dashed, under the track; each waypoint named on tap
  const plan = log.fpl && log.fpl.points.length ? log.fpl.points : [];
  // a white casing under the dashes keeps the route readable over the busy sectional
  const route = plan.map(p => [p[0], p[1]]);
  positionMap.plan = plan.length ? L.featureGroup([
    L.polyline(route, { color: '#ffffff', weight: 8, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }),
    L.polyline(route, { color: '#0a47c2', weight: 4, opacity: 1, dashArray: '12 7', lineCap: 'butt', lineJoin: 'round' }),
    ...plan.map(p => L.circleMarker([p[0], p[1]], { radius: 5.5, color: '#0a47c2', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(p[2] || 'Waypoint', { direction: 'top', offset: [0, -4] }))
  ]).addTo(positionMap.map) : null;
  positionMap.trackLine = pts.length > 1
    ? L.featureGroup([
      L.polyline(pts, { color: '#ffffff', weight: 8, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }),
      L.polyline(pts, { color: '#d81b60', weight: 4.5, opacity: 1, lineCap: 'round', lineJoin: 'round' })
    ]).addTo(positionMap.map)
    : null;
  const markers = log.entries.map(entry => {
    const at = checkpointPosition(log, entry);
    if (!at) return null;
    const quick = QUICK.find(q => q.kind === entry.kind);
    const label = entry.event || (quick && quick.label) || 'Checkpoint';
    const icon = L.divIcon({
      className: 'cp-marker',
      html: `<span class="cp-pin${quick ? '' : ' custom'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${quick ? quick.icon : CUSTOM_CHECKPOINT_ICON}</svg></span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    return L.marker(at, { icon, title: label, keyboard: false })
      .bindTooltip(label + (entry.time ? ' · ' + fmtZ(entry.time) : ''), { direction: 'top', offset: [0, -14] });
  }).filter(Boolean);
  positionMap.checkpoints = markers.length ? L.featureGroup(markers).addTo(positionMap.map) : null;
  const layers = [positionMap.trackLine, positionMap.checkpoints, positionMap.plan].filter(Boolean);
  if (fit && layers.length) {
    const bounds = L.latLngBounds([]);
    layers.forEach(layer => bounds.extend(layer.getBounds()));
    positionMap.follow = false;
    positionMap.map.fitBounds(bounds, { padding: [32, 32], maxZoom: chartFullZoom() });
  }
  if (positionPinned()) { positionMap.accuracy.bringToFront(); positionMap.dot.bringToFront(); }
}

/* ---------- Fly: the moving map ----------
   Fly is the chart, filling the screen between the header and the tab bar,
   with the sortie's controls floating over it: the position top left, the
   checkpoint buttons down the right, Observation, OPS check and the flight
   log bottom left, and the map switch bottom right. The map is built once
   and kept while Fly is open; a redraw only replaces the floating controls. */
let flyLogOpen = false;
// The position card over the map: hidden until the header's position is tapped.
let flyPosOpen = false;

// The checkpoint to tap next: the first in flight order not yet stamped.
function nextCheckpointKind(log) {
  const next = QUICK.find(q => { const e = entryForKind(log, q.kind); return !(e && e.time); });
  return next ? next.kind : '';
}

function flyCheckpointButton(log, item, next) {
  const entry = entryForKind(log, item.kind);
  const done = !!(entry && entry.time);
  return `<button type="button" class="fly-cp${done ? ' done' : ''}${item.kind === next ? ' next' : ''}" data-act="quick" data-kind="${esc(item.kind)}" data-label="${esc(item.label)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg>
      <span class="fly-cp-text"><span class="fly-cp-label">${esc(item.label)}</span>${done ? `<span class="fly-cp-time mono">${esc(fmtZ(entry.time))}</span>` : ''}</span>
    </button>`;
}

// The OPS status as one line over the map; tapping it records a check.
function flyOpsChip(log) {
  const last = log.ops[log.ops.length - 1];
  if (!last) return `<button type="button" class="fly-chip none" data-act="ops-add"><span class="sb-dot"></span>No OPS checks yet</button>`;
  const next = nextOpsDue(log);
  const interval = state.settings.opsInterval || 30;
  const since = last.time ? (nowMinutes() - timeToMin(last.time) + 1440) % 1440 : null;
  const overdue = since != null && since < 480 && since > interval + 4;
  if (overdue) return `<button type="button" class="fly-chip due" data-act="ops-add"><span class="sb-dot"></span>OPS check due · last ${esc(fmtZ(last.time))}</button>`;
  return `<button type="button" class="fly-chip ok" data-act="ops-add"><span class="sb-dot"></span>OPS ${last.normal ? 'normal' : 'flagged'} ${esc(fmtZ(last.time))}${next ? ' · next ' + esc(fmtZ(next)) : ''}</button>`;
}

const FLY_ICONS = {
  obs: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  ops: '<path d="M9 11l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
  log: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  flag: CUSTOM_CHECKPOINT_ICON,
  center: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>'
};
const flyIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FLY_ICONS[name]}</svg>`;

function flyOverlayHTML(log) {
  const next = nextCheckpointKind(log);
  const count = log.entries.length + log.observations.length;
  return `<div class="fly-top">
      <div class="pos-panel fly-panel" id="fly-pos" data-act="fly-pos-hide" role="button" aria-label="Hide the position" ${flyPosOpen ? '' : 'hidden'}>
        <div id="pos-text">${positionFixHTML(freshFix())}</div>
        <div class="pos-note" id="pos-note">${esc(chartNoteText(chartLayerKey()))}</div>
      </div>
      ${flyOpsChip(log)}
    </div>
    <div class="fly-rail" role="group" aria-label="Checkpoints">
      ${QUICK.map(q => flyCheckpointButton(log, q, next)).join('')}
      <button type="button" class="fly-cp custom" data-act="add-checkpoint">${flyIcon('flag')}<span class="fly-cp-text"><span class="fly-cp-label">+ Checkpoint</span></span></button>
      <button type="button" class="fly-cp obs" data-act="add-obs">${flyIcon('obs')}<span class="fly-cp-text"><span class="fly-cp-label">+ Observation</span>${log.observations.length ? `<span class="fly-cp-time">${log.observations.length} logged</span>` : ''}</span></button>
    </div>
    <div class="fly-mapctl">
      <button type="button" class="fly-round" data-act="fly-zoom" data-step="1" aria-label="Zoom in">${flyIcon('plus')}</button>
      <button type="button" class="fly-round" data-act="fly-zoom" data-step="-1" aria-label="Zoom out">${flyIcon('minus')}</button>
      <button type="button" class="fly-round" data-act="pos-recenter" aria-label="Center on my position">${flyIcon('center')}</button>
    </div>
    <div class="fly-actions">
      <button type="button" class="fly-btn" data-act="ops-add">${flyIcon('ops')}OPS check</button>
      <button type="button" class="fly-btn" data-act="fly-log">${flyIcon('log')}Log${count ? `<span class="fly-count">${count}</span>` : ''}</button>
    </div>
    <div class="seg pos-layers" role="group" aria-label="Map">
      ${Object.entries(CHART_LAYERS).map(([key, chart]) => `<button type="button" data-act="chart-layer" data-value="${key}" class="${key === chartLayerKey() ? 'active' : ''}">${chart.short}</button>`).join('')}
    </div>`;
}

// The flight log that used to be the Fly page: checkpoints, timeline and OPS checks.
function flyLogHTML(log) {
  return `<div class="fly-log-head" id="fly-log-head">
      <span class="fly-grab" aria-hidden="true"></span>
      <h2>Flight log</h2>
      <button type="button" class="fly-round small" data-act="fly-log" aria-label="Close the flight log">${flyIcon('close')}</button>
    </div>
    <div class="fly-log-body stack">
      ${installBannerHTML()}
      <section class="card tl-card-wrap" id="timeline-card">${timelineHTML(log)}</section>
      ${opsCardHTML(log)}
    </div>`;
}

function flyView(log) {
  return `<div class="fly-shell${flyLogOpen ? ' log-open' : ''}" id="fly-shell">
      <div class="pos-map" id="pos-map"></div>
      <div class="fly-ui" id="fly-ui">${flyOverlayHTML(log)}</div>
      <div class="fly-log" id="fly-log" style="transform:translateY(${flyLogOffset()})" aria-hidden="${flyLogOpen ? 'false' : 'true'}">${flyLogHTML(log)}</div>
    </div>`;
}

// Fly is already on screen with its map: swap in fresh controls and log only.
function refreshFlyView(log) {
  const ui = $('#fly-ui');
  const logEl = $('#fly-log');
  const shell = $('#fly-shell');
  if (!ui || !logEl || !shell) return false;
  ui.innerHTML = flyOverlayHTML(log);
  const scroll = logEl.querySelector('.fly-log-body') ? logEl.querySelector('.fly-log-body').scrollTop : 0;
  logEl.innerHTML = flyLogHTML(log);
  const body = logEl.querySelector('.fly-log-body');
  if (body) body.scrollTop = scroll;
  shell.classList.toggle('log-open', flyLogOpen);
  logEl.setAttribute('aria-hidden', flyLogOpen ? 'false' : 'true');
  if (!logEl.style.transition) logEl.style.transform = 'translateY(' + flyLogOffset() + ')';
  drawTrackOnMap();
  placeHobbsPopover();   // the buttons were redrawn: re-point the keypad's arrow
  refreshObsPop();
  return true;
}

// The map fills the space between the header and the tab bar.
function placeFlyShell() {
  const shell = $('#fly-shell');
  const bar = $('.topbar');
  if (!shell || !bar) return;
  const top = Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) + 'px';
  if (shell.style.top === top) return;
  shell.style.top = top;
  document.documentElement.style.setProperty('--page-top', top);
  if (positionMap) positionMap.map.invalidateSize();
  placeHobbsPopover();
}

function setFlyPos(open) {
  flyPosOpen = open;
  const card = $('#fly-pos');
  if (card) card.hidden = !open;
  const chip = $('#gpsChip');
  if (chip) chip.classList.toggle('open', open && activeTab === 'fly');
}

/* The flight log slides over the map at two heights, half and full, and is
   dragged by its head: a flick or a drag past the middle moves it on. */
let flyLogSnap = 'half';
const FLY_LOG_HALF = 0.42;   // the share of its height it slides down at half

function flyLogOffset() {
  if (!flyLogOpen) return '102%';
  return flyLogSnap === 'full' ? '0%' : (FLY_LOG_HALF * 100) + '%';
}

function setFlyLog(open, snap) {
  flyLogOpen = open;
  if (snap) flyLogSnap = snap;
  else if (open && !snap) flyLogSnap = flyLogSnap || 'half';
  const shell = $('#fly-shell');
  if (shell) shell.classList.toggle('log-open', open);
  const logEl = $('#fly-log');
  if (logEl) {
    logEl.style.transition = '';
    logEl.style.transform = 'translateY(' + flyLogOffset() + ')';
    logEl.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  if (open) autoGrowAll();
}

// Drag the log by its head: it follows the finger, then settles.
(function dragFlyLog() {
  let drag = null;
  document.addEventListener('pointerdown', event => {
    const head = event.target.closest('#fly-log-head');
    if (!head || event.target.closest('button')) return;
    const el = $('#fly-log');
    const h = el.offsetHeight;
    const start = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    drag = { el, h, start, y: event.clientY, t: performance.now(), lastY: event.clientY, lastT: performance.now(), v: 0, offset: start };
    el.style.transition = 'none';
    head.setPointerCapture(event.pointerId);
  });
  document.addEventListener('pointermove', event => {
    if (!drag) return;
    const now = performance.now();
    drag.v = (event.clientY - drag.lastY) / Math.max(1, now - drag.lastT);
    drag.lastY = event.clientY;
    drag.lastT = now;
    drag.offset = Math.max(0, Math.min(drag.h, drag.start + event.clientY - drag.y));
    drag.el.style.transform = 'translateY(' + drag.offset + 'px)';
  });
  const end = () => {
    if (!drag) return;
    const { offset, h, v } = drag;
    drag = null;
    const stops = [['full', 0], ['half', FLY_LOG_HALF * h], ['closed', h]];
    let target;
    if (v > 0.45) target = offset < FLY_LOG_HALF * h ? 'half' : 'closed';          // flicked down
    else if (v < -0.45) target = offset > FLY_LOG_HALF * h ? 'half' : 'full';      // flicked up
    else target = stops.reduce((a, b) => Math.abs(b[1] - offset) < Math.abs(a[1] - offset) ? b : a)[0];
    if (target === 'closed') setFlyLog(false);
    else setFlyLog(true, target);
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
})();

// Keep the open position sheet moving with each new fix.
function updatePositionSheet() {
  if (!positionMap) return;
  const fix = freshFix();
  const text = $('#pos-text');
  if (text) text.innerHTML = positionFixHTML(fix);
  if (!fix) return;
  const at = [fix.lat, fix.lon];
  if (!positionPinned()) {
    positionMap.dot.addTo(positionMap.map);
    positionMap.accuracy.addTo(positionMap.map);
  }
  positionMap.dot.setLatLng(at);
  positionMap.accuracy.setLatLng(at).setRadius(fix.accuracy);
  // while the track records, join its last saved point to where the aircraft is now
  const log = activeSortie();
  const last = log && trackSortieId === log.id && log.track[log.track.length - 1];
  if (last) {
    const seg = [[last[1], last[2]], at];
    if (positionMap.tail) positionMap.tail.setLatLngs(seg);
    else positionMap.tail = L.polyline(seg, { color: '#d81b60', weight: 4.5, opacity: 0.85, lineCap: 'round' }).addTo(positionMap.map);
  } else if (positionMap.tail) {
    positionMap.tail.remove();
    positionMap.tail = null;
  }
  positionMap.dot.bringToFront();
  if (positionMap.follow) positionMap.map.panTo(at, { animate: true });
}

function positionPinned() {
  return positionMap && positionMap.map.hasLayer(positionMap.dot);
}

function renderGpsChip() {
  const chip = $('#gpsChip');
  const label = $('#gpsLabel');
  if (!chip || !label) return;
  // Position and accuracy show once the open sortie has its first checkpoint;
  // REC while its flight track is being recorded.
  const sortie = activeSortie();
  const shown = !!(sortie && sortie.entries.length);
  chip.hidden = !shown;
  $$('.gps-pipe, #gpsPipeAfter').forEach(pipe => { pipe.hidden = !shown; });
  const rec = $('#recIcon');
  if (rec) rec.hidden = !(sortie && trackSortieId === sortie.id);
  renderTabDots();
  const fix = freshFix();
  let level = 'off';
  let text = 'GPS off';
  if (gpsState === 'denied') { level = 'bad'; text = 'GPS denied'; }
  else if (gpsState === 'unavailable') { level = 'off'; text = 'No GPS'; }
  else if (gpsState === 'off') { level = 'off'; text = 'GPS off'; }
  else if (fix) {
    const metres = Math.round(fix.accuracy);
    level = metres <= 50 ? 'ok' : 'warn';
    text = '±' + (metres >= 1000 ? (metres / 1000).toFixed(1) + ' km' : metres + ' m');
  } else if (gpsState === 'on') { level = 'warn'; text = 'GPS lost'; }
  else { level = 'warn'; text = 'GPS searching'; }
  chip.dataset.level = level;
  label.textContent = text;

  // current position, and the CAP grid it falls in, while the fix is current
  const pos = $('#gpsPos');
  if (pos) {
    pos.hidden = !fix;
    pos.textContent = fix ? fmtCoord(fix.lat, true) + '  ' + fmtCoord(fix.lon, false) : '';
  }
  const grid = $('#gpsGrid');
  if (grid) {
    // sectional grid and lat/long cell, whichever apply here
    const names = fix ? [capGridName(fix.lat, fix.lon), capCellName(fix.lat, fix.lon)].filter(Boolean) : [];
    grid.hidden = !names.length;
    grid.textContent = names.join(' · ');
  }
  // position | fix quality
  const sep = $('#gpsSep');
  if (sep) sep.hidden = !fix;
}

function gpsErrorText(error) {
  if (error && error.secure) {
    return 'GPS needs a secure page. Use the installed home-screen app or the https address.';
  }
  if (error && error.unsupported) return 'This browser does not support location.';
  const code = error && error.code;
  if (code === 1) {
    return NATIVE
      ? 'Location permission denied. Allow it in iPad Settings → Mission Log → Location.'
      : 'Location permission denied. Turn on Location Services for Safari or Mission Log in iPad Settings.';
  }
  if (code === 3) return 'GPS timed out. Move into the open and try again.';
  if (code === 2) return 'Location unavailable. Check that Location Services is on, then try again.';
  return 'Could not get a GPS fix.';
}

function fillCoordPair(latInput, lonInput, fix) {
  if (!latInput || !lonInput) return;
  latInput.value = fmtCoord(fix.lat, true);
  lonInput.value = fmtCoord(fix.lon, false);
  latInput.dispatchEvent(new Event('input', { bubbles: true }));
  lonInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function gpsBusy(button) {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Locating…';
  return () => {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  };
}

function reportGpsError(error) {
  if (gpsWarned) return;
  gpsWarned = true;
  toast(gpsErrorText(error));
}

function applyGpsToObservation(obs, fix, card) {
  obs.lat = fmtCoord(fix.lat, true);
  obs.lon = fmtCoord(fix.lon, false);
  obs.gpsAccuracy = Math.round(fix.accuracy);
  obs.gpsTime = fmtZ(hhmmFromMs(fix.at));

  if (card) {
    const latInput = card.querySelector('[data-bind$=".lat"]');
    const lonInput = card.querySelector('[data-bind$=".lon"]');
    if (latInput) latInput.value = obs.lat;
    if (lonInput) lonInput.value = obs.lon;
    const status = card.querySelector('.gps-status');
    if (status) status.textContent = 'GPS ±' + obs.gpsAccuracy + ' m · ' + obs.gpsTime;
  }
}

function autoGpsEntry(entry) {
  requestGps(false)
    .then(fix => {
      entry.lat = fmtCoord(fix.lat, true);
      entry.lon = fmtCoord(fix.lon, false);
      entry.gpsAccuracy = Math.round(fix.accuracy);
      entry.gpsTime = fmtZ(hhmmFromMs(fix.at));
      save();
      if (activeTab === 'fly' && !$('#overlay').classList.contains('show')) renderWhenIdle();
    })
    .catch(reportGpsError);
}

function autoGpsObservation(obs) {
  requestGps(false)
    .then(fix => {
      const card = activeTab === 'fly' ? $('.obs[data-obs-id="' + obs.id + '"]') : null;
      applyGpsToObservation(obs, fix, card || null);
      save();
      refreshObsPop();
    })
    .catch(reportGpsError);
}

/* ---------- state ---------- */

let state = null;
let activeTab = 'fly';
let sheetOnClose = null;
let sketchCtl = null;
let sigCtl = null;
let saveTimer = null;
let toastTimer = null;
let saveInFlight = false;

function emptyTimes() {
  return {
    engineStart: { time: '', hobbs: '' },
    wheelsUp: { time: '', hobbs: '' },
    inArea: { time: '', hobbs: '' },
    outOfArea: { time: '', hobbs: '' },
    wheelsDown: { time: '', hobbs: '' },
    shutDown: { time: '', hobbs: '' },
    tachStart: '',
    tachEnd: ''
  };
}

/* SAR results worksheet (CAPF 104a): one search area per log. */
const SAR_CORNERS = [['nw', 'Northwest'], ['ne', 'Northeast'], ['sw', 'Southwest'], ['se', 'Southeast']];
const SAR_TEXT_ROWS = [
  ['pattern', 'Search pattern', { autocap: 'characters' }],
  ['visibility', 'Search visibility (NM)', { inputmode: 'decimal', className: 'mono' }],
  ['altitude', 'Search altitude (AGL)', { inputmode: 'numeric', className: 'mono' }],
  ['speed', 'Search speed (knots)', { inputmode: 'numeric', className: 'mono' }],
  ['spacing', 'Track spacing (NM)', { inputmode: 'decimal', className: 'mono' }]
];
const SAR_CHOICE_ROWS = [
  ['terrain', 'Terrain', ['Flat', 'Rolling Hills', 'Rugged Hills', 'Mountainous']],
  ['cover', 'Cover', ['Open', 'Moderate', 'Heavy', 'Light Snow', 'Heavy Snow']],
  ['turbulence', 'Turbulence', ['Light', 'Moderate', 'Heavy']]
];
const SAR_RESULT_ROWS = [
  ['pod', 'Probability of detection', { inputmode: 'numeric', className: 'mono', placeholder: '%' }],
  ['toArea', 'Time to search area', { className: 'mono', placeholder: 'h:mm' }],
  ['started', 'Time started search', { className: 'mono', norm: 'time', inputmode: 'numeric', placeholder: 'hhmm Z' }],
  ['ended', 'Time ended search', { className: 'mono', norm: 'time', inputmode: 'numeric', placeholder: 'hhmm Z' }],
  ['inArea', 'Time in search area', { className: 'mono', placeholder: 'h:mm' }],
  ['fromArea', 'Time from search area', { className: 'mono', placeholder: 'h:mm' }],
  ['total', 'Total sortie time', { className: 'mono', placeholder: 'h:mm' }]
];
const SAR_RATINGS = ['Excellent', 'Good', 'Fair', 'Poor'];
const SAR_SCORES = ['1', '2', '3', '4', '5'];

function blankSarColumn() {
  const column = {};
  SAR_TEXT_ROWS.concat(SAR_CHOICE_ROWS, SAR_RESULT_ROWS).forEach(row => { column[row[0]] = ''; });
  return column;
}

function blankSar() {
  const corners = {};
  SAR_CORNERS.forEach(([key]) => { corners[key] = { lat: '', lon: '' }; });
  return {
    tracking: '',
    reporter: '',
    reporterCapid: '',
    areaName: '',
    corners,
    planned: blankSarColumn(),
    actual: blankSarColumn(),
    effectiveness: '',
    effectivenessScore: '',
    visibility: '',
    visibilityScore: '',
    comments: ''
  };
}

function normalizeSar(raw) {
  const sar = blankSar();
  if (!raw || typeof raw !== 'object') return sar;
  const corners = sar.corners;
  const planned = sar.planned;
  const actual = sar.actual;
  Object.assign(sar, raw);
  delete sar.missionDate;   // the mission date lives on the mission since 1.22.0
  sar.corners = corners;
  SAR_CORNERS.forEach(([key]) => { Object.assign(corners[key], (raw.corners && raw.corners[key]) || {}); });
  sar.planned = Object.assign(planned, raw.planned || {});
  sar.actual = Object.assign(actual, raw.actual || {});
  return sar;
}

function sarHasData(sar) {
  const filled = value => (value && typeof value === 'object'
    ? Object.keys(value).some(key => filled(value[key]))
    : String(value == null ? '' : value).trim() !== '');
  return filled(sar);
}

/* The worksheet as plain label/value rows, shared by the PDF and the print view. */
function sarReport(log) {
  const sar = log.sar;
  const cell = (column, key) => {
    const value = String(column[key] || '').trim();
    if (!value) return '';
    if (key === 'pod' && /^\d+(\.\d+)?$/.test(value)) return value + '%';
    if ((key === 'started' || key === 'ended') && isValidTime(value)) return value + 'Z';
    return value;
  };
  const rated = key => [sar[key], sar[key + 'Score'] ? 'score ' + sar[key + 'Score'] + ' of 5' : '']
    .filter(Boolean).join(' - ');
  return {
    meta: [
      ['Tracking number', sar.tracking || log.sortie],
      ['Mission number', missionOf(log).number],
      ['Mission date', missionOf(log).date],
      ['Reporting MO / MP / MS', [sar.reporter, sar.reporterCapid ? 'CAPID ' + sar.reporterCapid : ''].filter(Boolean).join(' - ')],
      ['Search area name', sar.areaName],
      ['Grid', log.grid],
      ['Effectiveness', rated('effectiveness')],
      ['Visibility', rated('visibility')]
    ],
    corners: SAR_CORNERS.map(([key, label]) => [label, normCoordText(sar.corners[key].lat, true), normCoordText(sar.corners[key].lon, false)]),
    rows: SAR_TEXT_ROWS.concat(SAR_CHOICE_ROWS, SAR_RESULT_ROWS)
      .map(([key, label]) => [label, cell(sar.planned, key), cell(sar.actual, key)]),
    comments: String(sar.comments || '').trim()
  };
}

/* The WMIRS brief and debrief fields, as label/value rows for the PDF and the
   printout. Empty ones are left out. */
function wmirsReport(log) {
  const d = log.debrief;
  const money = value => (String(value || '').trim() ? '$' + String(value).trim().replace(/^\$/, '') : '');
  const reason = d.reason === 'Other' ? d.reasonOther || 'Other' : [d.reason, d.reasonOther].filter(Boolean).join(' - ');
  const b = log.brief;
  const a = log.aircraftInfo;
  const ticked = (items, values, other) => items.filter(([key]) => values[key]).map(([key, label]) =>
    key === 'other' && other ? 'Other: ' + other : label).join(', ');
  const who = (name, capid) => [name, capid && 'CAPID ' + capid].filter(Boolean).join(', ');
  const quals = log.crew.filter(m => qualList(m).length)
    .map(m => (String(m.name || '').trim() || m.role) + ': ' + qualList(m).join(', ')).join('; ');
  const flightPlan = [b.fpRequired && 'Required', b.fpFiled && 'Filed', b.fpOpened && 'Opened', d.flightPlanClosed && 'Closed'].filter(Boolean).join(', ');
  const risk = [b.riskLevel, b.ormComplete && 'ORM matrix complete', b.riskApproval && 'Risk assessment approved'].filter(Boolean).join(', ');
  return [
    ['Sortie objective', b.objective],
    ['Area of operations', b.areaOfOps],
    ['ETD (Z) / ETE', [b.etd && fmtZ(b.etd), b.ete].filter(Boolean).join(' / ')],
    ['Crew qualifications', quals],
    ['Crew contact', log.crewContact],
    ['Aircraft', [a.type, a.color, a.tas && a.tas + ' kt TAS', a.fuelHours && a.fuelHours + ' h fuel', a.homeBase && 'Home ' + a.homeBase, a.owner].filter(Boolean).join(', ')],
    ['Equipment', ticked(AIRCRAFT_EQUIPMENT, a.equipment, a.equipmentOther)],
    ['Base telephone', b.basePhone],
    ['Radio checks & contacts', b.radioChecks],
    ['Sortie objectives', log.objectives],
    ['Sortie deliverables', log.deliverables],
    ['Actions to be taken', b.actions],
    ['Route of flight', log.route],
    ['Altitude restrictions', b.altitudeRestrictions],
    ['Airspeed restrictions', b.airspeedRestrictions],
    ...BRIEF_SAFETY.map(([key, label]) => [label, b[key]]),
    ['Other aircraft in area', b.otherAircraft],
    ['Ground teams in area', b.groundTeams],
    ...BRIEF_WEATHER.map(([key, label]) => ['Weather: ' + label, b.weather[key]]),
    ['Flight plan', flightPlan],
    ['Risk assessment', risk],
    ['Special instructions', b.specialInstructions],
    ['Briefer', [who(b.briefer, b.brieferCapid), b.phoneBriefing && 'by phone'].filter(Boolean).join(' · ')],
    ['Flight release officer', who(b.fro, b.froCapid)],
    ['Fuel used (gal)', d.fuelGal],
    ['Oil used (qt)', d.oilQt],
    ['Fuel & oil cost', money(d.fuelCost)],
    ['Receipt #', d.receipt],
    ['Wing paid', d.wingPaid ? 'Yes' : ''],
    ['Summary', d.summary],
    ['Results/Deliverables', d.results],
    ['Weather conditions', d.weather],
    ['Remarks', d.remarks],
    ['Sortie effectiveness', [d.effectiveness, d.effectiveness && d.effectiveness !== 'Successful' ? reason : ''].filter(Boolean).join(' - ')],
    ['Attachments', ticked(DEBRIEF_ATTACHMENTS, d.attachments, d.attachmentsOther)],
    ['Debriefer', [who(d.debriefer, d.debrieferCapid), d.debriefedAt, d.phoneDebrief && 'by phone'].filter(Boolean).join(' · ')]
  ].map(([label, value]) => [label, String(value || '').trim()]).filter(([, value]) => value);
}

/* ---------- crew ----------
   A sortie's crew is a list, so it can hold more than one observer, scanner or
   photographer. Roles as CAP writes them: mission pilot, observer, scanner,
   airborne photographer. */
const CREW_ROLES = [['MP', 'Mission pilot'], ['MO', 'Mission observer'], ['MS', 'Mission scanner'],
  ['AP', 'Airborne photographer'], ['RO', 'Radio operator'], ['PAX', 'Passenger']];
const CREW_ROLE_KEYS = CREW_ROLES.map(([key]) => key);

function crewMember(role) {
  return { id: uid(), role: role || 'MS', name: '', capid: '', quals: {} };
}

// The qualification boxes the form gives a crew member in this role.
function qualsFor(member) {
  return member.role === 'MP' ? QUALS_PILOT : QUALS_CREW;
}

function qualList(member) {
  return qualsFor(member).filter(q => member.quals && member.quals[q]);
}

// Logs saved before 1.11.0 have one named slot per role; turn them into the list.
function normalizeCrew(raw) {
  if (Array.isArray(raw)) {
    return raw.map(m => {
      const member = Object.assign(crewMember(), m || {});
      if (!CREW_ROLE_KEYS.includes(member.role)) member.role = 'MS';
      const quals = {};
      Object.keys(QUAL_NAMES).forEach(q => { if (member.quals && member.quals[q] === true) quals[q] = true; });
      member.quals = quals;
      return member;
    });
  }
  const old = raw || {};
  const list = [
    Object.assign(crewMember('MP'), { name: old.pilot || '' }),
    Object.assign(crewMember('MO'), { name: old.observer || '' })
  ];
  if (old.scanner) list.push(Object.assign(crewMember('MS'), { name: old.scanner }));
  if (old.ap) list.push(Object.assign(crewMember('AP'), { name: old.ap }));
  return list;
}

// Names for one role, in the order entered: "A. Rivera; J. Okafor".
function crewNames(log, role) {
  return log.crew.filter(m => m.role === role && String(m.name || '').trim())
    .map(m => m.name.trim()).join('; ');
}

// Crew for the PDF and printout: everyone with a name or CAPID, pilot first.
function crewForPrint(log) {
  const label = Object.fromEntries(CREW_ROLES);
  return crewInOrder(log)
    .filter(m => String(m.name || '').trim() || String(m.capid || '').trim())
    .map(m => ({ role: m.role, roleName: label[m.role] || m.role, name: String(m.name || '').trim(), capid: String(m.capid || '').trim() }));
}

// Everyone, pilot first, for the header.
function crewInOrder(log) {
  return CREW_ROLE_KEYS.flatMap(role => log.crew.filter(m => m.role === role));
}

/* ---------- missions and sorties ----------
   As in WMIRS: a mission (number, name, symbol) holds air sorties. Missions are
   their own records in state.missions; each sortie in state.logs points at its
   mission by missionId. */

// WMIRS Air Sortie Add/Edit → Sortie Type
const SORTIE_TYPES = ['ADIS Sortie', 'Airborne Photography', 'CD Evaluation', 'CD Training', 'Communication Relay',
  'DR Evaluation', 'DR Training', 'DF ELT', 'Impact Assessment', 'Relocation', 'Airborne Recon', 'SAR Evaluation',
  'SAR Training', 'Training/Evaluation', 'Crew Transportation'];
// WMIRS Air Sortie Debrief
const SORTIE_EFFECTIVENESS = ['Successful', 'Marginal', 'Unsuccessful', 'Not Flown', 'Not Required'];
const NOT_SUCCESSFUL_REASONS = ['Weather', 'Aircraft Maintenance', 'Equipment Failure', 'Crew Unavailable', 'Customer Cancellation', 'Other'];
// The debrief narrative, with the character limits WMIRS puts on each box.
const DEBRIEF_TEXT = [
  ['summary', 'Summary', 500],
  ['results', 'Results/Deliverables', 800],
  ['weather', 'Weather Conditions', 200],
  ['remarks', 'Remarks', 400]
];

/* The rest of the CAPF 104 (Dec 21): briefing pages 2 and 3, the manifest's
   qualifications and aircraft block, and the debrief's attachments and
   debriefing officers. */
// Qualification boxes on the manifest: a pilot's, and everyone else's.
const QUALS_PILOT = ['MP', 'TMP', 'MCP', 'MFC', 'WS', 'COM', 'IFR', 'Night', 'LES', 'Trainee'];
const QUALS_CREW = ['MO', 'MS', 'AP', 'ADIS', 'HRO', 'WS', 'LES', 'Trainee', 'Other'];
const QUAL_NAMES = {
  AP: 'Airborne Photographer', ADIS: 'ADIS', COM: 'Commercial Pilot', HRO: 'High-Bird Radio Operator',
  IFR: 'Instrument Flight Rated Pilot', LES: 'Law Enforcement Screened (CD Qual.)', MCP: 'Mission Check Pilot',
  MFC: 'Mountain Flying Certification', MO: 'Mission Observer', MP: 'Mission Pilot', MS: 'Mission Scanner',
  Night: 'Current to fly at night', TMP: 'Transport Mission Pilot', WS: 'Water Survival', Trainee: 'Trainee', Other: 'Other'
};
const AIRCRAFT_EQUIPMENT = [['aeronet', 'AERONet'], ['capFm', 'CAP FM Radio'], ['camera', 'Digital Camera'],
  ['survivalKit', 'Survival Kit'], ['satPhone', 'Sat Phone'], ['vor', 'VOR'], ['dme', 'DME'], ['autopilot', 'Autopilot'],
  ['gps', 'GPS'], ['flir', 'FLIR'], ['becker', 'Becker / Rho Theta DF'], ['ltronics', 'L-Tronics DF'],
  ['repeater', 'Tactical Repeater'], ['lifeRaft', 'Life Raft & Vests'], ['other', 'Other']];
const AIRCRAFT_OWNERS = ['CAP', 'Member Owned'];
const DEBRIEF_ATTACHMENTS = [['orm', 'AIF ORM Matrix'], ['recon104b', 'CAPF 104b Recon Summary'],
  ['ics214', 'ICSF 214 Unit Log'], ['receipts', 'Receipts'], ['sar104a', 'CAPF 104a SAR Results Worksheet'], ['other', 'Other']];
const BRIEF_WEATHER = [['currentLocal', 'Current Local'], ['currentEnroute', 'Current Enroute'],
  ['currentArea', 'Current Area of Operations'], ['forecastLocal', 'Forecast Local'],
  ['forecastEnroute', 'Forecast Enroute'], ['forecastArea', 'Forecast Area of Operations']];
const RISK_LEVELS = ['Low', 'Moderate', 'High'];
// Briefing text boxes, in the order of the form: [key, label, limit]
const BRIEF_SAFETY = [
  ['separation', 'Aircraft Separation (Adjoining Areas)', 500],
  ['alternates', 'Emergency / Alternate Fields', 500],
  ['mtrs', 'Military Low Altitude Training Routes', 500],
  ['hazards', 'Hazards To Flight', 1000]
];

function blankBrief() {
  const weather = {};
  BRIEF_WEATHER.forEach(([key]) => { weather[key] = ''; });
  return {
    objective: '',        // WMIRS Sortie Objective (the one-liner by Sortie Type)
    areaOfOps: '',        // WMIRS Area of Operations
    etd: '', ete: '',
    basePhone: '',
    radioChecks: '',      // Required Radio Checks & Contacts
    otherAircraft: '',    // Other Aircraft in Area (Location & Callsign)
    groundTeams: '',      // Ground Teams in Area (Location & Callsign)
    actions: '',          // Actions To Be Taken on Objectives & Deliverables
    altitudeRestrictions: '',
    airspeedRestrictions: '',
    separation: '', alternates: '', mtrs: '', hazards: '',
    weather,
    fpRequired: false, fpFiled: false, fpOpened: false,
    ormComplete: false, riskApproval: false, riskLevel: '',
    specialInstructions: '',
    briefer: '', brieferCapid: '', fro: '', froCapid: '', phoneBriefing: false
  };
}

function blankAircraftInfo() {
  const equipment = {};
  AIRCRAFT_EQUIPMENT.forEach(([key]) => { equipment[key] = false; });
  return { type: '', tas: '', color: '', owner: '', fuelHours: '', homeBase: '', equipment, equipmentOther: '' };
}

function blankMission() {
  return {
    id: uid(),
    number: '',    // WMIRS Mission No., e.g. 27-T-3852
    name: '',      // Mission Name
    symbol: '',    // Mission Symbol, e.g. A31
    date: '',      // DD MMM YY, as on the CAPF 104a
    closed: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function normalizeMission(raw) {
  const mission = blankMission();
  if (!raw || typeof raw !== 'object') return mission;
  ['id', 'number', 'name', 'symbol', 'date'].forEach(key => {
    if (raw[key] != null && raw[key] !== '') mission[key] = String(raw[key]);
  });
  mission.closed = raw.closed === true;
  mission.createdAt = Number(raw.createdAt) || mission.createdAt;
  mission.updatedAt = Number(raw.updatedAt) || mission.updatedAt;
  return mission;
}

function blankDebrief() {
  return {
    flightPlanClosed: false,
    fuelGal: '',
    oilQt: '',
    fuelCost: '',
    receipt: '',
    summary: '',
    results: '',
    weather: '',
    remarks: '',
    effectiveness: '',
    reason: '',
    reasonOther: '',
    wingPaid: false,
    attachments: Object.fromEntries(DEBRIEF_ATTACHMENTS.map(([key]) => [key, false])),
    attachmentsOther: '',
    debriefer: '',
    debrieferCapid: '',
    debriefedAt: '',
    phoneDebrief: false
  };
}

function blankRadio() {
  return { main: '', guard: '', airGround: '', airAir: '', baseCallsign: '', baseFreq: '', atis: '', ctaf: '', unicom: '', other: '' };
}

/* ---------- sketch pages ----------
   Each page is a background (graph paper, plain, or a piece of the sectional
   chart) with the drawing on its own transparent layer, so the background can
   change and the eraser takes off only ink. `image` is the two flattened, for
   the PDF and printout. */
const SKETCH_BACKGROUNDS = [['grid', 'Grid'], ['plain', 'Plain'], ['sectional', 'Sectional'], ['topo', 'Topo'], ['terrain', 'Terrain']];

// A page is 1000 points wide; its height follows the shape of the screen it
// was started on (1250 for pages from before 1.32.0).
function blankSketchPage(bg) {
  return { id: uid(), w: 1000, h: 1250, bg: bg || 'grid', bgImage: '', map: null, ink: '', image: '', pk: '', inkBase: '', strokes: [] };
}

function sketchSize(page) {
  return { w: page.w || 1000, h: page.h || 1250 };
}

// Nothing drawn and no map: a page that can still take the screen's shape.
function sketchPageBlank(page) {
  return !page.ink && !page.pk && !page.inkBase && !CHART_LAYERS[page.bg] && page.bg !== 'image';
}

function normalizeSketchPages(raw) {
  let pages = Array.isArray(raw && raw.sketches) ? raw.sketches.filter(p => p && typeof p === 'object').map(p => ({
    id: p.id || uid(),
    bg: ['grid', 'plain', 'sectional', 'topo', 'terrain', 'image'].includes(p.bg) ? p.bg : 'grid',
    bgImage: safeImage(p.bgImage),
    map: p.map && Number.isFinite(p.map.lat) && Number.isFinite(p.map.lon) && Number.isFinite(p.map.zoom)
      ? { lat: p.map.lat, lon: p.map.lon, zoom: p.map.zoom } : null,
    ink: safeImage(p.ink),
    image: safeImage(p.image),
    // the iPad app's PencilKit drawing (base64), and the ink drawn before it
    pk: typeof p.pk === 'string' && /^[A-Za-z0-9+/=]*$/.test(p.pk) ? p.pk : '',
    inkBase: safeImage(p.inkBase),
    strokes: normalizeStrokes(p.strokes),   // lines on a map page, in latitude and longitude
    w: 1000,
    h: Math.min(2400, Math.max(300, Math.round(Number(p.h) || 1250)))
  })) : [];
  // Before 1.24.0 a log had one sketch, saved flat with its grid: it becomes
  // page 1, drawn on as its own background.
  if (!pages.length && raw && safeImage(raw.sketch)) {
    pages = [Object.assign(blankSketchPage('image'), { bgImage: raw.sketch, image: raw.sketch })];
  }
  return pages.length ? pages : [blankSketchPage()];
}

// A page worth printing: something drawn on it, or a chart under it.
function sketchHasContent(page) {
  return !!(safeImage(page.image) && (page.ink || page.bg === 'image' || ['sectional', 'topo', 'terrain'].includes(page.bg)));
}

function blankLog(missionId) {
  return {
    id: uid(),
    missionId: missionId || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    closed: false,     // closed on the Close tab, once signed
    closedAt: 0,
    sortie: '',        // WMIRS Sortie No., e.g. A0009
    sortieType: '',    // one of SORTIE_TYPES
    aircraft: '',      // Tail No.
    callsign: '',
    depAirport: '',
    destAirport: '',
    objectives: '',    // from the WMIRS brief
    deliverables: '',
    route: '',
    sectional: '',
    grid: '',
    altitude: '',
    airspeed: '',
    entry: { lat: '', lon: '' },
    exit: { lat: '', lon: '' },
    crew: [crewMember('MP'), crewMember('MO'), crewMember('MS')],
    crewContact: '',   // Crew Contact (Phone, Email, etc.)
    brief: blankBrief(),
    aircraftInfo: blankAircraftInfo(),
    radio: blankRadio(),
    navAids: [
      { ident: '', freq: '', radial: '' },
      { ident: '', freq: '', radial: '' },
      { ident: '', freq: '', radial: '' }
    ],
    entries: [],
    times: emptyTimes(),
    ops: [],
    notes: '',
    sketches: [blankSketchPage()],
    observations: [],
    signoff: { name: '', capid: '', dateTime: '', signature: '' },
    debrief: blankDebrief(),
    sar: blankSar(),
    // flight track: [time ms, lat, lon, altitude m, accuracy m, speed m/s, course °]
    track: [],
    // the ForeFlight plan the search area came from: { name, points: [[lat, lon, identifier]] }
    fpl: null
  };
}

function newState() {
  return {
    version: 2,
    savedAt: 0,
    activeMissionId: '',
    activeId: '',      // the open sortie; '' while none is
    settings: {
      theme: 'auto',
      keepAwake: false,
      gpsLive: true,
      opsInterval: 30,
      hobbsPrompt: true,
      installDismissed: false,
      recordTrack: true,
      chartLayer: 'sectional',   // the chart's map: sectional, topo or terrain
      termsAccepted: 0,
      termsAcceptedAt: 0
    },
    missions: [],
    logs: []
  };
}

function normalizeLog(raw) {
  const base = blankLog();
  const log = Object.assign(base, raw || {});
  log.id = (raw && raw.id) || base.id;
  log.missionId = (raw && raw.missionId) || '';
  log.receivedFrom = (raw && raw.receivedFrom) || '';
  // Mission fields were copied onto every sortie before 1.22.0; they now live on
  // the mission (see splitLegacyLogs).
  delete log.mission;
  // WMIRS missions have no base; an old base becomes the sortie's departure
  if (raw && raw.base && !log.depAirport) log.depAirport = String(raw.base).trim().toUpperCase();
  delete log.base;
  delete log.missionCreated;
  delete log.started;
  // "CAP flight" became the WMIRS Sortie Type in 1.22.0. Keep anything else
  // that was typed there in the notes rather than lose it.
  if (raw && raw.capFlight && !log.sortieType) {
    const type = SORTIE_TYPES.find(t => t.toLowerCase() === String(raw.capFlight).trim().toLowerCase());
    if (type) log.sortieType = type;
    else log.notes = ('CAP flight: ' + String(raw.capFlight).trim() + (log.notes ? '\n' + log.notes : ''));
  }
  delete log.capFlight;
  log.closed = !!(raw && raw.closed === true);
  log.closedAt = (raw && Number(raw.closedAt)) || 0;
  log.debrief = Object.assign(blankDebrief(), (raw && raw.debrief) || {});
  log.debrief.flightPlanClosed = log.debrief.flightPlanClosed === true;
  log.debrief.wingPaid = log.debrief.wingPaid === true;
  log.debrief.phoneDebrief = log.debrief.phoneDebrief === true;
  log.debrief.attachments = Object.assign(blankDebrief().attachments, log.debrief.attachments || {});
  const rawBrief = (raw && raw.brief) || {};
  log.brief = Object.assign(blankBrief(), rawBrief);
  log.brief.weather = Object.assign(blankBrief().weather, rawBrief.weather || {});
  ['fpRequired', 'fpFiled', 'fpOpened', 'ormComplete', 'riskApproval', 'phoneBriefing'].forEach(key => {
    log.brief[key] = log.brief[key] === true;
  });
  if (!RISK_LEVELS.includes(log.brief.riskLevel)) log.brief.riskLevel = '';
  const rawAircraft = (raw && raw.aircraftInfo) || {};
  log.aircraftInfo = Object.assign(blankAircraftInfo(), rawAircraft);
  log.aircraftInfo.equipment = Object.assign(blankAircraftInfo().equipment, rawAircraft.equipment || {});
  log.crewContact = String(log.crewContact || '');
  log.times = Object.assign(emptyTimes(), (raw && raw.times) || {});
  TIME_DEFS.forEach(def => {
    log.times[def.key] = Object.assign({ time: '', hobbs: '' }, log.times[def.key] || {});
  });
  log.entry = Object.assign({ lat: '', lon: '' }, (raw && raw.entry) || {});
  log.exit = Object.assign({ lat: '', lon: '' }, (raw && raw.exit) || {});
  log.crew = normalizeCrew(raw && raw.crew);
  log.radio = Object.assign(blankRadio(), (raw && raw.radio) || {});
  log.signoff = Object.assign({ name: '', capid: '', dateTime: '', signature: '' }, (raw && raw.signoff) || {});
  log.sar = normalizeSar(raw && raw.sar);
  log.track = Array.isArray(raw && raw.track) ? raw.track.filter(p => Array.isArray(p) && p.length >= 3) : [];
  log.sketches = normalizeSketchPages(raw);
  delete log.sketch;
  const fpl = raw && raw.fpl;
  const fplPoints = fpl && Array.isArray(fpl.points)
    ? fpl.points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : [];
  log.fpl = fplPoints.length ? { name: String(fpl.name || ''), points: fplPoints } : null;
  log.navAids = Array.isArray(raw && raw.navAids) && raw.navAids.length
    ? raw.navAids.map(n => Object.assign({ ident: '', freq: '', radial: '' }, n || {}))
    : base.navAids;
  log.entries = Array.isArray(log.entries) ? log.entries.map(e => Object.assign({
    id: uid(), kind: '', time: '', hobbs: '', lat: '', lon: '', event: '', note: '', createdAt: Date.now(),
    gpsAccuracy: null, gpsTime: ''
  }, e || {})) : [];
  log.ops = Array.isArray(log.ops) ? log.ops.map(o => Object.assign({
    id: uid(), time: '', hobbs: '', fuel: '', altimeter: '', normal: true
  }, o || {})) : [];
  log.observations = Array.isArray(log.observations) ? log.observations.map(o => {
    const merged = Object.assign({
      id: uid(), time: '', hobbs: '', lat: '', lon: '', text: '', gpsAccuracy: null, gpsTime: '', createdAt: 0
    }, o || {});
    merged.photos = Array.isArray(merged.photos)
      ? merged.photos
          .filter(photo => photo && typeof photo.data === 'string' && photo.data.startsWith('data:image/'))
          .map(photo => ({
            id: photo.id || uid(),
            data: photo.data,
            thumb: typeof photo.thumb === 'string' && photo.thumb.startsWith('data:image/') ? photo.thumb : photo.data,
            w: Number(photo.w) || 0,
            h: Number(photo.h) || 0,
            addedAt: photo.addedAt || 0
          }))
      : [];
    return merged;
  }) : [];
  return log;
}

/* Before 1.22.0 there were no mission records: each log carried its mission's
   number, base and date, a new mission was a placeholder log (started: false),
   and missionCreated / started said which step it was at. Turn such logs into
   missions and sorties. Used for saved state and for older backup files. */
function splitLegacyLogs(rawLogs) {
  const logs = (rawLogs || []).filter(raw => raw && typeof raw === 'object').map(raw => Object.assign({}, raw));
  assignMissionIds(logs);
  const missions = [];
  const sorties = [];
  logs.forEach(raw => {
    const number = String(raw.mission || '').trim().toUpperCase();
    const logged = !!((Array.isArray(raw.entries) && raw.entries.length) ||
      (Array.isArray(raw.observations) && raw.observations.length) ||
      (raw.times && raw.times.engineStart && raw.times.engineStart.time));
    // Logs from before 1.13.0 have neither flag: a mission number or anything
    // logged meant a created mission and a started sortie.
    const created = typeof raw.missionCreated === 'boolean' ? raw.missionCreated : !!number || logged;
    const started = typeof raw.started === 'boolean' ? raw.started : !!number || logged;
    const date = String((raw.sar && raw.sar.missionDate) || '');
    let mission = missions.find(m => m.id === raw.missionId);
    if (!mission && (created || started || logged)) {
      mission = normalizeMission({ id: raw.missionId, number, date, createdAt: raw.createdAt });
      missions.push(mission);
    } else if (mission) {
      if (!mission.number) mission.number = number;
      if (!mission.date) mission.date = date;
      if (raw.createdAt && raw.createdAt < mission.createdAt) mission.createdAt = raw.createdAt;
    }
    // a placeholder with nothing logged was only the mission
    if (mission && (started || logged)) sorties.push(raw);
  });
  return { missions, logs: sorties };
}

function normalizeState(raw) {
  const fresh = newState();
  if (!raw || !Array.isArray(raw.logs)) return fresh;
  let missions;
  let rawLogs;
  if (Array.isArray(raw.missions)) {
    missions = raw.missions.filter(m => m && typeof m === 'object').map(normalizeMission);
    rawLogs = raw.logs;
  } else {
    ({ missions, logs: rawLogs } = splitLegacyLogs(raw.logs));
  }
  const normalized = {
    version: 2,
    savedAt: raw.savedAt || 0,
    activeMissionId: '',
    activeId: '',
    settings: Object.assign(fresh.settings, raw.settings || {}),
    missions,
    logs: rawLogs.map(normalizeLog)
  };
  // A sortie whose mission is missing gets one, so it can still be found.
  normalized.logs.forEach(log => {
    if (missions.some(m => m.id === log.missionId)) return;
    const mission = blankMission();
    if (log.missionId) mission.id = log.missionId;
    else log.missionId = mission.id;
    missions.push(mission);
  });
  const activeLogRaw = normalized.logs.find(l => l.id === raw.activeId);
  // '' means no mission is picked (one was just closed); before 1.22.0 there
  // was no such field, so pick the open sortie's mission or the newest open one.
  const newestOpen = missions.filter(m => !m.closed).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const activeMissionId = missions.some(m => m.id === raw.activeMissionId) ? raw.activeMissionId
    : raw.activeMissionId === '' ? ''
      : activeLogRaw ? activeLogRaw.missionId
        : (newestOpen || {}).id || '';
  normalized.activeMissionId = activeMissionId;
  normalized.activeId = activeLogRaw && activeLogRaw.missionId === activeMissionId ? activeLogRaw.id : '';
  delete normalized.settings.coordFormat;   // the format choice was removed in 1.4.3
  delete normalized.settings.introDismissed; // the intro card was removed in 1.7.3
  delete normalized.settings.gpsAuto;        // replaced by live GPS in 1.8.0
  delete normalized.settings.fingerDraw;     // a finger and Apple Pencil both draw since 1.24.0
  delete normalized.settings.fingerDefaultSet;
  return normalized;
}

function missionById(id) {
  return (state && id && state.missions.find(m => m.id === id)) || null;
}

// The mission picked on Missions, or null.
function activeMission() {
  return state ? missionById(state.activeMissionId) : null;
}

let emptyMission = null;

// A sortie's mission. Never null, so templates can read its fields.
function missionOf(log) {
  const mission = missionById(log && log.missionId);
  if (mission) return mission;
  if (!emptyMission) emptyMission = blankMission();
  return emptyMission;
}

// The open sortie of the picked mission, or null.
function activeSortie() {
  if (!state || !state.activeId) return null;
  const log = state.logs.find(l => l.id === state.activeId);
  return log && log.missionId === state.activeMissionId ? log : null;
}

let detachedLog = null;

/* The open sortie. With none open it is an empty stand-in that is never saved:
   the sortie tabs stay locked then, so nothing is typed into it. */
function activeLog() {
  const log = activeSortie();
  if (log) return log;
  if (!detachedLog) detachedLog = blankLog('');
  return detachedLog;
}

/* ---------- persistence ---------- */

let dbPromise = null;

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (_) {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

async function readState() {
  let fromLocal = null;
  let fromDb = null;

  // localStorage is synchronous and the most reliable mirror; read it first.
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.logs)) fromLocal = parsed;
    }
  } catch (err) {
    console.warn('localStorage read failed', err);
  }

  try {
    const db = await openDb();
    if (db) {
      const stored = await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get('state');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (stored) {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        if (parsed && Array.isArray(parsed.logs)) fromDb = parsed;
      }
    }
  } catch (err) {
    console.warn('IndexedDB read failed', err);
  }

  if (fromLocal && fromDb) {
    const localTime = fromLocal.savedAt || fromLocal.updatedAt || 0;
    const dbTime = fromDb.savedAt || fromDb.updatedAt || 0;
    return localTime >= dbTime ? fromLocal : fromDb;
  }
  return fromLocal || fromDb;
}

async function writeState() {
  const json = JSON.stringify(state);
  let ok = true;

  try {
    const db = await openDb();
    if (db) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(json, 'state');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } else if (json.length > STATE_MIRROR_LIMIT) {
      ok = false;
    }
  } catch (err) {
    console.warn('IndexedDB write failed', err);
    ok = false;
  }

  // Photos and sketches can push the state past the small localStorage quota.
  // IndexedDB is the primary store; skip the mirror rather than filling it up.
  try {
    if (json.length <= STATE_MIRROR_LIMIT) localStorage.setItem(STATE_KEY, json);
    else localStorage.removeItem(STATE_KEY);
  } catch (err) {
    if (!(err && err.name === 'QuotaExceededError')) console.warn('localStorage write failed', err);
  }

  return ok;
}

function mirrorState() {
  try {
    const json = JSON.stringify(state);
    if (json.length <= STATE_MIRROR_LIMIT) localStorage.setItem(STATE_KEY, json);
    else localStorage.removeItem(STATE_KEY);
  } catch (_) { /* ignore */ }
}

function setSaveStatus(kind, text) {
  const dot = $('#saveDot');
  const label = $('#saveLabel');
  if (dot) dot.className = 'save-dot' + (kind === 'saving' ? ' saving' : kind === 'error' ? ' error' : '');
  if (label) label.textContent = text;
}

let opsReminderTimer = null;
let trackSyncTimer = null;

// quiet: a background update (a track point) that should not reschedule
// the reminder, Live Activity and recorder.
function save(quiet) {
  if (!state) return;
  state.updatedAt = Date.now();
  state.savedAt = Date.now();
  activeLog().updatedAt = Date.now();
  setSaveStatus('saving', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (saveInFlight) return;
    saveInFlight = true;
    try {
      const ok = await writeState();
      if (ok) setSaveStatus('saved', 'Saved ' + fmtClock());
      else setSaveStatus('error', 'Save trouble — export a backup');
    } catch (err) {
      console.warn(err);
      setSaveStatus('error', 'Save trouble — export a backup');
    } finally {
      saveInFlight = false;
    }
  }, 420);
  if (quiet) return;
  if (NATIVE) {
    clearTimeout(opsReminderTimer);
    opsReminderTimer = setTimeout(() => { scheduleOpsReminder(); syncSortieActivity(); }, 1500);
  }
  clearTimeout(trackSyncTimer);
  trackSyncTimer = setTimeout(syncTrackRecorder, 1200);
}

/* ---------- theme / wake lock ---------- */

let wakeLock = null;

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme() {
  const theme = (state && state.settings.theme) || 'auto';
  const dark = theme === 'dark' || (theme === 'auto' && systemPrefersDark());

  if (theme === 'auto') {
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#1c2632');

}

async function syncWakeLock() {
  if (NATIVE) {
    Native.MissionLog.setKeepAwake({ enabled: !!(state && state.settings.keepAwake) }).catch(() => {});
    return;
  }
  const wanted = !!(state && state.settings.keepAwake);
  if (!wanted) {
    if (wakeLock) {
      try { await wakeLock.release(); } catch (_) { /* ignore */ }
      wakeLock = null;
    }
    return;
  }
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) {
    wakeLock = null;
  }
}

/* ---------- toast ---------- */

function toast(message, actionLabel, action) {
  const el = $('#toast');
  if (!el) return;
  el.innerHTML = '<span>' + esc(message) + '</span>' +
    (actionLabel ? '<button type="button" id="toastAction">' + esc(actionLabel) + '</button>' : '');
  el.classList.add('show');
  if (actionLabel) {
    const btn = $('#toastAction');
    if (btn) btn.onclick = () => {
      el.classList.remove('show');
      if (typeof action === 'function') action();
    };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 6000 : 2600);
}

/* ---------- derived values ---------- */

function lastHobbs(log) {
  const l = log || activeLog();
  for (let i = l.entries.length - 1; i >= 0; i--) {
    if (l.entries[i].hobbs) return l.entries[i].hobbs;
  }
  if (l.times.shutDown.hobbs) return l.times.shutDown.hobbs;
  if (l.times.engineStart.hobbs) return l.times.engineStart.hobbs;
  return '';
}

function lastPosition(log) {
  const l = log || activeLog();
  for (let i = l.entries.length - 1; i >= 0; i--) {
    const e = l.entries[i];
    if (e.lat || e.lon) return { lat: e.lat || '', lon: e.lon || '' };
  }
  return { lat: '', lon: '' };
}

function timeTotals(log) {
  const l = log || activeLog();
  const engine = diffMin(l.times.engineStart.time, l.times.shutDown.time);
  const flight = diffMin(l.times.wheelsUp.time, l.times.wheelsDown.time);
  const tachA = num(tachValues(l).start);
  const tachB = num(tachValues(l).end);
  const tach = tachA != null && tachB != null ? tachB - tachA : null;
  const hobbsA = num(l.times.engineStart.hobbs);
  const hobbsB = num(l.times.shutDown.hobbs);
  const hobbs = hobbsA != null && hobbsB != null ? hobbsB - hobbsA : null;
  // WMIRS wants the Hobbs total split in two parts that add back up to it.
  const areaIn = num(l.times.inArea.hobbs);
  const areaOut = num(l.times.outOfArea.hobbs);
  const hobbsArea = areaIn != null && areaOut != null ? areaOut - areaIn : null;
  const hobbsToFrom = hobbs != null && hobbsArea != null ? hobbs - hobbsArea : null;
  return { engine, flight, tach, hobbs, hobbsArea, hobbsToFrom };
}

function nextOpsDue(log) {
  const l = log || activeLog();
  const last = l.ops[l.ops.length - 1];
  if (!last || !isValidTime(last.time)) return '';
  return addMinutes(last.time, state.settings.opsInterval || 30);
}

function entryForKind(log, kind) {
  if (!kind) return null;
  return log.entries.find(e => e.kind === kind) || null;
}

function syncLinkedTime(key, field, value) {
  const log = activeLog();
  const def = TIME_DEFS.find(d => d.key === key);
  if (!def) return;
  const entry = entryForKind(log, def.kind);
  if (entry) entry[field] = value;
}

function fmtEntryPosition(entry) {
  return coordPair(entry.lat, entry.lon);
}

/* =========================================================================
   Rendering
   ========================================================================= */

function renderStrip() {
  const mission = activeMission();
  const log = activeSortie();
  const main = $('#stripMain');
  const sub = $('#stripSub');
  if (!main || !sub) return;

  // Header reads: mission number, then the sortie, its callsign and crew names.
  const any = state.missions.length > 0;
  if (mission) main.textContent = mission.number || 'Mission';
  else main.innerHTML = '<svg class="strip-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>Add Mission';
  // Until a sortie is open, an arrow points at the next step.
  const callout = $('#stripCallout');
  if (callout) callout.hidden = !!log;
  if (callout) callout.textContent = mission ? 'Add a sortie' : any ? 'Add a mission' : 'Start Here';
  const sortieBtn = $('#sortieSwitch');
  if (sortieBtn) sortieBtn.hidden = !log;
  if (sortieBtn && log) $('#sortieLabel').textContent = sortieLabel(log, missionSorties(log).indexOf(log));
  if (!log) { sub.textContent = ''; return; }
  const rest = [log.callsign, ...crewInOrder(log).map(m => m.name)]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  sub.textContent = rest.join('  ·  ');
}

function renderTabbar() {
  const bar = $('#tabbar');
  const locked = !activeSortie();
  if (bar) bar.classList.toggle('locked', locked);
  $$('#tabbar .tab').forEach(btn => {
    const on = btn.dataset.tab === activeTab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    if (btn.dataset.tab === 'logbook') return;
    if (locked) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
  });
  renderTabDots();
}

// The dots on the tabs: Fly while the track records, Close once the sortie is closed.
function renderTabDots() {
  const sortie = activeSortie();
  const fly = $('#tabbar [data-tab="fly"]');
  const close = $('#tabbar [data-tab="sign"]');
  if (fly) fly.classList.toggle('recording', !!(sortie && trackSortieId === sortie.id));
  if (close) close.classList.toggle('done', !!(sortie && sortie.closed));
}

/* A redraw replaces the fields on screen, which closes the keyboard. Background
   work (a GPS fix arriving) waits until nothing in the view is being typed in. */
let renderPending = false;

function fieldFocusedInView() {
  const el = document.activeElement;
  return !!(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.closest('#view'));
}

function renderWhenIdle() {
  if (fieldFocusedInView()) renderPending = true;
  else render();
}

function render() {
  if (!state) return;
  renderPending = false;
  renderStrip();
  renderGpsChip();
  renderTabbar();
  renderTopbarTools();
  placePageTop();
  const chip = $('#gpsChip');
  if (chip) chip.classList.toggle('open', activeTab === 'fly' && flyPosOpen);
  const view = $('#view');
  if (!view) return;
  const log = activeLog();

  if (!TABS.includes(activeTab) && !SCREENS.includes(activeTab)) activeTab = defaultTab(log);
  // Brief…Sign are about one sortie: Missions until one is open
  if (activeTab !== 'logbook' && !activeSortie()) activeTab = 'logbook';
  if (activeTab !== 'fly' && positionMap) closePositionView();
  document.documentElement.classList.toggle('page-full', activeTab === 'notes' || activeTab === 'sketch');
  if (activeTab === 'logbook') view.innerHTML = logbookView();
  else if (activeTab === 'plan') view.innerHTML = planView(log);
  else if (activeTab === 'fly') {
    // the map stays; only its controls and the log are redrawn
    if (positionMap && positionMap.logId === log.id && refreshFlyView(log)) placeFlyShell();
    else { view.innerHTML = flyView(log); mountFlyMap(); }
  }
  else if (activeTab === 'notes') view.innerHTML = notesView(log);
  else if (activeTab === 'sketch') view.innerHTML = sketchView(log);
  else if (activeTab === 'debrief') view.innerHTML = debriefView(log);
  else if (activeTab === 'sign') view.innerHTML = signView(log);

  updateOutputs();

  // Each drops its controller when its canvas is not on the current tab.
  setupSketch();
  setupSignature();

  if (activeTab === 'notes') {
    autoGrowAll();
  }
  if (activeTab === 'fly' || activeTab === 'plan' || activeTab === 'debrief') {
    autoGrowAll();
  }
}

/* ---------- the flight log as a vertical timeline ----------
   Checkpoints, observations and OPS checks together in time order, each a
   node on one line: the time on the left, an icon on the line, a card on the
   right, and the minutes between them on the line itself. They are still
   stored, numbered and printed separately. */
const TL_ICONS = {
  obs: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  ops: '<path d="M9 11.5l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
  opsFlag: '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>',
  next: '<circle cx="12" cy="12" r="3"/>'
};
const tlIcon = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

// Observations opened for editing in the timeline (not saved).
const expandedObs = new Set();

function tlGap(minutes) {
  if (minutes == null || minutes <= 0) return '';
  const text = minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h ' + pad2(minutes % 60) + ' min';
  return `<div class="tl-gap" aria-hidden="true"><span>${text}</span></div>`;
}

function tlEntryHTML(entry) {
  const quick = QUICK.find(q => q.kind === entry.kind);
  const pos = fmtEntryPosition(entry);
  const meta = [];
  if (entry.hobbs) meta.push('Hobbs <b class="mono">' + esc(entry.hobbs) + '</b>');
  if (pos) meta.push('<span class="mono">' + esc(pos) + '</span>');
  if (entry.gpsAccuracy) meta.push('±' + esc(entry.gpsAccuracy) + ' m');
  return `<div class="tl-item ${quick ? 'cp' : 'custom'}" data-act="edit-entry" data-id="${esc(entry.id)}" role="button" tabindex="0">
      <div class="tl-time mono">${entry.time ? esc(fmtZ(entry.time)) : '—'}</div>
      <div class="tl-node">${tlIcon(quick ? quick.icon : CUSTOM_CHECKPOINT_ICON)}</div>
      <div class="tl-card">
        <div class="tl-title">${esc(entry.event || 'Log entry')}</div>
        ${meta.length ? `<div class="tl-meta">${meta.join('<span class="tl-dot">·</span>')}</div>` : ''}
        ${entry.note ? `<div class="tl-note">${esc(entry.note)}</div>` : ''}
        <button type="button" class="row-del tl-del" data-act="del-entry" data-id="${esc(entry.id)}" aria-label="Delete entry">×</button>
      </div>
    </div>`;
}

function tlObsHTML(log, obs, index) {
  if (expandedObs.has(obs.id)) {
    return `<div class="tl-item tl-obs open">
        <div class="tl-time mono">${obs.time ? esc(fmtZ(obs.time)) : '—'}</div>
        <div class="tl-node">${tlIcon(TL_ICONS.obs)}</div>
        <div class="tl-card tl-obs-edit">
          ${obsCardHTML(log, obs, index)}
          <button type="button" class="btn small tl-collapse" data-act="obs-collapse" data-id="${esc(obs.id)}">Done</button>
        </div>
      </div>`;
  }
  const photos = Array.isArray(obs.photos) ? obs.photos : [];
  const pos = obs.lat && obs.lon ? obs.lat + '  ' + obs.lon : '';
  return `<div class="tl-item tl-obs" data-act="obs-expand" data-id="${esc(obs.id)}" role="button" tabindex="0">
      <div class="tl-time mono">${obs.time ? esc(fmtZ(obs.time)) : '—'}</div>
      <div class="tl-node">${tlIcon(TL_ICONS.obs)}</div>
      <div class="tl-card">
        <div class="tl-title">Observation ${index + 1}</div>
        <div class="tl-text${obs.text ? '' : ' empty'}">${obs.text ? esc(obs.text) : 'No note yet. Tap to add one.'}</div>
        ${photos.length ? `<div class="tl-photos">${photos.map((photo, i) => `<button type="button" class="tl-photo" data-act="view-photo" data-obs="${esc(obs.id)}" data-index="${i}" aria-label="View photo ${i + 1}"><img src="${esc(photo.thumb || photo.data)}" alt=""></button>`).join('')}</div>` : ''}
        ${pos || obs.hobbs ? `<div class="tl-meta">${[obs.hobbs ? 'Hobbs <b class="mono">' + esc(obs.hobbs) + '</b>' : '', pos ? '<span class="mono">' + esc(pos) + '</span>' : ''].filter(Boolean).join('<span class="tl-dot">·</span>')}</div>` : ''}
      </div>
    </div>`;
}

function tlOpsHTML(op, index) {
  const meta = [];
  if (op.fuel) meta.push('Fuel <b>' + esc(op.fuel) + '</b>');
  if (op.altimeter) meta.push('Altimeter <b class="mono">' + esc(op.altimeter) + '</b>');
  if (op.hobbs) meta.push('Hobbs <b class="mono">' + esc(op.hobbs) + '</b>');
  return `<div class="tl-item ops${op.normal ? '' : ' flagged'}" data-act="goto-ops" role="button" tabindex="0">
      <div class="tl-time mono">${op.time ? esc(fmtZ(op.time)) : '—'}</div>
      <div class="tl-node">${tlIcon(op.normal ? TL_ICONS.ops : TL_ICONS.opsFlag)}</div>
      <div class="tl-card">
        <div class="tl-title">OPS check ${index + 1} <span class="tl-tag">${op.normal ? 'Normal' : 'Flagged'}</span></div>
        ${meta.length ? `<div class="tl-meta">${meta.join('<span class="tl-dot">·</span>')}</div>` : ''}
      </div>
    </div>`;
}

// The figures at the top: time since Engine Start, and what has been logged.
function tlSummaryHTML(log) {
  const start = log.times.engineStart.time;
  const end = log.times.shutDown.time;
  const engine = isValidTime(start) ? diffMin(start, isValidTime(end) ? end : nowZ()) : null;
  const next = nextOpsDue(log);
  const stat = (label, value) => `<div class="tl-stat"><span>${label}</span><b>${value}</b></div>`;
  return `<div class="tl-summary">
      ${stat(isValidTime(end) ? 'Engine time' : 'Engine running', engine != null ? esc(fmtDuration(engine)) : '—')}
      ${stat('Checkpoints', log.entries.length)}
      ${stat('Observations', log.observations.length)}
      ${stat('OPS checks', log.ops.length + (next && !isValidTime(end) ? ' <small>next ' + esc(fmtZ(next)) + '</small>' : ''))}
    </div>`;
}

function timelineHTML(log) {
  const items = [
    ...log.entries.map(entry => ({ kind: 'entry', time: entry.time, at: entry.createdAt || 0, entry })),
    ...log.observations.map((obs, index) => ({ kind: 'obs', time: obs.time, at: obs.createdAt || 0, obs, index })),
    ...log.ops.map((op, index) => ({ kind: 'ops', time: op.time, at: index, op, index }))
  ];
  const next = QUICK.find(q => { const e = entryForKind(log, q.kind); return !(e && e.time); });
  if (!items.length) {
    return `${tlSummaryHTML(log)}<div class="empty"><strong>Nothing logged yet</strong>Checkpoints you tap, observations you add and OPS checks appear here, in time order.</div>`;
  }
  const minutes = item => (isValidTime(item.time) ? timeToMin(item.time) : null);
  items.sort((x, y) => {
    const a = minutes(x);
    const b = minutes(y);
    if (a != null && b != null && a !== b) return a - b;
    return x.at - y.at;
  });
  let previous = null;
  const rows = items.map(item => {
    const gap = previous && isValidTime(previous) && isValidTime(item.time) ? tlGap(diffMin(previous, item.time)) : '';
    if (isValidTime(item.time)) previous = item.time;
    if (item.kind === 'obs') return gap + tlObsHTML(log, item.obs, item.index);
    if (item.kind === 'ops') return gap + tlOpsHTML(item.op, item.index);
    return gap + tlEntryHTML(item.entry);
  }).join('');
  // the checkpoint still to come, greyed at the end of the line
  const upcoming = next && !log.closed ? `<div class="tl-item next" data-act="quick" data-kind="${esc(next.kind)}" data-label="${esc(next.label)}" role="button" tabindex="0">
      <div class="tl-time mono">Next</div>
      <div class="tl-node">${tlIcon(next.icon)}</div>
      <div class="tl-card"><div class="tl-title">${esc(next.label)}</div><div class="tl-meta">Tap to stamp it now</div></div>
    </div>` : '';
  return `${tlSummaryHTML(log)}<div class="tl">${rows}${upcoming}</div>`;
}

/* Tach start and end follow the readings taken at Engine Start and Shut Down
   until one is typed in on the Sign tab; clearing the field goes back to following. */
function tachValues(log) {
  const l = log || activeLog();
  return { start: l.times.tachStart || '', end: l.times.tachEnd || '' };
}

/* Hobbs and tach as the aircraft flight time log and the WMIRS debrief want them:
   end above start, with the totals, and Hobbs split into In Area and To/From. */
function tachCardHTML(log) {
  const totals = timeTotals(log);
  const tach = tachValues(log);
  const one = value => value == null ? '—' : fmtDecimal(value, 1);
  const shown = value => value ? esc(value) : '—';
  return `<section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Hobbs &amp; tach</h2></div>
        <span class="muted small">Check before signing</span>
      </div>
      <div class="meter-grid">
        <div></div><div class="meter-head">Hobbs</div><div class="meter-head">Tach</div>
        <div class="meter-label">End<small>Shut Down</small></div>
        <div class="meter-value mono" id="meter-hobbs-end">${shown(log.times.shutDown.hobbs)}</div>
        <input class="input mono" data-bind="times.tachEnd" data-norm="hobbs" inputmode="decimal" value="${esc(tach.end)}" placeholder="e.g. 5124.7" aria-label="Tach end">
        <div class="meter-label">Start<small>Engine Start</small></div>
        <div class="meter-value mono" id="meter-hobbs-start">${shown(log.times.engineStart.hobbs)}</div>
        <input class="input mono" data-bind="times.tachStart" data-norm="hobbs" inputmode="decimal" value="${esc(tach.start)}" placeholder="e.g. 5123.4" aria-label="Tach start">
        <div class="meter-label">Total</div>
        <div class="meter-value mono strong" id="meter-hobbs-total">${one(totals.hobbs)}</div>
        <div class="meter-value mono strong" id="tach-card-total">${one(totals.tach)}</div>
      </div>
      <div class="totals" style="grid-template-columns:1fr 1fr">
        <div class="total"><div class="tl">Hobbs In Area</div><div class="tv" id="meter-hobbs-area">${one(totals.hobbsArea)}</div></div>
        <div class="total"><div class="tl">Hobbs To/From</div><div class="tv" id="meter-hobbs-tofrom">${one(totals.hobbsToFrom)}</div></div>
      </div>
      <div class="sketch-hint">Hobbs comes from the checkpoints; correct it under Times above. In area is Out of Area minus In Area, and to / from is the rest, so the two add up to the total. On G1000 aircraft the tach reading is ENG HOURS.</div>
    </section>`;
}

/* ---------- install prompt ---------- */

// Chrome, Edge and Android hand over an install prompt; Safari has none, so
// there the banner spells out Share → Add to Home Screen.
let installPromptEvent = null;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPromptEvent = event;
  if (state && activeTab === 'fly') renderWhenIdle();
});
window.addEventListener('appinstalled', () => {
  installPromptEvent = null;
  if (state && activeTab === 'fly') renderWhenIdle();
});

const SHARE_ICON = '<svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

function installBannerHTML() {
  if (NATIVE || isStandaloneApp() || state.settings.installDismissed) return '';
  const ios = isIOSDevice();
  if (!ios && !installPromptEvent) return '';   // nothing useful to offer here
  const how = ios
    ? `In Safari, tap ${SHARE_ICON} <strong>Share</strong>, then <strong>Add to Home Screen</strong>.`
    : 'Install it to open from its own icon, full screen.';
  return `<div class="install-banner">
      <img src="icons/icon-192.png" alt="" width="52" height="52">
      <div class="install-text">
        <h3>Install Mission Log on this ${ios ? 'iPad' : 'device'}</h3>
        <p>${how} It gets its own app icon, opens full screen and works with no signal.</p>
        <p class="install-warn">Install before you start a log: logs made here in the browser do not move to the installed app.</p>
        <div class="btn-row">
          ${ios ? '<button class="btn small primary" data-act="help">Show me how</button>'
                : '<button class="btn small primary" data-act="install-app">Install</button>'}
          <button class="btn small" data-act="dismiss-install">Not now</button>
        </div>
      </div>
    </div>`;
}

/* ---------- tabs, in the order of a sortie ----------
   Plan (briefing) → Fly (in the aircraft) → Notes → Debrief (after landing) → Sign. */

const TABS = ['logbook', 'plan', 'fly', 'notes', 'sketch', 'debrief', 'sign'];

// Where a sortie opens: Missions until one is open, then its Brief.
function defaultTab() {
  return activeSortie() ? 'plan' : 'logbook';
}

// The sortie tabs (Brief…Sign) open once a sortie of the picked mission is open.
// Given a log: whether it is a real, saved sortie (not the empty stand-in).
function sortieReady(log) {
  if (log) return !!(state && state.logs.includes(log));
  return !!activeSortie();
}

/* ---------- missions above sorties ----------
   Missions (every mission on this iPad, each with its sorties, as in WMIRS)
   → Brief, Fly, Notes, Sketch, Debrief, Sign: one sortie, from WMIRS brief to debrief.
   Internally the first two tabs keep their old keys, 'logbook' and 'plan'. */
const SCREENS = [];

function missionsInOrder() {
  return state.missions.slice().sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
}

function showScreen(screen) {
  if (sketchCtl) sketchCtl.flush();
  if (sigCtl) sigCtl.flush();
  closeSheet();
  activeTab = screen;
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function missionTitle(mission) {
  return mission.number || 'Mission';
}

function closedBadge(mission) {
  return mission.closed ? '<span class="mission-closed">Closed</span>' : '';
}

/* ---------- Missions tab ----------
   The first tab: the picked mission with its sorties, then every other mission
   on this iPad, newest first. Missions come from WMIRS; + adds one here. */
function missionRowHTML(mission) {
  const sorties = missionSorties(mission.id);
  const missionHobbs = sorties.reduce((sum, l) => sum + (timeTotals(l).hobbs || 0), 0);
  const meta = [mission.name, mission.symbol, mission.date,
    sorties.length + ' sortie' + (sorties.length === 1 ? '' : 's'),
    missionHobbs ? fmtDecimal(missionHobbs, 1) + ' Hobbs' : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="log-row mission-row" data-act="open-mission" data-id="${esc(mission.id)}">
    <span class="log-name">${esc(missionTitle(mission))}</span>
    <span class="log-meta">${esc(meta)}</span>
    <svg class="row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`;
}

/* Missions: the picked mission on top, then the other open missions, then the
   closed ones. Closing a mission moves it down to Closed missions; tapping a
   closed mission brings it back up to look at or reopen. */
function logbookView() {
  const active = activeMission();
  const others = missionsInOrder().filter(m => m !== active);
  const open = others.filter(m => !m.closed);
  const closed = others.filter(m => m.closed);
  const hobbs = state.logs.reduce((sum, l) => sum + (timeTotals(l).hobbs || 0), 0);
  const nm = state.logs.reduce((sum, l) => { const t = trackStats(l); return sum + (t ? t.nm : 0); }, 0);
  return `<div class="stack">
    ${active ? activeMissionHTML(active) : ''}
    ${open.length || !active ? `<section class="card">
      <div class="card-head">
        <div class="head-left"><h2>${active ? 'Other open missions' : 'Open missions'}</h2><span class="count-badge">${open.length}</span></div>
      </div>
      ${open.length ? `<div class="log-list">${open.map(missionRowHTML).join('')}</div>`
        : `<div class="empty"><strong>No open missions</strong>Tap + to add a mission from WMIRS.</div>`}
    </section>` : ''}
    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Closed missions</h2><span class="count-badge">${closed.length}</span></div>
      </div>
      ${closed.length ? `<div class="log-list">${closed.map(missionRowHTML).join('')}</div>`
        : '<div class="empty"><strong>No closed missions</strong>A mission moves here once you close it.</div>'}
      <div class="totals" style="grid-template-columns:repeat(3,1fr)">
        <div class="total"><div class="tl">Sorties</div><div class="tv">${state.logs.length}</div></div>
        <div class="total"><div class="tl">Hobbs</div><div class="tv">${fmtDecimal(hobbs, 1) || '0.0'}</div></div>
        <div class="total"><div class="tl">Tracked</div><div class="tv">${Math.round(nm)} NM</div></div>
      </div>
      <div class="sheet-note">Missions and their sorties are created in WMIRS. Add each here with the numbers WMIRS gave it. Everything stays on this iPad.</div>
    </section>
  </div>
  ${fabHTML('new-mission', 'Add a mission')}`;
}

// Close or reopen a mission. Closing puts it away: it leaves the top of
// Missions for Closed missions, and its sortie tabs close.
function setMissionClosed(mission, closed) {
  mission.closed = closed;
  mission.updatedAt = Date.now();
  if (closed && state.activeMissionId === mission.id) {
    state.activeMissionId = '';
    state.activeId = '';
    activeTab = 'logbook';
  }
  save();
  closeSheet();
  render();
  toast('Mission ' + missionTitle(mission) + (closed ? ' closed · moved to Closed missions' : ' reopened'));
}

// The picked mission, at the top of Missions: its sorties and the way to add one.
function activeMissionHTML(mission) {
  const sorties = missionSorties(mission.id);
  const meta = [mission.symbol, mission.date].filter(Boolean).join(' · ');
  return `<section class="card card-current active-mission">
    <div class="card-head">
      <div class="head-left"><h2>${mission.closed ? 'Closed mission' : 'Active mission'}</h2></div>
      <button class="btn small" data-act="edit-mission">Mission details</button>
    </div>
    <div class="active-mission-title">
      <span class="active-mission-number">${esc(missionTitle(mission))} ${closedBadge(mission)}</span>
      ${mission.name ? `<span>${esc(mission.name)}</span>` : ''}
      ${meta ? `<span class="muted">${esc(meta)}</span>` : ''}
    </div>
    ${sorties.length ? `<div class="log-list">${sorties.map(sortieCardRowHTML).join('')}</div>`
      : '<p class="sheet-note" style="margin-top:4px">No sorties yet. Add each air sortie of this mission as it is in WMIRS.</p>'}
    <div class="btn-row" style="margin-top:12px">
      ${mission.closed ? '' : '<button class="btn primary" data-act="add-sortie">+ Add sortie</button>'}
      <button class="btn" data-act="toggle-mission-closed">${mission.closed ? 'Reopen mission' : 'Close mission'}</button>
    </div>
  </section>`;
}

const FAB_ICONS = {
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  // the Fly tab's aeroplane
  fly: '<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'
};

// The round button in the bottom corner: add a mission on Missions, go fly on Brief.
function fabHTML(act, label, icon) {
  return `<button type="button" class="fab" data-act="${act}" aria-label="${esc(label)}" title="${esc(label)}">
    <svg viewBox="0 0 24 24" aria-hidden="true">${FAB_ICONS[icon || 'plus']}</svg>
  </button>`;
}

function missionFieldsHTML(values, bind) {
  const input = (key, opts) => bind
    ? textInput('m.' + key, values[key], opts)
    : `<input class="input ${opts.className || ''}" id="nm-${key}" autocapitalize="${opts.autocap || 'characters'}" placeholder="${esc(opts.placeholder || '')}" value="${esc(values[key] || '')}">`;
  return `<div class="form-grid">
      <label class="field"><span>Mission No.</span>${input('number', { autocap: 'characters', placeholder: '27-T-3852' })}</label>
      <label class="field"><span>Mission Symbol</span>${input('symbol', { autocap: 'characters', placeholder: 'A31' })}</label>
      <label class="field span-2"><span>Mission Name</span>${input('name', { autocap: 'words', placeholder: 'As in WMIRS' })}</label>
      <label class="field"><span>Mission date</span>
        <div class="input-btn">
          ${input('date', { className: 'mono', autocap: 'characters', placeholder: 'DD MMM YY' })}
          <button type="button" class="mini" data-act="${bind ? 'mission-today' : 'nm-today'}">Today</button>
        </div></label>
    </div>`;
}

// Adding a mission: its WMIRS number (required), symbol, name, date and base.
function openNewMissionSheet() {
  openSheet({
    title: 'Add mission',
    sub: 'From WMIRS',
    body: `${missionFieldsHTML({}, false)}
    <p class="sheet-note">Only the mission number is required. The rest can be added later.</p>`,
    footer: `<button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" data-act="nm-save">Add mission</button>`
  });
  const number = $('#nm-number');
  if (number) setTimeout(() => number.focus(), 60);
}

// The picked mission's own details, from Missions or the header.
function openMissionSheet() {
  const mission = activeMission();
  if (!mission) { openNewMissionSheet(); return; }
  openSheet({
    title: 'Mission details',
    sub: 'Shared by every sortie',
    body: `<div id="mission-card">${missionFieldsHTML(mission, true)}</div>
    <p class="sheet-note">${mission.closed
      ? 'This mission is closed. Reopen it to keep adding sorties.'
      : 'Close the mission once it is closed in WMIRS. Its sorties stay on this iPad.'}</p>`,
    footer: `<button type="button" class="btn danger left" data-act="del-mission">Delete mission</button>
      <button type="button" class="btn" data-act="toggle-mission-closed">${mission.closed ? 'Reopen mission' : 'Close mission'}</button>
      <button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => render()
  });
}

function todayMissionDate() {
  const now = new Date();
  return pad2(now.getDate()) + ' ' + MONTHS[now.getMonth()] + ' ' + String(now.getFullYear()).slice(-2);
}

function saveNewMission() {
  const number = $('#nm-number');
  const value = String(number ? number.value : '').trim().toUpperCase();
  if (!value) {
    if (number) { number.classList.add('invalid'); number.focus(); }
    toast('Enter the mission number');
    return;
  }
  const read = id => String(($('#nm-' + id) || {}).value || '').trim();
  const mission = blankMission();
  mission.number = value;
  mission.symbol = read('symbol').toUpperCase();
  mission.name = read('name');
  mission.date = read('date').toUpperCase();
  state.missions.push(mission);
  state.activeMissionId = mission.id;
  state.activeId = '';
  closeSheet();
  activeTab = 'logbook';
  save();
  render();
  window.scrollTo(0, 0);
  toast('Mission ' + value + ' added · now add its first sortie');
}

function sortieCardRowHTML(l, index) {
  const crew = crewInOrder(l).map(m => m.name).filter(Boolean);
  const times = l.times.engineStart.time
    ? fmtZ(l.times.engineStart.time) + (l.times.shutDown.time ? '–' + fmtZ(l.times.shutDown.time) : ' →')
    : 'not flown yet';
  const signed = l.closed ? '<span class="sortie-signed">Closed</span>'
    : l.signoff.signature ? '<span class="sortie-signed">Signed</span>' : '';
  const meta = [l.sortieType, (l.aircraft || 'no tail') + (l.callsign ? ' · ' + l.callsign : ''), times,
    (l.entries.length + l.observations.length) + ' logged', crew.join(', '),
    l.receivedFrom ? 'from ' + l.receivedFrom : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="log-row sortie-row ${l.id === state.activeId ? 'active' : ''}" data-act="switch-log" data-id="${esc(l.id)}">
    <span class="log-name">${esc(sortieLabel(l, index))} ${signed}</span>
    <span class="log-meta">${esc(meta)}</span>
  </button>`;
}

function selectInput(path, value, options, label) {
  const list = value && !options.includes(value) ? options.concat([value]) : options;
  return `<select class="input" data-bind="${esc(path)}" aria-label="${esc(label || '')}">
    <option value="">-- Select --</option>
    ${list.map(option => `<option value="${esc(option)}" ${option === value ? 'selected' : ''}>${esc(option)}</option>`).join('')}
  </select>`;
}

/* Adding a sortie: what WMIRS shows on its Air Sortie Add/Edit page. Crew,
   frequencies and the search area carry over from the mission's last sortie. */
function openAddSortieSheet() {
  const mission = activeMission();
  if (!mission) { openNewMissionSheet(); return; }
  const sorties = missionSorties(mission.id);
  const prev = sorties[sorties.length - 1];
  const input = (id, value, placeholder) =>
    `<input class="input" id="ns-${id}" autocapitalize="characters" placeholder="${esc(placeholder)}" value="${esc(value || '')}">`;
  openSheet({
    title: 'Add sortie',
    sub: missionTitle(mission) + (mission.symbol ? ' / ' + mission.symbol : ''),
    body: `<div class="form-grid">
      <label class="field"><span>Sortie No.</span>${input('number', nextSortieNumber(sorties), 'A0001')}</label>
      <label class="field"><span>Sortie Type</span>
        <select class="input" id="ns-type">
          <option value="">-- Select --</option>
          ${SORTIE_TYPES.map(t => `<option ${prev && prev.sortieType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select></label>
      <label class="field"><span>Tail No.</span>${input('tail', prev && prev.aircraft, 'N123CP')}</label>
      <label class="field"><span>Call Sign</span>${input('callsign', prev && prev.callsign, 'CAP1234')}</label>
      <label class="field"><span>Dep. Airport</span>${input('dep', prev && prev.destAirport, 'KBED')}</label>
      <label class="field"><span>Dest. Airport</span>${input('dest', prev && prev.destAirport, 'KBED')}</label>
    </div>
    <p class="sheet-note">As in WMIRS. ${prev ? 'Crew, frequencies, nav aids and the search area are copied from ' + esc(sortieLabel(prev, sorties.length - 1)) + '.' : 'Crew, frequencies and the search area are set up on Brief.'}</p>`,
    footer: `<button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" data-act="ns-save">Add sortie</button>`
  });
  const number = $('#ns-number');
  if (number && !number.value) setTimeout(() => number.focus(), 60);
}

function saveAddSortie() {
  const mission = activeMission();
  if (!mission) return;
  const read = id => String(($('#ns-' + id) || {}).value || '').trim();
  const sorties = missionSorties(mission.id);
  const prev = sorties[sorties.length - 1];
  const log = blankLog(mission.id);
  if (prev) {
    // the next sortie of this mission: same crew, frequencies and search area;
    // times, Hobbs, entries, observations and results start empty
    ['sectional', 'grid', 'altitude', 'airspeed'].forEach(key => { log[key] = prev[key]; });
    log.crew = deepClone(prev.crew).map(m => Object.assign(m, { id: uid() }));
    log.radio = deepClone(prev.radio);
    log.navAids = deepClone(prev.navAids);
    log.entry = deepClone(prev.entry);
    log.exit = deepClone(prev.exit);
    ['reporter', 'reporterCapid', 'areaName'].forEach(key => { log.sar[key] = prev.sar[key]; });
    log.sar.corners = deepClone(prev.sar.corners);
    log.fpl = prev.fpl ? deepClone(prev.fpl) : null;
    log.signoff.name = prev.signoff.name;
    log.signoff.capid = prev.signoff.capid;
    log.crewContact = prev.crewContact;
    ['basePhone', 'radioChecks', 'separation', 'alternates', 'mtrs', 'hazards', 'areaOfOps'].forEach(key => { log.brief[key] = prev.brief[key]; });
  }
  log.sortie = read('number').toUpperCase();
  log.sortieType = read('type');
  log.aircraft = read('tail').toUpperCase();
  log.callsign = read('callsign').toUpperCase();
  log.depAirport = read('dep').toUpperCase();
  log.destAirport = read('dest').toUpperCase();
  // the same aircraft keeps its type, speed, equipment and the rest
  if (prev && (!log.aircraft || log.aircraft === prev.aircraft)) log.aircraftInfo = deepClone(prev.aircraftInfo);
  state.logs.push(log);
  state.activeId = log.id;
  closeSheet();
  activeTab = 'plan';   // check the copied crew, frequencies and search area
  save();
  render();
  window.scrollTo(0, 0);
  toast(sortieLabel(log, sorties.length) + ' added' + (prev ? ' · crew and search area copied' : ' · set up its crew and search area'));
}

function opsCardHTML(log) {
  const ops = log.ops.map((op, i) => opsRowHTML(log, op, i)).reverse().join('');
  return `<section class="card" id="ops-card">
      <div class="card-head">
        <div class="head-left"><h2>OPS status</h2><span class="count-badge">${log.ops.length}</span></div>
        <button class="btn small primary" data-act="ops-add">+ Record check</button>
      </div>
      <div class="note-strip" style="margin-top:0;margin-bottom:12px">
        Every ${state.settings.opsInterval || 30} minutes${nextOpsDue(log) ? ' · next due ' + fmtZ(nextOpsDue(log)) : ''}. Fuel and altimeter carry forward from the previous check.
      </div>
      <div class="ops-list">
        ${ops || '<div class="empty"><strong>No OPS checks</strong>Tap “Record check” every 30 minutes.</div>'}
      </div>
    </section>`;
}

// One column of the CAPF 104a plan-versus-actual grid: planned on Brief, actual on Debrief.
function sarColumnHTML(log, column) {
  const values = log.sar[column];
  const text = ([key, label, opts]) => field(label, textInput('sar.' + column + '.' + key, values[key], opts));
  const choice = ([key, label, options]) => `<div class="field span-2"><span>${esc(label)}</span>${sarChoice('sar.' + column + '.' + key, values[key], options)}</div>`;
  return `<div class="form-grid">
      ${SAR_TEXT_ROWS.map(text).join('')}
      ${SAR_CHOICE_ROWS.map(choice).join('')}
      ${SAR_RESULT_ROWS.map(text).join('')}
    </div>`;
}

function planView(log) {
  const crew = log.crew;
  const sar = log.sar;
  const navRows = log.navAids.map((nav, i) => `<div class="nav-row">
    <span class="num">${i + 1}</span>
    <input class="input" data-bind="navAids.${i}.ident" value="${esc(nav.ident)}" placeholder="Identifier" autocapitalize="characters" aria-label="Nav aid ${i + 1} identifier">
    <input class="input mono" data-bind="navAids.${i}.freq" value="${esc(nav.freq)}" placeholder="Frequency" inputmode="decimal" aria-label="Nav aid ${i + 1} frequency">
    <input class="input mono radial" data-bind="navAids.${i}.radial" value="${esc(nav.radial)}" placeholder="Radial" inputmode="numeric" aria-label="Nav aid ${i + 1} radial">
    <button type="button" class="row-del" data-act="del-navaid" data-index="${i}" aria-label="Delete nav aid">×</button>
  </div>`).join('');

  const mission = missionOf(log);
  return `<div class="stack">
    <section class="card" id="sortie-card">
      <div class="card-head">
        <div class="head-left"><h2>${esc(sortieLabel(log, missionSorties(log).indexOf(log)))}</h2></div>
        <span class="muted small">${esc([mission.number, mission.symbol].filter(Boolean).join(' / '))}</span>
      </div>
      <div class="form-grid">
        ${field('Sortie No.', textInput('sortie', log.sortie, { autocap: 'characters', placeholder: 'A0001' }))}
        ${field('Sortie Type', selectInput('sortieType', log.sortieType, SORTIE_TYPES, 'Sortie Type'))}
        ${field('Sortie Objective', textInput('brief.objective', log.brief.objective))}
        ${field('Area of Operations', textInput('brief.areaOfOps', log.brief.areaOfOps))}
        ${field('Tail No.', textInput('aircraft', log.aircraft, { autocap: 'characters', placeholder: 'N123CP' }))}
        ${field('Call Sign', textInput('callsign', log.callsign, { autocap: 'characters', placeholder: 'CAP1234' }))}
        ${field('Dep. Airport', textInput('depAirport', log.depAirport, { autocap: 'characters', placeholder: 'KBED' }))}
        ${field('Dest. Airport', textInput('destAirport', log.destAirport, { autocap: 'characters', placeholder: 'KBED' }))}
        ${field('ETD (Z)', textInput('brief.etd', log.brief.etd, { className: 'mono', norm: 'time', inputmode: 'numeric', maxlength: 4, placeholder: 'HHMM' }))}
        ${field('ETE', textInput('brief.ete', log.brief.ete, { className: 'mono', placeholder: '1+30' }))}
        ${field('Tracking No.', textInput('sar.tracking', sar.tracking, { className: 'mono', autocap: 'characters' }))}
      </div>
      <div class="subhead">Crew</div>
      <div class="form-grid">
      </div>
      <div class="crew-list">
        ${crew.map((m, i) => `<div class="crew-item"><div class="crew-row">
          <select class="input" data-bind="crew.${i}.role" data-rerender aria-label="Role">
            ${CREW_ROLES.map(([key, label]) => `<option value="${key}" ${m.role === key ? 'selected' : ''} title="${esc(label)}">${key}</option>`).join('')}
          </select>
          <input class="input" data-bind="crew.${i}.name" value="${esc(m.name)}" placeholder="Name" autocapitalize="characters" aria-label="Name">
          <input class="input mono" data-bind="crew.${i}.capid" value="${esc(m.capid)}" placeholder="CAPID" inputmode="numeric" aria-label="CAPID">
          <button type="button" class="row-del" data-act="del-crew" data-index="${i}" aria-label="Remove crew member">×</button>
        </div>
        ${checkChips('crew.' + i + '.quals', qualsFor(m).map(q => [q, q, QUAL_NAMES[q]]), m.quals, 'Qualifications')}
        </div>`).join('') || '<div class="empty"><strong>No crew yet</strong>Add each crew member with the buttons below.</div>'}
      </div>
      <div class="btn-row" style="margin-top:10px">
        ${CREW_ROLE_KEYS.map(role => `<button type="button" class="btn small" data-act="add-crew" data-role="${role}">+ ${role}</button>`).join('')}
      </div>
      <div class="sketch-hint">Tick the qualifications each seat needs, as on the CAPF 104 manifest.</div>
      <div class="form-grid" style="margin-top:14px">
        ${field('Crew Contact (Phone, Email, etc.)', textInput('crewContact', log.crewContact), 'span-2')}
        ${field('Reporting MO / MP / MS', textInput('sar.reporter', sar.reporter, { placeholder: 'Name' }))}
        ${field('Reporting CAPID', textInput('sar.reporterCapid', sar.reporterCapid, { className: 'mono', inputmode: 'numeric' }))}
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button type="button" class="btn small danger" data-act="del-log">Delete sortie</button>
      </div>
    </section>

    <section class="card" id="brief-card">
      <div class="card-head">
        <div class="head-left"><h2>Brief</h2></div>
        <span class="muted small">From the WMIRS sortie brief</span>
      </div>
      ${textAreaField('Sortie Objectives', 'objectives', log.objectives, 1000)}
      ${textAreaField('Sortie Deliverables', 'deliverables', log.deliverables, 1000)}
      ${textAreaField('Actions To Be Taken on Objectives & Deliverables', 'brief.actions', log.brief.actions, 1000)}
      ${textAreaField('Route Of Flight', 'route', log.route, 1000)}
    </section>

    ${aircraftCardHTML(log)}

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Flight profile</h2></div></div>
      <div class="form-grid">
        ${field('Sectional', textInput('sectional', log.sectional, { placeholder: 'Charlotte' }))}
        ${field('Altitude Assignment', textInput('altitude', log.altitude, { placeholder: '3500' }))}
        ${field('Airspeed Expected', textInput('airspeed', log.airspeed, { placeholder: '110' }))}
      </div>
      ${textAreaField('Altitude Restrictions', 'brief.altitudeRestrictions', log.brief.altitudeRestrictions, 500)}
      ${textAreaField('Airspeed Restrictions', 'brief.airspeedRestrictions', log.brief.airspeedRestrictions, 500)}
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Safety</h2></div><span class="muted small">CAPF 104 briefing</span></div>
      ${BRIEF_SAFETY.map(([key, label, max]) => textAreaField(label, 'brief.' + key, log.brief[key], max)).join('')}
      ${textAreaField('Other Aircraft in Area (Location & Callsign)', 'brief.otherAircraft', log.brief.otherAircraft, 500)}
      ${textAreaField('Ground Teams in Area (Location & Callsign)', 'brief.groundTeams', log.brief.groundTeams, 500)}
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Weather</h2></div><span class="muted small">Current &amp; forecast</span></div>
      <div class="form-grid">
        ${BRIEF_WEATHER.map(([key, label]) => `<label class="field"><span>${esc(label)}</span>
          <textarea class="input obs-text" data-bind="brief.weather.${key}" data-autogrow rows="2">${esc(log.brief.weather[key])}</textarea></label>`).join('')}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Flight plan &amp; risk</h2></div></div>
      <div class="check-grid">
        ${checkRow('brief.fpRequired', 'Flight Plan Required', log.brief.fpRequired)}
        ${checkRow('brief.fpFiled', 'Flight Plan Filed', log.brief.fpFiled)}
        ${checkRow('brief.fpOpened', 'Flight Plan Opened', log.brief.fpOpened)}
        ${checkRow('brief.ormComplete', 'ORM Matrix Complete', log.brief.ormComplete)}
        ${checkRow('brief.riskApproval', 'Risk Assessment Approval', log.brief.riskApproval)}
      </div>
      <div class="field"><span>Risk Assessment</span>${sarChoice('brief.riskLevel', log.brief.riskLevel, RISK_LEVELS)}</div>
      <div style="margin-top:12px">${textAreaField('Special Instructions (Including Risk Mitigation Procedures)', 'brief.specialInstructions', log.brief.specialInstructions, 1000)}</div>
      <div class="sketch-hint">Flight Plan Closed is on Debrief.</div>
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Releasing officers</h2></div></div>
      <div class="form-grid">
        ${field('Briefer', textInput('brief.briefer', log.brief.briefer, { placeholder: 'Name' }))}
        ${field('Briefer CAPID', textInput('brief.brieferCapid', log.brief.brieferCapid, { className: 'mono', inputmode: 'numeric' }))}
        ${field('Flight Release Officer', textInput('brief.fro', log.brief.fro, { placeholder: 'Name' }))}
        ${field('FRO CAPID', textInput('brief.froCapid', log.brief.froCapid, { className: 'mono', inputmode: 'numeric' }))}
      </div>
      ${checkRow('brief.phoneBriefing', 'Phone briefing', log.brief.phoneBriefing)}
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Search area</h2></div>
        <div class="btn-row" style="margin:0">
          ${log.fpl ? '<button class="btn small" data-act="track-map">Show on chart</button>' : ''}
          <button class="btn small" data-act="sar-import-fpl">Import from ForeFlight</button>
        </div>
      </div>
      <div class="note-strip" style="margin-top:0;margin-bottom:12px">
        To fill the corners from a ForeFlight search pattern: in ForeFlight open the flight plan, tap Edit, Send To, Share FPL File and save it to Files, then import that file here.
      </div>
      <div class="form-grid">
        ${field('Name', textInput('sar.areaName', sar.areaName))}
        ${field('Grid', textInput('grid', log.grid, { className: 'mono', autocap: 'characters' }))}
      </div>
      ${SAR_CORNERS.map(([key, label]) => `
        <div class="subhead">${esc(label)} corner</div>
        <div class="form-grid">
          ${coordField('Latitude', 'sar.corners.' + key + '.lat', sar.corners[key].lat, true)}
          ${coordField('Longitude', 'sar.corners.' + key + '.lon', sar.corners[key].lon, false)}
        </div>`).join('')}
      <div class="subhead">Entry point</div>
      <div class="form-grid">
        ${coordField('Latitude', 'entry.lat', log.entry.lat, true)}
        ${coordField('Longitude', 'entry.lon', log.entry.lon, false)}
      </div>
      <div class="gps-row">
        <button type="button" class="mini" data-act="copy-entry">Copy to exit</button>
      </div>
      <div class="subhead">Exit point</div>
      <div class="form-grid">
        ${coordField('Latitude', 'exit.lat', log.exit.lat, true)}
        ${coordField('Longitude', 'exit.lon', log.exit.lon, false)}
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" data-act="sar-clear-corners">Clear corners</button>
      </div>
    </section>

    ${offlineMapsCardHTML(log)}

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Search plan</h2></div>
        <span class="muted small">CAPF 104a · planned</span>
      </div>
      ${sarColumnHTML(log, 'planned')}
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Frequencies</h2></div></div>
      <div class="form-grid">
        <label class="field"><span>Main</span><input class="input mono" data-bind="radio.main" value="${esc(log.radio.main)}" placeholder="e.g. 123.45"></label>
        <label class="field"><span>Guard</span><input class="input mono" data-bind="radio.guard" value="${esc(log.radio.guard)}" placeholder="121.5"></label>
        <label class="field"><span>Air/Ground</span><input class="input mono" data-bind="radio.airGround" value="${esc(log.radio.airGround)}"></label>
        <label class="field"><span>Air/Air</span><input class="input mono" data-bind="radio.airAir" value="${esc(log.radio.airAir)}"></label>
        <label class="field"><span>Base Callsign</span><input class="input" data-bind="radio.baseCallsign" value="${esc(log.radio.baseCallsign)}" autocapitalize="characters"></label>
        <label class="field"><span>Base Freq.</span><input class="input mono" data-bind="radio.baseFreq" value="${esc(log.radio.baseFreq)}"></label>
        <label class="field"><span>ATIS / AWOS</span><input class="input mono" data-bind="radio.atis" value="${esc(log.radio.atis)}"></label>
        <label class="field"><span>CTAF</span><input class="input mono" data-bind="radio.ctaf" value="${esc(log.radio.ctaf)}"></label>
        <label class="field"><span>Unicom</span><input class="input mono" data-bind="radio.unicom" value="${esc(log.radio.unicom)}"></label>
        <label class="field"><span>Other</span><input class="input mono" data-bind="radio.other" value="${esc(log.radio.other)}"></label>
        <label class="field"><span>Base Telephone</span><input class="input mono" data-bind="brief.basePhone" value="${esc(log.brief.basePhone)}" inputmode="tel"></label>
      </div>
      <div style="margin-top:12px">${textAreaField('Required Radio Checks & Contacts', 'brief.radioChecks', log.brief.radioChecks, 500)}</div>
      <div class="subhead">Standard</div>
      <div class="freq-list">
        ${STANDARD_FREQS.map(([label, value]) => `<div class="freq-row"><span class="fl">${esc(label)}</span><span class="fv">${esc(value)}</span></div>`).join('')}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Nav aids</h2></div>
        <button class="btn small" data-act="add-navaid">+ Row</button>
      </div>
      <div class="nav-grid">${navRows}</div>
    </section>
  </div>
  ${fabHTML('start-flight-log', 'Start the flight log', 'fly')}`;
}

/* Debrief, in the order of the WMIRS Air Sortie Debrief: flight plan closed,
   ATD / ATA, Hobbs and tach, fuel and oil, then the narrative and the sortie's
   effectiveness. The CAPF 104a search results follow. */
function aircraftCardHTML(log) {
  const a = log.aircraftInfo;
  return `<section class="card">
      <div class="card-head"><div class="head-left"><h2>Aircraft</h2></div><span class="muted small">${esc(log.aircraft || 'Tail No. above')}</span></div>
      <div class="form-grid">
        ${field('Type', textInput('aircraftInfo.type', a.type, { autocap: 'characters', placeholder: 'C182T' }))}
        ${field('TAS (Knots)', textInput('aircraftInfo.tas', a.tas, { className: 'mono', inputmode: 'numeric' }))}
        ${field('Color / Description', textInput('aircraftInfo.color', a.color))}
        ${field('Fuel (In Hours)', textInput('aircraftInfo.fuelHours', a.fuelHours, { className: 'mono', inputmode: 'decimal' }))}
        ${field('Home Base', textInput('aircraftInfo.homeBase', a.homeBase, { autocap: 'characters', placeholder: 'KBED' }))}
        <div class="field"><span>Owner</span>${sarChoice('aircraftInfo.owner', a.owner, AIRCRAFT_OWNERS)}</div>
      </div>
      <div class="subhead">Aircraft &amp; aircrew equipment</div>
      ${checkChips('aircraftInfo.equipment', AIRCRAFT_EQUIPMENT, a.equipment, 'Aircraft and aircrew equipment')}
      <div class="form-grid" style="margin-top:10px">${field('Other equipment', textInput('aircraftInfo.equipmentOther', a.equipmentOther))}</div>
    </section>`;
}

function debriefView(log) {
  const totals = timeTotals(log);
  const sar = log.sar;
  const d = log.debrief;
  const rating = (label, key) => `
      <div class="sar-rating">
        <div class="sar-label">${esc(label)}</div>
        ${sarChoice('sar.' + key, sar[key], SAR_RATINGS)}
        <span class="sar-score-label">Score</span>
        ${sarChoice('sar.' + key + 'Score', sar[key + 'Score'], SAR_SCORES)}
      </div>`;
  return `<div class="stack">
    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Times</h2></div>
        <span class="muted small">UTC</span>
      </div>
      <label class="check-row"><input type="checkbox" data-bind="debrief.flightPlanClosed" ${d.flightPlanClosed ? 'checked' : ''}> Flight Plan Closed</label>
      ${TIME_DEFS.map(def => timeRowHTML(log, def)).join('')}
      <div class="totals">
        <div class="total"><div class="tl">ATD</div><div class="tv" id="tot-atd">${fmtZ(log.times.engineStart.time) || '—'}</div></div>
        <div class="total"><div class="tl">ATA</div><div class="tv" id="tot-ata">${fmtZ(log.times.shutDown.time) || '—'}</div></div>
        <div class="total"><div class="tl">ATA − ATD</div><div class="tv" id="tot-engine">${fmtDuration(totals.engine)}</div></div>
        <div class="total"><div class="tl">Wheels up → down</div><div class="tv" id="tot-flight">${fmtDuration(totals.flight)}</div></div>
      </div>
      <div class="note-strip">ATD is Engine Start and ATA is Shut Down, for the WMIRS debrief. Correct the times and Hobbs here; editing a time also updates the matching checkpoint on the timeline.</div>
    </section>

    ${tachCardHTML(log)}

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Fuel &amp; oil</h2></div>
        <span class="muted small">For the WMIRS debrief</span>
      </div>
      <div class="form-grid">
        ${field('Fuel Used (Gal)', textInput('debrief.fuelGal', d.fuelGal, { className: 'mono', inputmode: 'decimal' }))}
        ${field('Oil Used (Qt)', textInput('debrief.oilQt', d.oilQt, { className: 'mono', inputmode: 'decimal' }))}
        ${field('Fuel & Oil Cost ($)', textInput('debrief.fuelCost', d.fuelCost, { className: 'mono', inputmode: 'decimal' }))}
        ${field('Receipt #', textInput('debrief.receipt', d.receipt, { className: 'mono', autocap: 'characters' }))}
      </div>
      ${checkRow('debrief.wingPaid', 'Wing Paid', d.wingPaid)}
      <div class="sketch-hint">Upload the receipt itself in WMIRS.</div>
    </section>

    <section class="card" id="sortie-debrief-card">
      <div class="card-head">
        <div class="head-left"><h2>Sortie debrief</h2></div>
        <span class="muted small">As in WMIRS</span>
      </div>
      ${DEBRIEF_TEXT.map(([key, label, max]) => textAreaField(label, 'debrief.' + key, d[key], max)).join('')}
      <div class="field" style="margin-top:14px"><span>Sortie Effectiveness</span>${sarChoice('debrief.effectiveness', d.effectiveness, SORTIE_EFFECTIVENESS)}</div>
      <div class="form-grid" style="margin-top:12px">
        ${field('Reason (if not successful)', selectInput('debrief.reason', d.reason, NOT_SUCCESSFUL_REASONS, 'Reason (if not successful)'))}
        ${field('Reason (Other)', textInput('debrief.reasonOther', d.reasonOther))}
      </div>
      <div class="sketch-hint">WMIRS needs Remarks for anything but Successful.</div>
      <div class="subhead">Attachments &amp; documentation</div>
      ${checkChips('debrief.attachments', DEBRIEF_ATTACHMENTS, d.attachments, 'Attachments and documentation')}
      <div class="form-grid" style="margin-top:10px">${field('Other attachment', textInput('debrief.attachmentsOther', d.attachmentsOther))}</div>
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Debriefing officer</h2></div></div>
      <div class="form-grid">
        ${field('Debriefer', textInput('debrief.debriefer', d.debriefer, { placeholder: 'Name' }))}
        ${field('Debriefer CAPID', textInput('debrief.debrieferCapid', d.debrieferCapid, { className: 'mono', inputmode: 'numeric' }))}
        <label class="field"><span>Time &amp; Date Debriefed</span>
          <div class="gps-row" style="margin:0"><input class="input mono" data-bind="debrief.debriefedAt" value="${esc(d.debriefedAt)}" placeholder="DD MMM YY HHMMZ" style="flex:1">
          <button type="button" class="mini" data-act="debriefed-now">Now</button></div></label>
      </div>
      ${checkRow('debrief.phoneDebrief', 'Phone debriefing', d.phoneDebrief)}
    </section>

    ${trackCardHTML(log)}

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Search results</h2></div>
        <span class="muted small">CAPF 104a · actual</span>
      </div>
      ${sarColumnHTML(log, 'actual')}
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Search effectiveness</h2></div>
        <span class="muted small">CAPF 104a · crew remarks</span>
      </div>
      ${rating('Effectiveness', 'effectiveness')}
      ${rating('Visibility', 'visibility')}
      <label class="field" style="margin-top:14px"><span>Written comments</span>
        <textarea class="input obs-text" data-bind="sar.comments" data-autogrow
          placeholder="Anything bearing on the results: observer tied up on the radio, a scanner unwell in turbulence, areas not covered.">${esc(sar.comments)}</textarea>
      </label>
    </section>
  </div>`;
}

function timeRowHTML(log, def) {
  const value = log.times[def.key] || { time: '', hobbs: '' };
  const path = 'times.' + def.key;
  return `<div class="trow">
    <div class="tlabel">${esc(def.label)}</div>
    <div class="tfield">
      <input class="input time mono" data-bind="${path}.time" data-norm="time" inputmode="numeric" maxlength="4"
        value="${esc(value.time)}" placeholder="HHMM" aria-label="${esc(def.label)} time (UTC)">
      <button type="button" class="mini" data-act="fill-now" data-target="#t-${def.key}">Now</button>
    </div>
    <div class="tfield">
      <input class="input hobbs mono" id="t-${def.key}" data-bind="${path}.hobbs" data-norm="hobbs" inputmode="decimal"
        value="${esc(value.hobbs)}" placeholder="Hobbs" aria-label="${esc(def.label)} Hobbs">
    </div>
  </div>`;
}

function opsRowHTML(log, op, index) {
  return `<div class="ops-row">
    <div class="ops-top">
      <span class="ops-index">Check ${index + 1}</span>
      <span class="muted small mono">${op.time ? esc(fmtZ(op.time)) : ''}</span>
      <span style="flex:1"></span>
      <button type="button" class="toggle ${op.normal ? 'on' : ''}" data-act="toggle-ops" data-id="${esc(op.id)}">
        <span class="tick">✓</span> OPS normal
      </button>
      <button type="button" class="row-del" data-act="del-ops" data-id="${esc(op.id)}" aria-label="Delete OPS check">×</button>
    </div>
    <div class="ops-fields">
      <input class="input mono centered" data-bind="ops.${index}.time" data-norm="time" inputmode="numeric" maxlength="4"
        value="${esc(op.time)}" placeholder="Time" aria-label="OPS time">
      <input class="input mono centered" data-bind="ops.${index}.hobbs" data-norm="hobbs" inputmode="decimal"
        value="${esc(op.hobbs)}" placeholder="Hobbs" aria-label="OPS Hobbs">
      <input class="input" data-bind="ops.${index}.fuel" value="${esc(op.fuel)}" placeholder="Fuel" aria-label="Fuel">
      <input class="input mono centered" data-bind="ops.${index}.altimeter" inputmode="numeric"
        value="${esc(op.altimeter)}" placeholder="Altimeter" aria-label="Altimeter">
    </div>
  </div>`;
}

function obsCardHTML(log, obs, index) {
  const photos = Array.isArray(obs.photos) ? obs.photos : [];
  return `<article class="obs" data-obs-id="${esc(obs.id)}">
    <div class="obs-head">
      <span class="badge">Obs ${index + 1}</span>
      <span class="obs-time mono">${obs.time ? esc(fmtZ(obs.time)) : ''}</span>
      ${photos.length ? `<span class="obs-time">${photos.length} photo${photos.length === 1 ? '' : 's'}</span>` : ''}
      <span class="spacer"></span>
      <button type="button" class="row-del" data-act="del-obs" data-id="${esc(obs.id)}" aria-label="Delete observation">×</button>
    </div>
    <div class="obs-fields">
      <input class="input mono centered" data-bind="observations.${index}.time" data-norm="time" inputmode="numeric" maxlength="4"
        value="${esc(obs.time)}" placeholder="Time" aria-label="Observation time">
      <input class="input mono centered" data-bind="observations.${index}.hobbs" data-norm="hobbs" inputmode="decimal"
        value="${esc(obs.hobbs)}" placeholder="Hobbs" aria-label="Observation Hobbs">
      <input class="input mono" data-bind="observations.${index}.lat" data-coord="lat" data-norm="coord"
        value="${esc(obs.lat)}" placeholder="Latitude N" aria-label="Observation latitude">
      <input class="input mono" data-bind="observations.${index}.lon" data-coord="lon" data-norm="coord"
        value="${esc(obs.lon)}" placeholder="Longitude W" aria-label="Observation longitude">
    </div>
    <div class="gps-row">
      <button type="button" class="mini gps-mini" data-act="gps-obs" data-id="${esc(obs.id)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        Use GPS
      </button>
      <span class="gps-status">${obs.gpsAccuracy ? 'GPS ±' + esc(obs.gpsAccuracy) + ' m · ' + esc(obs.gpsTime || '') : ''}</span>
    </div>
    <textarea class="input obs-text" data-bind="observations.${index}.text" data-autogrow
      placeholder="What did you see? Include altitude, heading, and anything distinctive.">${esc(obs.text)}</textarea>
    <div class="obs-photos">
      ${photos.map((photo, photoIndex) => `<button type="button" class="obs-photo" data-act="view-photo" data-obs="${esc(obs.id)}" data-index="${photoIndex}" aria-label="View observation photo ${photoIndex + 1}">
        <img src="${esc(photo.thumb || photo.data)}" alt="">
      </button>`).join('')}
      ${photos.length < MAX_OBS_PHOTOS ? `<button type="button" class="obs-photo add" data-act="add-photo" data-obs="${esc(obs.id)}">
        ${PHOTO_ICON}
        <span>Photo</span>
      </button>` : ''}
    </div>
  </article>`;
}

function sarChoice(path, value, options) {
  return `<div class="seg wrap" data-choice="${esc(path)}">${options.map(option =>
    `<button type="button" data-act="sar-choice" data-value="${esc(option)}" class="${value === option ? 'active' : ''}">${esc(option)}</button>`
  ).join('')}</div>`;
}

/* ---------- ForeFlight search area import ---------- */

/* iPadOS cannot offer a home-screen web app in another app's share sheet, so a
   ForeFlight plan arrives as the FPL file it shares (Garmin flight plan XML),
   picked from Files. The search area is taken as the box around the plan's
   search-pattern waypoints; the sheet shows which waypoints were used so a
   stray one can be switched off before the corners are filled in. */
let fplImport = null;

function parseFplWaypoints(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('not XML');
  const child = (node, name) => {
    const el = Array.from(node.children).find(c => c.localName === name);
    return el ? el.textContent.trim() : '';
  };
  const points = Array.from(xml.getElementsByTagName('*'))
    .filter(node => node.localName === 'waypoint')
    .map(node => ({
      id: child(node, 'identifier'),
      type: child(node, 'type').toUpperCase(),
      lat: parseFloat(child(node, 'lat')),
      lon: parseFloat(child(node, 'lon'))
    }))
    .filter(pt => Number.isFinite(pt.lat) && Number.isFinite(pt.lon) && Math.abs(pt.lat) <= 90 && Math.abs(pt.lon) <= 180);
  if (!points.length) throw new Error('no waypoints');

  // Prefer waypoints ForeFlight names as search-pattern points, then user
  // waypoints (coordinates), then anything that is not an airport.
  const isSar = pt => /^SAR[-_ ]?\d+/i.test(pt.id);
  const isUser = pt => pt.type.includes('USER');
  const isAirport = pt => pt.type === 'AIRPORT';
  let pick = isSar;
  let rule = 'search-pattern waypoints (SAR-01, SAR-02, …)';
  if (points.filter(isSar).length < 2) {
    pick = isUser;
    rule = 'coordinate waypoints';
    if (points.filter(isUser).length < 2) {
      pick = pt => !isAirport(pt);
      rule = 'all waypoints except airports';
    }
  }
  points.forEach(pt => { pt.on = pick(pt); });
  return { points, rule };
}

function fplCorners(points) {
  const used = points.filter(pt => pt.on);
  if (used.length < 2) return null;
  const lats = used.map(pt => pt.lat);
  const lons = used.map(pt => pt.lon);
  const north = Math.max(...lats);
  const south = Math.min(...lats);
  const east = Math.max(...lons);
  const west = Math.min(...lons);
  if (north === south || east === west) return null;
  return { nw: [north, west], ne: [north, east], sw: [south, west], se: [south, east] };
}

function importForeFlightArea() {
  const input = document.createElement('input');
  input.type = 'file';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('cancel', () => input.remove());
  setTimeout(() => { if (input.isConnected) input.remove(); }, 300000);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const parsed = parseFplWaypoints(decodeTextBytes(new Uint8Array(await file.arrayBuffer())));
      fplImport = { name: file.name, points: parsed.points, rule: parsed.rule };
      fplImportSheet();
    } catch (err) {
      console.warn('FPL import failed', err);
      toast('That file is not a ForeFlight FPL flight plan');
    }
  });
  input.click();
}

function fplImportSheet() {
  if (!fplImport) return;
  const corners = fplCorners(fplImport.points);
  const used = fplImport.points.filter(pt => pt.on).length;
  const rows = fplImport.points.map((pt, index) => `
    <button type="button" class="toggle ${pt.on ? 'on' : ''}" data-act="fpl-toggle" data-index="${index}" style="width:100%;justify-content:flex-start;margin-bottom:6px">
      <span class="tick">✓</span>
      <span class="mono">${esc(pt.id || 'Waypoint ' + (index + 1))}</span>
      <span class="muted small mono" style="margin-left:auto">${esc(fmtCoord(pt.lat, true))} · ${esc(fmtCoord(pt.lon, false))}</span>
    </button>`).join('');
  const preview = corners
    ? SAR_CORNERS.map(([key, label]) => `<div class="freq-row"><span class="fl">${esc(label)}</span><span class="fv">${esc(fmtCoord(corners[key][0], true))} · ${esc(fmtCoord(corners[key][1], false))}</span></div>`).join('')
    : '<div class="empty"><strong>No area yet</strong>Select at least two waypoints that are not in line.</div>';

  openSheet({
    title: 'Search area from ForeFlight',
    sub: fplImport.name,
    body: `
      <div class="sheet-section">
        <h3>Corners</h3>
        <div class="freq-list">${preview}</div>
        <div class="sheet-note">The box around the ${used} selected waypoint${used === 1 ? '' : 's'}. These are the pattern's turn points, so the box is the area flown; it sits inside the assigned grid by any buffer set in ForeFlight.</div>
      </div>
      <div class="sheet-section">
        <h3>Waypoints in the plan</h3>
        <div class="sheet-note" style="margin-bottom:10px">Selected: ${esc(fplImport.rule)}. Tap a waypoint to include or leave it out.</div>
        ${rows}
      </div>`,
    footer: `
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" data-act="fpl-apply" ${corners ? '' : 'disabled'}>Fill corners</button>`,
    onClose: () => { fplImport = null; render(); }
  });
}

/* Close: sign the sortie off, then close it. A closed sortie is done (like a
   completed sortie in WMIRS); it can be reopened. */
function signView(log) {
  const closedAt = log.closedAt ? new Date(log.closedAt) : null;
  return `<div class="stack">
  ${log.closed ? `<section class="card card-current">
    <div class="card-head">
      <div class="head-left"><h2>Sortie closed</h2><span class="sortie-signed">Closed</span></div>
      <button class="btn small" data-act="reopen-sortie">Reopen</button>
    </div>
    <p class="sheet-note" style="margin-top:0">${esc(sortieLabel(log, missionSorties(log).indexOf(log)))} was closed${closedAt ? ' at ' + esc(fmtDateZ(closedAt)) : ''}.</p>
  </section>` : ''}
  <section class="card">
    <div class="card-head">
      <div class="head-left"><h2>Sign-off</h2></div>
      <button class="btn small" data-act="sign-now">Now (UTC)</button>
    </div>
    <div class="form-grid">
      <label class="field"><span>Printed name</span>
        <input class="input" data-bind="signoff.name" value="${esc(log.signoff.name)}" autocomplete="name">
      </label>
      <label class="field"><span>CAPID</span>
        <input class="input mono" data-bind="signoff.capid" value="${esc(log.signoff.capid)}" inputmode="numeric" autocapitalize="characters">
      </label>
      <label class="field span-2"><span>Date time — DDhhmmZ MMM YY</span>
        <input class="input mono" data-bind="signoff.dateTime" value="${esc(log.signoff.dateTime)}" placeholder="${esc(fmtDateZ(new Date()))}">
      </label>
    </div>
    <div class="sig-wrap"><canvas id="signature" width="1000" height="240" aria-label="Signature pad"></canvas></div>
    <div class="btn-row" style="margin-top:9px">
      <button class="btn small" data-act="clear-sign">Clear signature</button>
    </div>
    <div class="sketch-hint">Sign with a finger or Apple Pencil. The signature is stored only on this device and appears on the printed log.</div>
  </section>
  <section class="card">
    <div class="btn-row">
      ${log.closed ? '' : '<button class="btn primary" data-act="close-sortie" style="flex:1">Close sortie</button>'}
      <button class="btn ${log.closed ? 'primary' : ''}" data-act="share-log" style="flex:1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>
        </svg>
        Share signed log (PDF)
      </button>
      <button class="btn" data-act="export-capf104" style="flex:1">CAPF 104 (PDF)</button>
    </div>
    <div class="sketch-hint">Close the sortie once it is signed and debriefed in WMIRS. Share builds the mission log PDF with this sign-off for AirDrop, Mail, Messages or Save to Files. CAPF 104 fills in the CAP's own form from Brief and Debrief; its fields stay editable.</div>
  </section></div>`;
}

// Close the open sortie once it is signed; offer to close the mission when it
// was the last open one.
function closeSortie() {
  const log = activeSortie();
  if (!log) return;
  if (sigCtl) sigCtl.flush();
  if (!log.signoff.signature) { toast('Sign the sortie before closing it'); return; }
  log.closed = true;
  log.closedAt = Date.now();
  if (!log.signoff.dateTime) log.signoff.dateTime = fmtDateZ(new Date());
  save();
  render();
  const mission = missionOf(log);
  const open = missionSorties(log).filter(l => !l.closed).length;
  if (!open && !mission.closed) {
    toast(sortieLabel(log, missionSorties(log).indexOf(log)) + ' closed · all sorties of ' + missionTitle(mission) + ' are closed',
      'Close mission', () => setMissionClosed(mission, true));
  } else {
    toast(sortieLabel(log, missionSorties(log).indexOf(log)) + ' closed');
  }
}

// The page of the sketch pad on screen, per sortie (not saved).
const sketchPageIndex = {};

function currentSketchPage(log) {
  const pages = log.sketches;
  const index = Math.min(Math.max(sketchPageIndex[log.id] || 0, 0), pages.length - 1);
  sketchPageIndex[log.id] = index;
  return { page: pages[index], index, count: pages.length };
}

// Notes: one text box filling the page. It shrinks above the keyboard.
function notesView(log) {
  return `<div class="page-fill">
    <section class="card notes-card">
      <div class="card-head"><div class="head-left"><h2>Notes</h2></div><span class="muted small">Saved as you type</span></div>
      <textarea class="input notes-full" data-bind="notes"
        placeholder="Narrative notes, radio traffic, coordination, anything that does not fit elsewhere.">${esc(log.notes)}</textarea>
    </section>
  </div>`;
}

const SKETCH_TOOL_ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  clear: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  prev: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>'
};
const sketchIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SKETCH_TOOL_ICONS[name]}</svg>`;

/* The sketch pad fills everything between the header and the tab bar: the
   page takes the shape of the screen, and its tools sit in a row of the
   header, because in the app the PencilKit canvas lies over the page and
   would hide anything placed on it. */
const MAP_PENS = [['#d81b60', 'Magenta pen'], ['#17222e', 'Black pen'], ['#0a47c2', 'Blue pen']];

function sketchToolsHTML(log) {
  const { page, index, count } = currentSketchPage(log);
  const bg = page.bg === 'image' ? '' : page.bg;
  const mapPage = isMapSketchPage(page);
  const penTools = mapPage
    ? `<div class="sk-glass sk-pens" role="group" aria-label="Tool">
        <button type="button" class="sk-btn sk-hand${mapSketchTool === 'pan' ? ' on' : ''}" data-act="sketch-pan" aria-label="Move the map" title="Move the map (the Pencil still draws)">${sketchIcon('hand')}</button>
        ${MAP_PENS.map(([c, label]) => `<button type="button" class="swatch${mapSketchTool === 'pen' && mapSketchColor === c ? ' active' : ''}" style="background:${c}" data-act="pen" data-color="${c}" aria-label="${label}" title="${label}"></button>`).join('')}
        <button type="button" class="swatch eraser${mapSketchTool === 'eraser' ? ' active' : ''}" data-act="eraser" aria-label="Eraser" title="Eraser">⌫</button>
      </div>`
    : NATIVE ? '' : `<div class="sk-glass sk-pens" role="group" aria-label="Pen">
        <button type="button" class="swatch active" data-act="pen" data-color="#17222e" aria-label="Black pen" title="Black pen"></button>
        <button type="button" class="swatch red" data-act="pen" data-color="#b3261e" aria-label="Red pen" title="Red pen"></button>
        <button type="button" class="swatch eraser" data-act="eraser" aria-label="Eraser" title="Eraser">⌫</button>
      </div>`;
  return `<div class="sk-row">
      <div class="seg sk-glass sk-bgs" role="group" aria-label="Background">
        ${SKETCH_BACKGROUNDS.map(([key, label]) => `<button type="button" data-act="sketch-bg" data-value="${key}" class="${bg === key ? 'active' : ''}">${label}</button>`).join('')}
      </div>
      ${penTools}
      <div class="sk-glass">
        <button type="button" class="sk-btn" data-act="undo-sketch" aria-label="Undo" title="Undo">${sketchIcon('undo')}</button>
        ${NATIVE && !mapPage ? `<button type="button" class="sk-btn" data-act="redo-sketch" aria-label="Redo" title="Redo">${sketchIcon('redo')}</button>` : ''}
        <button type="button" class="sk-btn" data-act="clear-sketch" aria-label="Clear the drawing" title="Clear the drawing">${sketchIcon('clear')}</button>
      </div>
      <span class="sk-spacer"></span>
      <div class="sk-glass sk-pages">
        <button type="button" class="sk-btn" data-act="sketch-page" data-step="-1" ${index === 0 ? 'disabled' : ''} aria-label="Previous page">${sketchIcon('prev')}</button>
        <span class="sk-page-label">${index + 1} / ${count}</span>
        <button type="button" class="sk-btn" data-act="sketch-page" data-step="1" ${index === count - 1 ? 'disabled' : ''} aria-label="Next page">${sketchIcon('next')}</button>
        <button type="button" class="sk-btn" data-act="sketch-add-page" aria-label="Add a page" title="Add a page">${sketchIcon('add')}</button>
        <button type="button" class="sk-btn" data-act="sketch-del-page" aria-label="Delete this page" title="Delete this page">${sketchIcon('clear')}</button>
      </div>
    </div>`;
}

function renderTopbarTools() {
  const el = $('#topbarTools');
  if (!el) return;
  const log = activeSortie();
  if (activeTab !== 'sketch' || !log) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = sketchToolsHTML(log);
}

function sketchView(log) {
  const { page, index } = currentSketchPage(log);
  const { w, h } = sketchSize(page);
  if (isMapSketchPage(page)) {
    return `<div class="sketch-shell" id="sketch-card">
        <div class="sketch-map${mapSketchTool === 'pan' ? '' : ' drawing'}" id="sketch-map" aria-label="Map page ${index + 1}"></div>
        <div class="sk-mapzoom">
          <button type="button" class="fly-round" data-act="sketch-zoom" data-step="1" aria-label="Zoom in">${flyIcon('plus')}</button>
          <button type="button" class="fly-round" data-act="sketch-zoom" data-step="-1" aria-label="Zoom out">${flyIcon('minus')}</button>
        </div>
      </div>`;
  }
  return `<div class="sketch-shell" id="sketch-card">
      <div class="sketch-stage">
        <div class="canvas-wrap" style="--ar:${w / h}">
          <canvas id="sketch-bg" width="${w}" height="${h}" aria-hidden="true"></canvas>
          <canvas id="sketch" width="${w}" height="${h}" aria-label="Sketch pad, page ${index + 1}"></canvas>
        </div>
      </div>
    </div>`;
}

/* ---------- targeted output updates ---------- */

function updateOutputs() {
  const log = activeLog();
  const totals = timeTotals(log);

  const set = (selector, value) => {
    const el = $(selector);
    if (el) el.textContent = value;
  };
  set('#tot-flight', fmtDuration(totals.flight));
  set('#tot-atd', fmtZ(log.times.engineStart.time) || '—');
  set('#tot-ata', fmtZ(log.times.shutDown.time) || '—');
  set('#tot-engine', fmtDuration(totals.engine));
  set('#tot-tach', totals.tach == null ? '—' : fmtDecimal(totals.tach, 1));
  set('#tot-hobbs', totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1));
  set('#tach-card-total', totals.tach == null ? '—' : fmtDecimal(totals.tach, 1));
  set('#meter-hobbs-total', totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1));

  $$('[data-coord]').forEach(input => updateCoordHelp(input));
  updateToolbarState();
}

function updateCoordHelp(input) {
  const field = input.closest('.field') || input.closest('.obs') || input.parentElement;
  if (!field) return;
  const help = field.querySelector('.coord-help');
  if (!help) return;

  const info = coordHelpText(input.value, input.dataset.coord === 'lat');
  help.textContent = info.text;
  help.classList.toggle('error', info.error);
}

function updateToolbarState() {
  if (!sketchCtl) return;
  const mode = sketchCtl.mode();
  $$('.swatch[data-act="pen"]').forEach(btn => {
    btn.classList.toggle('active', !mode.eraser && btn.dataset.color === mode.color);
  });
  const eraser = $('.swatch[data-act="eraser"]');
  if (eraser) eraser.classList.toggle('active', mode.eraser);
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(el.scrollHeight, 64) + 'px';
}

function autoGrowAll() {
  $$('textarea[data-autogrow]').forEach(autoGrow);
}

/* =========================================================================
   Sketch & signature controllers
   ========================================================================= */

// Paint a page's background: graph paper, plain, or its saved image.
function paintSketchBackground(ctx, page, W, H) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (page.bg === 'grid') {
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 25) {
      ctx.strokeStyle = x % 125 === 0 ? '#c9d9e6' : '#e4edf4';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 25) {
      ctx.strokeStyle = y % 125 === 0 ? '#c9d9e6' : '#e4edf4';
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
    }
    return Promise.resolve();
  }
  if ((CHART_LAYERS[page.bg] || page.bg === 'image') && page.bgImage) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, W, H); resolve(); };
      img.onerror = () => resolve();
      img.src = page.bgImage;
    });
  }
  return Promise.resolve();
}

/* Where to centre a chart page: the search area (zoomed to fit it), else
   the current or last GPS position, else the track. */
function sketchMapView(log, W, H, layer) {
  const maxZoom = layer === 'sectional' ? 12 : 14;
  const plainZoom = layer === 'sectional' ? 11 : 12;
  const corners = SAR_CORNERS.map(([key]) => [parseLat(log.sar.corners[key].lat), parseLon(log.sar.corners[key].lon)])
    .filter(([lat, lon]) => lat != null && lon != null);
  if (corners.length >= 2) {
    const lats = corners.map(c => c[0]);
    const lons = corners.map(c => c[1]);
    const north = Math.max(...lats), south = Math.min(...lats), east = Math.max(...lons), west = Math.min(...lons);
    let zoom = 8;
    for (let z = maxZoom; z >= 8; z--) {
      const a = mercatorPx(north, west, z);
      const b = mercatorPx(south, east, z);
      if (b.x - a.x <= W * 0.72 && b.y - a.y <= H * 0.72) { zoom = z; break; }
    }
    return { lat: (north + south) / 2, lon: (east + west) / 2, zoom, box: { north, south, east, west } };
  }
  const fix = freshFix() || lastGpsFix;
  if (fix) return { lat: fix.lat, lon: fix.lon, zoom: plainZoom };
  const last = log.track[log.track.length - 1];
  if (last) return { lat: last[1], lon: last[2], zoom: plainZoom };
  return null;
}

function mercatorPx(lat, lon, zoom) {
  const n = 256 * Math.pow(2, zoom);
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: (lon + 180) / 360 * n,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n
  };
}

/* A chart (sectional, topographic or terrain) around a point, W×H pixels at
   one tile zoom, with the search area outlined: drawn once and kept as an
   image, so it shows offline. */
async function renderChartImage(view, W, H, layer) {
  const chart = CHART_LAYERS[layer];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8edf1';
  ctx.fillRect(0, 0, W, H);
  const centre = mercatorPx(view.lat, view.lon, view.zoom);
  const x0 = centre.x - W / 2;
  const y0 = centre.y - H / 2;
  const tiles = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W - 1) / 256); tx++) {
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H - 1) / 256); ty++) tiles.push([tx, ty]);
  }
  let drawn = 0;
  if (chart.exportUrl && navigator.onLine !== false) {
    // one picture of the whole page from the image server
    const res = 2 * EARTH_HALF / (256 * Math.pow(2, view.zoom));
    try {
      const img = await loadImage(chartExportUrl(chart, [x0 * res - EARTH_HALF, EARTH_HALF - (y0 + H) * res, (x0 + W) * res - EARTH_HALF, EARTH_HALF - y0 * res], W, H), true);
      ctx.drawImage(img, 0, 0, W, H);
      drawn++;
    } catch (_) { /* no signal: build it from tiles below */ }
  }
  if (!drawn) {
    const n = Math.pow(2, view.zoom);
    const results = await Promise.all(tiles.map(([tx, ty]) => drawChartTile(ctx, layer, view.zoom, ((tx % n) + n) % n, ty,
      Math.round(tx * 256 - x0), Math.round(ty * 256 - y0), 256)));
    drawn = results.filter(Boolean).length;
  }
  if (!drawn) throw new Error('no chart tiles');
  if (view.box) {
    const a = mercatorPx(view.box.north, view.box.west, view.zoom);
    const b = mercatorPx(view.box.south, view.box.east, view.zoom);
    ctx.save();
    ctx.strokeStyle = '#d81b60';
    ctx.lineWidth = 4;
    ctx.setLineDash([16, 10]);
    ctx.strokeRect(a.x - x0, a.y - y0, b.x - a.x, b.y - a.y);
    ctx.restore();
  }
  ctx.font = '600 18px -apple-system, Helvetica, sans-serif';
  const note = chart.source + ' · not for navigation';
  ctx.fillStyle = 'rgba(255, 255, 255, .85)';
  ctx.fillRect(8, H - 34, ctx.measureText(note).width + 16, 26);
  ctx.fillStyle = '#3d4f60';
  ctx.fillText(note, 16, H - 15);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/* ---------- map pages: drawing on a live map ----------
   A Sectional, Topo or Terrain page is the live chart, panned and zoomed like
   Fly's, with the drawing kept as lines on the map itself (latitude and
   longitude), so it moves and scales with the chart and stays where it was
   drawn. The Apple Pencil always draws; a finger moves the map with the hand
   tool, and draws with a pen picked. Two fingers pinch to zoom. The page's
   picture (for the PDF) is the view on screen, redrawn after each change.
   Grid and plain pages stay paper. Ink drawn on a map page before 1.33.0
   keeps that page as a picture. */
let mapSketch = null;            // the open map page: { map, page, layer, strokes }
let mapSketchTool = 'pan';       // pan, pen, eraser (what a finger does)
let mapSketchColor = '#d81b60';

// A map page that is drawn on live: a chart background, and no older picture-ink.
function isMapSketchPage(page) {
  return !!CHART_LAYERS[page.bg] && !page.ink && !page.pk && !page.inkBase;
}

function normalizeStrokes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(s => s && Array.isArray(s.p) && s.p.length).map(s => ({
    c: /^#[0-9a-f]{6}$/i.test(s.c) ? s.c : '#d81b60',
    w: Math.min(30, Math.max(1, Number(s.w) || 4)),
    z: Math.min(18, Math.max(3, Number(s.z) || 12)),
    p: s.p.filter(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))
      .map(q => [Math.round(q[0] * 1e6) / 1e6, Math.round(q[1] * 1e6) / 1e6])
  })).filter(s => s.p.length);
}

// A line's width at a map zoom: drawn at zoom z, it grows and shrinks with the chart.
function strokeWeight(stroke, zoom) {
  return Math.min(60, Math.max(1, stroke.w * Math.pow(2, zoom - stroke.z)));
}

function closeMapSketch() {
  if (!mapSketch) return;
  clearTimeout(mapSketch.snapTimer);
  mapSketch.map.remove();
  mapSketch = null;
}

function setupMapSketch(page) {
  const el = $('#sketch-map');
  if (!el || !window.L) return;
  closeMapSketch();
  if (NATIVE) hideNativeSketch();
  const log = activeLog();
  const { w, h } = sketchSize(page);
  const start = page.map || (() => {
    const view = sketchMapView(log, w, h, page.bg);
    return view ? { lat: view.lat, lon: view.lon, zoom: view.zoom } : { lat: 39.5, lon: -98.35, zoom: 5 };
  })();
  const map = L.map(el, { zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 15, zoomSnap: 1, tap: false })
    .setView([start.lat, start.lon], start.zoom);
  const tiles = chartTileLayer(page.bg).addTo(map);
  // the search area and the ForeFlight plan, for bearings
  const corners = SAR_CORNERS.map(([key]) => [parseLat(log.sar.corners[key].lat), parseLon(log.sar.corners[key].lon)]);
  if (corners.every(([a, b]) => a != null && b != null)) {
    L.polygon(corners, { color: '#e0662b', weight: 2, fillOpacity: 0.06, dashArray: '6 4', interactive: false }).addTo(map);
  }
  if (log.fpl && log.fpl.points.length > 1) {
    L.polyline(log.fpl.points.map(p => [p[0], p[1]]), { color: '#0a47c2', weight: 3, dashArray: '10 6', opacity: 0.8, interactive: false }).addTo(map);
  }
  const renderer = L.canvas({ padding: 0.5 });
  const group = L.layerGroup().addTo(map);
  const ms = mapSketch = { map, page, tiles, group, renderer, lines: [], undo: [], snapTimer: null };
  // an empty map page takes the screen's shape, so its picture matches the view
  const room = el.getBoundingClientRect();
  if (!page.strokes.length && room.width > 100 && room.height > 100) {
    page.w = 1000;
    page.h = Math.min(2400, Math.max(300, Math.round(1000 * room.height / room.width)));
  }

  function draw() {
    group.clearLayers();
    const zoom = map.getZoom();
    ms.lines = page.strokes.map(stroke => L.polyline(stroke.p, {
      color: stroke.c, weight: strokeWeight(stroke, zoom), lineCap: 'round', lineJoin: 'round', renderer, interactive: false
    }).addTo(group));
  }
  draw();
  map.on('zoomend', () => {
    const zoom = map.getZoom();
    ms.lines.forEach((line, i) => line.setStyle({ weight: strokeWeight(page.strokes[i], zoom) }));
  });
  map.on('moveend', () => {
    const c = map.getCenter();
    page.map = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    saveQuiet();
    scheduleSnapshot();
  });

  function useTool(tool) {
    mapSketchTool = tool;
    el.classList.toggle('drawing', tool !== 'pan');
    renderTopbarTools();
  }

  function remember() {
    ms.undo.push(JSON.stringify(page.strokes));
    if (ms.undo.length > 30) ms.undo.shift();
  }
  function changed() {
    save();
    scheduleSnapshot();
  }
  function scheduleSnapshot() {
    clearTimeout(ms.snapTimer);
    ms.snapTimer = setTimeout(() => snapshotMapSketch(ms).catch(() => {}), 1500);
  }

  // Drawing: a pen always; a finger or mouse unless the hand tool is on.
  let penSeen = false;
  let stroke = null;     // { pointerId, data, line } while a line is drawn
  let erasing = null;    // pointerId while erasing
  const latlng = event => {
    const r = el.getBoundingClientRect();
    return map.containerPointToLatLng([event.clientX - r.left, event.clientY - r.top]);
  };
  const eraseAt = event => {
    const r = el.getBoundingClientRect();
    const at = L.point(event.clientX - r.left, event.clientY - r.top);
    const before = page.strokes.length;
    page.strokes = page.strokes.filter(s => !s.p.some(q => map.latLngToContainerPoint(q).distanceTo(at) < 18));
    if (page.strokes.length !== before) draw();
  };
  el.addEventListener('pointerdown', event => {
    if (event.target.closest('.leaflet-control')) return;
    const pen = event.pointerType === 'pen';
    if (pen) penSeen = true;
    const fingerDraws = mapSketchTool !== 'pan' && !(event.pointerType === 'touch' && penSeen);
    if (!pen && !fingerDraws) return;            // the map pans and zooms
    if (stroke || erasing != null) return;      // one line at a time
    event.preventDefault();
    event.stopPropagation();
    map.dragging.disable();
    try { el.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    remember();
    const tool = pen && mapSketchTool === 'pan' ? 'pen' : mapSketchTool;
    if (tool === 'eraser') {
      erasing = event.pointerId;
      eraseAt(event);
      return;
    }
    const at = latlng(event);
    const data = { c: mapSketchColor, w: pen && event.pressure > 0 ? 2 + event.pressure * 5 : 4, z: map.getZoom(), p: [[at.lat, at.lng]] };
    const line = L.polyline([at], { color: data.c, weight: data.w, lineCap: 'round', lineJoin: 'round', renderer, interactive: false }).addTo(group);
    stroke = { pointerId: event.pointerId, data, line };
  }, true);
  el.addEventListener('pointermove', event => {
    if (erasing === event.pointerId) { event.stopPropagation(); eraseAt(event); return; }
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [];
    (samples.length ? samples : [event]).forEach(sample => {
      const at = latlng(sample);
      stroke.data.p.push([at.lat, at.lng]);
      stroke.line.addLatLng(at);
    });
  }, true);
  const end = event => {
    if (erasing === event.pointerId) {
      erasing = null;
      map.dragging.enable();
      changed();
      return;
    }
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    event.stopPropagation();
    const done = stroke.data;
    stroke = null;
    map.dragging.enable();
    page.strokes.push(normalizeStrokes([done])[0]);
    draw();
    changed();
  };
  el.addEventListener('pointerup', end, true);
  el.addEventListener('pointercancel', end, true);

  sketchCtl = {
    map: true,
    mode() { return { color: mapSketchColor, eraser: mapSketchTool === 'eraser' }; },
    setColor(c) { mapSketchColor = c; useTool('pen'); },
    setEraser() { useTool('eraser'); },
    setPan() { useTool('pan'); },
    undo() {
      if (!ms.undo.length) return;
      page.strokes = JSON.parse(ms.undo.pop());
      draw();
      changed();
    },
    redo() {},
    clear() {
      remember();
      page.strokes = [];
      draw();
      changed();
    },
    flush() {
      if (ms.snapTimer) { clearTimeout(ms.snapTimer); snapshotMapSketch(ms).catch(() => {}); }
    },
    zoom(step) { if (step > 0) map.zoomIn(); else map.zoomOut(); }
  };
  setTimeout(() => map.invalidateSize(), 60);
  if (!page.image) scheduleSnapshot();
}

// The page's picture for the PDF: exactly the view on screen (the chart at the
// map's zoom, the search area and the lines), scaled to the page.
async function snapshotMapSketch(ms) {
  const { map, page } = ms;
  ms.snapTimer = null;
  const { w: W, h: H } = sketchSize(page);
  const size = map.getSize();
  const sw = Math.round(size.x);
  const sh = Math.round(size.y);
  const c = map.getCenter();
  const zoom = map.getZoom();
  const log = activeLog();
  const corners = SAR_CORNERS.map(([key]) => [parseLat(log.sar.corners[key].lat), parseLon(log.sar.corners[key].lon)])
    .filter(([a, b]) => a != null && b != null);
  const box = corners.length >= 2 ? {
    north: Math.max(...corners.map(q => q[0])), south: Math.min(...corners.map(q => q[0])),
    east: Math.max(...corners.map(q => q[1])), west: Math.min(...corners.map(q => q[1]))
  } : null;
  const view = { lat: c.lat, lon: c.lng, zoom, box };
  const img = await loadImg(await renderChartImage(view, sw, sh, page.bg));
  if (!img) return;
  const screen = document.createElement('canvas');
  screen.width = sw;
  screen.height = sh;
  const ctx = screen.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  page.strokes.forEach(stroke => {
    const pts = stroke.p.map(q => map.latLngToContainerPoint(q));
    ctx.strokeStyle = stroke.c;
    ctx.lineWidth = strokeWeight(stroke, zoom);
    ctx.beginPath();
    pts.forEach((pt, i) => { if (i) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y); });
    if (pts.length === 1) ctx.lineTo(pts[0].x + 0.1, pts[0].y);
    ctx.stroke();
  });
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d');
  octx.fillStyle = '#e8edf1';
  octx.fillRect(0, 0, W, H);
  // the screen's view, filling the page (the page has the screen's shape)
  const scale = Math.max(W / sw, H / sh);
  octx.drawImage(screen, (W - sw * scale) / 2, (H - sh * scale) / 2, sw * scale, sh * scale);
  page.image = out.toDataURL('image/jpeg', 0.85);
  page.map = { lat: c.lat, lon: c.lng, zoom };
  save();
}

/* ---------- the sketch pad in the iPad app: PencilKit ----------
   The app puts Apple's PencilKit canvas over the page: the tool palette (pens,
   marker, pencil, eraser, lasso, ruler, colours), pressure and tilt, palm
   rejection, pinch to zoom, undo and redo. The page's background is drawn here
   and handed to it to sit under the strokes. Each change comes back as the
   PencilKit drawing (to edit again) and as a transparent PNG of the ink, which
   goes into the page's ink and printable image as before. Ink drawn before
   1.31.0 has no PencilKit drawing: it stays, as part of the background
   (`inkBase`), and new strokes go over it. */
let nativeSketchOn = false;

function sketchRect() {
  const wrap = $('.sketch-stage .canvas-wrap');
  if (!wrap) return null;
  const r = wrap.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function loadImg(src) {
  return new Promise(resolve => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// A page's background (and any older ink) as one JPEG, for under the strokes.
async function sketchUnderlay(page, W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  await paintSketchBackground(ctx, page, W, H);
  const base = await loadImg(page.inkBase);
  if (base) ctx.drawImage(base, 0, 0, W, H);
  return c.toDataURL('image/jpeg', 0.9);
}

// A change from PencilKit: the page's ink is the older ink with the new strokes over it.
async function applyNativeSketch(data) {
  const page = state.logs.flatMap(l => l.sketches).find(p => p.id === data.pageId);
  if (!page) return;
  const { w: W, h: H } = sketchSize(page);
  page.pk = data.drawing || '';
  const base = await loadImg(page.inkBase);
  const ink = await loadImg(data.ink);
  if (!base && !ink) {
    page.ink = '';
  } else {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    if (base) ctx.drawImage(base, 0, 0, W, H);
    if (ink) ctx.drawImage(ink, 0, 0, W, H);
    page.ink = c.toDataURL('image/png');
  }
  // the printable page: background and ink
  const flat = document.createElement('canvas');
  flat.width = W;
  flat.height = H;
  const fctx = flat.getContext('2d');
  await paintSketchBackground(fctx, page, W, H);
  const all = await loadImg(page.ink);
  if (all) fctx.drawImage(all, 0, 0, W, H);
  page.image = page.ink || CHART_LAYERS[page.bg] || page.bg === 'image' ? flat.toDataURL('image/jpeg', 0.82) : '';
  save();
}

if (NATIVE) {
  Native.MissionLog.addListener('sketchChanged', data => { applyNativeSketch(data).catch(err => console.warn('sketch', err)); });
}

function hideNativeSketch() {
  if (!nativeSketchOn) return;
  nativeSketchOn = false;
  Native.MissionLog.sketchHide().catch(() => {});
}

// Sheets and menus are web content: the canvas steps aside while one is open.
function nativeSketchVisible(visible) {
  if (nativeSketchOn) Native.MissionLog.sketchVisible({ visible }).catch(() => {});
}

function setupNativeSketch(page, W, H) {
  // ink from before PencilKit becomes the base the new strokes go over
  if (!page.pk && page.ink && !page.inkBase) {
    page.inkBase = page.ink;
    save();
  }
  const show = async () => {
    const rect = sketchRect();
    if (!rect || activeTab !== 'sketch') return;
    const background = await sketchUnderlay(page, W, H);
    if (activeTab !== 'sketch' || currentSketchPage(activeLog()).page !== page) return;
    nativeSketchOn = true;
    await Native.MissionLog.sketchShow(Object.assign({ pageId: page.id, drawing: page.pk || '', background, pageWidth: W, pageHeight: H }, sketchRect()));
    if ($('#overlay').classList.contains('show')) nativeSketchVisible(false);
  };
  show().catch(err => console.warn('sketch', err));
  // follow the page on screen: rotation, the header changing height
  const wrap = $('.sketch-stage .canvas-wrap');
  if (wrap && window.ResizeObserver) {
    new ResizeObserver(() => {
      const rect = sketchRect();
      if (rect && nativeSketchOn && activeTab === 'sketch') Native.MissionLog.sketchFrame(rect).catch(() => {});
    }).observe(wrap);
  }
  sketchCtl = {
    native: true,
    mode() { return { color: '', eraser: false }; },
    setColor() {},
    setEraser() {},
    undo() { Native.MissionLog.sketchUndo().catch(() => {}); },
    redo() { Native.MissionLog.sketchRedo().catch(() => {}); },
    async clear() {
      page.inkBase = '';
      page.pk = '';
      page.ink = '';
      page.image = CHART_LAYERS[page.bg] || page.bg === 'image' ? page.image : '';
      save();
      await Native.MissionLog.sketchClear().catch(() => {});
      Native.MissionLog.sketchBackground({ background: await sketchUnderlay(page, W, H) }).catch(() => {});
    },
    flush() {}
  };
  updateToolbarState();
}

/* The sketch pad (its own tab): two stacked canvases, the page's background under
   and its ink on top. A finger or Apple Pencil draws; the eraser removes ink
   only; Undo steps back through the last strokes on this page. */
function setupSketch() {
  if ($('#sketch-map')) {
    setupMapSketch(currentSketchPage(activeLog()).page);
    return;
  }
  closeMapSketch();
  if (mapSketchTool !== 'pan' && !$('#sketch')) mapSketchTool = 'pan';   // back to moving next time
  const canvas = $('#sketch');
  const bgCanvas = $('#sketch-bg');
  if (!canvas || !bgCanvas) { sketchCtl = null; if (NATIVE) hideNativeSketch(); return; }
  const ctx = canvas.getContext('2d');
  const bctx = bgCanvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const log = activeLog();
  const { page } = currentSketchPage(log);
  const stage = $('.sketch-stage');
  const room = stage && stage.getBoundingClientRect();
  if (room && room.width > 100 && room.height > 100 && sketchPageBlank(page)) {
    const fitH = Math.min(2400, Math.max(300, Math.round(1000 * room.height / room.width)));
    if (Math.abs(fitH - sketchSize(page).h) > 4) {
      page.w = 1000;
      page.h = fitH;
      page.image = '';
      save();
      render();
      return;
    }
  }
  if (NATIVE) {
    // PencilKit draws; the web canvases only show the page until it is up
    paintSketchBackground(bctx, page, W, H);
    setupNativeSketch(page, W, H);
    return;
  }

  let color = (sketchCtl && sketchCtl.mode().color) || '#17222e';
  let eraser = !!(sketchCtl && sketchCtl.mode().eraser);
  let drawing = false;   // the pointer drawing the line, or false
  let dirty = false;
  let last = null;
  let saveSketchTimer = null;
  const undoStack = [];

  function inkData() {
    return dirty || page.ink ? canvas.toDataURL('image/png') : '';
  }

  // the background and the ink as one JPEG, for the PDF and printout
  function flatten() {
    const flat = document.createElement('canvas');
    flat.width = W;
    flat.height = H;
    const fctx = flat.getContext('2d');
    fctx.drawImage(bgCanvas, 0, 0);
    fctx.drawImage(canvas, 0, 0);
    return flat.toDataURL('image/jpeg', 0.82);
  }

  function loadInk(data) {
    ctx.clearRect(0, 0, W, H);
    if (!data) return;
    const img = new Image();
    img.onload = () => { ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); };
    img.src = data;
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (W / rect.width),
      y: (event.clientY - rect.top) * (H / rect.height),
      // a pen's pressure thickens the line; a finger or mouse draws at the middle weight
      w: eraser ? 36 : event.pointerType === 'pen' && event.pressure > 0 ? 1.6 + event.pressure * 6.4 : 5
    };
  }

  // once a pen has drawn, a resting palm (touch) is ignored
  let penSeen = false;
  let lastMid = null;

  function strokeStyle() {
    ctx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = eraser ? '#000' : color;
    ctx.lineWidth = eraser ? 36 : 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function persist() {
    if (!dirty) return;
    try {
      page.ink = canvas.toDataURL('image/png');
      page.image = flatten();
      save();
    } catch (err) {
      console.warn('sketch save failed', err);
    }
  }

  function scheduleSave() {
    clearTimeout(saveSketchTimer);
    saveSketchTimer = setTimeout(persist, 500);
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button != null && event.button !== 0) return;
    if (event.pointerType === 'pen') penSeen = true;
    else if (event.pointerType === 'touch' && penSeen) return;
    if (drawing !== false) return;   // a second finger does not start another line
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    try {
      undoStack.push(inkData());
      if (undoStack.length > 12) undoStack.shift();
    } catch (_) { /* ignore */ }
    dirty = true;
    drawing = event.pointerId;
    last = pointFrom(event);
    lastMid = last;
    strokeStyle();
    ctx.lineWidth = last.w;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(last.x + 0.01, last.y + 0.01);
    ctx.stroke();
  });
  canvas.addEventListener('pointermove', event => {
    if (drawing === false || event.pointerId !== drawing) return;
    event.preventDefault();
    // every point the screen sampled, joined by curves through the midpoints
    const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [];
    (samples.length ? samples : [event]).forEach(sample => {
      const p = pointFrom(sample);
      const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
      ctx.lineWidth = (last.w + p.w) / 2;
      ctx.beginPath();
      ctx.moveTo(lastMid.x, lastMid.y);
      ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
      ctx.stroke();
      lastMid = mid;
      last = p;
    });
  });
  const up = event => {
    if (drawing === false || event.pointerId !== drawing) return;
    if (last && lastMid) {
      ctx.beginPath();
      ctx.moveTo(lastMid.x, lastMid.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    drawing = false;
    last = null;
    lastMid = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    scheduleSave();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  loadInk(page.ink);
  paintSketchBackground(bctx, page, W, H).then(() => {
    // a background that just changed: refresh the page's printable image
    if (page.reflatten) {
      delete page.reflatten;
      setTimeout(() => {
        try { page.image = flatten(); save(); } catch (_) { /* ignore */ }
      }, 120);
    }
  });

  sketchCtl = {
    redo() {},
    mode() { return { color, eraser }; },
    setColor(next) { color = next; eraser = false; updateToolbarState(); },
    setEraser() { eraser = true; updateToolbarState(); },
    undo() {
      if (!undoStack.length) return;
      clearTimeout(saveSketchTimer);
      const data = undoStack.pop();
      loadInk(data);
      dirty = true;
      setTimeout(() => {
        page.ink = data;
        page.image = data || CHART_LAYERS[page.bg] || page.bg === 'image' ? flatten() : '';
        save();
      }, 60);
    },
    clear() {
      clearTimeout(saveSketchTimer);
      ctx.clearRect(0, 0, W, H);
      undoStack.length = 0;
      dirty = false;
      page.ink = '';
      page.image = CHART_LAYERS[page.bg] || page.bg === 'image' ? flatten() : '';
      save();
    },
    flush() {
      clearTimeout(saveSketchTimer);
      persist();
    }
  };
  updateToolbarState();
}

/* A page is paper (grid, plain) or a map (sectional, topographic, terrain).
   An empty page changes kind; one already drawn on keeps it, and the other
   kind starts a new page. Between maps, a map page just changes chart. */
function setSketchBackground(bg) {
  const log = activeSortie();
  if (!log) return;
  if (sketchCtl) sketchCtl.flush();
  const { page } = currentSketchPage(log);
  const toMap = !!CHART_LAYERS[bg];
  const isMap = isMapSketchPage(page);
  if (page.bg === bg) return;
  const drawn = isMap ? page.strokes.length > 0 : !sketchPageBlank(page) || page.bg === 'image';
  if (toMap && isMap) {
    page.bg = bg;
    page.image = '';
  } else if (drawn) {
    const fresh = blankSketchPage(bg);
    if (toMap && isMap === false && page.map) fresh.map = page.map;
    log.sketches.push(fresh);
    sketchPageIndex[log.id] = log.sketches.length - 1;
    toast('Started page ' + log.sketches.length + ' with the ' + (toMap ? CHART_LAYERS[bg].label.toLowerCase() + ' map' : bg === 'plain' ? 'plain paper' : 'grid') + ' · this page kept its drawing');
  } else {
    page.bg = bg;
    page.bgImage = '';
    page.image = '';
    page.strokes = [];
    if (!toMap) page.map = null;
  }
  save();
  if (activeTab === 'sketch') render();
}

function setupSignature() {
  const canvas = $('#signature');
  if (!canvas) { sigCtl = null; return; }
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const log = activeLog();
  let drawing = false;
  let dirty = false;
  let last = null;
  let saveTimerSig = null;

  function paintBase() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#c7d2dc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(40, H - 30);
    ctx.lineTo(W - 40, H - 30);
    ctx.stroke();
  }

  function loadImage(data) {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
    };
    img.src = data;
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (W / rect.width),
      y: (event.clientY - rect.top) * (H / rect.height)
    };
  }

  function persist() {
    if (!dirty) return;
    try {
      log.signoff.signature = canvas.toDataURL('image/jpeg', 0.85);
      if (!log.signoff.dateTime) {
        log.signoff.dateTime = fmtDateZ(new Date());
        const input = $('[data-bind="signoff.dateTime"]');
        if (input) input.value = log.signoff.dateTime;
      }
      save();
    } catch (err) {
      console.warn('signature save failed', err);
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimerSig);
    saveTimerSig = setTimeout(persist, 450);
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    dirty = true;
    drawing = true;
    last = pointFrom(event);
    ctx.strokeStyle = '#17222e';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(last.x + 0.01, last.y + 0.01);
    ctx.stroke();
  });

  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    event.preventDefault();
    const p = pointFrom(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  });

  function endStroke(event) {
    if (!drawing) return;
    drawing = false;
    last = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    scheduleSave();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  if (log.signoff.signature) loadImage(log.signoff.signature);
  else paintBase();

  sigCtl = {
    clear() {
      paintBase();
      log.signoff.signature = '';
      dirty = false;
      clearTimeout(saveTimerSig);
      save();
    },
    flush() {
      clearTimeout(saveTimerSig);
      persist();
    }
  };
}

/* =========================================================================
   Sheets
   ========================================================================= */

// True while a sheet that must be answered (the terms) is showing.
let sheetLocked = false;

function openSheet(options) {
  const overlay = $('#overlay');
  if (!overlay) return;
  sheetLocked = !!options.locked;
  sheetOnClose = options.onClose || null;
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(options.title)}">
    <div class="sheet-head">
      <div>
        <h2>${options.title}</h2>
        ${options.sub ? '<div class="sheet-sub">' + esc(options.sub) + '</div>' : ''}
      </div>
      ${options.locked ? '' : `<button type="button" class="icon-btn" data-close aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>`}
    </div>
    <div class="sheet-body">${options.body || ''}</div>
    ${options.footer ? '<div class="sheet-foot">' + options.footer + '</div>' : ''}
  </div>`;
  overlay.classList.add('show');
  document.documentElement.classList.add('sheet-open');
  if (NATIVE) nativeSketchVisible(false);
}

function closeSheet() {
  const overlay = $('#overlay');
  if (!overlay || sheetLocked) return;
  overlay.classList.remove('show');
  overlay.innerHTML = '';
  document.documentElement.classList.remove('sheet-open');
  if (NATIVE && activeTab === 'sketch') nativeSketchVisible(true);
  const callback = sheetOnClose;
  sheetOnClose = null;
  if (typeof callback === 'function') callback();
}

/* =========================================================================
   Disclaimer & terms
   ========================================================================= */

// Issues, comments and ideas go to this form.
const FEEDBACK_URL = 'https://forms.gle/EBEkXN8LNWNPL8VG7';

// Raise this when the text below changes in substance: everyone is asked again.
const TERMS_VERSION = 1;

function termsNeeded() {
  return state.settings.termsAccepted !== TERMS_VERSION;
}

function termsHTML() {
  return `<div class="terms">
    <h3>Disclaimer</h3>
    <p><strong>Not an official Civil Air Patrol product.</strong> Mission Log is a personal tool made by a
      CAP member. It is not affiliated with, endorsed by, or supported by Civil Air Patrol, Inc. or the
      United States Air Force.</p>
    <p><strong>Not for navigation.</strong> This app is not a certified electronic flight bag and must not
      be used as a source of navigation, position, time, fuel or aircraft performance information. GPS
      positions, times, totals and imported search-area coordinates may be wrong, out of date or missing.
      Check everything against the aircraft's instruments and official sources.</p>
    <p><strong>Fly the aircraft first.</strong> Using this app must never distract from crew duties or
      from the safe conduct of the flight. The pilot in command and the crew remain solely responsible
      for the safety of the flight and for every decision made during it.</p>
    <p><strong>Not a replacement for required records.</strong> The log and the PDF it produces do not
      replace any form, system or report that Civil Air Patrol or your wing requires. You are responsible
      for checking that what you submit is complete and correct.</p>

    <h3>Terms of use</h3>
    <p><strong>1. No warranty.</strong> The app is provided “as is” and “as available”, without warranty of
      any kind, express or implied, including fitness for a particular purpose, accuracy and
      uninterrupted or error-free operation.</p>
    <p><strong>2. Limitation of liability.</strong> To the fullest extent the law allows, the developer is
      not liable for any loss, damage, injury or claim arising from the use of, or the inability to use,
      this app, including lost or incorrect data and decisions made in reliance on it. You use it at your
      own risk.</p>
    <p><strong>3. Your data.</strong> Everything you enter is stored only on this device. Nothing is sent to
      a server. Data can be lost if the app is removed, its website data is cleared, or the device
      fails. Keeping backups is your responsibility.</p>
    <p><strong>4. Mission information.</strong> You are responsible for handling mission information,
      photos and exported files in line with Civil Air Patrol regulations and any restrictions on the
      mission.</p>
    <p><strong>5. Third parties.</strong> Civil Air Patrol names and emblems are the property of Civil Air
      Patrol, Inc. ForeFlight is a trademark of its owner. The ForeFlight import feature is not
      affiliated with or endorsed by ForeFlight.</p>
    <p><strong>6. Changes.</strong> These terms may change as the app changes. When they do, you will be
      asked to accept them again before continuing.</p>
    <p>If you do not accept these terms, do not use the app.</p>
  </div>`;
}

// gate = true: shown at launch, cannot be dismissed without accepting.
function termsSheet(gate) {
  const acceptedAt = state.settings.termsAcceptedAt;
  openSheet({
    title: 'Disclaimer &amp; terms',
    sub: gate ? 'Please read and accept to continue' : '',
    locked: !!gate,
    body: termsHTML() + (!gate && acceptedAt
      ? `<p class="sheet-note">Accepted on this device on ${esc(new Date(acceptedAt).toLocaleDateString())}.</p>`
      : ''),
    footer: gate
      ? `<button type="button" class="btn primary" data-act="accept-terms">I have read and accept</button>`
      : `<button type="button" class="btn primary" data-close>Done</button>`
  });
}

function acceptTerms() {
  state.settings.termsAccepted = TERMS_VERSION;
  state.settings.termsAcceptedAt = Date.now();
  save();
  sheetLocked = false;
  closeSheet();
}

function field(label, inner, className) {
  return `<label class="field ${className || ''}"><span>${esc(label)}</span>${inner}</label>`;
}

// A long text box with WMIRS's character limit for it, counted as you type.
function textAreaField(label, path, value, max, placeholder) {
  const length = String(value || '').length;
  return `<label class="field text-field"><span>${esc(label)}<small class="char-count${length >= max ? ' full' : ''}">${length}/${max}</small></span>
    <textarea class="input obs-text" data-bind="${esc(path)}" data-autogrow maxlength="${max}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}>${esc(value || '')}</textarea></label>`;
}

// A row of checkboxes drawn as chips, each bound to prefix.key (true/false).
function checkChips(prefix, items, values, label) {
  return `<div class="chip-checks" role="group"${label ? ` aria-label="${esc(label)}"` : ''}>${items.map(([key, text, title]) =>
    `<label class="chip-check"${title ? ` title="${esc(title)}"` : ''}><input type="checkbox" data-bind="${esc(prefix + '.' + key)}" ${values && values[key] ? 'checked' : ''}><span>${esc(text)}</span></label>`
  ).join('')}</div>`;
}

function checkRow(path, label, on) {
  return `<label class="check-row"><input type="checkbox" data-bind="${esc(path)}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;
}

function updateCharCount(el) {
  const count = el.closest('.text-field') && el.closest('.text-field').querySelector('.char-count');
  if (!count || !(el.maxLength > 0)) return;
  count.textContent = el.value.length + '/' + el.maxLength;
  count.classList.toggle('full', el.value.length >= el.maxLength);
}

function textInput(path, value, options) {
  const opts = options || {};
  return `<input class="input ${opts.className || ''}" data-bind="${esc(path)}"
    ${opts.norm ? 'data-norm="' + esc(opts.norm) + '"' : ''}
    ${opts.inputmode ? 'inputmode="' + esc(opts.inputmode) + '"' : ''}
    ${opts.maxlength ? 'maxlength="' + opts.maxlength + '"' : ''}
    ${opts.autocap ? 'autocapitalize="' + esc(opts.autocap) + '"' : ''}
    ${opts.placeholder ? 'placeholder="' + esc(opts.placeholder) + '"' : ''}
    value="${esc(value)}">`;
}

function coordField(label, path, value, isLat) {
  return `<label class="field"><span>${esc(label)}</span>
    <input class="input mono" data-bind="${esc(path)}" data-coord="${isLat ? 'lat' : 'lon'}"
      data-norm="coord" inputmode="decimal" value="${esc(value)}"
      placeholder="${isLat ? 'N 35 30.00' : 'W 80 15.00'}">
    <div class="coord-help"></div>
  </label>`;
}

function sheetCoordField(label, id, value, isLat) {
  return `<label class="field"><span>${esc(label)}</span>
    <input class="input mono" id="${esc(id)}" data-coord="${isLat ? 'lat' : 'lon'}"
      inputmode="decimal" value="${esc(value)}"
      placeholder="${isLat ? 'N 35 30.00' : 'W 80 15.00'}">
    <div class="coord-help"></div>
  </label>`;
}

function safeImage(source) {
  return typeof source === 'string' && /^data:image\/(png|jpe?g|webp);base64,/i.test(source)
    ? source
    : '';
}

/* ---------- observation photos ---------- */

const MAX_OBS_PHOTOS = 6;
const PHOTO_MAX_EDGE = 1600;
const PHOTO_QUALITY = 0.74;

const PHOTO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l1.4-2h7.2L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="4"/></svg>';

function loadPhotoBitmap(file) {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null)
      .then(bitmap => {
        if (bitmap) return bitmap;
        return loadPhotoElement(file);
      });
  }
  return loadPhotoElement(file);
}

function loadPhotoElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

async function fileToPhoto(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    throw new Error('Not an image');
  }
  const bitmap = await loadPhotoBitmap(file);
  const width = bitmap.width || bitmap.naturalWidth || 0;
  const height = bitmap.height || bitmap.naturalHeight || 0;
  if (!width || !height) throw new Error('Empty image');

  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(bitmap, 0, 0, outW, outH);
  if (typeof bitmap.close === 'function') bitmap.close();

  const thumbScale = Math.min(1, 260 / Math.max(outW, outH));
  const thumbW = Math.max(1, Math.round(outW * thumbScale));
  const thumbH = Math.max(1, Math.round(outH * thumbScale));
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbW;
  thumbCanvas.height = thumbH;
  const thumbCtx = thumbCanvas.getContext('2d');
  thumbCtx.fillStyle = '#ffffff';
  thumbCtx.fillRect(0, 0, thumbW, thumbH);
  thumbCtx.drawImage(canvas, 0, 0, thumbW, thumbH);

  return {
    id: uid(),
    data: canvas.toDataURL('image/jpeg', PHOTO_QUALITY),
    thumb: thumbCanvas.toDataURL('image/jpeg', 0.68),
    w: outW,
    h: outH,
    addedAt: Date.now()
  };
}

function addObservationPhoto(obsId) {
  const log = activeLog();
  const obs = log.observations.find(o => o.id === obsId);
  if (!obs) return;
  if (!Array.isArray(obs.photos)) obs.photos = [];
  if (obs.photos.length >= MAX_OBS_PHOTOS) {
    toast('Up to ' + MAX_OBS_PHOTOS + ' photos per observation');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('cancel', () => input.remove());
  setTimeout(() => { if (input.isConnected) input.remove(); }, 300000);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;

    toast('Adding photo…');
    try {
      const photo = await fileToPhoto(file);
      obs.photos.push(photo);
      save();
      if (activeTab === 'fly') render();
      toast('Photo added');
    } catch (err) {
      console.warn('photo import failed', err);
      toast('Could not add that photo');
    }
  });

  input.click();
}

function viewObservationPhoto(obsId, index) {
  const log = activeLog();
  const obs = log.observations.find(o => o.id === obsId);
  if (!obs || !obs.photos || !obs.photos[index]) return;
  const photo = obs.photos[index];
  const obsIndex = log.observations.indexOf(obs);
  const source = safeImage(photo.data);
  if (!source) return;

  openSheet({
    title: 'Observation photo',
    sub: 'Obs ' + (obsIndex + 1) + (obs.time ? ' · ' + fmtZ(obs.time) : ''),
    body: `<img class="photo-full" src="${source}" alt="Observation photo">`,
    footer: `<button type="button" class="btn danger left" data-act="delete-photo" data-obs="${esc(obs.id)}" data-photo="${esc(photo.id)}">Delete photo</button>
      <button type="button" class="btn primary" data-close>Done</button>`
  });
}

function deleteObservationPhoto(obsId, photoId) {
  const log = activeLog();
  const obs = log.observations.find(o => o.id === obsId);
  if (!obs || !Array.isArray(obs.photos)) return;
  const index = obs.photos.findIndex(photo => photo.id === photoId);
  if (index < 0) return;
  const [removed] = obs.photos.splice(index, 1);
  closeSheet();
  save();
  render();
  toast('Photo deleted', 'Undo', () => {
    obs.photos.splice(index, 0, removed);
    save();
    render();
  });
}

/* ---------- Hobbs keypad ---------- */

const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

// Large keys that type into the input matched by `target`.
function keypadHTML(target) {
  const key = (k, label, cls) =>
    `<button type="button" class="key ${cls || ''}" data-act="keypad" data-key="${k}" data-target="${esc(target)}">${label}</button>`;
  return `<div class="keypad">
    ${KEYPAD_KEYS.map(k => key(k, k === 'back' ? '⌫' : k, k === 'back' ? 'aux' : '')).join('')}
    ${key('minus', '−0.1', 'aux')}${key('clear', 'Clear', 'aux')}${key('plus', '+0.1', 'aux')}
  </div>`;
}

// A prefilled value is "fresh": the first digit replaces it, as on a calculator,
// while ⌫ and ±0.1 adjust it.
function setKeypadFresh(input, fresh) {
  input.dataset.fresh = fresh ? '1' : '0';
  input.classList.toggle('fresh', !!fresh && !!input.value);
}

function keypadPress(target, key) {
  const input = $(target);
  if (!input) return;
  let value = input.value;
  const fresh = input.dataset.fresh === '1';
  const decimals = value.includes('.') ? value.split('.')[1].length : 0;

  if (key === 'plus' || key === 'minus') {
    const current = num(value);
    if (current == null) return;
    value = Math.max(0, current + (key === 'plus' ? 0.1 : -0.1)).toFixed(Math.max(1, decimals));
  } else if (key === 'clear') {
    value = '';
  } else if (key === 'back') {
    value = value.slice(0, -1);
  } else if (key === '.') {
    if (fresh || !value) value = '0.';
    else if (!value.includes('.')) value += '.';
  } else if (fresh) {
    value = key;
  } else if (value.length < 8 && !(value.includes('.') && decimals >= 2)) {
    value += key;
  }

  input.value = value;
  setKeypadFresh(input, false);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Asked straight after a checkpoint is stamped, so Hobbs goes in with big keys.
// Which tach reading a checkpoint carries, if any.
const KIND_TO_TACHKEY = { 'engine-start': 'tachStart', 'shut-down': 'tachEnd' };

// The Hobbs reading (and tach, at Engine Start and Shut Down) a checkpoint asks for.
function meterFieldsHTML(log, entry) {
  const tachKey = KIND_TO_TACHKEY[entry.kind];
  // Shut Down starts from the Engine Start tach, ready to be adjusted upwards.
  const tachValue = tachKey ? (log.times[tachKey] || (tachKey === 'tachEnd' ? log.times.tachStart : '') || '') : '';
  const meter = (id, label, value, active) => `<label class="meter-entry">
      <span>${label}</span>
      <input class="input hobbs-big mono ${active ? 'kp-active' : ''}" id="${id}" inputmode="none" autocomplete="off"
        value="${esc(value)}" placeholder="0.0">
    </label>`;
  return `<div class="meter-entries ${tachKey ? 'two' : ''}">
      ${meter('k-hobbs', 'Hobbs', entry.hobbs, true)}
      ${tachKey ? meter('k-tach', 'Tach', tachValue, false) : ''}
    </div>`;
}

function wireMeterInputs(scope) {
  $$('.hobbs-big', scope).forEach(input => {
    setKeypadFresh(input, true);
    input.addEventListener('focus', () => setMeterActive(input));
    input.addEventListener('keydown', () => setKeypadFresh(input, false));   // hardware keyboard
  });
}

/* On Fly, the keypad opens beside the checkpoint button that was tapped, as
   an iPad popover with its arrow on the button; the map stays in view. */
function hobbsPopover(entryId, anchor) {
  const log = activeLog();
  const entry = log.entries.find(e => e.id === entryId);
  const shell = $('#fly-shell');
  if (!entry || !shell || !anchor) return false;
  closeHobbsPopover(false);
  const tachKey = KIND_TO_TACHKEY[entry.kind];
  const pop = document.createElement('div');
  pop.className = 'kp-pop';
  pop.id = 'kp-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', (tachKey ? 'Hobbs and tach' : 'Hobbs') + ' for ' + entry.event);
  pop.dataset.kind = entry.kind;
  pop.innerHTML = `<div class="kp-pop-head"><strong>${esc(entry.event)}</strong><span class="mono">${esc(fmtZ(entry.time))}</span></div>
    ${meterFieldsHTML(log, entry)}
    ${keypadHTML('#kp-pop .kp-active')}
    <div class="kp-pop-foot">
      <button type="button" class="btn" data-act="kp-pop-skip">Skip</button>
      <button type="button" class="btn primary" id="k-next" data-act="${tachKey ? 'hobbs-next' : 'save-hobbs'}" data-id="${esc(entry.id)}">${tachKey ? 'Next: tach' : 'Save'}</button>
    </div>
    <span class="kp-pop-arrow" aria-hidden="true"></span>`;
  shell.appendChild(pop);
  wireMeterInputs(pop);
  placeHobbsPopover();
  return true;
}

// Beside the button, to its left, as high as fits; the arrow points at the button.
function placeHobbsPopover() {
  const pop = $('#kp-pop');
  const shell = $('#fly-shell');
  if (!pop || !shell) return;
  const anchor = $('.fly-cp[data-kind="' + pop.dataset.kind + '"]');
  if (!anchor) return;
  const box = shell.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const h = pop.offsetHeight;
  const mid = a.top + a.height / 2 - box.top;
  const top = Math.max(8, Math.min(box.height - h - 8, mid - h / 2));
  pop.style.top = top + 'px';
  pop.style.right = (box.right - a.left + 14) + 'px';
  pop.querySelector('.kp-pop-arrow').style.top = Math.max(16, Math.min(h - 16, mid - top)) + 'px';
  anchor.classList.add('kp-anchor');
}

function closeHobbsPopover(redraw) {
  const pop = $('#kp-pop');
  if (!pop) return false;
  pop.remove();
  $$('.fly-cp.kp-anchor').forEach(el => el.classList.remove('kp-anchor'));
  if (redraw !== false) render();
  return true;
}

function hobbsSheet(entryId) {
  const log = activeLog();
  const entry = log.entries.find(e => e.id === entryId);
  if (!entry) return;
  const tachKey = KIND_TO_TACHKEY[entry.kind];
  openSheet({
    title: tachKey ? 'Hobbs &amp; tach' : 'Hobbs',
    sub: entry.event + ' · ' + fmtZ(entry.time),
    body: `
      ${meterFieldsHTML(log, entry)}
      ${keypadHTML('#overlay .kp-active')}
      <div class="sheet-note" style="text-align:center">${tachKey
        ? 'Type Hobbs, then Next for tach. On G1000 aircraft tach is ENG HOURS (ENGINE, then SYSTEM).'
        : 'Type the reading, or adjust the last one with ±0.1.'}</div>
    `,
    footer: `<button type="button" class="btn" data-close>Skip</button>
      <button type="button" class="btn primary" id="k-next" data-act="${tachKey ? 'hobbs-next' : 'save-hobbs'}" data-id="${esc(entry.id)}">${tachKey ? 'Next: tach' : 'Save'}</button>`,
    onClose: () => render()
  });
  wireMeterInputs($('#overlay'));
}

// Point the keypad at one of the two readings; the footer button follows.
function setMeterActive(input) {
  $$('.hobbs-big', input.closest('#kp-pop, #overlay') || document).forEach(el => el.classList.toggle('kp-active', el === input));
  const next = $('#k-next');
  if (!next || !$('#k-tach')) return;
  const onTach = input.id === 'k-tach';
  next.dataset.act = onTach ? 'save-hobbs' : 'hobbs-next';
  next.textContent = onTach ? 'Save' : 'Next: tach';
}

function saveHobbsFromSheet(entryId) {
  const log = activeLog();
  const read = (selector, name) => {
    const input = $(selector);
    if (!input) return null;
    const value = input.value.trim().replace(/\.$/, '');
    if (value && num(value) == null) {
      toast('Enter a valid ' + name + ' reading');
      return undefined;
    }
    return value;
  };
  const hobbs = read('#k-hobbs', 'Hobbs');
  const tach = read('#k-tach', 'tach');
  if (hobbs === undefined || tach === undefined) return;

  const entry = log.entries.find(e => e.id === entryId);
  if (entry) {
    entry.hobbs = hobbs || '';
    const timeKey = KIND_TO_TIMEKEY[entry.kind];
    if (timeKey && log.times[timeKey]) log.times[timeKey].hobbs = entry.hobbs;
    const tachKey = KIND_TO_TACHKEY[entry.kind];
    if (tachKey && tach != null) log.times[tachKey] = tach;
    save();
  }
  if (!closeHobbsPopover()) closeSheet();
}

function openEntrySheet(entryId, preset) {
  const log = activeLog();
  const existing = entryId ? log.entries.find(e => e.id === entryId) : null;
  // A new entry starts at the current position; with no fix, at the last one logged.
  const fixAtOpen = existing ? null : freshFix();
  const startPosition = fixAtOpen
    ? { lat: fmtCoord(fixAtOpen.lat, true), lon: fmtCoord(fixAtOpen.lon, false) }
    : lastPosition(log);
  const entry = existing || Object.assign({
    id: '',
    kind: '',
    event: '',
    time: nowZ(),
    hobbs: lastHobbs(log),
    lat: startPosition.lat,
    lon: startPosition.lon,
    note: ''
  }, preset || {});

  const all = ['Engine Start', 'Wheels Up', 'In Area', 'On Target', 'Out of Area', 'Wheels Down', 'Shut Down',
    'Radio check', 'Photo', 'Contact', 'Divert', 'Notes'];
  const datalist = '<datalist id="event-options">' + all.map(v => '<option value="' + esc(v) + '"></option>').join('') + '</datalist>';

  openSheet({
    title: existing ? 'Edit log entry' : 'New log entry',
    body: `
      <input type="hidden" id="f-kind" value="${esc(entry.kind || '')}">
      <div class="form-grid">
        <label class="field"><span>Time (UTC)</span>
          <div class="input-btn">
            <input class="input time mono" id="f-time" inputmode="numeric" maxlength="4" value="${esc(entry.time)}" placeholder="HHMM">
            <button type="button" class="mini" data-act="fill-now" data-target="#f-time">Now</button>
          </div>
        </label>
        <label class="field"><span>Hobbs</span>
          <div class="input-btn">
            <input class="input hobbs mono" id="f-hobbs" inputmode="${existing ? 'decimal' : 'none'}" value="${esc(entry.hobbs)}" placeholder="1234.5">
            <button type="button" class="mini" data-act="fill-last-hobbs" data-target="#f-hobbs">Last</button>
            <button type="button" class="mini ${existing ? '' : 'on'}" data-act="toggle-keypad" data-target="#f-hobbs" data-panel="#f-keypad">Keypad</button>
          </div>
        </label>
      </div>
      <div id="f-keypad" ${existing ? 'hidden' : ''}>${keypadHTML('#f-hobbs')}</div>
      <div class="form-grid" style="margin-top:12px">
        ${sheetCoordField('Latitude N', 'f-lat', entry.lat, true)}
        ${sheetCoordField('Longitude W', 'f-lon', entry.lon, false)}
      </div>
      <div class="gps-row">
        <button type="button" class="mini gps-mini" data-act="gps-sheet">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
          Use current position
        </button>
        <span class="gps-status" id="gps-sheet-status"></span>
      </div>
      <div class="form-grid" style="margin-top:12px">
        <label class="field span-2"><span>Event</span>
          <input class="input" id="f-event" list="event-options" value="${esc(entry.event)}" placeholder="Wheels Up, On Target, contact…">
        </label>
      </div>
      ${datalist}
      <label class="field" style="margin-top:12px"><span>Remarks</span>
        <textarea class="input" id="f-note" placeholder="Optional detail">${esc(entry.note)}</textarea>
      </label>
      <div class="sheet-note">Position is filled from GPS when there is a fix, otherwise from your last entry. Overwrite it if it is wrong.</div>
    `,
    footer: `${existing ? '<button type="button" class="btn danger left" data-act="delete-entry-sheet" data-id="' + esc(entry.id) + '">Delete</button>' : ''}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" data-act="save-entry" data-id="${esc(entry.id)}">Save</button>`,
    onClose: null
  });

  if (!existing) {
    const status = $('#gps-sheet-status');
    const latInput = $('#f-lat');
    const lonInput = $('#f-lon');
    if (fixAtOpen) {
      if (status) status.textContent = gpsStatusText(fixAtOpen);
    } else if (state.settings.gpsLive && latInput && lonInput) {
      // No fix yet: fill the position when one arrives, unless it was typed over meanwhile.
      const before = latInput.value + '|' + lonInput.value;
      requestGps(false).then(fix => {
        if (!latInput.isConnected || latInput.value + '|' + lonInput.value !== before) return;
        fillCoordPair(latInput, lonInput, fix);
        if (status) status.textContent = gpsStatusText(fix);
      }).catch(() => { /* the header chip already shows the GPS state */ });
    }
  }

  const hobbsInput = $('#f-hobbs');
  if (hobbsInput) {
    setKeypadFresh(hobbsInput, !existing);
    hobbsInput.addEventListener('keydown', () => setKeypadFresh(hobbsInput, false));   // hardware keyboard
  }

  // Wire the sheet-local coordinate helpers (these fields are not live-bound).
  $$('#overlay [data-coord]').forEach(input => {
    const help = input.parentElement.querySelector('.coord-help');
    if (!help) return;
    const update = () => {
      const info = coordHelpText(input.value, input.dataset.coord === 'lat');
      help.textContent = info.text;
      help.classList.toggle('error', info.error);
    };
    input.addEventListener('input', update);
    update();
  });
}

function saveEntryFromSheet(entryId) {
  const log = activeLog();
  const time = normTime($('#f-time').value);
  const hobbs = $('#f-hobbs').value.trim();
  const lat = normCoordText($('#f-lat') ? $('#f-lat').value : '', true);
  const lon = normCoordText($('#f-lon') ? $('#f-lon').value : '', false);
  const event = $('#f-event').value.trim();
  const note = $('#f-note').value.trim();
  const kind = $('#f-kind').value;

  const timeInput = $('#f-time');
  if (!isValidTime(time)) {
    timeInput.classList.add('invalid');
    timeInput.focus();
    toast('Enter a valid UTC time (HHMM)');
    return;
  }
  timeInput.classList.remove('invalid');

  if (lat && parseLat(lat) == null) {
    toast('Latitude is not valid');
    return;
  }
  if (lon && parseLon(lon) == null) {
    toast('Longitude is not valid');
    return;
  }

  const data = { time, hobbs, lat, lon, event: event || 'Log entry', note, kind };

  if (entryId) {
    const entry = log.entries.find(e => e.id === entryId);
    if (entry) Object.assign(entry, data);
  } else {
    log.entries.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
  }

  const timeKey = KIND_TO_TIMEKEY[kind];
  if (timeKey) log.times[timeKey] = { time, hobbs };

  closeSheet();
  save();
  render();
  toast(entryId ? 'Entry updated' : 'Entry added');
}

function deleteEntry(entryId) {
  const log = activeLog();
  const index = log.entries.findIndex(e => e.id === entryId);
  if (index < 0) return;
  const beforeTimes = deepClone(log.times);
  const [removed] = log.entries.splice(index, 1);

  const timeKey = KIND_TO_TIMEKEY[removed.kind];
  if (timeKey && log.times[timeKey].time === removed.time) {
    log.times[timeKey] = { time: '', hobbs: '' };
  }

  closeSheet();
  save();
  render();
  toast('Entry deleted', 'Undo', () => {
    log.entries.splice(index, 0, removed);
    log.times = beforeTimes;
    save();
    render();
  });
}

/* ---------- menu, settings, help ---------- */

function menuSheet() {
  const log = activeLog();
  openSheet({
    title: 'Logs & data',
    body: `
      <div class="sheet-section">
        <h3>Missions</h3>
        <div class="btn-row">
          <button type="button" class="btn small" data-act="show-missions">Missions</button>
          <button type="button" class="btn small" data-act="edit-mission">This mission</button>
          <button type="button" class="btn small" data-act="new-log">+ New mission</button>
        </div>
      </div>

      <div class="sheet-section">
        <h3>Output</h3>
        <div class="menu-list">
          <button type="button" class="menu-item" data-act="print">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            <span>Print / Save PDF<span class="mi-sub">Two-page mission log, ready for signature</span></span>
          </button>
          <button type="button" class="menu-item" data-act="export-capf104">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></svg>
            <span>CAPF 104 (PDF)<span class="mi-sub">The sortie on the CAP's own Mission Flight Plan/Briefing form</span></span>
          </button>
          <button type="button" class="menu-item" data-act="export-json">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
            <span>Export backup<span class="mi-sub">All logs as a .json file</span></span>
          </button>
          <button type="button" class="menu-item" data-act="send-sortie">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>
            <span>Send sortie to crew<span class="mi-sub">This sortie only, by AirDrop, Messages or Mail</span></span>
          </button>
          <button type="button" class="menu-item" data-act="import-json">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/></svg>
            <span>Import backup<span class="mi-sub">Merge a .json backup into this device</span></span>
          </button>
          <button type="button" class="menu-item" data-act="export-csv">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg>
            <span>Sortie log CSV<span class="mi-sub">Time, Hobbs, position and remarks</span></span>
          </button>
        </div>
      </div>

      <div class="sheet-section">
        <div class="menu-list">
          <button type="button" class="menu-item" data-act="settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.63.66 1.1 1.3 1.1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/></svg>
            <span>Settings<span class="mi-sub">Theme, GPS, screen awake</span></span>
          </button>
          <button type="button" class="menu-item" data-act="help">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.9.7-1.5 1.2-1.5 2.5"/><path d="M12 17h.01"/></svg>
            <span>Help &amp; install<span class="mi-sub">Add to home screen, offline use</span></span>
          </button>
          <button type="button" class="menu-item" data-act="terms">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></svg>
            <span>Disclaimer &amp; terms<span class="mi-sub">Not for navigation, no warranty</span></span>
          </button>
          <a class="menu-item" href="${esc(FEEDBACK_URL)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>
            <span>Send feedback<span class="mi-sub">Report an issue, comment or idea (opens a form, needs a connection)</span></span>
          </a>
        </div>
      </div>

      <div class="sheet-note">Mission Log v${APP_VERSION} · ${state.logs.reduce((n, l) => n + l.entries.length, 0)} entries across ${state.logs.length} log${state.logs.length === 1 ? '' : 's'}. Data never leaves this iPad unless you export it.</div>
    `,
    footer: `<button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => render()
  });
}

function settingsSheet() {
  const settings = state.settings;
  const wakeSupported = NATIVE || 'wakeLock' in navigator;
  const gpsSupported = geoAvailable();

  openSheet({
    title: 'Settings',
    body: `
      <div class="setting-row">
        <div class="setting-label">Appearance<small>Auto follows the iPad</small></div>
        <div class="seg">
          <button type="button" data-act="set-theme" data-value="auto" class="${settings.theme === 'auto' ? 'active' : ''}">Auto</button>
          <button type="button" data-act="set-theme" data-value="light" class="${settings.theme === 'light' ? 'active' : ''}">Light</button>
          <button type="button" data-act="set-theme" data-value="dark" class="${settings.theme === 'dark' ? 'active' : ''}">Dark</button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label">OPS interval<small>Reminder rhythm on the Fly tab</small></div>
        <div class="input-btn" style="width:132px">
          <input class="input mono centered" id="ops-interval" data-bind="settings.opsInterval" inputmode="numeric" value="${esc(settings.opsInterval)}">
          <span class="muted small">min</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label">Keep screen awake<small>${wakeSupported ? 'While the app is open' : 'Not supported in this browser'}</small></div>
        <button type="button" class="toggle ${settings.keepAwake ? 'on' : ''}" data-act="toggle-wake" ${wakeSupported ? '' : 'disabled'}>
          <span class="tick">✓</span> ${settings.keepAwake ? 'On' : 'Off'}
        </button>
      </div>

      <div class="setting-row">
        <div class="setting-label">Live GPS<small>${gpsSupported ? 'Shows GPS status in the header and starts entries at the current position' : 'Needs the installed app or an https page'}</small></div>
        <button type="button" class="toggle ${settings.gpsLive ? 'on' : ''}" data-act="toggle-gps-live" ${gpsSupported ? '' : 'disabled'}>
          <span class="tick">✓</span> ${settings.gpsLive ? 'On' : 'Off'}
        </button>
      </div>

      <div class="setting-row">
        <div class="setting-label">Record flight track<small>From Engine Start to Shut Down${NATIVE ? ', also in the background' : ', while this page is open'}</small></div>
        <button type="button" class="toggle ${settings.recordTrack ? 'on' : ''}" data-act="toggle-record-track">
          <span class="tick">✓</span> ${settings.recordTrack ? 'On' : 'Off'}
        </button>
      </div>

      <div class="setting-row">
        <div class="setting-label">Hobbs keypad<small>Ask for Hobbs after each checkpoint</small></div>
        <button type="button" class="toggle ${settings.hobbsPrompt ? 'on' : ''}" data-act="toggle-hobbs-prompt">
          <span class="tick">✓</span> ${settings.hobbsPrompt ? 'On' : 'Off'}
        </button>
      </div>

      <div class="sheet-note" style="margin-top:16px">
        Stored on this iPad. Safari can clear website data after long periods of disuse — export a backup after each mission.
      </div>

      <button type="button" class="btn danger wide" data-act="reset-all" style="margin-top:8px">Erase all logs on this device</button>
    `,
    footer: `<button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => { render(); }
  });
}

function helpSheet() {
  openSheet({
    title: 'Help & install',
    body: `
      ${NATIVE ? '' : `      <div class="sheet-section">
        <h3>Put it on the home screen</h3>
        <p class="sheet-note" style="margin-top:0">
          Open this page in <strong>Safari</strong> on the iPad, tap the Share button, then
          <strong>Add to Home Screen</strong>. Launch it from that icon from then on. It opens full
          screen and keeps working with no signal.
        </p>
        <p class="sheet-note">
          The first load needs a connection so Safari can cache the app. After that, everything —
          including the sketch pad — runs offline.
        </p>
      </div>`}

      <div class="sheet-section">
        <h3>In the air</h3>
        <div class="menu-list">
          <div class="menu-item" style="cursor:default">
            <span><strong>Checkpoint buttons</strong><span class="mi-sub">Tap Engine Start, Wheels Up, In Area, etc. The time is stamped and a keypad asks for Hobbs, starting from the last reading. Engine Start and Shut Down also ask for tach. Tap the checkpoint again to edit it.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>OPS rhythm</strong><span class="mi-sub">Record a check every 30 minutes. Fuel and altimeter carry forward; the Fly tab warns you when one is due.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>Positions</strong><span class="mi-sub">Stored as degrees and decimal minutes (N 35° 30.00′). Type them that way, as decimal degrees (35.5) or as degrees, minutes and seconds (35 30 00); the line under each field shows the other formats. New entries start at your last position.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>GPS positions</strong><span class="mi-sub">The header shows the GPS status and accuracy. Checkpoints, new entries and observations start at the current position; with no fix they start at the last one logged. Allow location when asked; a fix works without a network. Switch Live GPS off in Settings to save battery.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>Observation photos</strong><span class="mi-sub">Tap Photo on an observation to use the camera or photo library. Up to six per observation; photos appear in the PDF.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>Sketch pad</strong><span class="mi-sub">Draw with a finger or Apple Pencil. Pick a background (grid, plain, or the sectional, topographic or terrain map around the search area), and add pages, all from the tools in the header. In the iPad app, Apple's palette has the pens, eraser, lasso and ruler; pinch to zoom.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>Offline maps</strong><span class="mi-sub">Before you leave, open Brief › Offline maps and tap Save. The sectional (and Topo or Terrain if you want them) around the search area, entry and exit points and ForeFlight route is kept on the iPad, so the chart and the sketch pad show it with no signal. Save the sectional again when it is more than 56 days old.</span></span>
          </div>
        </div>
        <p class="sheet-note" style="margin-top:10px">
          GPS accuracy depends on the iPad model. Cellular iPads have a real GPS receiver; Wi-Fi-only
          models use Wi-Fi positioning and may be much less accurate away from coverage.
        </p>
      </div>

      <div class="sheet-section">
        <h3>After the sortie</h3>
        <p class="sheet-note" style="margin-top:0">
          Tap <strong>Print / Save PDF</strong>, then choose <strong>Save to Files</strong> or
          <strong>Print</strong> in the share sheet. On a computer, the browser print dialog opens.
          That gives you a PDF of the log with notes, sketches, observations and signature.
          <strong>Export backup</strong> writes a .json copy of everything.
        </p>
      </div>

      <div class="sheet-section">
        <h3>Privacy</h3>
        <p class="sheet-note" style="margin-top:0">
          There is no account and no server. Logs live in this browser's storage on this iPad. Nothing is
          uploaded. Deleting the app's website data, or “Erase all logs”, removes them permanently — keep
          backups.
        </p>
      </div>

      <div class="sheet-note" style="text-align:center;margin-top:20px">Mission Log v${APP_VERSION}</div>
    `,
    footer: `<button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => render()
  });
}

/* =========================================================================
   Actions
   ========================================================================= */

function quickLog(kind, label) {
  const log = activeLog();
  const existing = kind ? entryForKind(log, kind) : null;
  if (existing) {
    openEntrySheet(existing.id);
    return;
  }

  const beforeTimes = deepClone(log.times);
  const fix = freshFix();
  const position = fix ? { lat: fmtCoord(fix.lat, true), lon: fmtCoord(fix.lon, false) } : lastPosition(log);
  const entry = {
    id: uid(),
    kind,
    event: label,
    time: nowZ(),
    hobbs: lastHobbs(log),
    lat: position.lat,
    lon: position.lon,
    note: '',
    createdAt: Date.now()
  };
  if (fix) {
    entry.gpsAccuracy = Math.round(fix.accuracy);
    entry.gpsTime = fmtZ(hhmmFromMs(fix.at));
  }
  log.entries.push(entry);

  const timeKey = KIND_TO_TIMEKEY[kind];
  if (timeKey) log.times[timeKey] = { time: entry.time, hobbs: entry.hobbs };

  save();
  render();
  if (!fix && state.settings.gpsLive) autoGpsEntry(entry);
  haptic('MEDIUM');
  if (state.settings.hobbsPrompt) {
    const anchor = activeTab === 'fly' && $('.fly-cp[data-kind="' + kind + '"]');
    if (!hobbsPopover(entry.id, anchor)) hobbsSheet(entry.id);
  }
  toast(label + ' logged at ' + fmtZ(entry.time), 'Undo', () => {
    closeHobbsPopover(false);
    log.entries = log.entries.filter(e => e.id !== entry.id);
    log.times = beforeTimes;
    save();
    render();
  });
}

function addObservation() {
  const log = activeLog();
  const fix = freshFix();
  const position = fix ? { lat: fmtCoord(fix.lat, true), lon: fmtCoord(fix.lon, false) } : lastPosition(log);
  const obs = {
    id: uid(),
    time: nowZ(),
    hobbs: lastHobbs(log),
    lat: position.lat,
    lon: position.lon,
    text: '',
    createdAt: Date.now()
  };
  if (fix) {
    obs.gpsAccuracy = Math.round(fix.accuracy);
    obs.gpsTime = fmtZ(hhmmFromMs(fix.at));
  }
  log.observations.push(obs);
  save();
  activeTab = 'fly';
  render();
  if (!fix && state.settings.gpsLive) autoGpsObservation(obs);
  // a note box at the top of the map, where the keyboard cannot cover it
  openObsPop(obs.id);
  haptic('MEDIUM');
}

/* ---------- Fly: a new observation ----------
   A compact box at the top of the map: when and where, the note, photos.
   The full card (time, Hobbs, position) is in the flight log. */
function obsPopInner(log, obs) {
  const index = log.observations.indexOf(obs);
  const photos = Array.isArray(obs.photos) ? obs.photos : [];
  const where = obs.lat && obs.lon ? obs.lat + '  ' + obs.lon : 'No position yet';
  return `<div class="obs-pop-head">
      <strong>Observation ${index + 1}</strong>
      <span class="mono">${esc(fmtZ(obs.time))}</span>
      <span class="obs-pop-where mono" id="obs-pop-where">${esc(where)}${obs.gpsAccuracy ? ' · ±' + esc(obs.gpsAccuracy) + ' m' : ''}</span>
    </div>
    <textarea class="input obs-pop-text" data-bind="observations.${index}.text" rows="3"
      placeholder="What did you see? Include altitude, heading, and anything distinctive.">${esc(obs.text)}</textarea>
    <div class="obs-pop-foot">
      <div class="obs-pop-photos">
        ${photos.map(photo => `<img src="${esc(photo.thumb || photo.data)}" alt="">`).join('')}
        ${photos.length < MAX_OBS_PHOTOS ? `<button type="button" class="btn small" data-act="add-photo" data-obs="${esc(obs.id)}">${PHOTO_ICON}Photo</button>` : ''}
      </div>
      <button type="button" class="btn small" data-act="obs-pop-discard">Discard</button>
      <button type="button" class="btn small primary" data-act="obs-pop-done">Done</button>
    </div>`;
}

function openObsPop(obsId) {
  const shell = $('#fly-shell');
  const log = activeLog();
  const obs = log.observations.find(o => o.id === obsId);
  if (!shell || !obs) return;
  closeHobbsPopover(false);
  let pop = $('#obs-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'obs-pop';
    pop.id = 'obs-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'New observation');
    shell.appendChild(pop);
  }
  pop.dataset.obs = obs.id;
  pop.innerHTML = obsPopInner(log, obs);
  const area = pop.querySelector('textarea');
  if (area) {
    area.focus({ preventScroll: true });
    // focusing must not scroll the map out of its frame
    requestAnimationFrame(() => { shell.scrollTop = 0; shell.scrollLeft = 0; });
  }
}

// Redraw the box (a photo or a GPS position arrived), keeping the typing.
function refreshObsPop() {
  const pop = $('#obs-pop');
  if (!pop) return;
  const log = activeLog();
  const obs = log.observations.find(o => o.id === pop.dataset.obs);
  if (!obs) { pop.remove(); return; }
  const area = pop.querySelector('textarea');
  const focused = area && document.activeElement === area;
  pop.innerHTML = obsPopInner(log, obs);
  if (focused) pop.querySelector('textarea').focus({ preventScroll: true });
}

function closeObsPop(discard) {
  const pop = $('#obs-pop');
  if (!pop) return;
  const log = activeLog();
  const obs = log.observations.find(o => o.id === pop.dataset.obs);
  pop.remove();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (discard && obs) {
    log.observations = log.observations.filter(o => o !== obs);
    save();
    toast('Observation discarded');
  } else if (obs) {
    toast('Observation ' + (log.observations.indexOf(obs) + 1) + ' saved at ' + fmtZ(obs.time));
  }
  render();
}

function addOpsCheck() {
  const log = activeLog();
  const last = log.ops[log.ops.length - 1];
  const op = {
    id: uid(),
    time: nowZ(),
    hobbs: lastHobbs(log),
    fuel: last ? last.fuel : '',
    altimeter: last ? last.altimeter : '',
    normal: true
  };
  log.ops.push(op);
  haptic('MEDIUM');
  save();
  render();
  scheduleOpsReminder();
  toast('OPS check recorded at ' + fmtZ(op.time), 'Undo', () => {
    log.ops = log.ops.filter(o => o.id !== op.id);
    save();
    render();
  });
}

// Open a sortie: on its Brief from Missions, on the same tab from the header.
function switchLog(id, keepTab) {
  const log = state.logs.find(l => l.id === id);
  if (!log) return;
  state.activeMissionId = log.missionId;
  state.activeId = id;
  closeSheet();
  if (!keepTab || activeTab === 'logbook') activeTab = defaultTab();
  save();
  render();
  window.scrollTo(0, 0);
}

// A mission's sorties, oldest first. Takes a sortie, a mission id, or nothing
// for the picked mission.
function missionSorties(of) {
  const id = typeof of === 'string' ? of : of ? of.missionId : state && state.activeMissionId;
  if (!state || !id) return [];
  return state.logs
    .filter(other => other.missionId === id)
    .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
}

function getPath(obj, path) {
  return path.split('.').reduce((value, key) => (value == null ? value : value[key]), obj);
}

// Logs saved before 1.9.0 have no missionId: those with the same mission number
// become sorties of one mission, the rest become one-sortie missions.
function assignMissionIds(logs) {
  const byNumber = {};
  logs.forEach(log => {
    if (log.missionId) {
      const key = String(log.mission || '').trim().toUpperCase();
      if (key && !byNumber[key]) byNumber[key] = log.missionId;
    }
  });
  logs.forEach(log => {
    if (log.missionId) return;
    const key = String(log.mission || '').trim().toUpperCase();
    if (key && byNumber[key]) {
      log.missionId = byNumber[key];
    } else {
      log.missionId = uid();
      if (key) byNumber[key] = log.missionId;
    }
  });
}

function sortieLabel(log, index) {
  return 'Sortie ' + (String(log.sortie || '').trim() || String(index + 1));
}

// WMIRS numbers sorties A0001, A0002…; suggest one past the highest so far.
function nextSortieNumber(sorties) {
  let best = null;
  sorties.forEach(l => {
    const match = String(l.sortie || '').trim().toUpperCase().match(/^(.*?)(\d+)$/);
    if (!match) return;
    const n = parseInt(match[2], 10);
    if (!best || n > best.n) best = { prefix: match[1], n, width: match[2].length };
  });
  return best ? best.prefix + String(best.n + 1).padStart(best.width, '0') : '';
}

function createLog() {
  openNewMissionSheet();
}

function addSortie() {
  if (!activeMission()) { openNewMissionSheet(); return; }
  if (activeMission().closed) { closeSheet(); toast('Mission closed · reopen it to add a sortie'); return; }
  openAddSortieSheet();
}

function deleteMission() {
  const mission = activeMission();
  if (!mission) return;
  const sorties = missionSorties(mission.id);
  if (!confirm('Delete mission ' + missionTitle(mission) + ' and its ' + sorties.length + ' sortie' +
    (sorties.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
  state.logs = state.logs.filter(l => l.missionId !== mission.id);
  state.missions = state.missions.filter(m => m !== mission);
  state.activeMissionId = (missionsInOrder().find(m => !m.closed) || {}).id || '';
  state.activeId = '';
  activeTab = 'logbook';
  closeSheet();
  save();
  render();
  pruneSavedMaps();
  toast('Mission deleted');
}

function deleteLog() {
  const log = activeSortie();
  if (!log) return;
  const sorties = missionSorties(log);
  const index = sorties.indexOf(log);
  if (!confirm('Delete ' + sortieLabel(log, index) + ' of ' + missionTitle(missionOf(log)) +
    ' and all of its entries? This cannot be undone.')) return;
  state.logs.splice(state.logs.indexOf(log), 1);
  const rest = sorties.filter(other => other !== log);
  state.activeId = rest.length ? rest[rest.length - 1].id : '';
  closeSheet();
  activeTab = defaultTab();
  save();
  render();
  pruneSavedMaps();
  toast('Sortie deleted');
}

// Header: switch to another sortie of this mission, or add one.
function sortieSheet() {
  const log = activeSortie();
  if (!log) return;
  const sorties = missionSorties(log);
  openSheet({
    title: 'Sorties',
    sub: missionTitle(missionOf(log)) + ' · ' + sorties.length + ' sortie' + (sorties.length === 1 ? '' : 's'),
    body: `<div class="log-list" data-keep-tab>${sorties.map(sortieCardRowHTML).join('')}</div>`,
    footer: `<button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" data-act="add-sortie">+ Add sortie</button>`
  });
}

function slug(value) {
  return String(value || 'mission').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || 'mission';
}

function exportName(extension) {
  const log = activeLog();
  const d = new Date();
  const date = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  return 'mission-log_' + slug(missionOf(log).number) + '_s' + slug(log.sortie) + '_' + date + '.' + extension;
}

async function shareFile(filename, blob) {
  if (NATIVE) {
    // The app's web view has no Web Share or downloads: write the file to the
    // app's cache folder and hand it to the iPad share sheet.
    try {
      const data = await blobToBase64(blob);
      const written = await Native.Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
      await Native.Share.share({ title: filename, files: [written.uri] });
      return true;
    } catch (err) {
      if (/cancel/i.test(String((err && err.message) || err))) return false;
      console.warn('native share failed', err);
      toast('Could not open the share sheet');
      return false;
    }
  }
  try {
    if (navigator.canShare && typeof File === 'function') {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return true;
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return false;
    console.warn('share failed, falling back to download', err);
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return true;
}

function exportJSON() {
  const payload = {
    app: 'Mission Log',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    missions: state.missions,
    logs: state.logs
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  shareFile(exportName('json'), blob);
  toast('Backup ready');
}

/* One sortie, to hand to a crew member: share sheet → AirDrop, Messages, Mail.
   They save it to Files and use Menu → Import, where it joins their copy of
   the mission as its own sortie. */
// Print, CSV and Send to crew are about the open sortie.
function needSortie() {
  if (activeSortie()) return true;
  closeSheet();
  toast(activeMission() ? 'Open a sortie first' : 'Pick or add a mission first');
  return false;
}

function exportSortie() {
  if (!needSortie()) return;
  const log = activeLog();
  if (sketchCtl) sketchCtl.flush();
  const payload = {
    app: 'Mission Log',
    kind: 'sortie',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    from: log.signoff.name || crewNames(log, 'MO').split('; ')[0] || '',
    missions: [missionOf(log)],
    logs: [log]
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  shareFile(exportName('sortie.json'), blob);
  toast('Sortie ready to send · choose AirDrop in the share sheet');
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function exportCSV() {
  if (!needSortie()) return;
  const log = activeLog();
  const header = ['Mission', 'Sortie', 'Tail No.', 'Call Sign', 'Time (Z)', 'Hobbs', 'Latitude (DD)', 'Longitude (DD)', 'Event', 'Remarks', 'GPS accuracy (m)'];
  const rows = [header];
  log.entries.forEach(entry => {
    const lat = parseLat(entry.lat);
    const lon = parseLon(entry.lon);
    rows.push([
      missionOf(log).number, log.sortie, log.aircraft, log.callsign,
      entry.time ? entry.time + 'Z' : '',
      entry.hobbs,
      lat == null ? '' : lat.toFixed(6),
      lon == null ? '' : lon.toFixed(6),
      entry.event, entry.note,
      entry.gpsAccuracy == null ? '' : entry.gpsAccuracy
    ]);
  });
  const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  shareFile(exportName('csv'), blob);
  toast('CSV ready');
}

// Apply a backup or a shared sortie, from the file picker or a file opened in the app.
function importBackupText(text) {
  const data = JSON.parse(text);
  let incoming = null;

  if (data && Array.isArray(data.logs)) incoming = data.logs;
  else if (data && Array.isArray(data.entries)) incoming = [data];

  if (!incoming || !incoming.length) throw new Error('No logs found in that file');

  // Files from before 1.22.0 carry the mission on each log.
  const { missions: inMissions, logs: rawLogs } = Array.isArray(data.missions)
    ? { missions: data.missions.filter(m => m && typeof m === 'object').map(normalizeMission), logs: incoming }
    : splitLegacyLogs(incoming);
  if (!rawLogs.length && !inMissions.length) throw new Error('No sorties found in that file');

  const shared = data && data.kind === 'sortie';
  const replacing = rawLogs.filter(raw => raw && state.logs.some(l => l.id === raw.id)).length;
  if (replacing && !confirm(replacing === 1 && shared
    ? 'This sortie is already on this iPad. Replace it with the copy in the file? Changes made here since it was shared will be lost.'
    : replacing + ' of these sorties are already on this iPad and will be replaced by the copies in the file. Continue?')) return;

  // Each mission in the file joins the same mission here (by id, then by
  // number), or is added.
  const missionIdMap = {};
  inMissions.forEach(mission => {
    const key = String(mission.number || '').trim().toUpperCase();
    const mine = state.missions.find(m => m.id === mission.id) ||
      (key && state.missions.find(m => String(m.number || '').trim().toUpperCase() === key));
    if (mine) {
      missionIdMap[mission.id] = mine.id;
      // a backup restores the mission's details; a crew member's sortie does not
      if (!shared && mine.id === mission.id) Object.assign(mine, mission);
    } else {
      state.missions.push(mission);
      missionIdMap[mission.id] = mission.id;
    }
  });

  let added = 0;
  let lastId = null;
  rawLogs.forEach(raw => {
    const log = normalizeLog(raw);
    log.missionId = missionIdMap[log.missionId] || log.missionId;
    if (!missionById(log.missionId)) {
      const mission = blankMission();
      if (log.missionId) mission.id = log.missionId;
      else log.missionId = mission.id;
      state.missions.push(mission);
    }
    if (shared && !state.logs.some(l => l.id === log.id)) {
      // a crew member's sortie: theirs to read, yours to sign
      log.receivedFrom = data.from || 'a crew member';
      const mine = state.logs.find(l => l.missionId === log.missionId);
      log.signoff = { name: mine ? mine.signoff.name : '', capid: mine ? mine.signoff.capid : '', dateTime: '', signature: '' };
    }
    lastId = log.id;
    const index = state.logs.findIndex(l => l.id === log.id);
    if (index >= 0) {
      state.logs[index] = log;
    } else {
      state.logs.push(log);
      added++;
    }
  });

  if (shared && lastId) {
    const log = state.logs.find(l => l.id === lastId);
    state.activeMissionId = log.missionId;
    state.activeId = lastId;
    activeTab = defaultTab();
  } else if (!activeMission()) {
    state.activeMissionId = (missionsInOrder().find(m => !m.closed) || {}).id || '';
    state.activeId = '';
  }
  if (data.settings) {
    const { termsAccepted, termsAcceptedAt } = state.settings;
    state.settings = Object.assign(state.settings, data.settings, { termsAccepted, termsAcceptedAt });
  }
  save();
  applyTheme();
  render();
  toast('Imported ' + rawLogs.length + ' sortie' + (rawLogs.length === 1 ? '' : 's') +
    (added ? ' (' + added + ' new)' : ''));
}

function importJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('cancel', () => input.remove());
  setTimeout(() => { if (input.isConnected) input.remove(); }, 300000);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      importBackupText(decodeTextBytes(new Uint8Array(await file.arrayBuffer())));
    } catch (err) {
      console.warn(err);
      toast('Could not import that file');
    }
  });
  input.click();
}

function printLog() {
  if (!needSortie()) return;
  closeSheet();

  // iPadOS blocks window.print() inside a home-screen web app. On iOS (and
  // any standalone PWA) build the PDF directly and hand it to the share sheet.
  if (isIOSDevice() || isStandaloneApp()) {
    exportPdf();
    return;
  }

  buildPrint();
  window.print();
}

/* ---------- PDF export ---------- */


function isStandaloneApp() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function pdfSafe(value) {
  return String(value == null ? '' : value)
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/′/g, "'")
    .replace(/″/g, '"')
    .replace(/→/g, '->')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '');
}

function pdfCoordPair(latRaw, lonRaw) {
  const lat = parseLat(latRaw);
  const lon = parseLon(lonRaw);
  if (lat == null || lon == null) return '';
  return pdfSafe(fmtCoord(lat, true) + ' / ' + fmtCoord(lon, false));
}

function pdfHeader(doc, title, subtitle, rightLines) {
  const W = doc.internal.pageSize.getWidth();
  const M = 36;
  const black = [0, 0, 0];

  const textX = M;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(black[0], black[1], black[2]);
  doc.text(pdfSafe(title), textX, 46);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(85, 85, 85);
  doc.text(pdfSafe(subtitle).toUpperCase(), textX, 59);

  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  rightLines.forEach((line, index) => {
    doc.text(pdfSafe(line), W - M, 38 + index * 11, { align: 'right' });
  });

  doc.setDrawColor(black[0], black[1], black[2]);
  doc.setLineWidth(1.6);
  doc.line(M, 76, W - M, 76);
}

function buildPdfBlob() {
  const lib = window.jspdf;
  if (!lib || !lib.jsPDF) throw new Error('PDF library not loaded');

  const doc = new lib.jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  if (typeof doc.autoTable !== 'function') throw new Error('PDF table plugin not loaded');

  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 36;
  const CW = W - M * 2;
  const ink = [0, 0, 0];
  const grey = [85, 85, 85];
  const dark = [0, 0, 0];
  const log = activeLog();
  const totals = timeTotals(log);
  const printed = fmtDateZ(new Date());
  const mission = pdfSafe(missionOf(log).number || 'Untitled mission');
  const sortie = pdfSafe(log.sortie || '-');
  const aircraft = pdfSafe(log.aircraft || 'No tail');

  pdfHeader(doc, 'Observer Mission Log', 'Sortie record', [
    'Printed ' + printed,
    'Entries ' + log.entries.length
  ]);

  let y = 86;

  const coordText = (latRaw, lonRaw) => pdfCoordPair(latRaw, lonRaw) || '';

  const meta = [
    ['Mission / symbol', mission + (missionOf(log).symbol ? ' / ' + pdfSafe(missionOf(log).symbol) : '')], ['Sortie', sortie],
    ['Sortie type', pdfSafe(log.sortieType)], ['Tail No.', aircraft],
    ['Call sign', pdfSafe(log.callsign)], ['Dep. / Dest.', pdfSafe([log.depAirport, log.destAirport].filter(Boolean).join(' - '))],
    ['Sectional', pdfSafe(log.sectional)], ['Grid', pdfSafe(log.grid)],
    ['Altitude', pdfSafe(log.altitude)], ['Airspeed', pdfSafe(log.airspeed)], ['Entry point', coordText(log.entry.lat, log.entry.lon)], ['Exit point', coordText(log.exit.lat, log.exit.lon)],
    ['Main radio', pdfSafe(log.radio.main)], ['Guard radio', pdfSafe(log.radio.guard)], ['ATIS / AWOS', pdfSafe(log.radio.atis)], ['CTAF', pdfSafe(log.radio.ctaf)]
  ];

  const cellW = CW / 4;
  const cellH = 31;
  meta.forEach((item, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x = M + col * cellW;
    const top = y + row * cellH;
    doc.setDrawColor(170, 170, 170);
    doc.setLineWidth(0.5);
    doc.rect(x, top, cellW, cellH);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(grey[0], grey[1], grey[2]);
    doc.text(item[0].toUpperCase(), x + 4, top + 8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(item[1] && item[1].length > 24 ? 7.4 : 8.2);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    const lines = item[1] ? doc.splitTextToSize(item[1], cellW - 8).slice(0, 2) : [];
    if (lines.length) doc.text(lines, x + 4, top + 17);
  });
  y += cellH * 4 + 9;

  // Crew: one line per person, two people side by side, so any number of
  // observers, scanners or photographers fit.
  const crew = crewForPrint(log);
  const crewRows = [];
  for (let i = 0; i < Math.max(crew.length, 2); i += 2) {
    const pair = [crew[i], crew[i + 1]];
    crewRows.push(pair.flatMap(m => m ? [m.role, pdfSafe(m.name), pdfSafe(m.capid)] : ['', '', '']));
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('CREW', M, y + 7);
  doc.autoTable({
    startY: y + 11,
    margin: { left: M, right: M },
    tableWidth: CW,
    head: [['ROLE', 'NAME', 'CAPID', 'ROLE', 'NAME', 'CAPID']],
    body: crewRows,
    theme: 'grid',
    styles: {
      font: 'helvetica', fontSize: 7.6, cellPadding: 2.4, textColor: dark,
      lineColor: [150, 150, 150], lineWidth: 0.4, overflow: 'linebreak'
    },
    headStyles: { fillColor: [235, 235, 235], textColor: ink, fontSize: 6.2, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 34, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: CW / 2 - 34 - 62 },
      2: { cellWidth: 62, halign: 'center' },
      3: { cellWidth: 34, halign: 'center', fontStyle: 'bold' },
      4: { cellWidth: CW / 2 - 34 - 62 },
      5: { cellWidth: 62, halign: 'center' }
    }
  });
  y = doc.lastAutoTable.finalY + 9;

  // Flight times and totals
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('TIMES', M, y + 7);
  doc.text('TOTALS', 350, y + 7);

  const leftW = 300;
  const rowH = 15;
  const tableTop = y + 13;

  doc.setFillColor(235, 235, 235);
  doc.rect(M, tableTop, leftW, rowH, 'F');
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.5);
  doc.rect(M, tableTop, leftW, rowH);
  doc.line(M + 150, tableTop, M + 150, tableTop + rowH);
  doc.line(M + 215, tableTop, M + 215, tableTop + rowH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.2);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('EVENT', M + 4, tableTop + 10);
  doc.text('TIME (Z)', M + 156, tableTop + 10);
  doc.text('HOBBS', M + 221, tableTop + 10);

  TIME_DEFS.forEach((def, index) => {
    const value = log.times[def.key] || {};
    const top = tableTop + rowH * (index + 1);
    doc.setDrawColor(170, 170, 170);
    doc.rect(M, top, leftW, rowH);
    doc.line(M + 150, top, M + 150, top + rowH);
    doc.line(M + 215, top, M + 215, top + rowH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.4);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(def.label, M + 4, top + 10);
    doc.setFont('helvetica', 'normal');
    doc.text(value.time ? value.time + 'Z' : '', M + 156, top + 10);
    doc.text(value.hobbs || '', M + 221, top + 10);
  });

  const totalsData = [
    ['Flight time', fmtDuration(totals.flight)],
    ['ATA - ATD', fmtDuration(totals.engine)],
    ['Total tach', totals.tach == null ? '-' : fmtDecimal(totals.tach, 1)],
    ['Hobbs used', totals.hobbs == null ? '-' : fmtDecimal(totals.hobbs, 1)]
  ];
  const totalsX = 350;
  const totalsW = W - M - totalsX;
  const totalsCell = totalsW / 2;
  const totalsH = 30;

  totalsData.forEach((item, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = totalsX + col * totalsCell;
    const top = tableTop + row * totalsH;
    doc.setDrawColor(170, 170, 170);
    doc.rect(x, top, totalsCell, totalsH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(5.8);
    doc.setTextColor(grey[0], grey[1], grey[2]);
    doc.text(item[0].toUpperCase(), x + 4, top + 8);
    doc.setFontSize(12);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(item[1], x + 4, top + 21);
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(grey[0], grey[1], grey[2]);
  doc.text('Tach start ' + (tachValues(log).start || '________') + '  ·  Tach end ' + (tachValues(log).end || '________'),
    totalsX, tableTop + totalsH * 2 + 10);

  y = Math.max(tableTop + rowH * 7, tableTop + totalsH * 2 + 16) + 10;

  // Flight log
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('SORTIE LOG', M, y + 7);

  const logRows = log.entries.map(entry => [
    entry.time ? entry.time + 'Z' : '',
    entry.hobbs || '',
    pdfSafe(fmtCoord(parseLat(entry.lat), true) || ''),
    pdfSafe(fmtCoord(parseLon(entry.lon), false) || ''),
    pdfSafe(entry.event || ''),
    pdfSafe(entry.note || '')
  ]);
  const blankLogs = Math.max(0, 10 - logRows.length);
  for (let i = 0; i < blankLogs; i++) logRows.push(['', '', '', '', '', '']);

  doc.autoTable({
    startY: y + 12,
    margin: { left: M, right: M },
    tableWidth: CW,
    head: [['TIME', 'HOBBS', 'LATITUDE N', 'LONGITUDE W', 'EVENT', 'REMARKS']],
    body: logRows,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7,
      cellPadding: 2.6,
      textColor: dark,
      lineColor: [150, 150, 150],
      lineWidth: 0.4,
      overflow: 'linebreak'
    },
    headStyles: {
      fillColor: [235, 235, 235],
      textColor: ink,
      fontSize: 6.2,
      fontStyle: 'bold'
    },
    columnStyles: {
      0: { cellWidth: 48, halign: 'center' },
      1: { cellWidth: 52, halign: 'center' },
      2: { cellWidth: 88 },
      3: { cellWidth: 92 },
      4: { cellWidth: 100 },
      5: { cellWidth: 160 }
    }
  });

  y = doc.lastAutoTable.finalY + 9;

  // OPS checks
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('OPS STATUS CHECKS', M, y + 7);

  const opsRows = log.ops.map((op, index) => [
    String(index + 1),
    op.time ? op.time + 'Z' : '',
    op.hobbs || '',
    pdfSafe(op.fuel || ''),
    pdfSafe(op.altimeter || ''),
    op.normal ? 'Normal' : 'Flagged'
  ]);
  const blankOps = Math.max(0, 3 - opsRows.length);
  for (let i = 0; i < blankOps; i++) opsRows.push(['', '', '', '', '', '']);

  doc.autoTable({
    startY: y + 12,
    margin: { left: M, right: M },
    tableWidth: CW,
    head: [['#', 'TIME', 'HOBBS', 'FUEL', 'ALTIMETER', 'STATUS']],
    body: opsRows,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7,
      cellPadding: 2.6,
      textColor: dark,
      lineColor: [150, 150, 150],
      lineWidth: 0.4
    },
    headStyles: {
      fillColor: [235, 235, 235],
      textColor: ink,
      fontSize: 6.2,
      fontStyle: 'bold'
    },
    columnStyles: {
      0: { cellWidth: 30, halign: 'center' },
      1: { cellWidth: 60, halign: 'center' },
      2: { cellWidth: 60, halign: 'center' },
      3: { cellWidth: 140 },
      4: { cellWidth: 80, halign: 'center' },
      5: { cellWidth: 170, halign: 'center' }
    }
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(100);
  doc.text('Observer Mission Log · ' + mission + ' · Sortie ' + sortie, M, H - 22);
  doc.text('Sortie record', W - M, H - 22, { align: 'right' });

  // Page 2 — notes, sketch, observations, certification
  doc.addPage();
  pdfHeader(doc, 'Notes & Observations', mission + ' · Sortie ' + sortie + ' · ' + aircraft, [
    'Printed ' + printed
  ]);

  let ny = 88;

  const wmirs = wmirsReport(log);
  if (wmirs.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(ink[0], ink[1], ink[2]);
    doc.text('WMIRS BRIEF & DEBRIEF', M, ny + 6);
    ny += 13;
    const labelW = 112;
    wmirs.forEach(([label, value]) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.2);
      const lines = doc.splitTextToSize(pdfSafe(value), CW - labelW - 10);
      const rowH = Math.max(14, lines.length * 9.4 + 5);
      if (ny + rowH > H - 50) {
        doc.addPage();
        pdfHeader(doc, 'Notes & Observations', mission + ' · Sortie ' + sortie + ' · ' + aircraft, ['Printed ' + printed]);
        ny = 88;
      }
      doc.setDrawColor(170, 170, 170);
      doc.setLineWidth(0.5);
      doc.rect(M, ny, CW, rowH);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.4);
      doc.setTextColor(grey[0], grey[1], grey[2]);
      doc.text(label.toUpperCase(), M + 4, ny + 9);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.2);
      doc.setTextColor(dark[0], dark[1], dark[2]);
      doc.text(lines, M + labelW, ny + 9.5);
      ny += rowH;
    });
    ny += 10;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('NOTES / SKETCHES', M, ny + 6);
  ny += 13;

  const noteText = pdfSafe(log.notes || '');
  const noteLines = noteText ? doc.splitTextToSize(noteText, CW - 10) : [];
  const noteH = Math.max(46, Math.min(160, noteLines.length * 9.6 + 12));
  doc.setDrawColor(170, 170, 170);
  doc.setLineWidth(0.5);
  doc.rect(M, ny, CW, noteH);
  if (noteLines.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(noteLines.slice(0, Math.floor((noteH - 9) / 9.6)), M + 5, ny + 8);
  }
  ny += noteH + 8;

  // every sketch page with something on it, each at its own shape
  log.sketches.filter(sketchHasContent).forEach(page => {
    const ratio = sketchSize(page).h / sketchSize(page).w;
    let sh = Math.min(300, 190 * ratio);
    let sw = sh / ratio;
    if (ny + sh > 460) { sh = Math.min(240, 160 * ratio); sw = sh / ratio; }
    if (ny + sh > H - 40) {
      doc.addPage();
      pdfHeader(doc, 'Notes & Observations (continued)', mission + ' · Sortie ' + sortie, ['Printed ' + printed]);
      ny = 88;
    }
    const sx = (W - sw) / 2;
    try {
      doc.addImage(page.image, 'JPEG', sx, ny, sw, sh);
      doc.setDrawColor(170, 170, 170);
      doc.rect(sx - 2, ny - 2, sw + 4, sh + 4);
    } catch (_) { /* skip a broken image */ }
    ny += sh + 10;
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('OBSERVATIONS', M, ny + 6);
  ny += 13;

  const obsCount = Math.max(4, log.observations.length);
  for (let i = 0; i < obsCount; i++) {
    const obs = log.observations[i];
    const time = obs && obs.time ? obs.time + 'Z' : '______Z';
    const hobbs = obs && obs.hobbs ? obs.hobbs : '______';
    const coords = obs
      ? (pdfCoordPair(obs.lat, obs.lon) || '______ N  /  ______ W')
      : '______ N  /  ______ W';
    const head = 'Obs ' + (i + 1) + '    Time ' + time + '    Hobbs ' + hobbs + '    ' + coords;
    const body = obs ? pdfSafe(obs.text || '') : '';
    const bodyLines = body ? doc.splitTextToSize(body, CW - 10) : [];

    const photos = obs && Array.isArray(obs.photos)
      ? obs.photos
          .map(photo => ({ ...photo, src: safeImage(photo.data) }))
          .filter(photo => photo.src)
          .slice(0, 6)
      : [];
    const photoH = 52;
    const photoGap = 5;
    const photoRows = Math.ceil(photos.length / 3);
    const photoAreaH = photoRows ? photoRows * (photoH + photoGap) + 4 : 0;
    const boxH = Math.max(32, 17 + bodyLines.length * 9.2 + 4 + photoAreaH);

    if (ny + boxH > H - 40) {
      doc.addPage();
      pdfHeader(doc, 'Notes & Observations (continued)', mission + ' · Sortie ' + sortie, ['Printed ' + printed]);
      ny = 88;
    }

    doc.setFillColor(242, 242, 242);
    doc.rect(M, ny, CW, 15, 'F');
    doc.setDrawColor(170, 170, 170);
    doc.rect(M, ny, CW, boxH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(ink[0], ink[1], ink[2]);
    doc.text(pdfSafe(head), M + 4, ny + 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    if (bodyLines.length) doc.text(bodyLines, M + 5, ny + 22);

    if (photos.length) {
      let px = M + 5;
      let py = ny + 17 + bodyLines.length * 9.2 + 6;
      photos.forEach((photo, photoIndex) => {
        let pw = photo.w && photo.h ? photoH * (photo.w / photo.h) : photoH * 1.33;
        if (pw > 84) pw = 84;
        if (photoIndex > 0 && photoIndex % 3 === 0) {
          px = M + 5;
          py += photoH + photoGap;
        }
        try {
          const format = photo.src.startsWith('data:image/png') ? 'PNG' : 'JPEG';
          doc.addImage(photo.src, format, px, py, pw, photoH);
          doc.setDrawColor(170, 170, 170);
          doc.rect(px, py, pw, photoH);
        } catch (_) { /* skip a broken image */ }
        px += pw + photoGap;
      });
    }

    ny += boxH + 5;
  }

  if (ny + 82 > H - 30) {
    doc.addPage();
    pdfHeader(doc, 'Certification', mission + ' · Sortie ' + sortie, ['Printed ' + printed]);
    ny = 88;
  }

  ny += 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.text('CERTIFICATION', M, ny + 6);
  ny += 14;

  const signature = safeImage(log.signoff.signature);
  if (signature) {
    try { doc.addImage(signature, 'JPEG', M, ny, 180, 43); } catch (_) { /* ignore */ }
  }

  doc.setDrawColor(60);
  doc.setLineWidth(0.7);
  doc.line(M, ny + 50, M + 200, ny + 50);
  doc.line(M + 220, ny + 50, M + 366, ny + 50);
  doc.line(M + 376, ny + 50, M + 446, ny + 50);
  doc.line(M + 456, ny + 50, W - M, ny + 50);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(dark[0], dark[1], dark[2]);
  if (log.signoff.name) doc.text(pdfSafe(log.signoff.name), M + 220, ny + 38);
  if (log.signoff.capid) doc.text(pdfSafe(log.signoff.capid), M + 376, ny + 38);
  doc.text(pdfSafe(log.signoff.dateTime || printed), M + 456, ny + 38);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6);
  doc.setTextColor(grey[0], grey[1], grey[2]);
  doc.text('SIGNATURE', M, ny + 59);
  doc.text('PRINTED NAME', M + 220, ny + 59);
  doc.text('CAPID', M + 376, ny + 59);
  doc.text('DATE TIME (DDhhmmZ MMM YY)', M + 456, ny + 59);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(100);
  doc.text('Observer Mission Log · ' + mission + ' · Sortie ' + sortie, M, H - 22);
  doc.text('Notes & observations', W - M, H - 22, { align: 'right' });

  // SAR results worksheet (CAPF 104a) — only when something was entered
  if (sarHasData(log.sar)) {
    const report = sarReport(log);
    doc.addPage();
    pdfHeader(doc, 'SAR Results Worksheet', 'CAPF 104a · ' + mission + ' · Sortie ' + sortie + ' · ' + aircraft, [
      'Printed ' + printed
    ]);

    const sarFooter = () => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(100);
      doc.text(pdfSafe('Observer Mission Log · ' + mission + ' · Sortie ' + sortie), M, H - 22);
      doc.text('SAR results worksheet', W - M, H - 22, { align: 'right' });
    };
    const sarTitle = (text, top) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(text, M, top + 6);
    };
    const sarTable = (startY, head, body, columnStyles) => {
      doc.autoTable({
        startY,
        margin: { left: M, right: M, top: 40, bottom: 40 },
        tableWidth: CW,
        head: head ? [head] : undefined,
        body: body.map(row => row.map(value => pdfSafe(value))),
        theme: 'grid',
        styles: {
          font: 'helvetica', fontSize: 8, cellPadding: 3.2, textColor: dark,
          lineColor: [150, 150, 150], lineWidth: 0.4, overflow: 'linebreak'
        },
        headStyles: { fillColor: [235, 235, 235], textColor: ink, fontSize: 6.2, fontStyle: 'bold' },
        columnStyles,
        didDrawPage: sarFooter
      });
      return doc.lastAutoTable.finalY;
    };
    const labelCol = { fontStyle: 'bold', textColor: grey, fontSize: 7 };

    let sy = 88;
    sarTitle('MISSION DATA', sy);
    const metaRows = [];
    for (let i = 0; i < report.meta.length; i += 2) {
      metaRows.push([report.meta[i][0], report.meta[i][1], report.meta[i + 1][0], report.meta[i + 1][1]]);
    }
    sy = sarTable(sy + 12, null, metaRows, {
      0: Object.assign({ cellWidth: 104 }, labelCol), 1: { cellWidth: CW / 2 - 104 },
      2: Object.assign({ cellWidth: 104 }, labelCol), 3: { cellWidth: CW / 2 - 104 }
    });

    sarTitle('SEARCH AREA', sy + 10);
    sy = sarTable(sy + 22, ['CORNER', 'LATITUDE', 'LONGITUDE'], report.corners, {
      0: Object.assign({ cellWidth: 150 }, labelCol)
    });

    sarTitle('SORTIE SEARCH PLAN VERSUS ACTUAL', sy + 10);
    sy = sarTable(sy + 22, ['VARIABLE', 'PLANNED', 'ACTUAL'], report.rows, {
      0: Object.assign({ cellWidth: 150 }, labelCol)
    });

    sarTitle('CREW REMARKS & NOTES', sy + 10);
    sarTable(sy + 22, null, [[report.comments || ' ']], { 0: { minCellHeight: 54 } });
  }

  return doc.output('blob');
}

/* ---------- CAPF 104 ----------
   The sortie on the CAP's own fillable CAPF 104 (Dec 21), shipped with the
   app as vendor/capf104.pdf: pdf-lib fills its form fields and the layout is
   the original's. The fields stay editable, so a debriefer can add to it.
   Field names are the form's own; its unnamed checkboxes ("undefined_N") are
   mapped here by where they sit on the page. */
const CAPF104_PIC_QUALS = { MP: 'MP', COM: 'COM', Trainee: 'Trainee', TMP: 'undefined_5', IFR: 'undefined_6',
  MFC: 'MFC', Night: 'Night', WS: 'undefined_7', LES: 'undefined_8' };
const CAPF104_CREW1_QUALS = { MCP: 'MCP', COM: 'COM_2', MO: 'MO', HRO: 'HRO', MP: 'MP_2', IFR: 'IFR', MS: 'MS',
  LES: 'LES', TMP: 'TMP', Night: 'Night_2', ADIS: 'ADIS', Trainee: 'Trainee_2', MFC: 'MFC_2', WS: 'WS', AP: 'AP', Other: 'Other_3' };
// crew members 2–7: nine boxes each, down the columns MS MO HRO · WS ADIS LES · AP Trainee Other
const CAPF104_CREW_ORDER = ['MS', 'MO', 'HRO', 'WS', 'ADIS', 'LES', 'AP', 'Trainee', 'Other'];
const CAPF104_EQUIPMENT = { aeronet: 'AERONet', capFm: 'CAP FM Radio', camera: 'Digital Camera', survivalKit: 'Survival Kit',
  satPhone: 'Sat Phone', vor: 'VOR', dme: 'DME', autopilot: 'Autopilot', gps: 'GPS', flir: 'FLIR',
  becker: 'Becker  Rho Theta DF', ltronics: 'LTronics DF', repeater: 'Tactical Repeater', lifeRaft: 'Life Raft  Vests', other: 'undefined_63' };
const CAPF104_ATTACHMENTS = { orm: 'AIF ORM Matrix', recon104b: 'CAPF 104b Recon Summary', ics214: 'ICSF 214 Unit Log',
  receipts: 'Receipts', sar104a: 'CAPF 104a SAR', other: 'Results Worksheet' };
const CAPF104_REASONS = { Weather: 'Weather', 'Aircraft Maintenance': 'Aircraft Maintenance', 'Equipment Failure': 'Equipment Failure',
  'Crew Unavailable': 'Crew Unavailable', 'Customer Cancellation': 'Customer Cancellation', Other: 'undefined_4' };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(el);
  });
}

// Every value the form takes, by its field name: text as strings, boxes as true.
function capf104Values(log) {
  const mission = missionOf(log);
  const b = log.brief;
  const a = log.aircraftInfo;
  const d = log.debrief;
  const totals = timeTotals(log);
  const tach = tachValues(log);
  const one = value => value == null ? '' : fmtDecimal(value, 1);
  const zulu = value => isValidTime(value) ? value + 'Z' : '';
  const who = (name, capid) => [String(name || '').trim(), String(capid || '').trim()].filter(Boolean).join(' · CAPID ');
  const lines = (...parts) => parts.map(p => String(p || '').trim()).filter(Boolean).join('\n');
  const text = {
    // page 1: mission data, manifest, aircraft, releasing officers
    'TRACKING NUMBER': log.sar.tracking || log.sortie,
    'Mission Number': mission.number,
    'Mission Name': mission.name,
    'Mission Symbol': mission.symbol,
    'Mission Date': mission.date,
    'Crew Contact Phone Email etc': log.crewContact,
    'Tail Number': log.aircraft,
    'Callsign': log.callsign,
    'Type': a.type,
    'TAS Knots': a.tas,
    'ColorDescription': a.color,
    'Fuel In Hours': a.fuelHours,
    'Home Base': a.homeBase,
    'Other_4': a.equipmentOther,
    'Briefer Name  CAPID': who(b.briefer, b.brieferCapid),
    'Flight Release Officer Name  CAPID': who(b.fro, b.froCapid),
    // page 2: briefing
    'WMIRS Sortie': log.sortie,
    'WMIRS Sortie Type': log.sortieType,
    'WMIRS Sortie Objective': b.objective,
    'WMIRS Area of Operations': b.areaOfOps,
    'Dep Airport': log.depAirport,
    'Dest Airport': log.destAirport,
    'ETDz': zulu(b.etd),
    'ETE': b.ete,
    'Base Telephone': b.basePhone,
    'Base Callsign': log.radio.baseCallsign,
    'Base': log.radio.baseFreq,
    'AirGround': log.radio.airGround,
    'AirAir': log.radio.airAir,
    'Required Radio Checks  Contacts': b.radioChecks,
    'Other Aircraft in Area Location  Callsign': b.otherAircraft,
    'Ground Teams in Area Location  Callsign': b.groundTeams,
    'Sortie Objectives': log.objectives,
    'Sortie Deliverables': log.deliverables,
    'Actions To Be Taken on Objectives  Deliverables': b.actions,
    'Route Of Flight': log.route,
    'Altitude Assignment  Restrictions': lines(log.altitude, b.altitudeRestrictions),
    'Airspeed Expected  Restrictions': lines(log.airspeed, b.airspeedRestrictions),
    'Aircraft Separation Adjoining Areas': b.separation,
    'Emergency  Alternate Fields': b.alternates,
    'Military Low Altitude Training Routes': b.mtrs,
    'Hazards To Flight': b.hazards,
    'Current Local': b.weather.currentLocal,
    'Current Enroute': b.weather.currentEnroute,
    'Current Area of Operations': b.weather.currentArea,
    'Forecast Local': b.weather.forecastLocal,
    'Forecast Enroute': b.weather.forecastEnroute,
    'Forecast Area of Operations': b.weather.forecastArea,
    // page 3: risk and crew notes
    'Special Instructions Including Risk Mitigation Procedures': b.specialInstructions,
    'CREW NOTESRow1': log.notes,
    // page 4: debrief
    'ATD Z': zulu(log.times.engineStart.time),
    'ATA Z': zulu(log.times.shutDown.time),
    'Hobbs End': log.times.shutDown.hobbs,
    'Hobbs Start': log.times.engineStart.hobbs,
    'Tach End': tach.end,
    'Tach Start': tach.start,
    'Hobbs ToFrom': one(totals.hobbsToFrom),
    'Hobbs in Area': one(totals.hobbsArea),
    'Hobbs Total': one(totals.hobbs),
    'Fuel Used Gal': d.fuelGal,
    'Oil Used Qt': d.oilQt,
    'Fuel  Oil Cost': String(d.fuelCost || '').trim() ? '$' + String(d.fuelCost).trim().replace(/^\$/, '') : '',
    'Receipt': d.receipt,
    'Summary': d.summary,
    'ResultsDeliverables': d.results,
    'Weather Conditions': d.weather,
    'Remarks CAPF 104b Reconnaissance Summary ICSF 214 Unit Log Receipts': d.remarks,
    'Other': d.reason === 'Other' ? d.reasonOther : '',
    'Other_2': d.attachmentsOther,
    'Debriefer Name  CAPID': who(d.debriefer, d.debrieferCapid),
    'Time  Date Debriefed': d.debriefedAt
  };
  const boxes = {
    'Flight Plan Required': b.fpRequired,
    'Flight Plan Filed': b.fpFiled,
    'Flight Plan Opened': b.fpOpened,
    'Flight Plan Closed': d.flightPlanClosed,
    'ORM Matrix Complete': b.ormComplete,
    'Risk Assessment Approval': b.riskApproval,
    'Low': b.riskLevel === 'Low',
    'Moderate': b.riskLevel === 'Moderate',
    'High': b.riskLevel === 'High',
    'Phone_2': b.phoneBriefing,
    'Phone': d.phoneDebrief,
    'CAP': a.owner === 'CAP',
    'Member': a.owner === 'Member Owned',
    'Wing Paid': d.wingPaid,
    // the attachment boxes beside Remarks repeat three of the attachments
    'undefined': d.attachments.recon104b,
    'undefined_2': d.attachments.ics214,
    'undefined_3': d.attachments.receipts
  };
  SORTIE_EFFECTIVENESS.forEach(option => { boxes[option] = d.effectiveness === option; });
  if (d.effectiveness && d.effectiveness !== 'Successful' && CAPF104_REASONS[d.reason]) boxes[CAPF104_REASONS[d.reason]] = true;
  Object.entries(CAPF104_EQUIPMENT).forEach(([key, name]) => { boxes[name] = !!a.equipment[key]; });
  Object.entries(CAPF104_ATTACHMENTS).forEach(([key, name]) => { boxes[name] = !!d.attachments[key]; });

  // the manifest: the first mission pilot in command, then everyone else in crew order
  const people = crewInOrder(log).filter(m => String(m.name || '').trim() || String(m.capid || '').trim());
  const picIndex = people.findIndex(m => m.role === 'MP');
  const pic = picIndex >= 0 ? people.splice(picIndex, 1)[0] : null;
  if (pic) {
    text['Pilot In Command Name  CAPID'] = who(pic.name, pic.capid);
    Object.entries(CAPF104_PIC_QUALS).forEach(([q, name]) => { if (pic.quals[q]) boxes[name] = true; });
  }
  people.slice(0, 7).forEach((m, i) => {
    text['Crew Member  Passenger ' + (i + 1) + ' Name  CAPID'] = who(m.name, m.capid) + (m.role === 'PAX' ? ' (passenger)' : '');
    // the form's boxes are the seat's qualifications; the role ticks its own box
    const quals = Object.assign({}, m.quals, { [m.role]: true });
    if (i === 0) {
      Object.entries(CAPF104_CREW1_QUALS).forEach(([q, name]) => { if (quals[q]) boxes[name] = true; });
    } else {
      const base = 9 + 9 * (i - 1);
      CAPF104_CREW_ORDER.forEach((q, k) => { if (quals[q]) boxes['undefined_' + (base + k)] = true; });
    }
  });
  if (pic && !pic.quals.MP) boxes.MP = true;   // the PIC's seat is the mission pilot's
  return { text, boxes, extraCrew: people.length > 7 ? people.slice(7) : [] };
}

// The largest size, 9 pt down to 5, at which text fits a box: on one line,
// or wrapped at words when the box is tall.
function fitFontSize(font, text, width, height, multi) {
  for (let size = 9; size > 5; size -= 0.5) {
    if (!multi) {
      if (font.widthOfTextAtSize(text, size) <= width && size * 1.15 <= height) return size;
      continue;
    }
    let lines = 0;
    text.split('\n').forEach(para => {
      let line = '';
      lines++;
      para.split(/\s+/).forEach(word => {
        const next = line ? line + ' ' + word : word;
        if (line && font.widthOfTextAtSize(next, size) > width) { lines++; line = word; } else line = next;
      });
    });
    if (lines * size * 1.18 <= height) return size;
  }
  return 5;
}

async function buildCapf104Blob(log) {
  if (!window.PDFLib) await loadScript('vendor/pdf-lib.min.js');
  const { PDFDocument, StandardFonts } = window.PDFLib;
  const res = await fetch('vendor/capf104.pdf');
  if (!res.ok) throw new Error('blank CAPF 104 missing');
  const doc = await PDFDocument.load(await res.arrayBuffer());
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { text, boxes, extraCrew } = capf104Values(log);
  if (extraCrew.length) {
    text['CREW NOTESRow1'] = ['More crew: ' + extraCrew.map(m => [m.role, m.name, m.capid && 'CAPID ' + m.capid].filter(Boolean).join(' ')).join('; '),
      text['CREW NOTESRow1']].filter(Boolean).join('\n\n');
  }
  Object.entries(text).forEach(([name, value]) => {
    const clean = pdfSafe(value).trim();
    if (!clean) return;
    let field;
    try { field = form.getTextField(name); } catch (_) { console.warn('CAPF 104 has no text field', name); return; }
    // 9 pt where it fits; smaller (down to 5) where it does not. A box taller
    // than a line wraps.
    const widget = field.acroField.getWidgets()[0];
    const rect = widget ? widget.getRectangle() : { width: 200, height: 12 };
    const multi = rect.height > 22 || /\n/.test(clean);
    if (multi) field.enableMultiline();
    const size = fitFontSize(font, clean, rect.width - 4, rect.height - 3, multi);
    field.acroField.setDefaultAppearance('/Helv ' + size + ' Tf 0 g');
    field.setText(clean);
  });
  Object.entries(boxes).forEach(([name, on]) => {
    if (!on) return;
    try { form.getCheckBox(name).check(); } catch (_) { console.warn('CAPF 104 has no checkbox', name); }
  });
  form.updateFieldAppearances(font);
  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function exportCapf104() {
  if (!needSortie()) return;
  const log = activeSortie();
  toast('Filling in the CAPF 104…');
  try {
    const blob = await buildCapf104Blob(log);
    await shareFile(exportName('pdf').replace(/^mission-log_/, 'CAPF104_'), blob);
  } catch (err) {
    console.warn('CAPF 104 failed', err);
    toast('Could not fill in the CAPF 104');
  }
}

function exportPdf() {
  try {
    const blob = buildPdfBlob();
    shareFile(exportName('pdf'), blob).catch(err => {
      console.warn('PDF share failed', err);
      toast('PDF built, but sharing failed');
    });
    toast('PDF ready — choose Save to Files or Print');
  } catch (err) {
    console.warn('PDF build failed', err);
    toast('Could not build the PDF. Export a backup instead.');
  }
}

function resetAll() {
  if (!confirm('Erase every log stored on this iPad? Export a backup first if you need one.')) return;
  const { termsAccepted, termsAcceptedAt } = state.settings;
  state = newState();
  Object.assign(state.settings, { termsAccepted, termsAcceptedAt });   // erasing logs is not un-accepting
  applyTheme();
  closeSheet();
  activeTab = defaultTab();
  save();
  render();
  toast('All logs erased');
}

/* =========================================================================
   Print
   ========================================================================= */

function buildPrint() {
  const log = activeLog();
  const totals = timeTotals(log);

  const coordText = (latRaw, lonRaw) => {
    const lat = parseLat(latRaw);
    const lon = parseLon(lonRaw);
    if (lat == null || lon == null) return '—';
    return fmtCoord(lat, true) + ' / ' + fmtCoord(lon, false);
  };

  const cell = (label, value, extraClass) => `<div class="p-cell ${extraClass || ''}">
    <div class="pl">${esc(label)}</div>
    <div class="pv">${value ? esc(value) : '&nbsp;'}</div>
  </div>`;

  const crewPrint = crewForPrint(log);
  const crewTable = `<table class="p-table p-crew">
      <thead><tr><th class="c">Role</th><th>Name</th><th class="c">CAPID</th><th class="c">Role</th><th>Name</th><th class="c">CAPID</th></tr></thead>
      <tbody>${Array.from({ length: Math.max(1, Math.ceil(crewPrint.length / 2)) }, (_, r) => '<tr>' +
        [crewPrint[r * 2], crewPrint[r * 2 + 1]].map(m => m
          ? `<td class="c"><b>${esc(m.role)}</b></td><td>${esc(m.name)}</td><td class="c mono">${esc(m.capid)}</td>`
          : '<td></td><td></td><td></td>').join('') + '</tr>').join('')}</tbody>
    </table>`;

  const headerCells = [
    cell('Mission / symbol', [missionOf(log).number, missionOf(log).symbol].filter(Boolean).join(' / ')),
    cell('Sortie', log.sortie),
    cell('Sortie type', log.sortieType),
    cell('Tail No.', log.aircraft),
    cell('Call sign', log.callsign),
    cell('Dep. / Dest.', [log.depAirport, log.destAirport].filter(Boolean).join(' – ')),
    cell('Sectional', log.sectional),
    cell('Grid', log.grid),
    cell('Altitude', log.altitude),
    cell('Airspeed', log.airspeed),
    cell('Entry point', coordText(log.entry.lat, log.entry.lon)),
    cell('Exit point', coordText(log.exit.lat, log.exit.lon)),
    cell('Main radio', log.radio.main),
    cell('Guard radio', log.radio.guard),
    cell('ATIS / AWOS', log.radio.atis),
    cell('CTAF', log.radio.ctaf)
  ].join('');

  const timesRows = TIME_DEFS.map(def => {
    const value = log.times[def.key] || {};
    return `<tr>
      <td class="lbl">${esc(def.label)}</td>
      <td class="t">${value.time ? esc(value.time + 'Z') : ''}</td>
      <td class="h">${value.hobbs ? esc(value.hobbs) : ''}</td>
    </tr>`;
  }).join('');

  const entries = log.entries.slice();
  const blankEntries = Math.max(0, 10 - entries.length);
  const entryRows = entries.map(entry => `<tr>
    <td class="c mono">${entry.time ? esc(entry.time + 'Z') : ''}</td>
    <td class="c mono">${esc(entry.hobbs || '')}</td>
    <td class="c mono">${esc(fmtCoord(parseLat(entry.lat), true) || '')}</td>
    <td class="c mono">${esc(fmtCoord(parseLon(entry.lon), false) || '')}</td>
    <td>${esc(entry.event || '')}</td>
    <td class="remark">${esc(entry.note || '')}</td>
  </tr>`).join('') +
    Array.from({ length: blankEntries }, () => '<tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');

  const opsRows = log.ops.map((op, index) => `<tr>
    <td class="c">${index + 1}</td>
    <td class="c mono">${op.time ? esc(op.time + 'Z') : ''}</td>
    <td class="c mono">${esc(op.hobbs || '')}</td>
    <td>${esc(op.fuel || '')}</td>
    <td class="c mono">${esc(op.altimeter || '')}</td>
    <td class="c">${op.normal ? 'Normal' : 'Flagged'}</td>
  </tr>`).join('') +
    Array.from({ length: Math.max(0, 3 - log.ops.length) }, () => '<tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');

  const obsList = log.observations.slice();
  const obsBlocks = obsList.map((obs, index) => {
    const photos = (obs.photos || []).map(photo => safeImage(photo.data)).filter(Boolean);
    return `<div class="p-obs">
      <div class="p-obs-head">
        <b>Obs ${index + 1}</b>
        <span>Time ${obs.time ? esc(obs.time + 'Z') : '________'}</span>
        <span>Hobbs ${esc(obs.hobbs || '________')}</span>
        <span>${esc(coordPair(obs.lat, obs.lon) || '________ N  ________ W')}</span>
      </div>
      <div class="p-obs-body">${esc(obs.text || '')}</div>
      ${photos.length ? `<div class="p-obs-photos">${photos.map(src => `<img src="${src}" alt="">`).join('')}</div>` : ''}
    </div>`;
  }).join('') +
    Array.from({ length: Math.max(0, Math.min(4, 4 - obsList.length)) }, (_, i) => `<div class="p-obs">
      <div class="p-obs-head"><b>Obs ${obsList.length + i + 1}</b><span>Time ______Z</span><span>Hobbs ______</span><span>______ N  ______ W</span></div>
      <div class="p-obs-body">&nbsp;</div>
    </div>`).join('');

  const signatureSource = safeImage(log.signoff.signature);
  const signature = signatureSource
    ? `<img src="${signatureSource}" alt="Signature">`
    : '&nbsp;';
  const sketchSources = log.sketches.filter(sketchHasContent).map(page => page.image);

  const printDate = fmtDateZ(new Date());

  $('#print').innerHTML = `
    <section class="print-page">
      <div class="p-head">
        <div class="p-brand">
          <div>
            <div class="p-title">Observer Mission Log</div>
            <div class="p-sub">Civil Air Patrol · sortie record</div>
          </div>
        </div>
        <div class="p-head-right">
          <div><b>Printed</b> ${esc(printDate)}</div>
          <div><b>Entries</b> ${log.entries.length}</div>
        </div>
      </div>

      <div class="p-meta">${headerCells}</div>
      <div class="p-section" style="margin-top:0;margin-bottom:7pt"><div class="p-section-title">Crew</div>${crewTable}</div>

      <div class="p-cols">
        <div class="p-section" style="margin-top:0">
          <div class="p-section-title">Times</div>
          <table class="p-table p-times">
            <thead><tr><th>Event</th><th class="c">Time (Z)</th><th class="c">Hobbs</th></tr></thead>
            <tbody>${timesRows}</tbody>
          </table>
        </div>
        <div class="p-section" style="margin-top:0">
          <div class="p-section-title">Totals</div>
          <div class="p-totals">
            <div class="p-total"><div class="tl">Flight time</div><div class="tv">${fmtDuration(totals.flight)}</div></div>
            <div class="p-total"><div class="tl">ATA − ATD</div><div class="tv">${fmtDuration(totals.engine)}</div></div>
            <div class="p-total"><div class="tl">Total tach</div><div class="tv">${totals.tach == null ? '—' : fmtDecimal(totals.tach, 1)}</div></div>
            <div class="p-total"><div class="tl">Hobbs used</div><div class="tv">${totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1)}</div></div>
          </div>
          <div class="p-note">Tach start ${esc(tachValues(log).start || '________')} · Tach end ${esc(tachValues(log).end || '________')}</div>
        </div>
      </div>

      <div class="p-section">
        <div class="p-section-title">Sortie log</div>
        <table class="p-table">
          <thead><tr>
            <th style="width:9%">Time</th>
            <th style="width:10%">Hobbs</th>
            <th style="width:16%">Latitude N</th>
            <th style="width:17%">Longitude W</th>
            <th style="width:20%">Event</th>
            <th>Remarks</th>
          </tr></thead>
          <tbody>${entryRows}</tbody>
        </table>
      </div>

      <div class="p-section">
        <div class="p-section-title">OPS status checks</div>
        <table class="p-table">
          <thead><tr><th class="c" style="width:5%">#</th><th class="c" style="width:11%">Time</th><th class="c" style="width:11%">Hobbs</th><th style="width:18%">Fuel</th><th class="c" style="width:14%">Altimeter</th><th style="width:14%">Status</th></tr></thead>
          <tbody>${opsRows}</tbody>
        </table>
      </div>

      <div class="p-footer">
        <span>Observer Mission Log · ${esc(missionOf(log).number || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
        <span>Sortie record</span>
      </div>
    </section>

    <section class="print-page">
      <div class="p-head">
        <div class="p-brand">
          <div>
            <div class="p-title">Notes &amp; Observations</div>
            <div class="p-sub">${esc(missionOf(log).number || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')} · ${esc(log.aircraft || 'No tail')}</div>
          </div>
        </div>
        <div class="p-head-right"><b>Printed</b> ${esc(printDate)}</div>
      </div>

      ${wmirsReport(log).length ? `<div class="p-section" style="margin-top:0">
        <div class="p-section-title">WMIRS brief &amp; debrief</div>
        <table class="p-table p-wmirs"><tbody>${wmirsReport(log).map(([label, value]) =>
          `<tr><td class="lbl">${esc(label)}</td><td class="remark">${esc(value)}</td></tr>`).join('')}</tbody></table>
      </div>` : ''}

      <div class="p-section"${wmirsReport(log).length ? '' : ' style="margin-top:0"'}>
        <div class="p-section-title">Notes / sketches</div>
        <div class="p-notes-text">${esc(log.notes || '')}</div>
        ${sketchSources.map((src, i) => `<div class="p-sketch"><img src="${src}" alt="Sketch page ${i + 1}"></div>`).join('')}
      </div>

      <div class="p-section">
        <div class="p-section-title">Observations</div>
        ${obsBlocks}
      </div>

      <div class="p-section">
        <div class="p-section-title">Certification</div>
        <div class="p-sign">
          <div class="sig-block">
            <div class="line">${signature}</div>
            <div class="cap">Signature</div>
          </div>
          <div class="sig-block">
            <div class="line">${log.signoff.name ? esc(log.signoff.name) : '&nbsp;'}</div>
            <div class="cap">Printed name</div>
          </div>
          <div class="sig-block">
            <div class="line">${log.signoff.capid ? esc(log.signoff.capid) : '&nbsp;'}</div>
            <div class="cap">CAPID</div>
          </div>
          <div class="sig-block">
            <div class="line">${log.signoff.dateTime ? esc(log.signoff.dateTime) : esc(fmtDateZ(new Date()))}</div>
            <div class="cap">Date time (DDhhmmZ MMM YY)</div>
          </div>
        </div>
      </div>

      <div class="p-footer">
        <span>Observer Mission Log · ${esc(missionOf(log).number || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
        <span>Notes &amp; observations</span>
      </div>
    </section>
    ${sarPrintPage(log, printDate)}
  `;
}

function sarPrintPage(log, printDate) {
  if (!sarHasData(log.sar)) return '';
  const report = sarReport(log);
  const td = value => `<td>${value ? esc(value) : '&nbsp;'}</td>`;
  return `
    <section class="print-page">
      <div class="p-head">
        <div class="p-brand">
          <div>
            <div class="p-title">SAR Results Worksheet</div>
            <div class="p-sub">CAPF 104a · ${esc(missionOf(log).number || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</div>
          </div>
        </div>
        <div class="p-head-right"><div><b>Printed</b> ${esc(printDate)}</div></div>
      </div>

      <div class="p-meta two">${report.meta.map(([label, value]) => `<div class="p-cell wide">
        <div class="pl">${esc(label)}</div>
        <div class="pv">${value ? esc(value) : '&nbsp;'}</div>
      </div>`).join('')}</div>

      <div class="p-section">
        <div class="p-section-title">Search area</div>
        <table class="p-table">
          <thead><tr><th style="width:26%">Corner</th><th>Latitude</th><th>Longitude</th></tr></thead>
          <tbody>${report.corners.map(row => `<tr>${row.map(td).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="p-section">
        <div class="p-section-title">Sortie search plan versus actual</div>
        <table class="p-table">
          <thead><tr><th style="width:26%">Variable</th><th>Planned</th><th>Actual</th></tr></thead>
          <tbody>${report.rows.map(row => `<tr>${row.map(td).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="p-section">
        <div class="p-section-title">Crew remarks &amp; notes</div>
        <div class="p-notes-text">${esc(report.comments)}</div>
      </div>

      <div class="p-footer">
        <span>Observer Mission Log · ${esc(missionOf(log).number || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
        <span>SAR results worksheet</span>
      </div>
    </section>`;
}

/* =========================================================================
   Events
   ========================================================================= */

const actions = {
  'tab': el => {
    const tab = el.dataset.tab;
    if (tab) switchTab(tab);
  },
  'install-app': async () => {
    if (!installPromptEvent) return;
    const prompt = installPromptEvent;
    installPromptEvent = null;
    prompt.prompt();
    try { await prompt.userChoice; } catch (_) { /* dismissed */ }
    render();
  },
  'dismiss-install': () => {
    state.settings.installDismissed = true;
    save();
    render();
    toast('Find the steps later under Menu → Help & install');
  },
  // the header's mission: its details, or Add Mission when none is picked
  'edit-mission': () => openMissionSheet(),
  'toggle-mission-closed': () => {
    const mission = activeMission();
    if (mission) setMissionClosed(mission, !mission.closed);
  },
  'show-missions': () => switchTab('logbook'),
  'open-mission': el => {
    if (!missionById(el.dataset.id)) return;
    const sorties = missionSorties(el.dataset.id);
    state.activeMissionId = el.dataset.id;
    state.activeId = sorties.length ? sorties[sorties.length - 1].id : '';
    save();
    switchTab('logbook');
  },
  'del-mission': () => deleteMission(),
  'new-mission': () => openNewMissionSheet(),
  'nm-save': () => saveNewMission(),
  'nm-today': () => { const d = $('#nm-date'); if (d) d.value = todayMissionDate(); },
  'ns-save': () => saveAddSortie(),
  // from Brief: on to Fly, where the sortie's flight log is kept
  'start-flight-log': () => switchTab('fly'),
  'goto-ops': () => {
    if (activeTab !== 'fly') switchTab('fly');
    setFlyLog(true, 'full');
    const card = $('#ops-card');
    if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 280);
  },
  'quick': el => quickLog(el.dataset.kind, el.dataset.label || 'Log entry'),
  'add-entry': () => openEntrySheet(null),
  'add-checkpoint': () => openEntrySheet(null),
  'edit-entry': el => openEntrySheet(el.dataset.id),
  'del-entry': el => deleteEntry(el.dataset.id),
  'save-entry': el => saveEntryFromSheet(el.dataset.id || null),
  'delete-entry-sheet': el => deleteEntry(el.dataset.id),
  'fill-now': el => {
    const target = $(el.dataset.target);
    if (target) {
      target.value = nowZ();
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  },
  'fill-last-hobbs': el => {
    const target = $(el.dataset.target);
    if (target) {
      target.value = lastHobbs(activeLog());
      setKeypadFresh(target, true);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  },
  'keypad': el => keypadPress(el.dataset.target, el.dataset.key),
  'toggle-keypad': el => {
    const panel = $(el.dataset.panel);
    const target = $(el.dataset.target);
    if (!panel || !target) return;
    panel.hidden = !panel.hidden;
    el.classList.toggle('on', !panel.hidden);
    // With the keypad up, keep the system keyboard down.
    target.setAttribute('inputmode', panel.hidden ? 'decimal' : 'none');
    if (panel.hidden) target.focus(); else target.blur();
  },
  'save-hobbs': el => saveHobbsFromSheet(el.dataset.id),
  'obs-pop-done': () => closeObsPop(false),
  'obs-pop-discard': () => {
    const pop = $('#obs-pop');
    const obs = pop && activeLog().observations.find(o => o.id === pop.dataset.obs);
    const empty = obs && !String(obs.text || '').trim() && !(obs.photos && obs.photos.length);
    if (!empty && !confirm('Discard this observation and its photos?')) return;
    closeObsPop(true);
  },
  'kp-pop-skip': () => closeHobbsPopover(),
  'hobbs-next': () => {
    const tach = $('#k-tach');
    if (tach) setMeterActive(tach);
  },
  'toggle-hobbs-prompt': () => {
    state.settings.hobbsPrompt = !state.settings.hobbsPrompt;
    save();
    settingsSheet();
  },
  'copy-entry': () => {
    const log = activeLog();
    const latInput = $('[data-bind="exit.lat"]');
    const lonInput = $('[data-bind="exit.lon"]');
    if (latInput) {
      latInput.value = log.entry.lat;
      latInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (lonInput) {
      lonInput.value = log.entry.lon;
      lonInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    toast('Exit point copied from entry');
  },
  'gps-sheet': async el => {
    const done = gpsBusy(el);
    try {
      const fix = await requestGps(true);
      fillCoordPair($('#f-lat'), $('#f-lon'), fix);
      const status = $('#gps-sheet-status');
      if (status) status.textContent = gpsStatusText(fix);
      toast('GPS position captured · ±' + Math.round(fix.accuracy) + ' m');
    } catch (err) {
      toast(gpsErrorText(err));
    } finally {
      done();
    }
  },
  'gps-obs': async el => {
    const log = activeLog();
    const obs = log.observations.find(o => o.id === el.dataset.id);
    if (!obs) return;
    const card = el.closest('.obs');
    const done = gpsBusy(el);
    try {
      const fix = await requestGps(true);
      applyGpsToObservation(obs, fix, card);
      save();
      toast('Observation position captured · ±' + Math.round(fix.accuracy) + ' m');
    } catch (err) {
      toast(gpsErrorText(err));
    } finally {
      done();
    }
  },
  'toggle-gps-live': () => {
    state.settings.gpsLive = !state.settings.gpsLive;
    save();
    if (state.settings.gpsLive) startGpsWatch(); else stopGpsWatch();
    settingsSheet();
  },
  'gps-chip': () => {
    if (!state.settings.gpsLive) {
      state.settings.gpsLive = true;
      save();
    }
    if (!lastGpsFix) {
      if (gpsState === 'denied') { toast(gpsErrorText({ code: 1 })); return; }
      if (gpsState === 'unavailable') { toast(gpsErrorText(window.isSecureContext ? { unsupported: true } : { secure: true })); return; }
      if (gpsWatchId == null) startGpsWatch();
    }
    // the header's position shows the position card on Fly's map, centred on
    // the aircraft; tapped again on Fly, it hides the card
    if (activeTab === 'fly' && flyPosOpen) { setFlyPos(false); return; }
    flyPosOpen = true;
    if (activeTab !== 'fly') switchTab('fly');
    else setFlyPos(true);
    actions['pos-recenter']();
  },
  'fly-pos-hide': () => setFlyPos(false),
  'pos-recenter': () => {
    const fix = freshFix() || lastGpsFix;
    if (!positionMap) return;
    if (!fix) { toast('No GPS position yet'); return; }
    positionMap.follow = true;
    positionMap.map.setView([fix.lat, fix.lon], Math.max(positionMap.map.getZoom(), chartFullZoom()));
  },
  'fly-zoom': el => {
    if (!positionMap) return;
    if (Number(el.dataset.step) > 0) positionMap.map.zoomIn(); else positionMap.map.zoomOut();
  },
  'fly-log': () => setFlyLog(!flyLogOpen, 'half'),
  'obs-expand': el => { expandedObs.add(el.dataset.id); render(); },
  'obs-collapse': el => { expandedObs.delete(el.dataset.id); render(); },
  'track-map': () => {
    switchTab('fly');
    setTimeout(() => drawTrackOnMap(true), 80);
  },
  'track-gpx': () => {
    const log = activeLog();
    if (!log.track.length) return;
    shareFile(exportName('gpx'), new Blob([trackGPX(log)], { type: 'application/gpx+xml' }));
  },
  'toggle-record-track': () => {
    state.settings.recordTrack = !state.settings.recordTrack;
    save();
    settingsSheet();
  },
  'add-obs': () => addObservation(),
  'del-obs': el => {
    const log = activeLog();
    const index = log.observations.findIndex(o => o.id === el.dataset.id);
    if (index < 0) return;
    const [removed] = log.observations.splice(index, 1);
    save();
    render();
    toast('Observation deleted', 'Undo', () => {
      log.observations.splice(index, 0, removed);
      save();
      render();
    });
  },
  'add-photo': el => addObservationPhoto(el.dataset.obs),
  'view-photo': el => viewObservationPhoto(el.dataset.obs, Number(el.dataset.index)),
  'delete-photo': el => deleteObservationPhoto(el.dataset.obs, el.dataset.photo),
  'ops-add': () => addOpsCheck(),
  'del-ops': el => {
    const log = activeLog();
    const index = log.ops.findIndex(o => o.id === el.dataset.id);
    if (index < 0) return;
    const [removed] = log.ops.splice(index, 1);
    save();
    render();
    toast('OPS check deleted', 'Undo', () => {
      log.ops.splice(index, 0, removed);
      save();
      render();
    });
  },
  'toggle-ops': el => {
    const log = activeLog();
    const op = log.ops.find(o => o.id === el.dataset.id);
    if (!op) return;
    op.normal = !op.normal;
    save();
    render();
  },
  'add-navaid': () => {
    const log = activeLog();
    log.navAids.push({ ident: '', freq: '', radial: '' });
    save();
    render();
  },
  'del-navaid': el => {
    const log = activeLog();
    log.navAids.splice(Number(el.dataset.index), 1);
    save();
    render();
  },
  'switch-log': el => switchLog(el.dataset.id, !!el.closest('[data-keep-tab]')),
  'new-log': () => createLog(),
  'add-sortie': () => addSortie(),
  'add-crew': el => {
    const log = activeLog();
    log.crew.push(crewMember(el.dataset.role));
    save();
    render();
    const names = $$('[data-bind$=".name"]', $('.crew-list'));
    if (names.length) names[names.length - 1].focus();
  },
  'del-crew': el => {
    const log = activeLog();
    const index = Number(el.dataset.index);
    const removed = log.crew[index];
    if (!removed) return;
    log.crew.splice(index, 1);
    save();
    render();
    toast((removed.name || removed.role) + ' removed', 'Undo', () => {
      log.crew.splice(index, 0, removed);
      save();
      render();
    });
  },
  'send-sortie': () => exportSortie(),
  'sortie-menu': () => sortieSheet(),
  'close-sortie': () => closeSortie(),
  'reopen-sortie': () => {
    const log = activeSortie();
    if (!log) return;
    log.closed = false;
    log.closedAt = 0;
    save();
    render();
    toast('Sortie reopened');
  },
  'del-log': () => deleteLog(),
  'menu': () => menuSheet(),
  'settings': () => settingsSheet(),
  'help': () => helpSheet(),
  'terms': () => termsSheet(false),
  'accept-terms': () => acceptTerms(),
  'print': () => printLog(),
  'export-capf104': () => { closeSheet(); exportCapf104(); },
  'share-log': () => {
    // Pick up a signature stroke that has not been saved yet.
    if (sigCtl) sigCtl.flush();
    exportPdf();
  },
  'export-json': () => { closeSheet(); exportJSON(); },
  'export-csv': () => { closeSheet(); exportCSV(); },
  'import-json': () => { closeSheet(); importJSON(); },
  'set-theme': el => {
    state.settings.theme = el.dataset.value;
    applyTheme();
    save();
    settingsSheet();
  },
  'toggle-wake': () => {
    state.settings.keepAwake = !state.settings.keepAwake;
    syncWakeLock();
    save();
    settingsSheet();
  },
  'sar-import-fpl': () => importForeFlightArea(),
  'fpl-toggle': el => {
    if (!fplImport) return;
    const pt = fplImport.points[Number(el.dataset.index)];
    if (!pt) return;
    pt.on = !pt.on;
    const body = $('#overlay .sheet-body');
    const scroll = body ? body.scrollTop : 0;
    fplImportSheet();
    const next = $('#overlay .sheet-body');
    if (next) next.scrollTop = scroll;
  },
  'fpl-apply': () => {
    const corners = fplImport && fplCorners(fplImport.points);
    if (!corners) return;
    const sar = activeLog().sar;
    SAR_CORNERS.forEach(([key]) => {
      sar.corners[key] = { lat: fmtCoord(corners[key][0], true), lon: fmtCoord(corners[key][1], false) };
    });
    // keep the whole plan, in order, to draw on the chart with the track
    activeLog().fpl = { name: fplImport.name || '', points: fplImport.points.map(pt => [pt.lat, pt.lon, pt.id || '']) };
    save();
    closeSheet();
    if (activeTab === 'plan') render();
    toast('Search area corners filled from ForeFlight');
  },
  'sar-clear-corners': () => {
    const log = activeLog();
    const sar = log.sar;
    const previous = deepClone(sar.corners);
    const previousPlan = log.fpl;
    if (!sarHasData(previous) && !previousPlan) return;
    sar.corners = blankSar().corners;
    log.fpl = null;
    save();
    render();
    toast('Search area corners cleared', 'Undo', () => {
      sar.corners = previous;
      log.fpl = previousPlan;
      save();
      if (activeTab === 'plan') render();
    });
  },
  'mission-today': () => {
    // The local calendar date, as it would be written on the paper form.
    const mission = activeMission();
    if (!mission) return;
    mission.date = todayMissionDate();
    const input = $('[data-bind="m.date"]');
    if (input) input.value = mission.date;
    save();
  },
  'sar-choice': el => {
    // Tap the selected option again to clear it.
    const group = el.closest('[data-choice]');
    const value = el.classList.contains('active') ? '' : el.dataset.value;
    setPath(activeLog(), group.dataset.choice, value);
    $$('button', group).forEach(btn => btn.classList.toggle('active', btn === el && value !== ''));
    save();
  },
  'reset-all': () => resetAll(),
  'debriefed-now': () => {
    const log = activeLog();
    log.debrief.debriefedAt = fmtDateZ(new Date());
    save();
    const input = $('[data-bind="debrief.debriefedAt"]');
    if (input) input.value = log.debrief.debriefedAt;
  },
  'sign-now': () => {
    const log = activeLog();
    log.signoff.dateTime = fmtDateZ(new Date());
    save();
    const input = $('[data-bind="signoff.dateTime"]');
    if (input) input.value = log.signoff.dateTime;
    toast('Date time stamped');
  },
  'clear-sign': () => {
    if (sigCtl) sigCtl.clear();
    toast('Signature cleared');
  },
  'sketch-bg': el => setSketchBackground(el.dataset.value),
  'sketch-pan': () => { if (sketchCtl && sketchCtl.setPan) sketchCtl.setPan(); },
  'sketch-zoom': el => { if (sketchCtl && sketchCtl.zoom) sketchCtl.zoom(Number(el.dataset.step)); },
  'sketch-page': el => {
    const log = activeSortie();
    if (!log) return;
    if (sketchCtl) sketchCtl.flush();
    sketchPageIndex[log.id] = currentSketchPage(log).index + Number(el.dataset.step);
    render();
  },
  'sketch-add-page': () => {
    const log = activeSortie();
    if (!log) return;
    if (sketchCtl) sketchCtl.flush();
    const { page } = currentSketchPage(log);
    // a new page keeps the kind of this one: the same paper, or the same map where it is now
    const fresh = blankSketchPage(isMapSketchPage(page) ? page.bg : page.bg === 'plain' ? 'plain' : 'grid');
    if (isMapSketchPage(page) && page.map) fresh.map = Object.assign({}, page.map);
    log.sketches.push(fresh);
    sketchPageIndex[log.id] = log.sketches.length - 1;
    save();
    render();
    toast('Page ' + log.sketches.length + ' added');
  },
  'sketch-del-page': () => {
    const log = activeSortie();
    if (!log) return;
    const { index, count } = currentSketchPage(log);
    if (!confirm(count > 1 ? 'Delete page ' + (index + 1) + ' of the sketch pad?' : 'Clear the only page of the sketch pad, background and all?')) return;
    if (count > 1) {
      log.sketches.splice(index, 1);
      sketchPageIndex[log.id] = Math.max(0, index - 1);
    } else {
      log.sketches = [blankSketchPage()];
    }
    sketchCtl = null;
    save();
    render();
  },
  'offline-map-save': el => { const log = activeSortie(); if (log) saveOfflineMap(log, el.dataset.value); },
  'offline-map-stop': () => { if (mapSaveJob) mapSaveJob.abort.abort(); },
  'offline-map-delete': el => {
    const log = activeSortie();
    if (!log || !confirm('Delete the saved ' + CHART_LAYERS[el.dataset.value].label + ' map for this sortie from the iPad?')) return;
    deleteOfflineMap(log, el.dataset.value);
  },
  'chart-layer': el => {
    const key = el.dataset.value;
    if (!CHART_LAYERS[key]) return;
    state.settings.chartLayer = key;
    save();
    if (positionMap) {
      if (positionMap.tiles) positionMap.map.removeLayer(positionMap.tiles);
      positionMap.tiles = chartTileLayer(key).addTo(positionMap.map);
      positionMap.tiles.bringToBack();
    }
    $$('.pos-layers [data-act="chart-layer"]').forEach(b => b.classList.toggle('active', b.dataset.value === key));
    const note = $('#pos-note');
    if (note) note.textContent = chartNoteText(key);
  },
  'pen': el => {
    if (sketchCtl) sketchCtl.setColor(el.dataset.color);
  },
  'eraser': () => {
    if (sketchCtl) sketchCtl.setEraser();
  },
  'undo-sketch': () => {
    if (sketchCtl) sketchCtl.undo();
  },
  'redo-sketch': () => {
    if (sketchCtl) sketchCtl.redo();
  },
  'clear-sketch': () => {
    if (!confirm('Clear the drawing on this page? Its background stays.')) return;
    if (sketchCtl) sketchCtl.clear();
  }
};

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  // Brief…Sign are about one sortie: they open once one is.
  if (tab !== 'logbook' && !activeSortie()) {
    toast(activeMission() ? 'Add or pick a sortie first' : 'Pick or add a mission first');
    if (activeTab === 'logbook') return;
    tab = 'logbook';
  }
  if (sketchCtl) sketchCtl.flush();
  if (sigCtl) sigCtl.flush();
  activeTab = tab;
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

document.addEventListener('click', event => {
  const closeBtn = event.target.closest('[data-close]');
  if (closeBtn) {
    closeSheet();
    return;
  }

  const tabBtn = event.target.closest('#tabbar [data-tab]');
  if (tabBtn) {
    switchTab(tabBtn.dataset.tab);
    return;
  }

  const el = event.target.closest('[data-act]');
  if (!el) return;
  const name = el.dataset.act;
  if (!actions[name]) return;
  event.preventDefault();
  actions[name](el, event);
});

document.addEventListener('input', event => {
  const el = event.target;
  if (el.matches('textarea[data-autogrow]')) autoGrow(el);

  const bound = el.closest('[data-bind]');
  if (!bound) return;

  const path = bound.dataset.bind;
  if (path === 'sheet.lat' || path === 'sheet.lon') {
    // Sheet-local helper fields are read on save.
    return;
  }

  const value = el.type === 'checkbox' ? el.checked : el.value;
  if (path.startsWith('settings.')) setPath(state, path, value);
  else if (path.startsWith('m.')) {
    // the picked mission's own fields, from Mission details
    const mission = activeMission();
    if (!mission) return;
    setPath(mission, path.slice(2), value);
    mission.updatedAt = Date.now();
  } else {
    setPath(activeLog(), path, value);
  }

  if (el.matches('[data-coord]')) updateCoordHelp(el);
  if (el.matches('textarea[maxlength]')) updateCharCount(el);
  if (/^(m\.number|sortie|aircraft|callsign|crew\.)/.test(path)) renderStrip();
  if (/^(sar\.corners|entry|exit)\./.test(path) && !mapSaveJob) renderOfflineMapsCard();

  save();
});

document.addEventListener('change', event => {
  const el = event.target.closest('[data-bind]');
  if (!el) return;
  // a crew member's role decides which qualification boxes they get
  if (el.matches('[data-rerender]')) { setPath(activeLog(), el.dataset.bind, el.value); save(); render(); return; }
  const path = el.dataset.bind;
  const kind = el.dataset.norm;

  if (kind === 'time') {
    const normalized = normTime(el.value);
    if (normalized && !isValidTime(normalized)) {
      el.classList.add('invalid');
      return;
    }
    el.classList.remove('invalid');
    el.value = normalized;
    const target = path.startsWith('settings.') ? state : activeLog();
    setPath(target, path, normalized);
    const match = path.match(/^times\.(\w+)\.time$/);
    if (match) syncLinkedTime(match[1], 'time', normalized);
    save();
    updateOutputs();
  } else if (kind === 'hobbs') {
    el.value = el.value.trim();
    const target = path.startsWith('settings.') ? state : activeLog();
    setPath(target, path, el.value);
    const match = path.match(/^times\.(\w+)\.hobbs$/);
    if (match) syncLinkedTime(match[1], 'hobbs', el.value);
    save();
    updateOutputs();
  } else if (kind === 'coord') {
    const isLat = el.dataset.coord === 'lat';
    const value = el.value.trim();
    const parsed = value ? (isLat ? parseLat(value) : parseLon(value)) : null;
    if (value && parsed == null) el.classList.add('invalid');
    else el.classList.remove('invalid');
    if (parsed != null) {
      // Rewrite a valid entry in standard form once the field is left.
      el.value = fmtCoord(parsed, isLat);
      setPath(activeLog(), path, el.value);
      save();
    }
    updateCoordHelp(el);
  } else if (path === 'settings.opsInterval') {
    let value = Math.round(num(el.value) || 30);
    value = Math.min(180, Math.max(5, value));
    el.value = value;
    state.settings.opsInterval = value;
    save();
    render();
  }
});

document.addEventListener('focusout', () => {
  if (!renderPending) return;
  setTimeout(() => {
    if (!renderPending || fieldFocusedInView()) return;
    if ($('#overlay').classList.contains('show')) return;   // the sheet redraws when it closes
    render();
  }, 0);
});

// A tap anywhere off the Hobbs popover puts it away, as Skip does.
document.addEventListener('pointerdown', event => {
  const pop = $('#kp-pop');
  // no redraw: the reading is unchanged, and the button under the finger must stay for its click
  if (pop && !pop.contains(event.target) && !event.target.closest('#toast')) closeHobbsPopover(false);
}, true);

// Fly's map starts where the header ends. The header changes height on its
// own: the GPS position arriving can push the mission and sortie onto a
// second row. Rotating the iPad does too.
function placePageTop() {
  const bar = $('.topbar');
  if (bar) document.documentElement.style.setProperty('--page-top', Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) + 'px');
  if (activeTab === 'fly') placeFlyShell();
}
window.addEventListener('resize', placePageTop);
if (window.ResizeObserver) {
  const topbar = document.querySelector('.topbar');
  if (topbar) new ResizeObserver(placePageTop).observe(topbar, { box: 'border-box' });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if ($('#overlay').classList.contains('show')) closeSheet();
    else if (closeHobbsPopover()) { /* skipped the reading */ }
    else if ($('#obs-pop')) closeObsPop(false);
    else if (activeTab === 'fly' && flyLogOpen) setFlyLog(false);
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    const saveBtn = $('#overlay [data-act="save-entry"]');
    if (saveBtn) saveBtn.click();
  }
});

$('#overlay').addEventListener('click', event => {
  if (event.target.id === 'overlay') closeSheet();
});

/* =========================================================================
   Tap-to-place caret
   ========================================================================= */

/* On a tap, iOS only ever puts the caret at the start or end of a word; landing
   between two letters takes a long-press drag. Most fields here hold a single
   "word" (a callsign, a time, a coordinate), so a tap could never reach the
   middle of one. On a quick touch tap, work out which character boundary is
   under the finger and put the caret there ourselves. */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const CARET_MIRROR_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
  'fontVariantNumeric', 'fontFeatureSettings', 'fontKerning', 'letterSpacing',
  'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'lineHeight', 'tabSize',
  'direction', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
];
const CARET_MAX_LENGTH = 20000;

let caretDown = null;     // touch currently in progress on a text field
let caretTap = null;      // completed quick tap, waiting for its click
let caretLastTapAt = 0;   // to leave double-tap (select word) alone
let caretPin = null;      // caret position to hold while iOS settles its own

function isCaretField(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && /^(text|search|tel|url)$/.test(el.type);
}

/* Lay the field's text out in a hidden copy with the same box and font, then
   find the character boundary closest to the tapped point. */
function caretIndexFromPoint(el, x, y) {
  const value = el.value;
  if (!value) return 0;
  if (value.length > CARET_MAX_LENGTH) return null;

  const multiline = el.tagName === 'TEXTAREA';
  const computed = getComputedStyle(el);
  const mirror = document.createElement('div');
  CARET_MIRROR_PROPS.forEach(prop => { mirror.style[prop] = computed[prop]; });
  Object.assign(mirror.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    margin: '0',
    boxSizing: 'border-box',
    width: el.offsetWidth + 'px',
    height: el.offsetHeight + 'px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
    whiteSpace: multiline ? 'pre-wrap' : 'pre',
    overflowWrap: multiline ? 'break-word' : 'normal'
  });
  mirror.textContent = value;
  document.body.appendChild(mirror);
  mirror.scrollLeft = el.scrollLeft;
  mirror.scrollTop = el.scrollTop;

  const fieldRect = el.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const px = x - fieldRect.left + mirrorRect.left;
  const py = y - fieldRect.top + mirrorRect.top;

  const node = mirror.firstChild;
  const range = document.createRange();
  let best = value.length;
  let bestDy = Infinity;
  let bestDx = Infinity;
  const consider = (index, dy, dx) => {
    if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
      best = index;
      bestDy = dy;
      bestDx = dx;
    }
  };

  for (let i = 0; i < value.length;) {
    const code = value.charCodeAt(i);
    const size = code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length ? 2 : 1;
    range.setStart(node, i);
    range.setEnd(node, i + size);
    const rect = range.getClientRects()[0];
    if (rect) {
      // A single-line field has one line wherever the finger lands vertically.
      const dy = !multiline || (py >= rect.top && py <= rect.bottom)
        ? 0
        : Math.min(Math.abs(py - rect.top), Math.abs(py - rect.bottom));
      consider(i, dy, Math.abs(px - rect.left));
      if (value[i] !== '\n') consider(i + size, dy, Math.abs(px - rect.right));
    }
    i += size;
  }

  mirror.remove();
  return best;
}

function holdCaretPin() {
  const pin = caretPin;
  if (!pin) return;
  if (Date.now() > pin.until || document.activeElement !== pin.el) {
    caretPin = null;
    return;
  }
  const el = pin.el;
  // A range means iOS selected something (double tap); that wins.
  if (el.selectionStart !== el.selectionEnd) {
    caretPin = null;
    return;
  }
  if (el.selectionStart !== pin.index) el.setSelectionRange(pin.index, pin.index);
}

function setupCaretTaps() {
  if (!IS_IOS || !window.PointerEvent) return;

  document.addEventListener('pointerdown', event => {
    caretPin = null;
    caretTap = null;
    const isFinger = event.isPrimary && (event.pointerType === 'touch' || event.pointerType === 'pen');
    caretDown = isFinger && isCaretField(event.target)
      ? { el: event.target, x: event.clientX, y: event.clientY, at: Date.now() }
      : null;
  }, true);

  document.addEventListener('pointerup', event => {
    const down = caretDown;
    caretDown = null;
    if (!down || event.target !== down.el) return;
    const now = Date.now();
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    const isDoubleTap = down.at - caretLastTapAt < 500;
    caretLastTapAt = now;
    if (now - down.at > 400 || moved > 10 || isDoubleTap) return;
    caretTap = { el: down.el, x: event.clientX, y: event.clientY, at: now };
  }, true);

  document.addEventListener('pointercancel', () => { caretDown = null; }, true);

  document.addEventListener('click', event => {
    const tap = caretTap;
    caretTap = null;
    if (!tap || event.target !== tap.el || Date.now() - tap.at > 800) return;
    const el = tap.el;
    if (document.activeElement !== el || el.selectionStart !== el.selectionEnd) return;
    const index = caretIndexFromPoint(el, tap.x, tap.y);
    if (index == null) return;
    el.setSelectionRange(index, index);
    // iOS may apply its own word-boundary caret just after the click; hold ours
    // briefly, and let go the moment the user types or touches again.
    caretPin = { el, index, until: Date.now() + 300 };
    [0, 60, 200].forEach(delay => setTimeout(holdCaretPin, delay));
  }, true);

  document.addEventListener('selectionchange', holdCaretPin);
  document.addEventListener('keydown', () => { caretPin = null; }, true);
  document.addEventListener('beforeinput', () => { caretPin = null; }, true);
}

setupCaretTaps();

/* =========================================================================
   App updates
   ========================================================================= */

/* The service worker serves the cached build first and fetches a new one in
   the background, so on its own a deploy only shows up on the launch after the
   next one. Instead: look for a new build whenever the app comes to the
   foreground, and once the new worker has taken over, reload into it — at once
   if nothing is being edited, otherwise on the next return to the app or when
   the user taps Reload. */
let swRegistration = null;
let updateReady = false;
let lastUpdateCheck = 0;

function checkForUpdate() {
  if (!swRegistration || Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  swRegistration.update().catch(() => { /* offline: try again next time */ });
}

function isEditing() {
  if ($('#overlay').classList.contains('show')) return true;
  const el = document.activeElement;
  return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

async function reloadForUpdate() {
  if (sketchCtl) sketchCtl.flush();
  if (sigCtl) sigCtl.flush();
  // Never reload over unsaved work: a log with photos can be too big for the
  // localStorage mirror, so wait for the real write before leaving the page.
  clearTimeout(saveTimer);
  try {
    if (!(await writeState())) return;
  } catch (err) {
    console.warn('save before update failed', err);
    return;
  }
  mirrorState();
  location.reload();
}

function applyUpdate() {
  if (!updateReady) return;
  if (isEditing()) {
    toast('Update ready', 'Reload', reloadForUpdate);
    return;
  }
  reloadForUpdate();
}

/* =========================================================================
   Boot
   ========================================================================= */

async function boot() {
  let loaded = null;
  try {
    loaded = await readState();
  } catch (err) {
    console.warn('load failed', err);
  }

  state = loaded ? normalizeState(loaded) : newState();
  // open where the crew left off: a sortie in progress on Fly, otherwise Missions
  activeTab = sortieRunning(activeLog()) ? 'fly' : 'logbook';
  applyTheme();
  render();
  if (termsNeeded()) termsSheet(true);
  loadSavedMapAreas();

  setSaveStatus('saved', loaded ? 'Saved ' + fmtClock(state.savedAt ? new Date(state.savedAt) : new Date()) : 'On this device');
  if (!loaded) save();

  // Re-check the theme when the system changes while set to Auto.
  if (window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (state.settings.theme === 'auto') applyTheme(); };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      mirrorState();
      return;
    }
    if (state.settings.keepAwake && !wakeLock) syncWakeLock();
    if (state.settings.gpsLive && gpsWatchId == null && gpsState !== 'denied') startGpsWatch();
    if (updateReady) applyUpdate();
    else checkForUpdate();
  });
  window.addEventListener('pagehide', mirrorState);

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  syncWakeLock();
  startNative();

  if (state.settings.gpsLive) startGpsWatch(); else renderGpsChip();
  setInterval(renderGpsChip, 5000);   // a fix that stops arriving turns to GPS lost

  // The iPad app ships its files inside the app, so it has no service worker.
  if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    // A controller at load means this is an update, not the first install.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      updateReady = true;
      applyUpdate();
    });
    const register = () => {
      navigator.serviceWorker.register('./sw.js')
        .then(registration => { swRegistration = registration; })
        .catch(err => console.warn('SW registration failed', err));
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

boot();

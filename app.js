'use strict';

/* =========================================================================
   Mission Log — offline CAP observer mission log
   All data stays in the browser (IndexedDB with a localStorage mirror).
   ========================================================================= */

const APP_VERSION = '1.20.0';
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
  return !!(log && sortieReady(log) && isValidTime(log.times.engineStart.time) && !log.times.shutDown.time);
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
  const name = (log.mission || 'Mission') + ' sortie ' + (log.sortie || '');
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
    mission: log.mission || '',
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
async function openSharedFile(url) {
  try {
    const name = decodeURIComponent(String(url).split('/').pop() || 'file');
    const read = await Native.Filesystem.readFile({ path: url, encoding: 'utf8' });
    const text = typeof read.data === 'string' ? read.data : await read.data.text();
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
   service and need a connection; ones already viewed stay in the cache. */
const SECTIONAL_TILES = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}';
let positionMap = null;

// The zoom that shows the FAA chart at 100%: one chart pixel per screen pixel.
// The FAA's most detailed tiles are level 12; a Retina screen draws them one
// level earlier at half size.
function chartFullZoom() {
  return (window.devicePixelRatio || 1) > 1.4 ? 11 : 12;
}

function closePositionView() {
  if (positionMap) positionMap.remove();
  positionMap = null;
  const view = $('#pos-full');
  if (view) view.remove();
  document.documentElement.classList.remove('pos-open');
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

function positionSheet() {
  const fix = freshFix() || lastGpsFix;
  closePositionView();
  // Full screen: the chart fills it, the position floats over the top in a
  // see-through panel, and the buttons sit at the corners.
  const view = document.createElement('div');
  view.className = 'pos-full';
  view.id = 'pos-full';
  view.innerHTML = `<div class="pos-map" id="pos-map"></div>
    <div class="pos-panel">
      <div id="pos-text">${positionFixHTML(freshFix())}</div>
      <div class="pos-note">FAA sectional · for reference, not navigation · needs a connection the first time an area is viewed</div>
    </div>
    <button type="button" class="pos-close" data-act="pos-close" aria-label="Close chart">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
    </button>
    <button type="button" class="pos-recenter" data-act="pos-recenter">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
      Center
    </button>`;
  document.body.appendChild(view);
  document.documentElement.classList.add('pos-open');
  if (!window.L) return;
  const log = activeLog();
  const center = fix ? [fix.lat, fix.lon] : [39.5, -98.35];
  // The FAA serves the sectional at tile zooms 8–12; 12 is the chart's own
  // detail. On a Retina screen each tile is drawn at half size from one zoom
  // level deeper (detectRetina), so the chart stays sharp instead of being
  // stretched to twice its pixels.
  const retina = (window.devicePixelRatio || 1) > 1.4;
  const map = L.map('pos-map', {
    zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 13, zoomSnap: 1
  }).setView(center, fix ? chartFullZoom() : 5);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer(SECTIONAL_TILES, {
    detectRetina: true,
    minNativeZoom: retina ? 7 : 8,
    maxNativeZoom: retina ? 11 : 12,
    minZoom: 5, maxZoom: 13,
    keepBuffer: 3,
    attribution: 'FAA AIS · not for navigation'
  }).addTo(map);
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
  if (corners.every(Boolean)) {
    L.polygon(corners, { color: '#e0662b', weight: 2, fillOpacity: 0.08, dashArray: '6 4' }).addTo(map);
  }
  const accuracy = L.circle(center, { radius: fix ? fix.accuracy : 0, color: '#1877cc', weight: 1, fillOpacity: 0.12 });
  const dot = L.circleMarker(center, { radius: 8, color: '#fff', weight: 3, fillColor: '#1877cc', fillOpacity: 1 });
  if (fix) { accuracy.addTo(map); dot.addTo(map); }
  positionMap = { map, dot, accuracy, follow: true, trackLine: null, remove: () => map.remove() };
  drawTrackOnMap();
  pullTrack(activeLog());
  map.on('dragstart', () => { if (positionMap) positionMap.follow = false; });
  // the sheet animates in; let the map measure itself once it has
  setTimeout(() => map.invalidateSize(), 60);
}

function drawTrackOnMap(fit) {
  if (!positionMap || !window.L) return;
  const log = activeLog();
  const pts = log.track.map(p => [p[1], p[2]]);
  if (positionMap.trackLine) positionMap.trackLine.remove();
  positionMap.trackLine = pts.length > 1
    ? L.polyline(pts, { color: '#d81b60', weight: 3, opacity: 0.9 }).addTo(positionMap.map)
    : null;
  if (fit && positionMap.trackLine) {
    positionMap.follow = false;
    positionMap.map.fitBounds(positionMap.trackLine.getBounds(), { padding: [24, 24], maxZoom: chartFullZoom() });
  }
}

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
  if (positionMap.follow) positionMap.map.panTo(at, { animate: true });
}

function positionPinned() {
  return positionMap && positionMap.map.hasLayer(positionMap.dot);
}

function renderGpsChip() {
  const chip = $('#gpsChip');
  const label = $('#gpsLabel');
  if (!chip || !label) return;
  const fix = freshFix();
  let level = 'off';
  let text = 'GPS off';
  if (gpsState === 'denied') { level = 'bad'; text = 'GPS denied'; }
  else if (gpsState === 'unavailable') { level = 'off'; text = 'No GPS'; }
  else if (gpsState === 'off') { level = 'off'; text = 'GPS off'; }
  else if (fix) {
    const metres = Math.round(fix.accuracy);
    level = metres <= 50 ? 'ok' : 'warn';
    text = 'GPS ±' + (metres >= 1000 ? (metres / 1000).toFixed(1) + ' km' : metres + ' m');
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
    grid.textContent = names.length ? '· ' + names.join(' · ') : '';
  }
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
    missionDate: '',
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
      ['Mission number', log.mission],
      ['Mission date', sar.missionDate],
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

/* ---------- crew ----------
   A sortie's crew is a list, so it can hold more than one observer, scanner or
   photographer. Roles as CAP writes them: mission pilot, observer, scanner,
   airborne photographer. */
const CREW_ROLES = [['MP', 'Mission pilot'], ['MO', 'Mission observer'], ['MS', 'Mission scanner'], ['AP', 'Airborne photographer']];
const CREW_ROLE_KEYS = CREW_ROLES.map(([key]) => key);

function crewMember(role) {
  return { id: uid(), role: role || 'MS', name: '', capid: '' };
}

// Logs saved before 1.11.0 have one named slot per role; turn them into the list.
function normalizeCrew(raw) {
  if (Array.isArray(raw)) {
    return raw.map(m => {
      const member = Object.assign(crewMember(), m || {});
      if (!CREW_ROLE_KEYS.includes(member.role)) member.role = 'MS';
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

function blankLog() {
  return {
    id: uid(),
    missionId: uid(),
    missionCreated: false,   // step 1: the mission exists
    started: false,          // step 2: this record is a sortie, not just the new mission's placeholder
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mission: '',
    sortie: '',
    aircraft: '',
    callsign: '',
    base: '',
    capFlight: '',
    sectional: '',
    grid: '',
    altitude: '',
    airspeed: '',
    entry: { lat: '', lon: '' },
    exit: { lat: '', lon: '' },
    crew: [crewMember('MP'), crewMember('MO'), crewMember('MS')],
    radio: { main: '', guard: '', atis: '', ctaf: '', unicom: '', other: '' },
    navAids: [
      { ident: '', freq: '', radial: '' },
      { ident: '', freq: '', radial: '' },
      { ident: '', freq: '', radial: '' }
    ],
    entries: [],
    times: emptyTimes(),
    ops: [],
    notes: '',
    sketch: '',
    observations: [],
    signoff: { name: '', capid: '', dateTime: '', signature: '' },
    sar: blankSar(),
    // flight track: [time ms, lat, lon, altitude m, accuracy m, speed m/s, course °]
    track: []
  };
}

function newState() {
  const log = blankLog();
  return {
    version: 1,
    savedAt: 0,
    activeId: log.id,
    settings: {
      theme: 'auto',
      fingerDraw: true,
      fingerDefaultSet: true,
      keepAwake: false,
      gpsLive: true,
      opsInterval: 30,
      hobbsPrompt: true,
      installDismissed: false,
      recordTrack: true,
      termsAccepted: 0,
      termsAcceptedAt: 0
    },
    logs: [log]
  };
}

function normalizeLog(raw) {
  const base = blankLog();
  const log = Object.assign(base, raw || {});
  log.id = (raw && raw.id) || base.id;
  log.missionId = (raw && raw.missionId) || '';   // filled in by assignMissionIds
  log.receivedFrom = (raw && raw.receivedFrom) || '';
  // Logs from before 1.13.0 have neither flag: anything with a mission number or
  // something logged was already a created mission and a started sortie.
  const hasData = !!(String(log.mission || '').trim() || log.entries.length || log.observations.length ||
    (log.times.engineStart && log.times.engineStart.time));
  log.missionCreated = raw && typeof raw.missionCreated === 'boolean' ? raw.missionCreated : hasData;
  log.started = raw && typeof raw.started === 'boolean' ? raw.started : hasData;
  log.times = Object.assign(emptyTimes(), (raw && raw.times) || {});
  TIME_DEFS.forEach(def => {
    log.times[def.key] = Object.assign({ time: '', hobbs: '' }, log.times[def.key] || {});
  });
  log.entry = Object.assign({ lat: '', lon: '' }, (raw && raw.entry) || {});
  log.exit = Object.assign({ lat: '', lon: '' }, (raw && raw.exit) || {});
  log.crew = normalizeCrew(raw && raw.crew);
  log.radio = Object.assign({ main: '', guard: '', atis: '', ctaf: '', unicom: '', other: '' }, (raw && raw.radio) || {});
  log.signoff = Object.assign({ name: '', capid: '', dateTime: '', signature: '' }, (raw && raw.signoff) || {});
  log.sar = normalizeSar(raw && raw.sar);
  log.track = Array.isArray(raw && raw.track) ? raw.track.filter(p => Array.isArray(p) && p.length >= 3) : [];
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

function normalizeState(raw) {
  const fresh = newState();
  if (!raw || !Array.isArray(raw.logs) || !raw.logs.length) return fresh;
  const normalized = {
    version: 1,
    savedAt: raw.savedAt || 0,
    activeId: raw.activeId,
    settings: Object.assign(fresh.settings, raw.settings || {}),
    logs: raw.logs.map(normalizeLog)
  };
  assignMissionIds(normalized.logs);
  // Finger became the sketch default in 1.3.8. State saved before that carries
  // the old Pencil default, indistinguishable from a choice, so switch it once.
  if (!raw.settings || !raw.settings.fingerDefaultSet) normalized.settings.fingerDraw = true;
  delete normalized.settings.coordFormat;   // the format choice was removed in 1.4.3
  delete normalized.settings.introDismissed; // the intro card was removed in 1.7.3
  delete normalized.settings.gpsAuto;        // replaced by live GPS in 1.8.0
  if (!normalized.logs.some(l => l.id === normalized.activeId)) {
    normalized.activeId = normalized.logs[0].id;
  }
  return normalized;
}

function activeLog() {
  if (!state) return blankLog();
  let log = state.logs.find(l => l.id === state.activeId);
  if (!log) {
    log = state.logs[0];
    state.activeId = log.id;
  }
  return log;
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

  document.body.classList.toggle('finger-draw', !!(state && state.settings.fingerDraw));
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
  const log = activeLog();
  const main = $('#stripMain');
  const sub = $('#stripSub');
  if (!main || !sub) return;

  // Header reads: mission number, then callsign and crew names.
  main.textContent = log.mission || 'New Mission';
  // Until the mission has a number, an arrow points at it: that is where to begin.
  const callout = $('#stripCallout');
  if (callout) callout.hidden = sortieReady(log);
  if (callout) callout.textContent = log.missionCreated ? 'Add a sortie' : 'Start Here';
  const sortieBtn = $('#sortieSwitch');
  if (sortieBtn) sortieBtn.hidden = !sortieReady(log);
  if (sortieBtn) {
    const sorties = missionSorties(log);
    $('#sortieLabel').textContent = sortieLabel(log, sorties.indexOf(log)) +
      (sorties.length > 1 ? ' of ' + sorties.length : '');
  }
  const rest = [log.callsign, ...crewInOrder(log).map(m => m.name)]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  sub.textContent = rest.join('  ·  ');
}

function renderTabbar() {
  const bar = $('#tabbar');
  if (bar) bar.classList.toggle('locked', !sortieReady());
  $$('#tabbar .tab').forEach(btn => {
    const on = btn.dataset.tab === activeTab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
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
  renderTabbar();
  const view = $('#view');
  if (!view) return;
  const log = activeLog();

  if (!TABS.includes(activeTab) && !SCREENS.includes(activeTab)) activeTab = defaultTab(log);
  if (activeTab === 'logbook') view.innerHTML = logbookView();
  else if (activeTab === 'plan') view.innerHTML = planView(log);
  else if (activeTab === 'fly') view.innerHTML = flyView(log);
  else if (activeTab === 'notes') view.innerHTML = notesView(log);
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

function opsBanner(log) {
  const last = log.ops[log.ops.length - 1];
  if (!last) {
    return `<button class="status-banner none" data-act="goto-ops">
      <span class="sb-dot"></span>
      <span>No OPS checks yet — <strong>record the first one</strong></span>
    </button>`;
  }

  const next = nextOpsDue(log);
  const interval = state.settings.opsInterval || 30;
  const since = last.time ? (nowMinutes() - timeToMin(last.time) + 1440) % 1440 : null;
  const live = since != null && since < 480;
  const overdue = live && since > interval + 4;

  if (overdue) {
    return `<button class="status-banner due" data-act="goto-ops">
      <span class="sb-dot"></span>
      <span><strong>OPS check due</strong> — last was ${fmtZ(last.time)} (${fmtDuration(since)} ago)</span>
    </button>`;
  }

  return `<button class="status-banner ok" data-act="goto-ops">
    <span class="sb-dot"></span>
    <span><strong>OPS ${last.normal ? 'normal' : 'flagged'}</strong> at ${fmtZ(last.time)}${next ? ' · next ' + fmtZ(next) : ''} · ${log.ops.length} check${log.ops.length === 1 ? '' : 's'}</span>
  </button>`;
}

function quickButton(log, item) {
  const entry = entryForKind(log, item.kind);
  const done = !!(entry && entry.time);
  const cls = 'quick' + (done ? ' done' : '');
  return `<button type="button" class="${cls}" data-act="quick" data-kind="${esc(item.kind)}" data-label="${esc(item.label)}">
    <svg class="quick-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg>
    <span class="quick-label">${esc(item.label)}</span>
    <span class="quick-time mono">${done ? fmtZ(entry.time) : ''}</span>
  </button>`;
}

function entryRowHTML(entry, previous) {
  const delta = previous && previous.time && entry.time ? diffMin(previous.time, entry.time) : null;
  const pos = fmtEntryPosition(entry);
  const bits = [];
  if (entry.hobbs) bits.push('Hobbs ' + esc(entry.hobbs));
  if (pos) bits.push(esc(pos));
  if (entry.gpsAccuracy) bits.push('GPS ±' + esc(entry.gpsAccuracy) + ' m');
  if (delta != null && delta > 0) bits.push('<span class="entry-delta">+' + delta + 'm</span>');
  return `<div class="entry-row" data-act="edit-entry" data-id="${esc(entry.id)}" role="button" tabindex="0">
      <div class="entry-time mono">${entry.time ? esc(fmtZ(entry.time)) : '—'}</div>
      <div>
        <div class="entry-title">${esc(entry.event || 'Log entry')}${entry.kind ? '<span class="tag">checkpoint</span>' : ''}</div>
        ${bits.length ? '<div class="entry-sub">' + bits.join(' <span class="muted">·</span> ') + '</div>' : ''}
        ${entry.note ? '<div class="entry-note">' + esc(entry.note) + '</div>' : ''}
      </div>
      <button type="button" class="row-del" data-act="del-entry" data-id="${esc(entry.id)}" aria-label="Delete entry">×</button>
    </div>`;
}

/* The sortie as one timeline: flight log entries and observations together, in
   time order. They are still stored, numbered and printed separately. */
function timelineHTML(log) {
  const items = [
    ...log.entries.map(entry => ({ kind: 'entry', time: entry.time, at: entry.createdAt || 0, entry })),
    ...log.observations.map((obs, index) => ({ kind: 'obs', time: obs.time, at: obs.createdAt || 0, obs, index }))
  ];
  if (!items.length) {
    return `<div class="empty"><strong>Nothing logged yet</strong>Checkpoints you tap and observations you add appear here, in time order.</div>`;
  }
  const minutes = item => (isValidTime(item.time) ? timeToMin(item.time) : null);
  items.sort((x, y) => {
    const a = minutes(x);
    const b = minutes(y);
    if (a != null && b != null && a !== b) return a - b;
    return x.at - y.at;
  });
  let previous = null;
  return '<div class="timeline">' + items.map(item => {
    if (item.kind === 'obs') return obsCardHTML(log, item.obs, item.index);
    const row = entryRowHTML(item.entry, previous);
    previous = item.entry;
    return row;
  }).join('') + '</div>';
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
        <div class="total"><div class="tl">Hobbs in area</div><div class="tv" id="meter-hobbs-area">${one(totals.hobbsArea)}</div></div>
        <div class="total"><div class="tl">Hobbs to / from</div><div class="tv" id="meter-hobbs-tofrom">${one(totals.hobbsToFrom)}</div></div>
      </div>
      <div class="sketch-hint">Hobbs comes from the checkpoints; correct it under Flight times above. In area is Out of Area minus In Area, and to / from is the rest, so the two add up to the total. On G1000 aircraft the tach reading is ENG HOURS.</div>
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

const TABS = ['logbook', 'plan', 'fly', 'notes', 'debrief', 'sign'];

// Where a sortie opens: Missions until one is picked, Sorties until it has a sortie, then Fly.
function defaultTab(log) {
  const l = log || activeLog();
  if (!l.missionCreated) return 'logbook';
  return l.started ? 'fly' : 'plan';
}

// The sortie tabs only open once the mission exists and has a sortie.
function sortieReady(log) {
  const l = log || activeLog();
  return !!(l.missionCreated && l.started);
}

/* ---------- missions above sorties ----------
   Missions (every mission on this iPad) → Sorties (the picked mission, its
   sorties and the open sortie's set-up) → Fly…Sign, about one sortie.
   Internally the first two tabs keep their old keys, 'logbook' and 'plan'. */
const SCREENS = [];

function missionIdsInOrder() {
  const ids = [];
  state.logs.slice().sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))
    .forEach(l => { if (!ids.includes(l.missionId)) ids.push(l.missionId); });
  return ids;
}

function showScreen(screen) {
  if (sketchCtl) sketchCtl.flush();
  if (sigCtl) sigCtl.flush();
  closeSheet();
  activeTab = screen;
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ---------- Missions tab ----------
   The first tab: every mission on this iPad with its sorties, newest first,
   and where a new mission (from WMIRS) or sortie is added. */
function logbookView() {
  const ids = missionIdsInOrder().filter(id => state.logs.some(l => l.missionId === id && l.missionCreated));
  const sorties = state.logs.filter(l => l.started);
  const hobbs = sorties.reduce((sum, l) => sum + (timeTotals(l).hobbs || 0), 0);
  const nm = sorties.reduce((sum, l) => { const t = trackStats(l); return sum + (t ? t.nm : 0); }, 0);
  const rows = ids.map(id => {
    const all = state.logs.filter(l => l.missionId === id);
    const first = all[0];
    const flown = all.filter(l => l.started);
    const missionHobbs = flown.reduce((sum, l) => sum + (timeTotals(l).hobbs || 0), 0);
    const current = id === activeLog().missionId;
    const meta = [first.sar.missionDate, first.base,
      flown.length + ' sortie' + (flown.length === 1 ? '' : 's'),
      missionHobbs ? fmtDecimal(missionHobbs, 1) + ' Hobbs' : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="log-row mission-row ${current ? 'active' : ''}" data-act="open-mission" data-id="${esc(id)}">
      <span class="log-name">${esc(first.mission)}</span>
      <span class="log-meta">${esc(meta)}</span>
      <svg class="row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
  }).join('');
  return `<div class="stack">
    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Missions</h2><span class="count-badge">${ids.length}</span></div>
      </div>
      <div class="totals" style="grid-template-columns:repeat(3,1fr);margin-top:0;padding-top:0;border-top:0">
        <div class="total"><div class="tl">Sorties</div><div class="tv">${sorties.length}</div></div>
        <div class="total"><div class="tl">Hobbs</div><div class="tv">${fmtDecimal(hobbs, 1) || '0.0'}</div></div>
        <div class="total"><div class="tl">Tracked</div><div class="tv">${Math.round(nm)} NM</div></div>
      </div>
      ${rows ? `<div class="log-list" style="margin-top:12px">${rows}</div>`
        : '<div class="empty" style="margin-top:12px"><strong>No missions yet</strong>Tap + to add a mission from WMIRS.</div>'}
      <div class="sheet-note">Missions are created in WMIRS. Add one here with its mission number, then add each sortie you fly on it. Everything stays on this iPad.</div>
    </section>
  </div>
  ${fabHTML('new-mission', 'Add a mission')}`;
}

// The round add button in the bottom corner: a mission on Missions, a sortie on Sorties.
function fabHTML(act, label) {
  return `<button type="button" class="fab" data-act="${act}" aria-label="${esc(label)}" title="${esc(label)}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
  </button>`;
}

// Adding a mission: its WMIRS number (required), date and base. Then its first sortie.
function openNewMissionSheet() {
  openSheet({
    title: 'Add mission',
    sub: 'From WMIRS',
    body: `<div class="form-grid">
      <label class="field span-2"><span>Mission number</span>
        <input class="input" id="nm-number" autocapitalize="characters" placeholder="e.g. 24-001"></label>
      <label class="field"><span>Mission date</span>
        <div class="input-btn">
          <input class="input mono" id="nm-date" autocapitalize="characters" placeholder="DD MMM YY">
          <button type="button" class="mini" data-act="nm-today">Today</button>
        </div></label>
      <label class="field"><span>Base</span><input class="input" id="nm-base" autocapitalize="characters" placeholder="KBUY"></label>
    </div>
    <p class="sheet-note">Only the mission number is required. Date and base can be added later.</p>`,
    footer: `<button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" data-act="nm-save">Add mission</button>`
  });
  const number = $('#nm-number');
  if (number) setTimeout(() => number.focus(), 60);
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
  // reuse the empty record a fresh install starts with
  const current = activeLog();
  const log = !current.missionCreated && !current.started && !current.mission ? current : blankLog();
  if (log !== current) state.logs.push(log);
  log.mission = value;
  log.sar.missionDate = String($('#nm-date').value || '').trim().toUpperCase();
  log.base = String($('#nm-base').value || '').trim().toUpperCase();
  log.missionCreated = true;
  log.sortie = log.sortie || '1';
  state.activeId = log.id;
  closeSheet();
  activeTab = 'plan';
  save();
  render();
  window.scrollTo(0, 0);
  toast('Mission ' + value + ' added · now its first sortie');
  const first = $('#new-sortie-card [data-bind="aircraft"]');
  if (first) setTimeout(() => first.focus(), 60);
}

function sortieCardRowHTML(l, index) {
  const crew = crewInOrder(l).map(m => m.name).filter(Boolean);
  const times = l.times.engineStart.time
    ? fmtZ(l.times.engineStart.time) + (l.times.shutDown.time ? '–' + fmtZ(l.times.shutDown.time) : ' →')
    : 'not flown yet';
  const signed = l.signoff.signature ? '<span class="sortie-signed">Signed</span>' : '';
  return `<button type="button" class="log-row sortie-row ${l.id === state.activeId ? 'active' : ''}" data-act="switch-log" data-id="${esc(l.id)}">
    <span class="log-name">${esc(sortieLabel(l, index))} ${signed}</span>
    <span class="log-meta">${esc(l.aircraft || 'no tail')}${l.callsign ? ' · ' + esc(l.callsign) : ''} · ${esc(times)} · ${l.entries.length + l.observations.length} logged${crew.length ? ' · ' + esc(crew.join(', ')) : ''}${l.receivedFrom ? ' · from ' + esc(l.receivedFrom) : ''}</span>
  </button>`;
}

// The mission and its sorties: the top of the Sorties tab.
function missionSectionsHTML(log) {
  const sar = log.sar;
  const sorties = missionSorties(log).filter(l => l.started);
  return `<button type="button" class="back-link" data-act="show-missions">‹ Missions</button>
    <section class="card" id="mission-card">
      <div class="card-head">
        <div class="head-left"><h2>Mission</h2></div>
        <span class="muted small">Shared by every sortie</span>
      </div>
      <div class="form-grid">
        ${field('Mission number', textInput('mission', log.mission, { autocap: 'characters', placeholder: 'e.g. 24-001' }))}
        <label class="field"><span>Mission date</span>
          <div class="input-btn">
            ${textInput('sar.missionDate', sar.missionDate, { className: 'mono', autocap: 'characters', placeholder: 'DD MMM YY' })}
            <button type="button" class="mini" data-act="sar-today">Today</button>
          </div>
        </label>
        ${field('Base', textInput('base', log.base, { placeholder: 'KBUY' }))}
      </div>
    </section>

    ${sorties.length ? `<section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Sorties</h2><span class="count-badge">${sorties.length}</span></div>
      </div>
      <div class="log-list">${sorties.map(sortieCardRowHTML).join('')}</div>
      <div class="sheet-note">Tap a sortie to open it. + starts the next one with the same crew, aircraft, frequencies and search area.</div>
    </section>` : `<section class="card card-current" id="new-sortie-card">
      <div class="card-head"><div class="head-left"><h2>New sortie</h2></div></div>
      <p class="sheet-note" style="margin-top:0">A sortie is one flight of this mission. Crew, search area and the rest are set up once it is added.</p>
      <div class="form-grid">
        ${field('Sortie', textInput('sortie', log.sortie, { inputmode: 'numeric', placeholder: '1' }))}
        ${field('Tracking number', textInput('sar.tracking', sar.tracking, { className: 'mono', autocap: 'characters' }))}
        ${field('Aircraft N#', textInput('aircraft', log.aircraft, { autocap: 'characters', placeholder: 'N12345' }))}
        ${field('Callsign', textInput('callsign', log.callsign, { autocap: 'characters', placeholder: 'CAP 1234' }))}
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn primary" data-act="add-sortie">Add sortie</button>
      </div>
    </section>`}
`;
}

// The Sorties tab before a mission is picked.
function noMissionHTML() {
  return `<div class="stack">
    <section class="card">
      <div class="empty"><strong>No mission selected</strong>Pick a mission on the Missions tab, or add one from WMIRS.</div>
      <div class="btn-row" style="justify-content:center">
        <button class="btn" data-act="show-missions">Missions</button>
        <button class="btn primary" data-act="new-mission">Add mission</button>
      </div>
    </section>
  </div>`;
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

function flyView(log) {
  return `<div class="stack">
    ${installBannerHTML()}
    ${opsBanner(log)}
    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Checkpoints</h2></div>
        <span class="muted small">Tap to stamp UTC</span>
      </div>
      <div class="quick-grid">${QUICK.map(q => quickButton(log, q)).join('')}</div>
      <button type="button" class="btn soft wide gps-mark" data-act="add-checkpoint">+ Checkpoint</button>
      <div class="gps-hint">Tap a checkpoint to stamp the time and position. + Checkpoint adds one of your own.</div>
    </section>
    <section class="card" id="timeline-card">
      <div class="card-head">
        <div class="head-left">
          <h2>Timeline</h2>
          <span class="count-badge">${log.entries.length + log.observations.length}</span>
        </div>
        <button class="btn small primary" data-act="add-obs">+ Observation</button>
      </div>
      ${timelineHTML(log)}
    </section>
    ${opsCardHTML(log)}
  </div>`;
}

// One column of the CAPF 104a plan-versus-actual grid: planned on Sorties, actual on Debrief.
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

  if (!log.missionCreated) return noMissionHTML();
  // Until the mission has a sortie, the tab is the mission and the new-sortie form.
  if (!sortieReady(log)) return `<div class="stack">${missionSectionsHTML(log)}</div>`;

  return `<div class="stack">
    ${missionSectionsHTML(log)}
    <section class="card" id="sortie-card">
      <div class="card-head">
        <div class="head-left"><h2>${esc(sortieLabel(log, missionSorties(log).indexOf(log)))}</h2></div>
        <span class="muted small">This sortie only</span>
      </div>
      <div class="form-grid">
        ${field('Sortie', textInput('sortie', log.sortie, { inputmode: 'numeric', placeholder: '1' }))}
        ${field('Tracking number', textInput('sar.tracking', sar.tracking, { className: 'mono', autocap: 'characters', placeholder: log.sortie ? 'Sortie ' + log.sortie : 'Sortie number' }))}
        ${field('Aircraft N#', textInput('aircraft', log.aircraft, { autocap: 'characters', placeholder: 'N12345' }))}
        ${field('Callsign', textInput('callsign', log.callsign, { autocap: 'characters', placeholder: 'CAP 1234' }))}
        ${field('CAP flight', textInput('capFlight', log.capFlight, { placeholder: 'NC-123' }))}
      </div>
      <div class="subhead">Crew</div>
      <div class="form-grid">
      </div>
      <div class="crew-list">
        ${crew.map((m, i) => `<div class="crew-row">
          <select class="input" data-bind="crew.${i}.role" aria-label="Role">
            ${CREW_ROLES.map(([key, label]) => `<option value="${key}" ${m.role === key ? 'selected' : ''} title="${esc(label)}">${key}</option>`).join('')}
          </select>
          <input class="input" data-bind="crew.${i}.name" value="${esc(m.name)}" placeholder="Name" autocapitalize="characters" aria-label="Name">
          <input class="input mono" data-bind="crew.${i}.capid" value="${esc(m.capid)}" placeholder="CAPID" inputmode="numeric" aria-label="CAPID">
          <button type="button" class="row-del" data-act="del-crew" data-index="${i}" aria-label="Remove crew member">×</button>
        </div>`).join('') || '<div class="empty"><strong>No crew yet</strong>Add each crew member with the buttons below.</div>'}
      </div>
      <div class="btn-row" style="margin-top:10px">
        ${CREW_ROLE_KEYS.map(role => `<button type="button" class="btn small" data-act="add-crew" data-role="${role}">+ ${role}</button>`).join('')}
      </div>
      <div class="form-grid" style="margin-top:14px">
        ${field('Reporting MO / MP / MS', textInput('sar.reporter', sar.reporter, { placeholder: 'Name' }))}
        ${field('Reporting CAPID', textInput('sar.reporterCapid', sar.reporterCapid, { className: 'mono', inputmode: 'numeric' }))}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Flight profile</h2></div></div>
      <div class="form-grid">
        ${field('Sectional', textInput('sectional', log.sectional, { placeholder: 'Charlotte' }))}
        ${field('Altitude', textInput('altitude', log.altitude, { placeholder: '3500' }))}
        ${field('Airspeed', textInput('airspeed', log.airspeed, { placeholder: '110' }))}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Search area</h2></div>
        <button class="btn small" data-act="sar-import-fpl">Import from ForeFlight</button>
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
        <label class="field"><span>ATIS / AWOS</span><input class="input mono" data-bind="radio.atis" value="${esc(log.radio.atis)}"></label>
        <label class="field"><span>CTAF</span><input class="input mono" data-bind="radio.ctaf" value="${esc(log.radio.ctaf)}"></label>
        <label class="field"><span>Unicom</span><input class="input mono" data-bind="radio.unicom" value="${esc(log.radio.unicom)}"></label>
        <label class="field"><span>Other</span><input class="input mono" data-bind="radio.other" value="${esc(log.radio.other)}"></label>
      </div>
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
  ${fabHTML('add-sortie', 'Add the next sortie')}`;
}

function debriefView(log) {
  const totals = timeTotals(log);
  const sar = log.sar;
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
        <div class="head-left"><h2>Flight times</h2></div>
        <span class="muted small">UTC</span>
      </div>
      ${TIME_DEFS.map(def => timeRowHTML(log, def)).join('')}
      <div class="totals">
        <div class="total"><div class="tl">Wheels up → down</div><div class="tv" id="tot-flight">${fmtDuration(totals.flight)}</div></div>
        <div class="total"><div class="tl">Engine start → shut</div><div class="tv" id="tot-engine">${fmtDuration(totals.engine)}</div></div>
        <div class="total"><div class="tl">Tach</div><div class="tv" id="tot-tach">${totals.tach == null ? '—' : fmtDecimal(totals.tach, 1)}</div></div>
        <div class="total"><div class="tl">Hobbs used</div><div class="tv" id="tot-hobbs">${totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1)}</div></div>
      </div>
      <div class="note-strip">Correct the checkpoint times and Hobbs here. Editing a time also updates the matching entry in the flight log.</div>
    </section>

    ${tachCardHTML(log)}

    ${trackCardHTML(log)}

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Search results</h2></div>
        <span class="muted small">CAPF 104a · actual</span>
      </div>
      ${sarColumnHTML(log, 'actual')}
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Crew remarks &amp; notes</h2></div></div>
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
      const parsed = parseFplWaypoints(await file.text());
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

function signView(log) {
  return `<div class="stack"><section class="card">
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
    <button class="btn primary" data-act="share-log" style="width:100%">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>
      </svg>
      Share signed log (PDF)
    </button>
    <div class="sketch-hint">Builds the mission log PDF with this sign-off and opens the share sheet — AirDrop, Mail, Messages or Save to Files.</div>
  </section></div>`;
}

function notesView(log) {
  return `<div class="stack">
    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Notes</h2></div></div>
      <textarea class="input notes-area" data-bind="notes" data-autogrow
        placeholder="Narrative notes, radio traffic, coordination, anything that does not fit elsewhere.">${esc(log.notes)}</textarea>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Sketch pad</h2></div>
        <div class="sketch-tools">
          <button type="button" class="swatch active" data-act="pen" data-color="#17222e" aria-label="Black pen" title="Black pen"></button>
          <button type="button" class="swatch red" data-act="pen" data-color="#b3261e" aria-label="Red pen" title="Red pen"></button>
          <button type="button" class="swatch eraser" data-act="eraser" aria-label="Eraser" title="Eraser">⌫</button>
          <button type="button" class="mini" data-act="undo-sketch">Undo</button>
          <button type="button" class="mini" data-act="clear-sketch">Clear</button>
        </div>
      </div>
      <div class="sketch-mode">
        <span class="sketch-mode-label">Draw with</span>
        <div class="seg">
          <button type="button" data-act="set-finger-mode" data-value="0" class="${state.settings.fingerDraw ? '' : 'active'}">Apple Pencil</button>
          <button type="button" data-act="set-finger-mode" data-value="1" class="${state.settings.fingerDraw ? 'active' : ''}">Finger</button>
        </div>
        <span class="sketch-mode-note">${state.settings.fingerDraw ? 'Finger draws. Switch to Pencil to scroll.' : 'Pencil draws. A finger scrolls the page.'}</span>
      </div>
      <div class="canvas-wrap">
        <canvas id="sketch" width="1000" height="1250" aria-label="Sketch pad"></canvas>
        ${!state.settings.fingerDraw && !log.sketch ? '<div class="canvas-tip">Using a finger? Choose <strong>Finger</strong> above.</div>' : ''}
      </div>
      <div class="sketch-hint">
        ${state.settings.fingerDraw
          ? 'A finger or Apple Pencil draws. Switch to Apple Pencil mode when you want a finger to scroll the page.'
          : 'Apple Pencil draws. A finger scrolls the page. Choose Finger to sketch with a finger.'}
        Sketches save automatically.
      </div>
    </section>
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

function setupSketch() {
  const canvas = $('#sketch');
  if (!canvas) { sketchCtl = null; return; }
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const log = activeLog();

  let color = '#17222e';
  let eraser = false;
  let drawing = false;
  let dirty = false;
  let last = null;
  let saveSketchTimer = null;
  const undoStack = [];
  const hadSketchAtStart = !!log.sketch;

  function paintGrid() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
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
  }

  function loadImage(data) {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
    };
    img.src = data;
  }

  function snapshot() {
    try {
      undoStack.push({
        data: canvas.toDataURL('image/jpeg', 0.7),
        base: undoStack.length === 0 && !hadSketchAtStart && !dirty
      });
      if (undoStack.length > 8) undoStack.shift();
    } catch (_) { /* ignore */ }
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (W / rect.width),
      y: (event.clientY - rect.top) * (H / rect.height)
    };
  }

  function strokeStyle() {
    ctx.strokeStyle = eraser ? '#ffffff' : color;
    ctx.lineWidth = eraser ? 30 : 3.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function onDown(event) {
    if (event.pointerType !== 'pen' && !state.settings.fingerDraw) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const tip = canvas.parentElement.querySelector('.canvas-tip');
    if (tip) tip.remove();
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    snapshot();
    dirty = true;
    drawing = true;
    last = pointFrom(event);
    strokeStyle();
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(last.x + 0.01, last.y + 0.01);
    ctx.stroke();
  }

  function onMove(event) {
    if (!drawing) return;
    event.preventDefault();
    const p = pointFrom(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }

  function persist() {
    if (!dirty) return;
    try {
      log.sketch = canvas.toDataURL('image/jpeg', 0.82);
      save();
    } catch (err) {
      console.warn('sketch save failed', err);
    }
  }

  function scheduleSave() {
    clearTimeout(saveSketchTimer);
    saveSketchTimer = setTimeout(persist, 500);
  }

  function onUp(event) {
    if (!drawing) return;
    drawing = false;
    last = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    scheduleSave();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  if (log.sketch) loadImage(log.sketch);
  else paintGrid();

  sketchCtl = {
    mode() { return { color, eraser }; },
    setColor(next) { color = next; eraser = false; updateToolbarState(); },
    setEraser() { eraser = true; updateToolbarState(); },
    undo() {
      const item = undoStack.pop();
      if (!item) return;
      if (item.base) {
        paintGrid();
        log.sketch = '';
        dirty = false;
      } else {
        loadImage(item.data);
        log.sketch = item.data;
        dirty = true;
      }
      save();
    },
    clear() {
      paintGrid();
      log.sketch = '';
      undoStack.length = 0;
      dirty = false;
      clearTimeout(saveSketchTimer);
      save();
    },
    flush() {
      clearTimeout(saveSketchTimer);
      persist();
    }
  };

  updateToolbarState();
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
}

function closeSheet() {
  const overlay = $('#overlay');
  if (!overlay || sheetLocked) return;
  overlay.classList.remove('show');
  overlay.innerHTML = '';
  document.documentElement.classList.remove('sheet-open');
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

function hobbsSheet(entryId) {
  const log = activeLog();
  const entry = log.entries.find(e => e.id === entryId);
  if (!entry) return;
  const tachKey = KIND_TO_TACHKEY[entry.kind];
  // Shut Down starts from the Engine Start tach, ready to be adjusted upwards.
  const tachValue = tachKey ? (log.times[tachKey] || (tachKey === 'tachEnd' ? log.times.tachStart : '') || '') : '';
  const meter = (id, label, value, active) => `<label class="meter-entry">
      <span>${label}</span>
      <input class="input hobbs-big mono ${active ? 'kp-active' : ''}" id="${id}" inputmode="none" autocomplete="off"
        value="${esc(value)}" placeholder="0.0">
    </label>`;
  openSheet({
    title: tachKey ? 'Hobbs &amp; tach' : 'Hobbs',
    sub: entry.event + ' · ' + fmtZ(entry.time),
    body: `
      <div class="meter-entries ${tachKey ? 'two' : ''}">
        ${meter('k-hobbs', 'Hobbs', entry.hobbs, true)}
        ${tachKey ? meter('k-tach', 'Tach', tachValue, false) : ''}
      </div>
      ${keypadHTML('#overlay .kp-active')}
      <div class="sheet-note" style="text-align:center">${tachKey
        ? 'Type Hobbs, then Next for tach. On G1000 aircraft tach is ENG HOURS (ENGINE, then SYSTEM).'
        : 'Type the reading, or adjust the last one with ±0.1.'}</div>
    `,
    footer: `<button type="button" class="btn" data-close>Skip</button>
      <button type="button" class="btn primary" id="k-next" data-act="${tachKey ? 'hobbs-next' : 'save-hobbs'}" data-id="${esc(entry.id)}">${tachKey ? 'Next: tach' : 'Save'}</button>`,
    onClose: () => render()
  });
  $$('#overlay .hobbs-big').forEach(input => {
    setKeypadFresh(input, true);
    input.addEventListener('focus', () => setMeterActive(input));
    input.addEventListener('keydown', () => setKeypadFresh(input, false));   // hardware keyboard
  });
}

// Point the keypad at one of the two readings; the footer button follows.
function setMeterActive(input) {
  $$('#overlay .hobbs-big').forEach(el => el.classList.toggle('kp-active', el === input));
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
  closeSheet();
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
            <span>Flight log CSV<span class="mi-sub">Time, Hobbs, position and remarks</span></span>
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

      <div class="setting-row">
        <div class="setting-label">Finger drawing<small>Off means one finger scrolls the sketch</small></div>
        <button type="button" class="toggle ${settings.fingerDraw ? 'on' : ''}" data-act="toggle-finger">
          <span class="tick">✓</span> ${settings.fingerDraw ? 'On' : 'Off'}
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
            <span><strong>Apple Pencil</strong><span class="mi-sub">Choose <strong>Finger</strong> above the sketch pad to draw without a pencil. In Apple Pencil mode a finger scrolls the page instead of drawing.</span></span>
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
  if (state.settings.hobbsPrompt) hobbsSheet(entry.id);
  toast(label + ' logged at ' + fmtZ(entry.time), 'Undo', () => {
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
  requestAnimationFrame(() => {
    const last = $('.obs[data-obs-id="' + obs.id + '"]');
    if (last) {
      const area = last.querySelector('textarea');
      if (area) {
        area.focus({ preventScroll: true });
        last.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  });
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

function switchLog(id) {
  if (!state.logs.some(l => l.id === id)) return;
  state.activeId = id;
  closeSheet();
  activeTab = defaultTab();
  save();
  render();
  window.scrollTo(0, 0);
}

/* ---------- missions and sorties ----------
   Each log is one sortie. Sorties that share a missionId belong to one mission,
   and the mission-level fields below are kept the same on all of them. */

const MISSION_FIELDS = ['mission', 'base', 'sar.missionDate', 'signoff.name', 'signoff.capid', 'missionCreated'];

function missionSorties(log) {
  const l = log || activeLog();
  return state.logs
    .filter(other => other.missionId === l.missionId)
    .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
}

function getPath(obj, path) {
  return path.split('.').reduce((value, key) => (value == null ? value : value[key]), obj);
}

// Copy a mission-level field from one sortie to the rest of its mission.
function syncMissionField(log, path) {
  if (!MISSION_FIELDS.includes(path)) return;
  const value = getPath(log, path);
  missionSorties(log).forEach(other => { if (other !== log) setPath(other, path, value); });
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

function nextSortieNumber(sorties) {
  const numbers = sorties.map(l => parseInt(l.sortie, 10)).filter(Number.isFinite);
  return numbers.length ? String(Math.max(...numbers) + 1) : '';
}

function createLog() {
  openNewMissionSheet();
}

// The next sortie of this mission: same crew, aircraft, frequencies and search
// area; times, Hobbs, entries, observations and results start empty.
function addSortie() {
  const current = activeLog();
  if (!current.missionCreated) {
    openNewMissionSheet();
    return;
  }
  const placeholder = missionSorties(current).find(l => !l.started);
  if (placeholder) {
    placeholder.started = true;
    if (!placeholder.sortie) placeholder.sortie = '1';
    state.activeId = placeholder.id;
    closeSheet();
    activeTab = 'plan';
    save();
    render();
    window.scrollTo(0, 0);
    toast('Sortie 1 added · set up its crew, aircraft and search area');
    return;
  }
  const source = current;
  const sorties = missionSorties(source);
  const log = blankLog();
  log.missionId = source.missionId;
  log.missionCreated = true;
  log.started = true;
  ['mission', 'base', 'capFlight', 'aircraft', 'callsign', 'sectional', 'grid', 'altitude', 'airspeed']
    .forEach(key => { log[key] = source[key]; });
  log.crew = deepClone(source.crew).map(m => Object.assign(m, { id: uid() }));
  log.radio = deepClone(source.radio);
  log.navAids = deepClone(source.navAids);
  log.entry = deepClone(source.entry);
  log.exit = deepClone(source.exit);
  ['missionDate', 'reporter', 'reporterCapid', 'areaName'].forEach(key => { log.sar[key] = source.sar[key]; });
  log.sar.corners = deepClone(source.sar.corners);
  log.signoff.name = source.signoff.name;
  log.signoff.capid = source.signoff.capid;
  log.sortie = nextSortieNumber(sorties);
  state.logs.push(log);
  state.activeId = log.id;
  closeSheet();
  activeTab = 'plan';   // check the copied crew, aircraft and search area
  save();
  render();
  window.scrollTo(0, 0);
  toast(sortieLabel(log, sorties.length) + ' started · crew, aircraft and search area copied');
}

function deleteMission() {
  const log = activeLog();
  const sorties = missionSorties(log);
  if (!confirm('Delete mission ' + (log.mission || '(no number)') + ' and its ' + sorties.length + ' sortie' +
    (sorties.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
  state.logs = state.logs.filter(l => l.missionId !== log.missionId);
  if (!state.logs.length) state.logs.push(blankLog());
  state.activeId = state.logs[state.logs.length - 1].id;
  activeTab = 'logbook';
  save();
  render();
  toast('Mission deleted');
}

function deleteLog() {
  const log = activeLog();
  const sorties = missionSorties(log);
  const index = sorties.indexOf(log);
  const what = sorties.length > 1
    ? sortieLabel(log, index) + ' of ' + (log.mission || 'this mission')
    : '“' + (log.mission || 'New Mission') + '”';
  if (!confirm('Delete ' + what + ' and all of its entries? This cannot be undone.')) return;
  state.logs.splice(state.logs.indexOf(log), 1);
  if (!state.logs.length) state.logs.push(blankLog());
  const sibling = sorties.find(other => other !== log);
  state.activeId = (sibling || state.logs[0]).id;
  closeSheet();
  activeTab = defaultTab();
  save();
  render();
  toast(sorties.length > 1 ? 'Sortie deleted' : 'Mission deleted');
}

function sortieRowHTML(l, index) {
  const start = l.times.engineStart.time ? fmtZ(l.times.engineStart.time) : 'not started';
  return `<button type="button" class="log-row sortie-row ${l.id === state.activeId ? 'active' : ''}" data-act="switch-log" data-id="${esc(l.id)}">
    <span class="log-name">${esc(sortieLabel(l, index))}</span>
    <span class="log-meta">${esc(l.aircraft || 'no tail')} · ${esc(start)} · ${l.entries.length} entr${l.entries.length === 1 ? 'y' : 'ies'}${l.receivedFrom ? ' · from ' + esc(l.receivedFrom) : ''}</span>
  </button>`;
}

// Header switcher: the sorties of this mission, and + Sortie.
function sortieSheet() {
  const log = activeLog();
  const sorties = missionSorties(log);
  openSheet({
    title: 'Sorties',
    sub: (log.mission || 'New Mission') + ' · ' + sorties.length + ' sortie' + (sorties.length === 1 ? '' : 's'),
    body: `
      <div class="log-list">${sorties.map(sortieRowHTML).join('')}</div>
      <div class="sheet-note">
        + Sortie starts the next sortie of this mission with the same crew, aircraft, frequencies and search
        area. The mission number, base, mission date and your name and CAPID are shared by every sortie.
        Send to crew shares this sortie by AirDrop; they save it to Files and use Menu → Import backup.
      </div>
    `,
    footer: `<button type="button" class="btn danger left" data-act="del-log">Delete this sortie</button>
      <button type="button" class="btn" data-act="send-sortie">Send to crew</button>
      <button type="button" class="btn primary" data-act="add-sortie">+ Sortie</button>`
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
  return 'mission-log_' + slug(log.mission) + '_s' + slug(log.sortie) + '_' + date + '.' + extension;
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
    logs: state.logs
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  shareFile(exportName('json'), blob);
  toast('Backup ready');
}

/* One sortie, to hand to a crew member: share sheet → AirDrop, Messages, Mail.
   They save it to Files and use Menu → Import, where it joins their copy of
   the mission as its own sortie. */
function exportSortie() {
  const log = activeLog();
  if (sketchCtl) sketchCtl.flush();
  const payload = {
    app: 'Mission Log',
    kind: 'sortie',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    from: log.signoff.name || crewNames(log, 'MO').split('; ')[0] || '',
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
  const log = activeLog();
  const header = ['Mission', 'Sortie', 'Aircraft', 'Callsign', 'Time (Z)', 'Hobbs', 'Latitude (DD)', 'Longitude (DD)', 'Event', 'Remarks', 'GPS accuracy (m)'];
  const rows = [header];
  log.entries.forEach(entry => {
    const lat = parseLat(entry.lat);
    const lon = parseLon(entry.lon);
    rows.push([
      log.mission, log.sortie, log.aircraft, log.callsign,
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

  const shared = data && data.kind === 'sortie';
  const replacing = incoming.filter(raw => raw && state.logs.some(l => l.id === raw.id)).length;
  if (replacing && !confirm(replacing === 1 && shared
    ? 'This sortie is already on this iPad. Replace it with the copy in the file? Changes made here since it was shared will be lost.'
    : replacing + ' of these sorties are already on this iPad and will be replaced by the copies in the file. Continue?')) return;

  let added = 0;
  let lastId = null;
  incoming.forEach(raw => {
    const log = normalizeLog(raw);
    if (!log.missionId || !state.logs.some(l => l.missionId === log.missionId)) {
      // join a mission here with the same number, if there is one
      const key = String(log.mission || '').trim().toUpperCase();
      const match = key && state.logs.find(l => String(l.mission || '').trim().toUpperCase() === key);
      log.missionId = match ? match.missionId : (log.missionId || uid());
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
    state.activeId = lastId;
    activeTab = defaultTab();
  }
  if (data.settings) {
    const { termsAccepted, termsAcceptedAt } = state.settings;
    state.settings = Object.assign(state.settings, data.settings, { termsAccepted, termsAcceptedAt });
  }
  save();
  applyTheme();
  render();
  toast('Imported ' + incoming.length + ' log' + (incoming.length === 1 ? '' : 's') +
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
      importBackupText(await file.text());
    } catch (err) {
      console.warn(err);
      toast('Could not import that file');
    }
  });
  input.click();
}

function printLog() {
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

let pdfLogoData = null;

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

function loadImageData(url) {
  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('image request failed');
      return response.blob();
    })
    .then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }));
}

function preloadPdfLogo() {
  loadImageData('icons/emblem.png')
    .then(data => { pdfLogoData = data; })
    .catch(() => { /* the PDF still works without the corner mark */ });
}

function pdfHeader(doc, title, subtitle, rightLines) {
  const W = doc.internal.pageSize.getWidth();
  const M = 36;
  const navy = [18, 63, 110];

  if (pdfLogoData) {
    try { doc.addImage(pdfLogoData, 'PNG', M, 28, 40, 40); } catch (_) { /* ignore */ }
  }

  const textX = pdfLogoData ? M + 50 : M;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text(pdfSafe(title), textX, 46);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(92, 106, 118);
  doc.text(pdfSafe(subtitle).toUpperCase(), textX, 59);

  doc.setFontSize(8);
  doc.setTextColor(30, 40, 50);
  rightLines.forEach((line, index) => {
    doc.text(pdfSafe(line), W - M, 38 + index * 11, { align: 'right' });
  });

  doc.setDrawColor(navy[0], navy[1], navy[2]);
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
  const navy = [18, 63, 110];
  const grey = [92, 106, 118];
  const dark = [30, 40, 50];
  const log = activeLog();
  const totals = timeTotals(log);
  const printed = fmtDateZ(new Date());
  const mission = pdfSafe(log.mission || 'Untitled mission');
  const sortie = pdfSafe(log.sortie || '-');
  const aircraft = pdfSafe(log.aircraft || 'No tail');

  pdfHeader(doc, 'Observer Mission Log', 'Sortie record', [
    'Printed ' + printed,
    'Entries ' + log.entries.length
  ]);

  let y = 86;

  const coordText = (latRaw, lonRaw) => pdfCoordPair(latRaw, lonRaw) || '';

  const meta = [
    ['Mission', mission], ['Sortie', sortie], ['Aircraft N#', aircraft], ['Callsign', pdfSafe(log.callsign)],
    ['Base', pdfSafe(log.base)], ['CAP flight', pdfSafe(log.capFlight)], ['Sectional', pdfSafe(log.sectional)], ['Grid', pdfSafe(log.grid)],
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
    doc.setDrawColor(170, 185, 198);
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
  doc.setTextColor(navy[0], navy[1], navy[2]);
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
      lineColor: [150, 160, 170], lineWidth: 0.4, overflow: 'linebreak'
    },
    headStyles: { fillColor: [232, 238, 244], textColor: navy, fontSize: 6.2, fontStyle: 'bold' },
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
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('FLIGHT TIMES', M, y + 7);
  doc.text('TOTALS', 350, y + 7);

  const leftW = 300;
  const rowH = 15;
  const tableTop = y + 13;

  doc.setFillColor(232, 238, 244);
  doc.rect(M, tableTop, leftW, rowH, 'F');
  doc.setDrawColor(150, 160, 170);
  doc.setLineWidth(0.5);
  doc.rect(M, tableTop, leftW, rowH);
  doc.line(M + 150, tableTop, M + 150, tableTop + rowH);
  doc.line(M + 215, tableTop, M + 215, tableTop + rowH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.2);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('EVENT', M + 4, tableTop + 10);
  doc.text('TIME (Z)', M + 156, tableTop + 10);
  doc.text('HOBBS', M + 221, tableTop + 10);

  TIME_DEFS.forEach((def, index) => {
    const value = log.times[def.key] || {};
    const top = tableTop + rowH * (index + 1);
    doc.setDrawColor(170, 185, 198);
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
    ['Engine run', fmtDuration(totals.engine)],
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
    doc.setDrawColor(170, 185, 198);
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
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('FLIGHT LOG', M, y + 7);

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
      lineColor: [150, 160, 170],
      lineWidth: 0.4,
      overflow: 'linebreak'
    },
    headStyles: {
      fillColor: [232, 238, 244],
      textColor: navy,
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
  doc.setTextColor(navy[0], navy[1], navy[2]);
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
      lineColor: [150, 160, 170],
      lineWidth: 0.4
    },
    headStyles: {
      fillColor: [232, 238, 244],
      textColor: navy,
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

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('NOTES / SKETCHES', M, ny + 6);
  ny += 13;

  const noteText = pdfSafe(log.notes || '');
  const noteLines = noteText ? doc.splitTextToSize(noteText, CW - 10) : [];
  const noteH = Math.max(46, Math.min(160, noteLines.length * 9.6 + 12));
  doc.setDrawColor(170, 185, 198);
  doc.setLineWidth(0.5);
  doc.rect(M, ny, CW, noteH);
  if (noteLines.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(noteLines.slice(0, Math.floor((noteH - 9) / 9.6)), M + 5, ny + 8);
  }
  ny += noteH + 8;

  const sketch = safeImage(log.sketch);
  if (sketch) {
    let sw = 190;
    let sh = 238;
    if (ny + sh > 460) { sw = 160; sh = 200; }
    if (ny + sh > H - 40) {
      doc.addPage();
      pdfHeader(doc, 'Notes & Observations (continued)', mission + ' · Sortie ' + sortie, ['Printed ' + printed]);
      ny = 88;
    }
    const sx = (W - sw) / 2;
    try {
      doc.addImage(sketch, 'JPEG', sx, ny, sw, sh);
      doc.setDrawColor(170, 185, 198);
      doc.rect(sx - 2, ny - 2, sw + 4, sh + 4);
    } catch (_) { /* skip a broken image */ }
    ny += sh + 10;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
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

    doc.setFillColor(238, 243, 248);
    doc.rect(M, ny, CW, 15, 'F');
    doc.setDrawColor(170, 185, 198);
    doc.rect(M, ny, CW, boxH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(navy[0], navy[1], navy[2]);
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
          doc.setDrawColor(170, 185, 198);
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
  doc.setTextColor(navy[0], navy[1], navy[2]);
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
      doc.setTextColor(navy[0], navy[1], navy[2]);
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
          lineColor: [150, 160, 170], lineWidth: 0.4, overflow: 'linebreak'
        },
        headStyles: { fillColor: [232, 238, 244], textColor: navy, fontSize: 6.2, fontStyle: 'bold' },
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
    cell('Mission', log.mission),
    cell('Sortie', log.sortie),
    cell('Aircraft N#', log.aircraft),
    cell('Callsign', log.callsign),
    cell('Base', log.base),
    cell('CAP flight', log.capFlight),
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
  const sketchSource = safeImage(log.sketch);

  const printDate = fmtDateZ(new Date());

  $('#print').innerHTML = `
    <section class="print-page">
      <div class="p-head">
        <div class="p-brand">
          <img class="p-emblem" src="icons/emblem.png" alt="">
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
          <div class="p-section-title">Flight times</div>
          <table class="p-table p-times">
            <thead><tr><th>Event</th><th class="c">Time (Z)</th><th class="c">Hobbs</th></tr></thead>
            <tbody>${timesRows}</tbody>
          </table>
        </div>
        <div class="p-section" style="margin-top:0">
          <div class="p-section-title">Totals</div>
          <div class="p-totals">
            <div class="p-total"><div class="tl">Flight time</div><div class="tv">${fmtDuration(totals.flight)}</div></div>
            <div class="p-total"><div class="tl">Engine run</div><div class="tv">${fmtDuration(totals.engine)}</div></div>
            <div class="p-total"><div class="tl">Total tach</div><div class="tv">${totals.tach == null ? '—' : fmtDecimal(totals.tach, 1)}</div></div>
            <div class="p-total"><div class="tl">Hobbs used</div><div class="tv">${totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1)}</div></div>
          </div>
          <div class="p-note">Tach start ${esc(tachValues(log).start || '________')} · Tach end ${esc(tachValues(log).end || '________')}</div>
        </div>
      </div>

      <div class="p-section">
        <div class="p-section-title">Flight log</div>
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
        <span>Observer Mission Log · ${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
        <span>Sortie record</span>
      </div>
    </section>

    <section class="print-page">
      <div class="p-head">
        <div class="p-brand">
          <img class="p-emblem" src="icons/emblem.png" alt="">
          <div>
            <div class="p-title">Notes &amp; Observations</div>
            <div class="p-sub">${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')} · ${esc(log.aircraft || 'No tail')}</div>
          </div>
        </div>
        <div class="p-head-right"><b>Printed</b> ${esc(printDate)}</div>
      </div>

      <div class="p-section" style="margin-top:0">
        <div class="p-section-title">Notes / sketches</div>
        <div class="p-notes-text">${esc(log.notes || '')}</div>
        ${sketchSource ? `<div class="p-sketch"><img src="${sketchSource}" alt="Sketch"></div>` : ''}
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
        <span>Observer Mission Log · ${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
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
          <img class="p-emblem" src="icons/emblem.png" alt="">
          <div>
            <div class="p-title">SAR Results Worksheet</div>
            <div class="p-sub">CAPF 104a · ${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</div>
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
        <span>Observer Mission Log · ${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
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
  'edit-mission': () => {
    if (!activeLog().missionCreated) { openNewMissionSheet(); return; }
    switchTab('plan');
    const number = $('#mission-card [data-bind="mission"]');
    if (number && !number.value) number.focus();
  },
  'show-missions': () => switchTab('logbook'),
  'open-mission': el => {
    const sorties = state.logs.filter(l => l.missionId === el.dataset.id).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    if (!sorties.length) return;
    state.activeId = sorties[sorties.length - 1].id;
    save();
    switchTab('plan');
  },
  'del-mission': () => deleteMission(),
  'new-mission': () => openNewMissionSheet(),
  'nm-save': () => saveNewMission(),
  'nm-today': () => { const d = $('#nm-date'); if (d) d.value = todayMissionDate(); },
  'goto-ops': () => {
    if (activeTab !== 'fly') switchTab('fly');
    const card = $('#ops-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    positionSheet();
  },
  'pos-close': () => closePositionView(),
  'pos-recenter': () => {
    const fix = freshFix() || lastGpsFix;
    if (!positionMap || !fix) return;
    positionMap.follow = true;
    positionMap.map.setView([fix.lat, fix.lon], chartFullZoom());
  },
  'track-map': () => {
    positionSheet();
    setTimeout(() => drawTrackOnMap(true), 320);
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
  'switch-log': el => switchLog(el.dataset.id),
  'new-log': () => createLog(),
  'add-sortie': el => {
    // from the Logbook: the sortie goes on that mission
    if (el && el.dataset.mission) {
      const mine = state.logs.filter(l => l.missionId === el.dataset.mission)
        .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
      if (mine.length) state.activeId = mine[mine.length - 1].id;
    }
    addSortie();
  },
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
  'del-log': () => deleteLog(),
  'menu': () => menuSheet(),
  'settings': () => settingsSheet(),
  'help': () => helpSheet(),
  'terms': () => termsSheet(false),
  'accept-terms': () => acceptTerms(),
  'print': () => printLog(),
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
  'toggle-finger': () => {
    state.settings.fingerDraw = !state.settings.fingerDraw;
    if (sketchCtl) sketchCtl.flush();
    if (sigCtl) sigCtl.flush();
    applyTheme();
    save();
    if ($('#overlay').classList.contains('show')) settingsSheet();
    else if (activeTab === 'notes') render();
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
    save();
    closeSheet();
    toast('Search area corners filled from ForeFlight');
  },
  'sar-clear-corners': () => {
    const sar = activeLog().sar;
    const previous = deepClone(sar.corners);
    if (!sarHasData(previous)) return;
    sar.corners = blankSar().corners;
    save();
    render();
    toast('Search area corners cleared', 'Undo', () => {
      sar.corners = previous;
      save();
      if (activeTab === 'plan') render();
    });
  },
  'sar-today': () => {
    // The local calendar date, as it would be written on the paper form.
    const now = new Date();
    const value = pad2(now.getDate()) + ' ' + MONTHS[now.getMonth()] + ' ' + String(now.getFullYear()).slice(-2);
    activeLog().sar.missionDate = value;
    syncMissionField(activeLog(), 'sar.missionDate');
    const input = $('[data-bind="sar.missionDate"]');
    if (input) input.value = value;
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
  'set-finger-mode': el => {
    const next = el.dataset.value === '1';
    if (state.settings.fingerDraw === next) return;
    state.settings.fingerDraw = next;
    if (sketchCtl) sketchCtl.flush();
    if (sigCtl) sigCtl.flush();
    applyTheme();
    save();
    render();
  },
  'reset-all': () => resetAll(),
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
  'pen': el => {
    if (sketchCtl) sketchCtl.setColor(el.dataset.color);
  },
  'eraser': () => {
    if (sketchCtl) sketchCtl.setEraser();
  },
  'undo-sketch': () => {
    if (sketchCtl) sketchCtl.undo();
  },
  'clear-sketch': () => {
    if (!confirm('Clear the sketch pad?')) return;
    if (sketchCtl) sketchCtl.clear();
  }
};

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  // Only Missions and Sorties open until a mission with a sortie is picked.
  if (tab !== 'plan' && tab !== 'logbook' && !sortieReady()) {
    tab = activeLog().missionCreated ? 'plan' : 'logbook';
    toast(activeLog().missionCreated ? 'Add the first sortie to open its tabs' : 'Pick or add a mission first');
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

  if (path.startsWith('settings.')) setPath(state, path, el.value);
  else {
    setPath(activeLog(), path, el.value);
    syncMissionField(activeLog(), path);
  }

  if (el.matches('[data-coord]')) updateCoordHelp(el);
  if (/^(mission|sortie|aircraft|callsign|crew\.)/.test(path)) renderStrip();

  save();
});

document.addEventListener('change', event => {
  const el = event.target.closest('[data-bind]');
  if (!el) return;
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

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if ($('#pos-full')) closePositionView();
    else if ($('#overlay').classList.contains('show')) closeSheet();
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

  preloadPdfLogo();
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

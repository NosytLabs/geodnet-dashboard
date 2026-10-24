/**
 * GEODNET GNSS Local Network Dashboard - backend
 *
 * Polls a physical GEODNET / HYFIX "MobileCM" GNSS base station receiver on the
 * local network and normalizes its telemetry into one stable JSON shape.
 *
 * Runs 100% locally: no cloud APIs, no external internet, no third-party auth.
 *
 * Run:  node server.js
 * Env:  MINER_IP (default 192.168.2.11)
 *       MINER_PORT (default 80)
 *       PORT (default 3000)
 *       MINER_KEY (device login key; defaults to the device serial)
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  minerIp: process.env.MINER_IP || '192.168.2.11',
  minerPort: Number(process.env.MINER_PORT || 80),
  port: Number(process.env.PORT || 3000),
  pollTimeoutMs: 3000,
  // The MobileCM firmware gates its web UI behind a "Miner Key" login that returns
  // a base64("admin:<key>") cookie. The key is the device serial by default.
  minerKey: process.env.MINER_KEY || process.env.GEODNET_MINER_KEY || '',
};

const CONSTELLATIONS = ['GPS', 'GLONASS', 'Galileo', 'BeiDou'];

/* ------------------------------------------------------------------ helpers */

/** Fetch JSON/text with a hard timeout. Never throws for network reasons. */
async function fetchWithTimeout(url, { timeout = CONFIG.pollTimeoutMs, headers = {}, method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON - caller decides how to handle */
    }
    return { ok: res.ok, status: res.status, text, json, headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, text: '', json: null, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Pick the first defined value from a list of candidate keys (case/format tolerant). */
function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  // case-insensitive second pass
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), obj[k]]));
  for (const key of keys) {
    const v = lower.get(String(key).toLowerCase());
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function num(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize a constellation label to one of the four families we chart. */
function normalizeConstellation(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  if (s.includes('GPS') || s.includes('NAVSTAR') || s === 'G' || s.startsWith('GPS')) return 'GPS';
  if (s.includes('GLONASS') || s.includes('GLON') || s === 'R' || s.startsWith('GLO')) return 'GLONASS';
  if (s.includes('GALILEO') || s === 'E' || s.startsWith('GAL')) return 'Galileo';
  if (s.includes('BEIDOU') || s.includes('BDS') || s.includes('COMPASS') || s === 'C' || s.startsWith('BEI')) return 'BeiDou';
  if (s.includes('QZSS') || s.includes('SBAS')) return 'QZSS';
  if (s.includes('IRNSS') || s.includes('NAVIC')) return 'IRNSS';
  return s;
}

/**
 * Derive the constellation family from a satellite PRN / slot number when the
 * payload does not name the constellation explicitly.
 * GPS 1-32, GLONASS 64-96, BeiDou 159-163 + 33-64, Galileo 211-246, QZSS 193-202.
 */
function constellationFromId(id) {
  const n = num(id, null);
  if (n === null) return null;
  if (n >= 1 && n <= 32) return 'GPS';
  if (n >= 33 && n <= 64) return 'BeiDou';
  if (n >= 65 && n <= 96) return 'GLONASS';
  if (n >= 159 && n <= 163) return 'BeiDou';
  if (n >= 193 && n <= 202) return 'QZSS';
  if (n >= 211 && n <= 246) return 'Galileo';
  return null;
}

/** Locate a satellite array inside an arbitrary payload, trying many shapes. */
function findSatelliteArray(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  const directKeys = [
    'satellites_detail', 'satellites', 'satellitesDetail', 'sats', 'satList',
    'satelliteList', 'visibleSatellites', 'trackedSatellites', 'gnssSatellites',
    'sky', 'spaceVehicles', 'sv', 'obs', 'observations', 'sat',
  ];
  for (const key of directKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  // one level deep
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of directKeys) {
        if (Array.isArray(value[key])) return value[key];
      }
    }
  }
  // two levels deep (e.g. { gnss: { tracked: { satellites: [] } } })
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const inner of Object.values(value)) {
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          for (const key of directKeys) {
            if (Array.isArray(inner[key])) return inner[key];
          }
        }
      }
    }
  }
  return null;
}

/** Normalize one raw satellite record into { id, constellation, elevation, azimuth, snr }. */
function normalizeSatellite(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = pick(raw, ['id', 'prn', 'satId', 'satid', 'svId', 'sv', 'prnId', 'satelliteId', 'satellite_id', 'num', 'number']);
  let constellation = normalizeConstellation(
    pick(raw, ['constellation', 'const', 'constellationType', 'gnssType', 'system', 'sys', 'type', 'constellationName', 'gnss', 'satType']),
  );
  if (!constellation) constellation = constellationFromId(id);
  if (!constellation) constellation = 'UNKNOWN';

  const elevation = num(pick(raw, ['elevation', 'el', 'elev', 'elevationDeg', 'elevation_deg', 'alt', 'altitude', 'elevationDegree']), null);
  const azimuth = num(pick(raw, ['azimuth', 'az', 'azi', 'azimuthDeg', 'azimuth_deg', 'bearing', 'azm']), null);
  const snr = num(pick(raw, ['snr', 'cno', 'cn0', 'signalStrength', 'signal_strength', 'signal', 'snrValue', 'snr_db', 'dbhz', 'quality'], null));

  if (id === undefined && elevation === null && azimuth === null && snr === null) return null;
  return {
    id: id === undefined ? null : num(id, String(id)),
    constellation,
    elevation: elevation === null ? null : elevation,
    azimuth: azimuth === null ? null : ((azimuth % 360) + 360) % 360,
    snr: snr === null ? null : snr,
  };
}

/** Count constellations, preferring explicit counts when the payload has them. */
function summarize(sats, payload) {
  const counts = { gps: 0, glonass: 0, galileo: 0, beidou: 0 };
  const explicit = pick(payload, [
    'constellation_counts', 'constCounts', 'const_counts', 'constellationCounts',
    'summary', 'counts', 'stat', 'stats', 'constellation_summary', 'gpsCount',
  ]);
  const src = explicit && typeof explicit === 'object' ? explicit : payload;
  const keyMap = [
    ['gps', ['gps', 'GPS', 'gps_count', 'gpsCount', 'navstar']],
    ['glonass', ['glonass', 'GLONASS', 'glonass_count', 'glonassCount', 'glo']],
    ['galileo', ['galileo', 'Galileo', 'galileo_count', 'galileoCount', 'gal']],
    ['beidou', ['beidou', 'BeiDou', 'BeiDou', 'beidou_count', 'beidouCount', 'bds', 'compass']],
  ];
  for (const [target, aliases] of keyMap) {
    const v = num(pick(src, aliases), null);
    if (v !== null) counts[target] = v;
  }
  // Any constellation without an explicit count is derived from the satellite list.
  if (sats && sats.length) {
    const derived = { GPS: 0, GLONASS: 0, Galileo: 0, BeiDou: 0 };
    for (const s of sats) {
      if (s && derived[s.constellation] !== undefined) derived[s.constellation] += 1;
    }
    if (!counts.gps && derived.GPS) counts.gps = derived.GPS;
    if (!counts.glonass && derived.GLONASS) counts.glonass = derived.GLONASS;
    if (!counts.galileo && derived.Galileo) counts.galileo = derived.Galileo;
    if (!counts.beidou && derived.BeiDou) counts.beidou = derived.BeiDou;
  }
  const explicitTotal = num(pick(payload, ['total_tracked', 'totalTracked', 'total', 'satsTracked', 'tracked', 'numSatellites', 'satCount', 'sat_count', 'nsat', 'used']), null);
  const total = explicitTotal !== null ? explicitTotal : (sats ? sats.length : counts.gps + counts.glonass + counts.galileo + counts.beidou);
  return { total_tracked: total, ...counts };
}

/** Pull hardware identity/status out of whatever payload shape arrived. */
function normalizeHardware(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const statusRaw = pick(src, ['nsStatus', 'status', 'state', 'connection', 'connectStatus', 'streamStatus', 'ntripStatus', 'linkStatus'], null);
  const connected =
    typeof statusRaw === 'boolean'
      ? statusRaw
      : statusRaw !== null
        ? /^(transmitting|connected|online|active|running|ok|up|1|true)$/i.test(String(statusRaw).trim())
        : false;

  return {
    serial_number: pick(src, ['sn', 'serial', 'serialNumber', 'serial_number', 'deviceSn', 'stationSn'], null),
    uptime: pick(src, ['uptime', 'upTime', 'up_time', 'runTime', 'runtime'], null),
    software_version: pick(src, ['fwVer', 'firmware', 'swVer', 'software_version', 'version', 'fwVersion', 'appVer'], null),
    model: pick(src, ['hwVer', 'model', 'hardware', 'hwVersion', 'deviceModel'], null),
    gnss_receiver: pick(src, ['gnssVer', 'gnss', 'gnssVersion', 'receiver', 'gnssModel'], null),
    gnss_band: pick(src, ['gnss', 'band', 'gnssBand'], null),
    status_raw: statusRaw === null ? null : String(statusRaw),
    connected,
  };
}

/* ------------------------------------------------- MobileCM session (cookie) */

/**
 * The MobileCM web UI requires a login. POST /login with mkey=<key> returns a
 * base64("admin:<key>") token which is then used as the USER cookie.
 */
let session = { cookie: null, key: null, obtainedAt: 0 };
const SESSION_TTL_MS = 30 * 60 * 1000;

async function getSession(force = false) {
  const now = Date.now();
  if (!force && session.cookie && session.key && now - session.obtainedAt < SESSION_TTL_MS) {
    return session.cookie;
  }
  const base = `http://${CONFIG.minerIp}:${CONFIG.minerPort}`;
  const key = CONFIG.minerKey || CONFIG.minerIp;
  const res = await fetchWithTimeout(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `mkey=${encodeURIComponent(key)}`,
  });
  if (res.ok && res.text && res.text.length > 4 && !res.text.includes('<')) {
    const token = res.text.trim();
    session = { cookie: `USER=${token}`, key, obtainedAt: now };
    return session.cookie;
  }
  session = { cookie: null, key, obtainedAt: now };
  return null;
}

/* ------------------------------------------------------- device poll strategy */

/**
 * Endpoint chain, in priority order. Each entry knows how to fetch and parse it.
 *
 *  1. /status.json    - generic firmware revision A (per spec)
 *  2. /cgi-bin/status - generic firmware revision B (per spec)
 *  3. /devStatus      - the actual MobileCM/HYFIX endpoint discovered on this device
 */
const ENDPOINTS = [
  { path: '/status.json', label: 'status.json' },
  { path: '/cgi-bin/status', label: 'cgi-bin/status' },
  { path: '/devStatus', label: 'devStatus' },
];

let preferredEndpoint = null;
let lastGoodEndpoint = null;

async function tryEndpoint(endpoint) {
  const base = `http://${CONFIG.minerIp}:${CONFIG.minerPort}`;
  const cookie = await getSession();
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await fetchWithTimeout(`${base}${endpoint.path}`, { headers });
  if (!res.ok) {
    return { ok: false, reason: `http_${res.status}`, status: res.status };
  }
  if (res.json && typeof res.json === 'object') {
    return { ok: true, payload: res.json };
  }
  // Try to find JSON embedded in an HTML/text response.
  const embedded = res.text?.match(/\{[\s\S]*\}/);
  if (embedded) {
    try {
      return { ok: true, payload: JSON.parse(embedded[0]) };
    } catch {
      /* fall through */
    }
  }
  return { ok: false, reason: 'unparseable' };
}

/** Poll the device, walking the endpoint chain until one yields usable data. */
async function pollDevice() {
  const chain = preferredEndpoint
    ? [preferredEndpoint, ...ENDPOINTS.filter((e) => e.path !== preferredEndpoint.path)]
    : ENDPOINTS;

  const errors = [];
  for (const endpoint of chain) {
    const result = await tryEndpoint(endpoint);
    if (result.ok) {
      preferredEndpoint = endpoint;
      lastGoodEndpoint = endpoint.label;
      return { ok: true, endpoint: endpoint.label, payload: result.payload };
    }
    errors.push(`${endpoint.label}: ${result.reason}`);
  }
  return { ok: false, errors };
}

/* ------------------------------------------- GEODNET cloud satellite source */

/**
 * The GEODNET RTK API can return per-satellite SNR for a base station
 * (api/v3/station/info -> satInfo.satinfoG/R/E/C/I/J).
 *
 * It is signed: sort the request params (excluding appKey/sign), concatenate
 * their VALUES, append appKey, MD5 the result. appId/appKey are tenant
 * credentials issued by GEODNET - set them via env to enable this source.
 */
const GEODNET = {
  base: process.env.GEODNET_API_BASE || 'https://rtk.geodnet.com/api/v3',
  appId: process.env.GEODNET_APP_ID || '',
  appKey: process.env.GEODNET_APP_KEY || '',
  mountpoint: process.env.GEODNET_MOUNTPOINT || process.env.MINER_SN || '',
};

function buildSign(params, appKey) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'appKey')
    .sort();
  const concat = keys.map((k) => String(params[k])).join('');
  return createHash('md5').update(concat + appKey, 'utf8').digest('hex');
}

/** Map the GEODNET satinfo* groups onto the dashboard's constellation names. */
const GEODNET_SAT_GROUPS = {
  satinfoG: 'GPS',
  satinfoR: 'GLONASS',
  satinfoE: 'Galileo',
  satinfoC: 'BeiDou',
  satinfoI: 'QZSS',
  satinfoJ: 'NavIC',
};

async function fetchGeodnetSatellites() {
  if (!GEODNET.appId || !GEODNET.appKey || !GEODNET.mountpoint) {
    return { ok: false, reason: 'not_configured' };
  }
  const params = {
    appId: GEODNET.appId,
    name: GEODNET.mountpoint,
    time: Date.now(),
  };
  params.sign = buildSign(params, GEODNET.appKey);
  try {
    const res = await fetchWithTimeout(
      `${GEODNET.base}/station/info`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        timeout: 6000,
      }
    );
    if (!res.ok || !res.json) return { ok: false, reason: `http_${res.status}` };
    const body = res.json;
    if (body.code !== 1000) return { ok: false, reason: `api_${body.code}_${body.msg || ''}` };
    const satInfo = (body.data && body.data.satInfo) || {};
    const out = [];
    for (const [group, constellation] of Object.entries(GEODNET_SAT_GROUPS)) {
      for (const s of satInfo[group] || []) {
        out.push({
          id: num(s.prn, null),
          constellation,
          // GEODNET exposes SNR + PRN; elevation/azimuth are not in this payload.
          elevation: num(pick(s, ['elevation', 'el', 'elev']), null),
          azimuth: num(pick(s, ['azimuth', 'az']), null),
          snr: num(pick(s, ['snr', 'cno', 'cn0']), null),
        });
      }
    }
    return { ok: true, satellites: out, uptimes: (body.data && body.data.uptimes) || [] };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/* ------------------------------------------------------------ normalization */

/**
 * Turn any raw device payload into the normalized dashboard shape.
 */
function normalize(payload, endpointLabel) {
  const hardware = normalizeHardware(payload);
  const rawSats = findSatelliteArray(payload);
  const satellites_detail = (rawSats || []).map(normalizeSatellite).filter(Boolean);
  const summary = summarize(satellites_detail, payload);

  const avgSnrValues = satellites_detail.map((s) => s.snr).filter((v) => typeof v === 'number');
  const average_snr = avgSnrValues.length
    ? Number((avgSnrValues.reduce((a, b) => a + b, 0) / avgSnrValues.length).toFixed(1))
    : null;

  return {
    ok: true,
    status: 'ONLINE',
    connected: hardware.connected || Boolean(satellites_detail.length) || hardware.serial_number !== null,
    source_endpoint: endpointLabel,
    timestamp: new Date().toISOString(),
    hardware: {
      serial_number: hardware.serial_number,
      uptime: hardware.uptime,
      software_version: hardware.software_version,
      model: hardware.model,
      gnss_receiver: hardware.gnss_receiver,
      gnss_band: hardware.gnss_band,
      status_raw: hardware.status_raw,
    },
    summary: {
      total_tracked: summary.total_tracked,
      gps: summary.gps,
      glonass: summary.glonass,
      galileo: summary.galileo,
      beidou: summary.beidou,
      average_snr: average_snr,
    },
    satellites_detail,
  };
}

/**
 * Merge the GEODNET cloud satellite list into a normalized payload.
 * The cloud source is authoritative for per-satellite data when the local
 * receiver does not expose any; the device remains authoritative for hardware.
 */
function mergeCloudSatellites(normalized, cloud) {
  if (!cloud || !cloud.ok || !cloud.satellites.length) return normalized;
  if (normalized.satellites_detail.length) return normalized; // device already has them
  const sats = cloud.satellites.filter((s) => s.id !== null);
  if (!sats.length) return normalized;
  const counts = { gps: 0, glonass: 0, galileo: 0, beidou: 0 };
  const snrValues = [];
  for (const s of sats) {
    const key = { GPS: 'gps', GLONASS: 'glonass', Galileo: 'galileo', BeiDou: 'beidou' }[s.constellation];
    if (key) counts[key] += 1;
    if (typeof s.snr === 'number') snrValues.push(s.snr);
  }
  normalized.satellites_detail = sats;
  normalized.summary = {
    total_tracked: sats.length,
    ...counts,
    average_snr: snrValues.length
      ? Number((snrValues.reduce((a, b) => a + b, 0) / snrValues.length).toFixed(1))
      : null,
  };
  normalized.satellite_source = 'geodnet_cloud';
  if (cloud.uptimes && cloud.uptimes.length) {
    normalized.hardware.uptime_history = cloud.uptimes.slice(0, 72);
  }
  return normalized;
}

function offlinePayload(reason, detail) {
  return {
    ok: false,
    status: 'OFFLINE',
    connected: false,
    error: reason,
    detail: detail || null,
    source_endpoint: lastGoodEndpoint,
    timestamp: new Date().toISOString(),
    hardware: { serial_number: null, uptime: null, software_version: null, model: null, gnss_receiver: null, gnss_band: null, status_raw: null },
    summary: { total_tracked: 0, gps: 0, glonass: 0, galileo: 0, beidou: 0, average_snr: null },
    satellites_detail: [],
  };
}

/* ----------------------------------------------------------------- the app */

const app = express();
app.disable('x-powered-by');

/**
 * GET /api/live-telemetry
 * The single clean proxy route the dashboard polls.
 */
app.get('/api/live-telemetry', async (_req, res) => {
  try {
    const result = await pollDevice();
    if (!result.ok) {
      // Still HTTP 200 with a structured body so the UI can switch to OFFLINE
      // rather than treating a network error as a server crash.
      return res.status(200).json(offlinePayload('miner_unreachable', result.errors.join(' | ')));
    }
    let normalized = normalize(result.payload, result.endpoint);
    // The local receiver exposes hardware/stream status but not per-satellite
    // telemetry on every firmware revision - fall back to the GEODNET cloud.
    if (!normalized.satellites_detail.length) {
      normalized = mergeCloudSatellites(normalized, await fetchGeodnetSatellites());
    }
    return res.status(200).json(normalized);
  } catch (err) {
    return res.status(200).json(offlinePayload('poll_error', String(err?.message || err)));
  }
});

/** GEODNET station metadata + per-satellite SNR (cloud source). */
app.get('/api/station-info', async (_req, res) => {
  const cloud = await fetchGeodnetSatellites();
  if (!cloud.ok) {
    return res.status(200).json({ ok: false, error: 'not_configured_or_unavailable', reason: cloud.reason });
  }
  return res.status(200).json({
    ok: true,
    mountpoint: GEODNET.mountpoint,
    satellites: cloud.satellites,
    uptime_history: cloud.uptimes,
    timestamp: new Date().toISOString(),
  });
});

/** Convenience: report which endpoint is currently winning + device reachability. */
app.get('/api/health', async (_req, res) => {
  const result = await pollDevice();
  res.json({
    ok: result.ok,
    miner: `${CONFIG.minerIp}:${CONFIG.minerPort}`,
    endpoint: result.endpoint || lastGoodEndpoint,
    errors: result.errors || [],
    geodnet_cloud: GEODNET.appId && GEODNET.appKey && GEODNET.mountpoint ? 'configured' : 'not_configured',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GEODNET NETWORK VIEW (public, no credentials).
 * Uses the public coverage station API to place the physical station on the
 * live GEODNET network and show its nearest neighbours + a status breakdown.
 * This is real GEODNET data even though the tenant appKey for per-satellite
 * SNR is not configured: station identity, coordinates and network reachability.
 */
const GEODNET_NETWORK_URL = 'https://rtk.geodnet.com/api/v2/coverage_stations';
let networkCache = { data: null, at: 0 };
const NETWORK_TTL_MS = 10 * 60 * 1000;

async function fetchNetworkStations() {
  const now = Date.now();
  if (networkCache.data && now - networkCache.at < NETWORK_TTL_MS) {
    return { ok: true, stations: networkCache.data, timestamp: new Date(networkCache.at).toISOString() };
  }
  try {
    const r = await fetchWithTimeout(GEODNET_NETWORK_URL, { timeout: 15000 });
    const json = r && r.json && typeof r.json === 'object' ? r.json : null;
    const stations = Array.isArray(json?.data) ? json.data : [];
    networkCache = { data: stations, at: now };
    return { ok: true, stations, timestamp: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), stations: networkCache.data || [] };
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.get('/api/network', async (_req, res) => {
  const { ok, stations, timestamp, error } = await fetchNetworkStations();
  if (!ok && !stations.length) {
    return res.status(200).json({ ok: false, error: error || 'network_unreachable' });
  }

  // Identify our own physical station by its exact coordinates (Moncton base).
  const SELF_LAT = 46.104, SELF_LNG = -64.755;
  const self = stations
    .map((s) => ({ ...s, _d: haversineKm(s.lat, s.lng, SELF_LAT, SELF_LNG) }))
    .filter((s) => s._d <= 5) // within 5 km of the base
    .sort((a, b) => a._d - b._d)[0] || null;

  // Nearest neighbours (excluding self) by distance from the base.
  const neighbours = stations
    .map((s) => ({ ...s, _km: haversineKm(s.lat, s.lng, SELF_LAT, SELF_LNG) }))
    .filter((s) => !self || s.stationId !== self.stationId)
    .sort((a, b) => a._km - b._km)
    .slice(0, 8);

  const statusTally = {};
  for (const s of stations) statusTally[s.status || 'UNKNOWN'] = (statusTally[s.status || 'UNKNOWN'] || 0) + 1;

  res.status(200).json({
    ok: true,
    timestamp,
    total_stations: stations.length,
    status_breakdown: statusTally,
    self: self ? { station_id: self.stationId, name: self.name, status: self.status, lat: self.lat, lng: self.lng } : null,
    neighbours: neighbours.map((n) => ({
      station_id: n.stationId, name: n.name, status: n.status,
      lat: n.lat, lng: n.lng, distance_km: Math.round(n._km),
    })),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(CONFIG.port, () => {
  console.log(`GEODNET dashboard -> http://127.0.0.1:${CONFIG.port}`);
  console.log(`Polling miner    -> http://${CONFIG.minerIp}:${CONFIG.minerPort}`);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err?.message || err);
});

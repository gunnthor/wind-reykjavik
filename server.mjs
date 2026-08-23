// Wind over Reykjavík — zero-dependency data server.
//
// Two upstreams:
//   Open-Meteo    — DMI Harmonie DINI (~2 km) forecast grid. CORS-open, no key.
//   Veðurstofan   — xmlweather.vedur.is live station observations. Sends no CORS
//                   header, so it has to be proxied through here.
import { createServer } from 'node:http';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LANGS, DEFAULT_LANG } from './public/i18n.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

// --- Refresh policy ---------------------------------------------------------
// Open-Meteo's free tier bills roughly one call per location, and one grid fetch
// asks for 714 of them, against a 10,000/day allowance. Three things keep us
// inside it:
//
//   1. Refreshes are demand-driven. cached() only refetches when a request
//      arrives after the TTL has lapsed, so an idle night costs nothing at all.
//   2. The TTL widens during the quiet hours. That does not matter for a night
//      with no visitors — it matters for the one that has an uptime monitor
//      pinging every five minutes, which demand-driven caching alone would
//      happily refresh straight through.
//   3. A hard daily budget, tracked across restarts, stops a traffic spike or a
//      restart loop from spending the allowance before the day is out.
//
// The TTL is compared against the cache age at *read* time, so a long night
// window cannot leak into the morning: at 08:00 the daytime TTL applies again
// and a grid fetched at 01:00 is already stale.
//
// Iceland runs on UTC year-round, so UTC hours are local hours.
// 22:00-05:59. A narrower 01:00-06:00 window reads more natural but does not
// actually lower the ceiling: 19 active hours still round up to the same seven
// daytime refreshes. Eight quiet hours remove one whole refresh from the day.
const QUIET_FROM = Number(process.env.QUIET_FROM ?? 22);   // inclusive
const QUIET_TO   = Number(process.env.QUIET_TO   ?? 6);    // exclusive
const TTL_ACTIVE = Number(process.env.GRID_TTL_MS)       || 3 * 60 * 60 * 1000;
const TTL_QUIET  = Number(process.env.GRID_TTL_QUIET_MS) || 8 * 60 * 60 * 1000;

const isQuietHour = (d = new Date()) => {
  const h = d.getUTCHours();
  return QUIET_FROM <= QUIET_TO
    ? h >= QUIET_FROM && h < QUIET_TO
    : h >= QUIET_FROM || h < QUIET_TO;      // window wrapping midnight
};
const gridTtl = () => (isQuietHour() ? TTL_QUIET : TTL_ACTIVE);

const GRID_CACHE_FILE = () => join(ROOT, 'data', 'grid-cache.json');
const USAGE_FILE = () => join(ROOT, 'data', 'api-usage.json');

// --- Daily API budget -------------------------------------------------------
const DAILY_BUDGET = Number(process.env.OPEN_METEO_DAILY_BUDGET) || 9000;
const utcDay = () => new Date().toISOString().slice(0, 10);
let usage = null;

async function loadUsage() {
  if (usage) return usage;
  usage = await readFile(USAGE_FILE(), 'utf8').then(JSON.parse).catch(() => null)
       ?? { day: utcDay(), calls: 0 };
  if (usage.day !== utcDay()) usage = { day: utcDay(), calls: 0 };
  return usage;
}

async function spendBudget(n) {
  const u = await loadUsage();
  if (u.day !== utcDay()) { u.day = utcDay(); u.calls = 0; }
  u.calls += n;
  writeFile(USAGE_FILE(), JSON.stringify(u)).catch(() => {});
}

async function budgetRemaining() {
  const u = await loadUsage();
  return u.day === utcDay() ? DAILY_BUDGET - u.calls : DAILY_BUDGET;
}

// --- Grid geometry ----------------------------------------------------------
// 0.02 lat x 0.04 lon ≈ 2.2 x 1.9 km, matching the native Harmonie mesh.
// Deliberately wider than any viewport so wind reaches every edge of the screen;
// covers the capital region plus Esja, Bláfjöll, Reykjanes and open sea.
const GRID = { lat0: 63.96, lat1: 64.36, lon0: -22.52, lon1: -21.20, dlat: 0.02, dlon: 0.04 };
GRID.nlat = Math.round((GRID.lat1 - GRID.lat0) / GRID.dlat) + 1;
GRID.nlon = Math.round((GRID.lon1 - GRID.lon0) / GRID.dlon) + 1;

const HOURLY = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
                'cloud_cover', 'precipitation', 'snowfall', 'temperature_2m'];

// --- Tiny cache -------------------------------------------------------------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  try {
    const val = await fn();
    cache.set(key, { at: Date.now(), val });
    return val;
  } catch (err) {
    if (hit) return hit.val;           // serve stale rather than fail
    throw err;
  }
}

const r2 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 100) / 100);

// --- Open-Meteo forecast grid ----------------------------------------------
async function fetchGrid() {
  const lats = [], lons = [];
  for (let i = 0; i < GRID.nlat; i++) {
    for (let j = 0; j < GRID.nlon; j++) {
      lats.push(+(GRID.lat0 + i * GRID.dlat).toFixed(4));
      lons.push(+(GRID.lon0 + j * GRID.dlon).toFixed(4));
    }
  }

  // Open-Meteo answers on GET only and rejects request URIs past ~8 KB, so the
  // point list is split into chunks and stitched back together in order.
  const CHUNK = 300;
  const jobs = [];
  for (let s = 0; s < lats.length; s += CHUNK) {
    const la = lats.slice(s, s + CHUNK), lo = lons.slice(s, s + CHUNK);
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + la.join(',')
      + '&longitude=' + lo.join(',')
      + '&hourly=' + HOURLY.join(',')
      + '&models=dmi_seamless&forecast_days=2&past_days=1'
      + '&wind_speed_unit=ms&timezone=GMT';
    jobs.push((async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error('open-meteo ' + res.status + ' ' + (await res.text()).slice(0, 200));
      const raw = await res.json();
      return Array.isArray(raw) ? raw : [raw];
    })());
  }
  const pts = (await Promise.all(jobs)).flat();
  if (pts.length !== lats.length) throw new Error('expected ' + lats.length + ' points, got ' + pts.length);

  const times = pts[0].hourly.time;
  const nt = times.length, nc = pts.length;
  const mk = () => Array.from({ length: nt }, () => new Array(nc).fill(0));
  const out = { u: mk(), v: mk(), speed: mk(), gust: mk(), cloud: mk(), precip: mk(), snow: mk(), temp: mk() };

  for (let c = 0; c < nc; c++) {
    const h = pts[c].hourly;
    for (let t = 0; t < nt; t++) {
      const sp = h.wind_speed_10m[t] ?? 0;
      const dir = h.wind_direction_10m[t] ?? 0;
      // Meteorological direction is where the wind blows FROM.
      const rad = dir * Math.PI / 180;
      out.u[t][c] = r2(-sp * Math.sin(rad));   // eastward m/s
      out.v[t][c] = r2(-sp * Math.cos(rad));   // northward m/s
      out.speed[t][c] = r2(sp);
      out.gust[t][c] = r2(h.wind_gusts_10m[t]);
      out.cloud[t][c] = h.cloud_cover[t];
      out.precip[t][c] = r2(h.precipitation[t]);
      out.snow[t][c] = r2(h.snowfall[t]);
      out.temp[t][c] = r2(h.temperature_2m[t]);
    }
  }

  return {
    meta: {
      model: 'DMI Harmonie DINI (dmi_seamless) via Open-Meteo',
      resolutionKm: 2,
      generated: new Date().toISOString(),
      grid: { ...GRID },
      elevationRange: [Math.min(...pts.map(p => p.elevation)), Math.max(...pts.map(p => p.elevation))],
    },
    times,
    elevation: pts.map(p => p.elevation),
    ...out,
  };
}

const readDiskGrid = () =>
  readFile(GRID_CACHE_FILE(), 'utf8').then(JSON.parse).catch(() => null);

const diskAge = (g) => Date.now() - Date.parse(g?.meta?.generated ?? 0);

// A rate-limited or unreachable upstream should not blank the map: the last
// good grid is kept on disk and served (flagged stale) until a fetch succeeds.
async function fetchGridCached() {
  const cost = GRID.nlat * GRID.nlon;
  const disk = await readDiskGrid();

  // Cold start after a restart: a disk grid still inside the current TTL is
  // exactly what the memory cache would have held, so spend nothing.
  if (disk && diskAge(disk) < gridTtl()) return disk;

  if (disk && await budgetRemaining() < cost) {
    console.warn('daily API budget spent — serving disk grid from ' + disk.meta.generated);
    return { ...disk, meta: { ...disk.meta, stale: true, staleReason: 'daily budget reached' } };
  }

  try {
    const grid = await fetchGrid();
    await spendBudget(cost);
    writeFile(GRID_CACHE_FILE(), JSON.stringify(grid)).catch(() => {});
    return grid;
  } catch (err) {
    if (!disk) throw err;
    console.warn('grid fetch failed (' + err.message + ') — serving disk cache from ' + disk.meta.generated);
    return { ...disk, meta: { ...disk.meta, stale: true, staleReason: err.message } };
  }
}

// --- Veðurstofan live observations ------------------------------------------
const COMPASS = { N: 0, NNA: 22.5, NA: 45, ANA: 67.5, A: 90, ASA: 112.5, SA: 135, SSA: 157.5,
                  S: 180, SSV: 202.5, SV: 225, VSV: 247.5, V: 270, VNV: 292.5, NV: 315, NNV: 337.5 };

const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

async function loadStations() {
  return cached('stations', 3600000, async () =>
    JSON.parse(await readFile(join(ROOT, 'data', 'stations.json'), 'utf8')));
}

async function fetchObs() {
  const stations = await loadStations();
  const ids = stations.map(s => s.id).join(';');
  const url = 'https://xmlweather.vedur.is/?op_w=xml&type=obs&lang=is&view=xml'
    + '&ids=' + ids + '&params=F;FX;FG;D;T;TD;R;RH;P;N;V;W';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('vedur.is ' + res.status);
  const xml = await res.text();

  const byId = new Map(stations.map(s => [s.id, s]));
  const out = [];
  for (const m of xml.matchAll(/<station id="(\d+)"[^>]*valid="(\d)"[^>]*>([\s\S]*?)<\/station>/g)) {
    const id = Number(m[1]), valid = m[2] === '1', body = m[3];
    const meta = byId.get(id);
    if (!meta) continue;
    const tag = (t) => {
      const g = body.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>'));
      return g ? g[1].trim() : '';
    };
    const dirTxt = tag('D').toUpperCase();
    out.push({
      id, name: meta.name, lat: meta.lat, lon: meta.lon, elev: meta.elev,
      valid, err: tag('err') || null, time: tag('time') || null,
      wind: num(tag('F')),          // 10-min mean, m/s
      windMax: num(tag('FX')),      // highest 10-min mean in the hour
      gust: num(tag('FG')),         // highest gust
      dirText: tag('D') || null,
      dir: dirTxt in COMPASS ? COMPASS[dirTxt] : null,
      temp: num(tag('T')), dewpoint: num(tag('TD')), precip: num(tag('R')),
      humidity: num(tag('RH')), pressure: num(tag('P')),
      cloudOktas: num(tag('N')), visibilityKm: num(tag('V')),
      weather: tag('W') || null,
    });
  }
  return { fetched: new Date().toISOString(), source: 'Veðurstofa Íslands (xmlweather.vedur.is)', stations: out };
}

// Bilinear interpolation on the regular lat/lon mesh; NaN outside it.
function bilinear(grid, arr, lat, lon) {
  const g = grid.meta.grid;
  const fy = (lat - g.lat0) / g.dlat, fx = (lon - g.lon0) / g.dlon;
  if (!(fx >= 0 && fy >= 0 && fx <= g.nlon - 1 && fy <= g.nlat - 1)) return NaN;
  const j0 = Math.floor(fx), i0 = Math.floor(fy);
  const j1 = Math.min(j0 + 1, g.nlon - 1), i1 = Math.min(i0 + 1, g.nlat - 1);
  const sx = fx - j0, sy = fy - i0;
  const a = arr[i0 * g.nlon + j0], b = arr[i0 * g.nlon + j1];
  const c = arr[i1 * g.nlon + j0], d = arr[i1 * g.nlon + j1];
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

// The model at each station, read out of the grid the map is already drawing
// rather than fetched separately. That costs no extra API calls, and it means
// the accuracy panel verifies exactly what is on screen.
function modelAtStations(grid, stations) {
  const key = new Date().toISOString().slice(0, 13);
  let i0 = grid.times.findIndex(t => t.slice(0, 13) === key);
  if (i0 < 0) i0 = 0;
  const i1 = Math.min(i0 + 1, grid.times.length - 1);
  const f = new Date().getUTCMinutes() / 60;

  const blend = (k) => {
    const a = grid[k][i0], b = grid[k][i1];
    return a.map((v, i) => v + (b[i] - v) * f);
  };
  const F = {
    u: blend('u'), v: blend('v'), gust: blend('gust'),
    temp: blend('temp'), cloud: blend('cloud'), precip: blend('precip'),
  };

  const out = {};
  for (const s of stations) {
    const u = bilinear(grid, F.u, s.lat, s.lon);
    const v = bilinear(grid, F.v, s.lat, s.lon);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    out[s.id] = {
      wind: r2(Math.hypot(u, v)),
      dir: r2((Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360),
      gust: r2(bilinear(grid, F.gust, s.lat, s.lon)),
      temp: r2(bilinear(grid, F.temp, s.lat, s.lon)),
      cloud: Math.round(bilinear(grid, F.cloud, s.lat, s.lon)),
      precip: r2(bilinear(grid, F.precip, s.lat, s.lon)),
      time: grid.times[i0],
      gridElev: r2(bilinear(grid, grid.elevation, s.lat, s.lon)),
    };
  }
  return out;
}

let lastLoggedObsTime = null;

// Signed circular difference in degrees, [-180, 180].
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

async function buildVerification() {
  const [obs, grid, stations] = await Promise.all([
    cached('obs', 60000, fetchObs),
    cached('grid', gridTtl(), fetchGridCached),
    loadStations(),
  ]);
  const model = modelAtStations(grid, stations);

  const rows = [];
  for (const s of obs.stations) {
    const m = model[s.id];
    if (!m || !s.valid) { rows.push({ ...s, model: m || null, d: null }); continue; }
    const d = {};
    if (s.wind != null && m.wind != null) d.wind = r2(m.wind - s.wind);
    if (s.gust != null && m.gust != null) d.gust = r2(m.gust - s.gust);
    if (s.dir != null && m.dir != null) d.dir = r2(angDiff(m.dir, s.dir));
    if (s.temp != null && m.temp != null) d.temp = r2(m.temp - s.temp);
    rows.push({ ...s, model: m, d });
  }

  const stat = (key) => {
    const vals = rows.map(r => r.d?.[key]).filter(v => v != null);
    if (!vals.length) return null;
    const bias = vals.reduce((a, b) => a + b, 0) / vals.length;
    const mae = vals.reduce((a, b) => a + Math.abs(b), 0) / vals.length;
    const rmse = Math.sqrt(vals.reduce((a, b) => a + b * b, 0) / vals.length);
    return { n: vals.length, bias: r2(bias), mae: r2(mae), rmse: r2(rmse) };
  };

  const payload = {
    at: new Date().toISOString(),
    obsTime: obs.stations.find(s => s.time)?.time || null,
    summary: { wind: stat('wind'), gust: stat('gust'), dir: stat('dir'), temp: stat('temp') },
    rows,
    source: obs.source,
  };

  // Append to the running log so accuracy can be tracked over time. Observations
  // only advance hourly, so only a new obsTime earns a row.
  // On a cold start, pick up where the existing log left off so a restart does
  // not re-append the round that is already there.
  if (lastLoggedObsTime === null) {
    const prior = await verificationHistory();
    lastLoggedObsTime = prior.length ? prior.at(-1).obsTime : '';
  }
  if (payload.obsTime && payload.obsTime !== lastLoggedObsTime) {
    lastLoggedObsTime = payload.obsTime;
    const line = JSON.stringify({ at: payload.at, obsTime: payload.obsTime, summary: payload.summary });
    try {
      await appendFile(join(ROOT, 'data', 'verification.ndjson'), line + '\n');
    } catch { /* logging is best-effort */ }
  }

  return payload;
}

async function verificationHistory() {
  try {
    const txt = await readFile(join(ROOT, 'data', 'verification.ndjson'), 'utf8');
    const seen = new Map();
    for (const line of txt.trim().split('\n')) {
      if (!line) continue;
      try { const j = JSON.parse(line); if (j.obsTime) seen.set(j.obsTime, j); } catch { /* skip */ }
    }
    return [...seen.values()].slice(-96);
  } catch { return []; }
}

// --- Language ---------------------------------------------------------------
// The page is served already translated rather than translated in the browser,
// so an Icelandic visitor never sees a flash of English.
//
// Precedence: ?lang= > saved cookie > CDN country header > Icelandic IP range >
// Accept-Language > English.

let isRanges = null;
async function icelandicRanges() {
  if (isRanges) return isRanges;
  try {
    const raw = JSON.parse(await readFile(join(ROOT, 'data', 'is-ip-ranges.json'), 'utf8'));
    isRanges = { v4: raw.v4, v6: raw.v6.map(([a, b]) => [BigInt(a), BigInt(b)]) };
  } catch {
    isRanges = { v4: [], v6: [] };     // no table: fall through to the other signals
  }
  return isRanges;
}

// Ranges are sorted and merged by scripts/build-geo.mjs, so this is a plain
// binary search. Works for both Number (v4) and BigInt (v6) bounds.
const inRanges = (ranges, n) => {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (n < ranges[mid][0]) hi = mid - 1;
    else if (n > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
};

function clientIP(req) {
  // X-Forwarded-For is spoofable, but here it only selects a language — and
  // behind a reverse proxy it is the only way to see the real client.
  const fwd = req.headers['x-forwarded-for'];
  const raw = (fwd ? String(fwd).split(',')[0] : null)
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || '';
  return String(raw).trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
}

async function isIcelandicIP(ip) {
  if (!ip) return false;
  const { v4, v6 } = await icelandicRanges();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const n = ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
    return inRanges(v4, n);
  }
  if (!ip.includes(':')) return false;
  try {
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const tl = tail ? tail.split(':') : [];
    if (h.length + tl.length > 8) return false;
    const groups = [...h, ...Array(8 - h.length - tl.length).fill('0'), ...tl];
    const n = groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
    return inRanges(v6, n);
  } catch { return false; }
}

const CDN_COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country',
                             'cloudfront-viewer-country', 'x-country-code'];

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Accept-Language: "is", "is-IS", and Icelandic's retired code "in" all count.
const prefersIcelandic = (header) =>
  String(header || '').split(',').some(p => /^\s*(is|in)(-|;|$)/i.test(p));

async function detectLang(req, url) {
  const q = url.searchParams.get('lang');
  if (q && LANGS.includes(q)) return { lang: q, via: 'query' };

  const cookie = parseCookies(req.headers.cookie).lang;
  if (cookie && LANGS.includes(cookie)) return { lang: cookie, via: 'cookie' };

  for (const h of CDN_COUNTRY_HEADERS) {
    const cc = req.headers[h];
    if (cc && cc !== 'XX') return { lang: String(cc).toUpperCase() === 'IS' ? 'is' : 'en', via: h };
  }

  const ip = clientIP(req);
  if (await isIcelandicIP(ip)) return { lang: 'is', via: 'ip' };
  if (prefersIcelandic(req.headers['accept-language'])) return { lang: 'is', via: 'accept-language' };
  return { lang: DEFAULT_LANG, via: 'default' };
}

// index.html carries {{key}} placeholders. Escaping is applied to every value
// except the few that are deliberately markup — and since &quot;/&amp; render
// correctly in both text and attribute position, one pass covers both.
const TOKEN = /\{\{([\w.]+)\}\}/g;
const RAW_HTML_KEYS = new Set(['slider.note', 'note.model']);
const escapeHTML = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function renderIndex(lang) {
  const html = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
  const dict = STRINGS[lang] ?? STRINGS[DEFAULT_LANG];
  return html.replace(TOKEN, (m, key) => {
    if (key === '__lang__') return lang;
    const v = dict[key] ?? STRINGS[DEFAULT_LANG][key];
    if (typeof v !== 'string') return m;
    return RAW_HTML_KEYS.has(key) ? v : escapeHTML(v);
  });
}

// --- HTTP -------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJSON(req, res, obj, maxAge = 0) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=' + maxAge,
    'access-control-allow-origin': '*',
  };
  if ((req.headers['accept-encoding'] || '').includes('gzip') && body.length > 1400) {
    const gz = gzipSync(body);
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': gz.length });
    res.end(gz);
  } else {
    res.writeHead(200, { ...headers, 'content-length': body.length });
    res.end(body);
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/api/grid')     return sendJSON(req, res, await cached('grid', gridTtl(), fetchGridCached), 300);
    if (path === '/api/obs')      return sendJSON(req, res, await cached('obs', 60000, fetchObs));
    if (path === '/api/stations') return sendJSON(req, res, await loadStations(), 3600);
    if (path === '/api/verify')   return sendJSON(req, res, await cached('verify', 60000, buildVerification));
    if (path === '/api/verify/history') return sendJSON(req, res, await verificationHistory());
    if (path === '/api/health') {
      const g = cache.get('grid');
      const cost = GRID.nlat * GRID.nlon;
      const u = await loadUsage();
      // Worst case assumes traffic in every hour, which is the only way a
      // demand-driven cache reaches its ceiling.
      const quietHours = (QUIET_TO - QUIET_FROM + 24) % 24;
      const ceiling = Math.ceil((24 - quietHours) * 3600000 / TTL_ACTIVE)
                    + Math.ceil(quietHours * 3600000 / TTL_QUIET);
      return sendJSON(req, res, {
        ok: true,
        cached: [...cache.keys()],
        grid: GRID,
        gridPoints: cost,
        gridGenerated: g?.val?.meta?.generated ?? null,
        gridStale: g?.val?.meta?.stale ?? false,
        gridStaleReason: g?.val?.meta?.staleReason ?? null,
        quietHour: isQuietHour(),
        ttlMinutesNow: Math.round(gridTtl() / 60000),
        ttlMinutesActive: Math.round(TTL_ACTIVE / 60000),
        ttlMinutesQuiet: Math.round(TTL_QUIET / 60000),
        budget: { day: u.day, used: u.calls, limit: DAILY_BUDGET, remaining: await budgetRemaining() },
        worstCaseCallsPerDay: ceiling * cost,
      });
    }
    if (path === '/api/locale') {
      const d = await detectLang(req, new URL(req.url, 'http://localhost'));
      return sendJSON(req, res, { ...d, ip: clientIP(req), langs: LANGS });
    }

    if (path === '/' || path === '/index.html') {
      const { lang } = await detectLang(req, new URL(req.url, 'http://localhost'));
      const body = Buffer.from(await renderIndex(lang));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-language': lang,
        vary: 'Cookie, Accept-Language',
      });
      res.end(body);
      return;
    }

    const rel = path;
    const file = join(ROOT, 'public', normalize(rel).replace(/^[/\\]+/, ''));
    if (!file.startsWith(join(ROOT, 'public'))) { res.writeHead(403).end('forbidden'); return; }
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (err) {
    const code = err?.code === 'ENOENT' ? 404 : 500;
    console.error('[' + code + '] ' + path + ':', err?.message || err);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log('\n  Vindur yfir höfuðborgarsvæðinu');
  console.log('  http://localhost:' + PORT + '\n');
  console.log('  grid ' + GRID.nlat + ' x ' + GRID.nlon + ' = ' + (GRID.nlat * GRID.nlon) + ' points @ ~2 km');
  console.log('  refresh ' + (TTL_ACTIVE / 3600000) + 'h active, ' + (TTL_QUIET / 3600000) + 'h quiet ('
    + String(QUIET_FROM).padStart(2, '0') + ':00-' + String(QUIET_TO).padStart(2, '0') + ':00 UTC)'
    + ' · budget ' + DAILY_BUDGET + '/day');
  // Warm the caches so the first page load is instant.
  cached('grid', gridTtl(), fetchGridCached).then(
    g => console.log('  grid ready: ' + g.times.length + ' hours, ' + g.times[0] + ' -> ' + g.times.at(-1)),
    e => console.error('  grid warmup failed:', e.message));
  buildVerification().then(
    v => console.log('  obs ready: ' + v.rows.filter(r => r.valid).length + ' live stations'),
    e => console.error('  obs warmup failed:', e.message));
});

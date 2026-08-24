/* Vindur yfir höfuðborgarsvæðinu
   ─────────────────────────────────────────────────────────────────────────────
   A 2 km DMI Harmonie wind field, animated as advected particles, with live
   Veðurstofan station observations laid over it so the model can be checked
   against reality.

   Iceland runs on UTC all year, so model times need no timezone conversion. */

import { STRINGS, LANGS, DEFAULT_LANG, translate } from './i18n.js';

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const MOBILE_Q = window.matchMedia('(max-width: 900px)');
const isMobile = () => MOBILE_Q.matches;
// Landscape phones get a side drawer rather than a bottom sheet, so the drag
// axis and the snap arithmetic both flip.
const isLandscape = () => window.matchMedia('(orientation: landscape)').matches;

// ── Palette ────────────────────────────────────────────────────────────────
// Single-hue blue sequential ramp, stepped dark→light for the dark surface.
const RAMP = [
  [0,  '#1c5cab'], [4,  '#2a78d6'], [8,  '#3987e5'],
  [13, '#5598e7'], [18, '#86b6ef'], [24, '#b7d3f6'], [32, '#cde2fb'],
];
const STATUS = { warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', good: '#0ca30c' };
// Gust thresholds roughly matching Veðurstofan's wind-warning tiers.
const GUST_TIERS = [[20, STATUS.warning], [28, STATUS.serious], [35, STATUS.critical]];
const RAIN = '#1baf7a', SNOW = '#9085e9';

const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RAMP_RGB = RAMP.map(([v, h]) => [v, hex2rgb(h)]);

function windRGB(v) {
  if (!(v >= 0)) v = 0;
  if (v <= RAMP_RGB[0][0]) return RAMP_RGB[0][1];
  for (let i = 1; i < RAMP_RGB.length; i++) {
    const [v1, c1] = RAMP_RGB[i], [v0, c0] = RAMP_RGB[i - 1];
    if (v <= v1) {
      const f = (v - v0) / (v1 - v0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return RAMP_RGB.at(-1)[1];
}
const windCSS = (v) => { const c = windRGB(v); return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; };

// Compass points and the Beaufort names are language-specific; the thresholds
// are not. Icelandic uses A/V for east/west, so the abbreviations really do differ.
const dirName = (deg) => (deg == null ? '–' : dict().compass[Math.round(deg / 22.5) % 16]);
const BEAUFORT = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
const beaufort = (v) => { let b = 0; while (b < BEAUFORT.length && v >= BEAUFORT[b]) b++; return b; };
const bfName = (b) => dict().beaufort[b];

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  grid: null, obs: null, verify: null, history: [],
  tIndex: 0, nowIndex: 0, slice: null,
  layers: { particles: true, speed: true, gusts: false, cloud: false, precip: false, stations: true },
  density: 5000, rate: 12, trail: 9, playing: false,
  lang: DEFAULT_LANG,
};

// ── Language ───────────────────────────────────────────────────────────────
// The server has already picked a language (Icelandic IP, Accept-Language, or a
// saved cookie) and stamped it on <html lang>. An explicit choice still wins.
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && LANGS.includes(q)) return q;
  try {
    const saved = localStorage.getItem('lang');
    if (saved && LANGS.includes(saved)) return saved;
  } catch { /* private mode */ }
  const stamped = document.documentElement.lang;
  return LANGS.includes(stamped) ? stamped : DEFAULT_LANG;
}
state.lang = pickLang();

// Named `dict`, not `L` — Leaflet owns the global `L`.
const dict = () => STRINGS[state.lang] ?? STRINGS[DEFAULT_LANG];
const t = (key, params) => translate(state.lang, key, params);

// Static markup carries its key so a switch can re-fill it without a reload.
function applyStaticI18n() {
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  document.title = t('page.title');
}

function setLang(lang) {
  if (!LANGS.includes(lang) || lang === state.lang) return;
  state.lang = lang;
  try { localStorage.setItem('lang', lang); } catch { /* private mode */ }
  // Also tell the server, so the next page load arrives already translated.
  document.cookie = 'lang=' + lang + ';path=/;max-age=31536000;samesite=lax';
  document.documentElement.lang = lang;

  applyStaticI18n();
  buildLayerToggles();
  syncSliders();
  renderLegend();
  renderSheetPeek();
  if (state.grid) { renderModelInfo(); renderTimeLabel(); }
  if (state.verify) { renderNow(); renderStations(); renderAccuracy(); }
}

// ── Map ────────────────────────────────────────────────────────────────────
const map = L.map('map', {
  zoomControl: true, minZoom: 8, maxZoom: 14,
  zoomSnap: 0.5, wheelPxPerZoomLevel: 120, attributionControl: true,
}).setView([64.105, -21.87], 11);

// The map option is a boolean; the prefix is configured on the control itself.
// Dropping it keeps the credit line to one row on a phone.
map.attributionControl.setPrefix(false);

const CARTO = { subdomains: 'abcd', maxZoom: 20, attribution:
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> · ' +
  '<a href="https://carto.com/attributions">CARTO</a> · ' +
  '<a href="https://open-meteo.com/">Open-Meteo</a> · ' +
  '<a href="https://vedur.is/">Veðurstofan</a>' };

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', CARTO).addTo(map);

for (const [name, z] of [['raster', 300], ['particles', 350], ['labels', 400]]) {
  const p = map.createPane(name);
  p.style.zIndex = z;
  p.style.pointerEvents = 'none';
}
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
  { ...CARTO, attribution: '', pane: 'labels', opacity: 0.85 }).addTo(map);

// ── Grid sampling ──────────────────────────────────────────────────────────
// The slice holds every field blended to the current fractional hour, so the
// hot path only ever does spatial interpolation.
function rebuildSlice() {
  const g = state.grid;
  if (!g) return;
  const n = g.elevation.length;
  const last = g.times.length - 1;
  const t0 = Math.max(0, Math.min(last, Math.floor(state.tIndex)));
  const t1 = Math.min(last, t0 + 1);
  const f = Math.max(0, Math.min(1, state.tIndex - t0));

  const out = {};
  for (const k of ['u', 'v', 'speed', 'gust', 'cloud', 'precip', 'snow', 'temp']) {
    const a = g[k][t0], b = g[k][t1], arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = a[i] + (b[i] - a[i]) * f;
    out[k] = arr;
  }
  state.slice = out;
}

// Bilinear interpolation on the regular lat/lon mesh. Returns NaN outside it.
function sampleAt(arr, lat, lon) {
  const g = state.grid.meta.grid;
  const fy = (lat - g.lat0) / g.dlat, fx = (lon - g.lon0) / g.dlon;
  if (!(fx >= 0 && fy >= 0 && fx <= g.nlon - 1 && fy <= g.nlat - 1)) return NaN;
  const j0 = fx | 0, i0 = fy | 0;
  const j1 = Math.min(j0 + 1, g.nlon - 1), i1 = Math.min(i0 + 1, g.nlat - 1);
  const sx = fx - j0, sy = fy - i0;
  const a = arr[i0 * g.nlon + j0], b = arr[i0 * g.nlon + j1];
  const c = arr[i1 * g.nlon + j0], d = arr[i1 * g.nlon + j1];
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

// Web Mercator separates the axes: latitude depends only on screen y, longitude
// only on screen x. That turns an O(w*h) unproject into O(w+h).
function axisLatLon(cols, rows, cell) {
  const lons = new Float64Array(cols), lats = new Float64Array(rows);
  for (let c = 0; c < cols; c++) lons[c] = map.containerPointToLatLng([c * cell, 0]).lng;
  for (let r = 0; r < rows; r++) lats[r] = map.containerPointToLatLng([0, r * cell]).lat;
  return { lats, lons };
}

// ── Canvas layer base ──────────────────────────────────────────────────────
// The canvas is pinned to the container, not to the map pane, so it is redrawn
// in screen space and re-anchored whenever Leaflet moves the pane underneath.
class CanvasLayer {
  constructor(pane) {
    this.canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
    this.canvas.style.pointerEvents = 'none';
    map.getPane(pane).appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, isMobile() ? 1.75 : 2);
    this.resize();
  }
  resize() {
    const s = map.getSize();
    this.w = s.x; this.h = s.y;
    this.canvas.width = Math.round(s.x * this.dpr);
    this.canvas.height = Math.round(s.y * this.dpr);
    this.canvas.style.width = s.x + 'px';
    this.canvas.style.height = s.y + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  reposition() { L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0])); }
  clear() { this.ctx.clearRect(0, 0, this.w, this.h); }
}

// ── Raster overlays (speed / gusts / cloud / precipitation) ────────────────
const RC = 6;   // raster sampling step in CSS pixels; upscaled with smoothing

class RasterLayer extends CanvasLayer {
  constructor() {
    super('raster');
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');
  }
  draw() {
    const L_ = state.layers;
    const any = L_.speed || L_.gusts || L_.cloud || L_.precip;
    this.clear();
    if (!any || !state.slice) return;

    const cols = Math.ceil(this.w / RC) + 1, rows = Math.ceil(this.h / RC) + 1;
    const { lats, lons } = axisLatLon(cols, rows, RC);
    this.off.width = cols; this.off.height = rows;
    const img = this.offCtx.createImageData(cols, rows);
    const px = img.data;
    const S = state.slice;

    for (let r = 0; r < rows; r++) {
      const lat = lats[r];
      for (let c = 0; c < cols; c++) {
        const lon = lons[c], o = (r * cols + c) * 4;
        let cr = 0, cg = 0, cb = 0, ca = 0;

        // Painter's order: speed underneath, then gust flags, cloud, precip.
        if (L_.speed) {
          const v = sampleAt(S.speed, lat, lon);
          if (v === v) {
            const col = windRGB(v);
            const a = Math.min(0.60, 0.08 + Math.pow(Math.min(v, 24) / 24, 0.72) * 0.52);
            cr = col[0]; cg = col[1]; cb = col[2]; ca = a;
          }
        }
        if (L_.gusts) {
          const gv = sampleAt(S.gust, lat, lon);
          if (gv === gv) {
            let tier = null;
            for (const [thr, col] of GUST_TIERS) if (gv >= thr) tier = col;
            if (tier) {
              const t = hex2rgb(tier), a = 0.42;
              cr = cr * (1 - a) + t[0] * a; cg = cg * (1 - a) + t[1] * a;
              cb = cb * (1 - a) + t[2] * a; ca = Math.max(ca, a);
            }
          }
        }
        if (L_.cloud) {
          const cv = sampleAt(S.cloud, lat, lon);
          if (cv === cv && cv > 8) {
            // Iceland is overcast most of the time, so this stays a thin veil —
            // strong enough to read, light enough to keep the map underneath.
            const a = Math.min(0.26, Math.pow(cv / 100, 1.6) * 0.26);
            cr = cr * (1 - a) + 226 * a; cg = cg * (1 - a) + 232 * a;
            cb = cb * (1 - a) + 240 * a; ca = Math.max(ca, a);
          }
        }
        if (L_.precip) {
          const pv = sampleAt(S.precip, lat, lon), sv = sampleAt(S.snow, lat, lon);
          const snowy = sv === sv && sv > 0.02;
          if (pv === pv && pv > 0.02) {
            const t = hex2rgb(snowy ? SNOW : RAIN);
            // No opacity floor: drizzle at 0.1 mm/h must not read like a downpour.
            const a = Math.pow(Math.min(pv, 1), 0.5) * 0.40;   // stays a tint, not a wash
            cr = cr * (1 - a) + t[0] * a; cg = cg * (1 - a) + t[1] * a;
            cb = cb * (1 - a) + t[2] * a; ca = Math.max(ca, a);
          }
        }

        px[o] = cr; px[o + 1] = cg; px[o + 2] = cb; px[o + 3] = ca * 255;
      }
    }

    this.offCtx.putImageData(img, 0, 0);
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.off, 0, 0, cols, rows, -RC / 2, -RC / 2, cols * RC, rows * RC);
  }
}

// ── Particle layer ─────────────────────────────────────────────────────────
const FCELL = 14;        // screen-space wind-field cell, px
const BUCKETS = 18;      // speed buckets, so strokes batch by colour
const BUCKET_MAX = 30;

class ParticleLayer extends CanvasLayer {
  constructor() {
    super('particles');
    this.p = null; this.n = 0;
    this.bucketCol = Array.from({ length: BUCKETS },
      (_, i) => windCSS((i + 0.5) / BUCKETS * BUCKET_MAX));
    this.paths = Array.from({ length: BUCKETS }, () => []);
    this.buildField();
    this.seed();
  }

  buildField() {
    this.fc = Math.ceil(this.w / FCELL) + 1;
    this.fr = Math.ceil(this.h / FCELL) + 1;
    const n = this.fc * this.fr;
    if (!this.fu || this.fu.length !== n) {
      this.fu = new Float32Array(n); this.fv = new Float32Array(n);
    }
    if (!state.slice) { this.fu.fill(NaN); return; }
    const { lats, lons } = axisLatLon(this.fc, this.fr, FCELL);
    const S = state.slice;
    for (let r = 0; r < this.fr; r++) {
      const lat = lats[r], row = r * this.fc;
      for (let c = 0; c < this.fc; c++) {
        this.fu[row + c] = sampleAt(S.u, lat, lons[c]);
        this.fv[row + c] = sampleAt(S.v, lat, lons[c]);
      }
    }
  }

  // Bilinear lookup in the screen-space field. Writes into `out` to stay allocation-free.
  sample(x, y, out) {
    const fx = x / FCELL, fy = y / FCELL;
    if (!(fx >= 0 && fy >= 0 && fx <= this.fc - 1 && fy <= this.fr - 1)) { out.u = NaN; return; }
    const j0 = fx | 0, i0 = fy | 0;
    const j1 = Math.min(j0 + 1, this.fc - 1), i1 = Math.min(i0 + 1, this.fr - 1);
    const sx = fx - j0, sy = fy - i0;
    const a = i0 * this.fc, b = i1 * this.fc;
    const u = (this.fu[a + j0] + (this.fu[a + j1] - this.fu[a + j0]) * sx) * (1 - sy)
            + (this.fu[b + j0] + (this.fu[b + j1] - this.fu[b + j0]) * sx) * sy;
    const v = (this.fv[a + j0] + (this.fv[a + j1] - this.fv[a + j0]) * sx) * (1 - sy)
            + (this.fv[b + j0] + (this.fv[b + j1] - this.fv[b + j0]) * sx) * sy;
    out.u = u; out.v = v;
  }

  seed() {
    // Density scales with viewport area so the look holds across window sizes.
    const target = Math.round(state.density * (this.w * this.h) / (1600 * 900));
    this.n = Math.max(200, Math.min(20000, target));
    this.p = new Float32Array(this.n * 4);   // x, y, age, maxAge
    for (let i = 0; i < this.n; i++) this.respawn(i, true);
  }

  respawn(i, initial) {
    const o = i * 4;
    this.p[o] = Math.random() * this.w;
    this.p[o + 1] = Math.random() * this.h;
    const maxAge = 32 + Math.random() * 96;
    this.p[o + 3] = maxAge;
    this.p[o + 2] = initial ? Math.random() * maxAge : maxAge;
  }

  step(dt) {
    const ctx = this.ctx;
    // Fade the previous frame's trails by lowering alpha, leaving the map visible.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,' + (0.5 / (state.trail + 1.5)).toFixed(4) + ')';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'source-over';

    if (!state.layers.particles || !state.slice) return;

    for (const b of this.paths) b.length = 0;
    const out = { u: 0, v: 0 };
    const rate = state.rate;

    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      let x = this.p[o], y = this.p[o + 1];
      this.p[o + 2] -= dt * 60;

      if (this.p[o + 2] <= 0 || x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) {
        this.respawn(i, false); continue;
      }
      this.sample(x, y, out);
      if (out.u !== out.u) { this.respawn(i, false); continue; }

      const nx = x + out.u * rate * dt;
      const ny = y - out.v * rate * dt;        // screen y grows downward
      const spd = Math.hypot(out.u, out.v);
      const bi = Math.min(BUCKETS - 1, (spd / BUCKET_MAX * BUCKETS) | 0);
      const seg = this.paths[bi];
      seg.push(x, y, nx, ny);

      this.p[o] = nx; this.p[o + 1] = ny;
    }

    ctx.lineCap = 'round';
    for (let b = 0; b < BUCKETS; b++) {
      const seg = this.paths[b];
      if (!seg.length) continue;
      ctx.strokeStyle = this.bucketCol[b];
      ctx.lineWidth = 0.95 + (b / BUCKETS) * 1.15;
      ctx.globalAlpha = 0.62 + (b / BUCKETS) * 0.34;
      ctx.beginPath();
      for (let k = 0; k < seg.length; k += 4) {
        ctx.moveTo(seg[k], seg[k + 1]);
        ctx.lineTo(seg[k + 2], seg[k + 3]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

let raster, particles;

// ── Station markers ────────────────────────────────────────────────────────
const markerLayer = L.layerGroup().addTo(map);

function arrowSVG(deg, color, size) {
  // Arrow points the way the wind is going: meteorological direction + 180°.
  // The glyph is drawn pointing north, so rotating by (from-direction + 180)
  // aims it the way the air is actually travelling.
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"
      style="transform:rotate(${(deg ?? 0) + 180}deg)">
    <path d="M12 21 L12 3 M12 3 L7.2 8.8 M12 3 L16.8 8.8" fill="none"
      stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const isNow = () => Math.abs(state.tIndex - state.nowIndex) <= 0.5;

// Observations only exist for the present. Once the timeline is scrubbed away
// from now, the station points show the *model* at those same coordinates
// instead — labelled as such — rather than leaving stale readings sitting on a
// forecast map.
function displayRows() {
  const rows = state.verify?.rows ?? [];
  if (isNow() || !state.slice) return { mode: 'obs', rows };
  const S = state.slice;
  return {
    mode: 'model',
    rows: rows.map(r => {
      const sp = sampleAt(S.speed, r.lat, r.lon);
      if (!(sp === sp)) return { ...r, valid: false, wind: null, gust: null, dir: null, model: null, d: null };
      const u = sampleAt(S.u, r.lat, r.lon), v = sampleAt(S.v, r.lat, r.lon);
      return {
        ...r, valid: true, wind: sp,
        gust: sampleAt(S.gust, r.lat, r.lon),
        dir: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360,   // direction it blows FROM
        temp: sampleAt(S.temp, r.lat, r.lon),
        humidity: null, pressure: null, precip: null, err: null,
        model: null, d: null,
      };
    }),
  };
}

function renderStations() {
  markerLayer.clearLayers();
  if (!state.verify || !state.layers.stations) return;
  const { mode, rows } = displayRows();

  for (const r of rows) {
    const live = r.valid && r.wind != null;
    const col = live ? windCSS(r.wind) : '#5c5b57';
    const html = live
      ? `<div class="stn-dot${mode === 'model' ? ' model' : ''}">${arrowSVG(r.dir, col, 26)}</div>`
      : `<div class="stn-dot off"><svg width="10" height="10" viewBox="0 0 10 10">
           <circle cx="5" cy="5" r="3.2" fill="none" stroke="${col}" stroke-width="1.6"/></svg></div>`;

    const m = L.marker([r.lat, r.lon], {
      icon: L.divIcon({ className: 'stn-marker', html, iconSize: [28, 28], iconAnchor: [14, 14] }),
      riseOnHover: true, keyboard: false,
    });
    m.bindPopup(mode === 'obs' ? popupHTML(r) : forecastPopupHTML(r),
      { closeButton: true, maxWidth: Math.min(300, window.innerWidth - 44), autoPanPadding: [16, 16] });
    m.stationId = r.id;
    markerLayer.addLayer(m);
  }
}

function forecastPopupHTML(r) {
  const when = (state.grid.times[Math.round(state.tIndex)] ?? '').replace('T', ' ');
  const bf = r.wind != null ? beaufort(r.wind) : null;
  return `<div class="pop-h">${r.name}</div>
    <div class="pop-sub">${t('pop.forecast', { when })}${
      bf != null ? ' · ' + t('pop.beaufort', { n: bf, desc: bfName(bf) }) : ''}</div>
    <div class="pop-g">
      <div class="l">${t('pop.wind')}</div><div class="v">${fmt(r.wind, 1)}</div><div class="m">m/s</div>
      <div class="l">${t('pop.gust')}</div><div class="v">${fmt(r.gust, 1)}</div><div class="m">m/s</div>
      <div class="l">${t('pop.dir')}</div><div class="v">${r.dir != null ? dirName(r.dir) : '–'}</div>
      <div class="m">${r.dir != null ? r.dir.toFixed(0) + '°' : ''}</div>
      <div class="l">${t('pop.temp')}</div><div class="v">${fmt(r.temp, 1)}</div><div class="m">°C</div>
    </div>
    <div class="pop-extra">${t('pop.forecastNote')}</div>`;
}

const fmt = (v, d = 1, unit = '') => (v == null ? '–' : v.toFixed(d) + unit);
const dclass = (v) => (v == null ? 'dnil' : v < -0.05 ? 'dneg' : v > 0.05 ? 'dpos' : '');
const dsign = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : '') + v.toFixed(d));

function popupHTML(r) {
  const m = r.model || {};
  const d = r.d || {};
  const bf = r.wind != null ? beaufort(r.wind) : null;
  const rows = [
    [t('pop.wind'), fmt(r.wind, 1), fmt(m.wind, 1), d.wind],
    [t('pop.gust'), fmt(r.gust, 1), fmt(m.gust, 1), d.gust],
    [t('pop.dir'), r.dir != null ? `${dirName(r.dir)} ${r.dir.toFixed(0)}°` : '–',
            m.dir != null ? `${dirName(m.dir)} ${m.dir.toFixed(0)}°` : '–', d.dir],
    [t('pop.temp'), fmt(r.temp, 1, '°'), fmt(m.temp, 1, '°'), d.temp],
  ];
  const extras = [];
  if (r.humidity != null) extras.push(`<span>${t('pop.rh')}</span> ${r.humidity}%`);
  if (r.pressure != null) extras.push(`<span>${t('pop.pressure')}</span> ${r.pressure} hPa`);
  if (r.precip != null) extras.push(`<span>${t('pop.rain')}</span> ${r.precip.toFixed(1)} mm`);
  if (m.cloud != null) extras.push(`<span>${t('pop.cloud')}</span> ${m.cloud}% <em>${t('pop.modelTag')}</em>`);

  return `<div class="pop-h">${r.name}</div>
    <div class="pop-sub">${r.elev != null ? t('pop.masl', { v: r.elev }) + ' · ' : ''}#${r.id}${
      r.valid ? '' : ' · ' + t('pop.offline')}${
      bf != null ? ' · ' + t('pop.beaufort', { n: bf, desc: bfName(bf) }) : ''}</div>
    <div class="pop-g">
      <div class="h">&nbsp;</div><div class="h" style="text-align:right">${t('th.obs')}</div><div class="h" style="text-align:right">${t('th.model')}</div>
      ${rows.map(([k, o, mv, dv]) =>
        `<div class="l">${k}</div><div class="v">${o}</div>
         <div class="m">${mv} <b class="${dclass(dv)}">${dv == null ? '' : '(' + dsign(dv) + ')'}</b></div>`).join('')}
    </div>
    ${extras.length ? `<div class="pop-extra">${extras.join(' · ')}</div>` : ''}
    ${r.err ? `<div class="pop-extra" style="color:${STATUS.warning}">${r.err}</div>` : ''}`;
}

// ── Panel rendering ────────────────────────────────────────────────────────

// The hero arrow animates between readings, so the target angle is unwrapped to
// stay within a half-turn of where it already is — otherwise a 203° wind reads
// as a full spin. The very first reading snaps into place instead.
let heroAngle = null;
function setHeroAngle(target, color) {
  const arrow = $('.hero-arrow');
  if (heroAngle == null) {
    heroAngle = ((target % 360) + 360) % 360;
    arrow.style.transition = 'none';
    arrow.style.transform = `rotate(${heroAngle}deg)`;
    arrow.getBoundingClientRect();            // flush before re-enabling the transition
    arrow.style.transition = '';
  } else {
    heroAngle += ((target - heroAngle + 540) % 360) - 180;
    arrow.style.transform = `rotate(${heroAngle}deg)`;
  }
  arrow.style.color = color;
}
function renderNow() {
  const v = state.verify;
  if (!v) return;
  const { mode, rows } = displayRows();
  const forecast = mode === 'model';
  const live = rows.filter(r => r.valid && r.wind != null);
  const hero = rows.find(r => r.id === 1 && r.valid && r.wind != null)
            || rows.find(r => r.id === 1477 && r.valid && r.wind != null)
            || live[0];

  const when = state.grid?.times[Math.round(state.tIndex)]?.replace('T', ' ') ?? '';
  $('.hero-label').textContent = forecast
    ? t('hero.model', { when: when + ' UTC' }) : t('hero.observed');

  if (hero) {
    $('#heroSpeed').textContent = hero.wind.toFixed(1);
    setHeroAngle((hero.dir ?? 0) + 180, windCSS(hero.wind));
    const bf = beaufort(hero.wind);
    const dirLabel = dirName(hero.dir) + (hero.dir != null ? ' ' + hero.dir.toFixed(0) + '°' : '');
    $('#heroMeta').textContent = t('hero.meta', { dir: dirLabel, gust: fmt(hero.gust, 0), bf });
    const heroName = `<b>${hero.name}</b>`;
    $('#heroFoot').innerHTML = forecast
      ? t('hero.footForecast', { name: heroName, desc: bfName(bf) })
      : `${t('hero.foot', { name: heroName, desc: bfName(bf), model: fmt(hero.model?.wind, 1) })}
         <b class="${dclass(hero.d?.wind)}">(${dsign(hero.d?.wind)})</b>`;
  }

  // Regional spread is the thing a single number hides.
  const speeds = live.map(r => r.wind);
  const gusts = live.map(r => r.gust).filter(x => x != null);
  const temps = live.map(r => r.temp).filter(x => x != null);
  const center = { lat: 64.135, lon: -21.90 };
  const S = state.slice;
  const cloud = S ? sampleAt(S.cloud, center.lat, center.lon) : NaN;
  const precip = S ? sampleAt(S.precip, center.lat, center.lon) : NaN;
  const snow = S ? sampleAt(S.snow, center.lat, center.lon) : NaN;

  const tiles = [
    [t('tile.region'), speeds.length ? `${Math.min(...speeds).toFixed(0)}–${Math.max(...speeds).toFixed(0)}` : '–',
      'm/s', forecast ? t('tile.modelPoints') : t('tile.regionSub', { n: live.length })],
    [t('tile.gust'), gusts.length ? Math.max(...gusts).toFixed(0) : '–', 'm/s',
      gusts.length ? live.find(r => r.gust === Math.max(...gusts)).name : ''],
    [t('tile.cloud'), cloud === cloud ? cloud.toFixed(0) : '–', '%', t('tile.modelRvk')],
    [t('tile.precip'), precip === precip ? precip.toFixed(1) : '–', 'mm/h',
      snow > 0.02 ? t('tile.asSnow') : t('tile.modelRvk')],
    [t('tile.temp'), temps.length ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : '–',
      '°C', forecast ? t('tile.modelPoints') : t('tile.meanStations')],
    [t('tile.gustFactor'), gusts.length && speeds.length
      ? (gusts.reduce((a, b) => a + b, 0) / gusts.length /
         (speeds.reduce((a, b) => a + b, 0) / speeds.length)).toFixed(2) : '–', '×', t('tile.gustOverWind')],
  ];
  $('#tiles').innerHTML = tiles.map(([k, val, u, s]) =>
    `<div class="tile"><div class="tile-k">${k}</div>
      <div class="tile-v">${val}<span class="unit">${u}</span></div>
      <div class="tile-s">${s}</div></div>`).join('');

  $('#stnCount').textContent = forecast
    ? t('count.modelPoints', { n: live.length })
    : t('count.live', { n: live.length, m: rows.length });
  $('#stationList').innerHTML = [...rows]
    .sort((a, b) => (b.wind ?? -1) - (a.wind ?? -1))
    .map(r => {
      const on = r.valid && r.wind != null;
      return `<div class="st ${on ? '' : 'off'}" data-id="${r.id}">
        <div class="st-arrow">${on ? arrowSVG(r.dir, windCSS(r.wind), 16) : ''}</div>
        <div class="st-name">${r.name}</div>
        <div class="st-val">${on ? r.wind.toFixed(0) : '–'}<span class="g">${
          on && r.gust != null ? ' / ' + r.gust.toFixed(0) : ''}</span></div></div>`;
    }).join('');

  renderSheetPeek();

  $('#obsNote').innerHTML = forecast
    ? t('note.model', { when })
    : t('note.obs', { time: v.obsTime ?? '–', source: v.source });
}

function renderAccuracy() {
  const v = state.verify;
  if (!v) return;
  const s = v.summary;

  const flag = (mae, good, ok) => {
    const [col, txt] = mae == null ? ['#5c5b57', ''] :
      mae <= good ? [STATUS.good, 'close'] : mae <= ok ? [STATUS.warning, 'fair'] : [STATUS.critical, 'poor'];
    if (!txt) return '';
    const label = t('flag.' + txt);
    const icon = txt === 'close'
      ? '<svg viewBox="0 0 12 12"><path d="M2 6.4 L4.7 9 L10 3.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : txt === 'fair'
      ? '<svg viewBox="0 0 12 12"><path d="M6 1.6 L11 10.4 H1 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M6 5v2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 3.4v3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    return `<div class="score-flag" style="color:${col}">${icon}${label}</div>`;
  };

  const biasN = (st, d = 1, unit = '') =>
    t('acc.biasN', { bias: dsign(st?.bias, d) + unit, n: st?.n ?? 0 });
  const cards = [
    [t('acc.windMAE'), s.wind?.mae, 'm/s', biasN(s.wind), flag(s.wind?.mae, 1, 2)],
    [t('acc.gustMAE'), s.gust?.mae, 'm/s', biasN(s.gust), flag(s.gust?.mae, 2, 4)],
    [t('acc.dirMAE'), s.dir?.mae, '°', biasN(s.dir, 0, '°'), flag(s.dir?.mae, 20, 40)],
    [t('acc.tempMAE'), s.temp?.mae, '°C', biasN(s.temp), flag(s.temp?.mae, 1, 2)],
  ];
  $('#scorecards').innerHTML = cards.map(([k, val, u, sub, fl]) =>
    `<div class="score"><div class="score-k">${k}</div>
      <div class="score-v">${val == null ? '–' : val.toFixed(val < 10 ? 2 : 0)}<span class="unit">${u}</span></div>
      <div class="score-s">${sub}</div>${fl}</div>`).join('');

  $('#cmpTable tbody').innerHTML = [...v.rows]
    .filter(r => r.d && r.d.wind != null)
    .sort((a, b) => Math.abs(b.d.wind) - Math.abs(a.d.wind))
    .map(r => `<tr data-id="${r.id}">
      <td title="${r.name}">${r.name}</td>
      <td>${fmt(r.wind, 1)}</td>
      <td>${fmt(r.model?.wind, 1)}</td>
      <td class="${dclass(r.d.wind)}">${dsign(r.d.wind)}</td>
      <td class="${dclass(r.d.dir)}">${dsign(r.d.dir, 0)}°</td></tr>`).join('');

  renderBiasChart();
}

function renderBiasChart() {
  const h = state.history.filter(x => x.summary?.wind?.bias != null);
  const el = $('#biasChart');
  if (h.length < 2) {
    el.innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#5c5b57;font-size:11px">
      ${h.length ? t('acc.oneRound') : t('acc.noRounds')}</div>`;
    return;
  }
  const W = 300, H = 96, pad = { l: 26, r: 8, t: 8, b: 16 };
  const vals = h.map(x => x.summary.wind.bias);
  const lo = Math.min(-0.5, Math.min(...vals)), hi = Math.max(0.5, Math.max(...vals));
  const X = (i) => pad.l + i / (h.length - 1) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b);
  const path = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const last = vals.at(-1);

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="${t('acc.biasOverTime')}">
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="#383835" stroke-width="1"/>
    <text x="${pad.l - 5}" y="${Y(hi) + 4}" fill="#898781" font-size="8" text-anchor="end">${hi.toFixed(1)}</text>
    <text x="${pad.l - 5}" y="${Y(0) + 3}" fill="#898781" font-size="8" text-anchor="end">0</text>
    <text x="${pad.l - 5}" y="${Y(lo) + 1}" fill="#898781" font-size="8" text-anchor="end">${lo.toFixed(1)}</text>
    <path d="${path}" fill="none" stroke="#3987e5" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(h.length - 1)}" cy="${Y(last)}" r="2.6" fill="#3987e5"
      stroke="#1a1a19" stroke-width="1.5"/>
    <text x="${W - pad.r}" y="${H - 4}" fill="#898781" font-size="8" text-anchor="end">${t('acc.now')}</text>
    <text x="${pad.l}" y="${H - 4}" fill="#898781" font-size="8">${t('acc.rounds', { n: h.length })}</text>
  </svg>`;
  $('#biasNote').textContent = t('acc.biasNoteLatest', { v: dsign(last) });
}

function renderModelInfo() {
  const m = state.grid?.meta;
  if (!m) return;
  $('#modelInfo').innerHTML = `
    <dt>${t('model.model')}</dt><dd>${m.model}</dd>
    <dt>${t('model.grid')}</dt><dd>${t('model.gridVal', {
      nlat: m.grid.nlat, nlon: m.grid.nlon, n: m.grid.nlat * m.grid.nlon, km: m.resolutionKm })}</dd>
    <dt>${t('model.terrain')}</dt><dd>${t('pop.masl', {
      v: m.elevationRange[0] + '–' + m.elevationRange[1] })}</dd>
    <dt>${t('model.window')}</dt><dd>${state.grid.times[0]} → ${state.grid.times.at(-1)} UTC</dd>
    <dt>${t('model.fetched')}</dt><dd>${new Date(m.generated).toLocaleString(dict().locale)}</dd>`;
}

// ── Bottom sheet (mobile) ──────────────────────────────────────────────────
// Snap heights and the transition live in CSS, keyed off body[data-sheet];
// this only picks the state and, mid-drag, writes a live --sheet-h override.
// The map is full-bleed underneath and never resizes, so moving the sheet
// costs nothing beyond the compositor.
const SHEET_STATES = ['peek', 'half', 'full'];

function sheetState() { return document.body.dataset.sheet || 'half'; }

function setSheet(next, persist = true) {
  if (!SHEET_STATES.includes(next)) return;
  document.body.dataset.sheet = next;
  document.body.style.removeProperty('--sheet-h');   // hand height back to CSS
  $('#sheetHandle').setAttribute('aria-expanded', String(next !== 'peek'));
  if (persist) { try { localStorage.setItem('sheet', next); } catch { /* private mode */ } }
  renderSheetPeek();
}

// Collapsed, the handle is the only panel there is — so it carries the reading.
function renderSheetPeek() {
  const el = $('#sheetPeek');
  if (!el) return;
  if (!state.verify) { el.textContent = t('sheet.idle'); return; }
  const { rows } = displayRows();
  const live = rows.filter(r => r.valid && r.wind != null);
  const hero = rows.find(r => r.id === 1 && r.valid && r.wind != null)
            || rows.find(r => r.id === 1477 && r.valid && r.wind != null)
            || live[0];
  if (!hero) { el.textContent = t('sheet.idle'); return; }
  el.innerHTML = t('sheet.peek', {
    speed: `<b>${hero.wind.toFixed(1)}</b>`,
    dir: dirName(hero.dir),
    gust: fmt(hero.gust, 0),
  });
}

function initSheet() {
  let initial = 'half';
  try {
    const saved = localStorage.getItem('sheet');
    if (SHEET_STATES.includes(saved)) initial = saved;
  } catch { /* private mode */ }
  document.body.dataset.sheet = initial;
  $('#sheetHandle').setAttribute('aria-expanded', String(initial !== 'peek'));

  const handle = $('#sheetHandle');
  const panel = $('#panel');
  let drag = null, suppressClick = false;

  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile() || e.button) return;
    drag = {
      y: e.clientY, x: e.clientX, moved: false,
      h: panel.getBoundingClientRect().height,
      landscape: isLandscape(), want: null,
    };
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // In the landscape drawer the panel slides horizontally and CSS owns the
    // whole transition, so there is no live height to track — just the intent.
    if (drag.landscape) {
      const dx = drag.x - e.clientX;
      if (!drag.moved && Math.abs(dx) < 8) return;
      drag.moved = true;
      drag.want = dx > 0 ? 'half' : 'peek';       // dragging left opens it
      return;
    }
    const dy = drag.y - e.clientY;
    if (!drag.moved) {
      if (Math.abs(dy) < 5) return;               // let a tap stay a tap
      drag.moved = true;
      document.body.dataset.dragging = '1';
    }
    const h = Math.max(44, Math.min(window.innerHeight * 0.92, drag.h + dy));
    document.body.style.setProperty('--sheet-h', h + 'px');
  });

  const endDrag = (e) => {
    if (!drag) return;
    const moved = drag.moved, want = drag.want;
    drag = null;
    delete document.body.dataset.dragging;
    if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    if (!moved) return;                            // the click handler will act

    if (want) {                                    // landscape: open or closed
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      setSheet(want);
      return;
    }

    // Snap to whichever rest height is closest to where the finger let go.
    const h = panel.getBoundingClientRect().height;
    const vh = window.innerHeight;
    const targets = { peek: 56, half: vh * 0.48, full: vh * 0.88 };
    const nearest = Object.entries(targets)
      .reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0];
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    setSheet(nearest);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Tap (and Enter/Space, since it is a real button) toggles open/closed.
  handle.addEventListener('click', () => {
    if (suppressClick) return;
    setSheet(sheetState() === 'peek' ? 'half' : 'peek');
  });

  // Leaving mobile widths mid-session must not strand an inline height.
  MOBILE_Q.addEventListener('change', () => {
    document.body.style.removeProperty('--sheet-h');
  });

  renderSheetPeek();
}

// ── Legend ─────────────────────────────────────────────────────────────────
function renderLegend() {
  const stops = RAMP.map(([v, c]) => `${c} ${(v / 32 * 100).toFixed(1)}%`).join(', ');
  $('#ramp').style.background = `linear-gradient(90deg, ${stops})`;
  $('#rampTicks').innerHTML = [0, 8, 16, 24, 32]
    .map(v => `<span style="left:${(v / 32 * 100).toFixed(1)}%">${v}</span>`).join('');

  const parts = [];
  if (state.layers.gusts) parts.push(...GUST_TIERS.map(([thr, c]) =>
    `<div><i style="background:${c}"></i>${t('legend.gustTier', { v: thr })}</div>`));
  if (state.layers.precip) parts.push(
    `<div><i style="background:${RAIN}"></i>${t('legend.rain')}</div>`,
    `<div><i style="background:${SNOW}"></i>${t('legend.snow')}</div>`);
  if (state.layers.cloud) parts.push(`<div><i style="background:#e2e8f0"></i>${t('legend.cloud')}</div>`);
  $('#legendWarn').innerHTML = parts.join('') || `<div>${t('legend.hint')}</div>`;
}

// ── Time ───────────────────────────────────────────────────────────────────
function setTime(idx, fromSlider) {
  const last = state.grid.times.length - 1;
  state.tIndex = Math.max(0, Math.min(last, idx));
  rebuildSlice();
  particles?.buildField();
  raster?.draw();
  renderTimeLabel();
  renderNow();
  renderStations();
  if (!fromSlider) $('#timeSlider').value = String(state.tIndex);
}

function renderTimeLabel() {
  const iso = state.grid.times[Math.round(state.tIndex)];
  if (!iso) return;
  const d = new Date(iso + 'Z');
  $('#timeLabel').textContent =
    `${dict().days[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
  const dh = state.tIndex - state.nowIndex;
  $('#timeRel').textContent = Math.abs(dh) < 0.5 ? t('time.isNow')
    : (dh > 0 ? `+${Math.round(dh)} h` : `${Math.round(dh)} h`);
}

function computeNowIndex() {
  const key = new Date().toISOString().slice(0, 13);
  const i = state.grid.times.findIndex(t => t.slice(0, 13) === key);
  state.nowIndex = i >= 0 ? i + new Date().getUTCMinutes() / 60 : 0;
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

// ── Data loading ───────────────────────────────────────────────────────────
async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}

// The grid is deliberately larger than any viewport, so the map is framed to sit
// *inside* it — wind reaches every edge of the screen, and panning is clamped so
// it never exposes the empty area beyond the model.
function fitToGrid(keepCenter) {
  const g = state.grid.meta.grid;
  const b = L.latLngBounds([g.lat0, g.lon0], [g.lat1, g.lon1]);
  // inside=true → the lowest zoom at which the viewport still fits within `b`.
  const z = Math.min(map.getBoundsZoom(b, true), 14);
  map.setMinZoom(z);
  map.setMaxBounds(b);
  if (keepCenter) { if (map.getZoom() < z) map.setZoom(z); return; }
  // Centre on the capital region, then nudge east so the city clears the panel.
  map.setView([64.12, -21.87], z, { animate: false });
  // Nudge the city clear of whatever is covering the view: the panel on the
  // right at desktop widths, the sheet along the bottom on a phone.
  if (!isMobile()) map.panBy([190, 0], { animate: false });
  else if (isLandscape()) map.panBy([150, 0], { animate: false });
  else map.panBy([0, -34], { animate: false });
}

async function loadGrid() {
  state.grid = await get('/api/grid');
  fitToGrid();
  computeNowIndex();
  state.tIndex = state.nowIndex;
  rebuildSlice();
  const last = state.grid.times.length - 1;
  const sl = $('#timeSlider');
  sl.max = String(last); sl.value = String(state.tIndex);
  renderModelInfo(); renderTimeLabel();
}

async function loadObs() {
  const [verify, history] = await Promise.all([
    get('/api/verify'), get('/api/verify/history').catch(() => []),
  ]);
  state.verify = verify; state.history = history;
  renderStations(); renderNow(); renderAccuracy();
}

// ── Layer definitions ──────────────────────────────────────────────────────
// Names and descriptions come from the string table; only the swatch lives here.
const LAYER_DEFS = [
  ['particles', 'linear-gradient(90deg,#1c5cab,#cde2fb)'],
  ['speed',     'linear-gradient(90deg,#1c5cab,#86b6ef)'],
  ['gusts',     `linear-gradient(90deg,${STATUS.warning},${STATUS.critical})`],
  ['cloud',     'linear-gradient(90deg,#3a3a38,#e2e8f0)'],
  ['precip',    `linear-gradient(90deg,${RAIN},${SNOW})`],
  ['stations',  'linear-gradient(90deg,#86b6ef,#86b6ef)'],
];

function buildLayerToggles() {
  $('#layerToggles').innerHTML = LAYER_DEFS.map(([k, sw]) =>
    `<label class="lay"><input type="checkbox" data-layer="${k}" ${state.layers[k] ? 'checked' : ''}>
      <span class="lay-sw" style="background:${sw}"></span>
      <span><span class="lay-t">${t('layer.' + k)}</span><br>
        <span class="lay-d">${t('layer.' + k + '.d')}</span></span></label>`).join('');

  $$('#layerToggles input').forEach(el => el.addEventListener('change', () => {
    state.layers[el.dataset.layer] = el.checked;
    if (el.dataset.layer === 'stations') renderStations();
    else if (el.dataset.layer === 'particles') particles.clear();
    else raster.draw();
    renderLegend();
  }));
}

// ── Wiring ─────────────────────────────────────────────────────────────────
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => { x.classList.toggle('is-on', x === t); x.setAttribute('aria-selected', x === t); });
  $$('.pane').forEach(p => p.classList.toggle('is-on', p.dataset.pane === t.dataset.tab));
}));

$('#timeSlider').addEventListener('input', (e) => setTime(Number(e.target.value), true));
$('#nowBtn').addEventListener('click', () => { stopPlay(); setTime(state.nowIndex); toast(t('toast.backToNow')); });

let playTimer = null;
function stopPlay() { state.playing = false; clearInterval(playTimer); $('#playBtn').classList.remove('is-on'); $('#playBtn').textContent = '▶'; }
$('#playBtn').addEventListener('click', () => {
  if (state.playing) return stopPlay();
  state.playing = true;
  $('#playBtn').classList.add('is-on'); $('#playBtn').textContent = '❚❚';
  playTimer = setInterval(() => {
    const last = state.grid.times.length - 1;
    setTime(state.tIndex + 0.25 >= last ? state.nowIndex : state.tIndex + 0.25);
  }, 130);
});

const SLIDERS = [
  ['density', v => v.toLocaleString(dict().locale)],
  ['rate', v => v + ' ' + t('slider.rateUnit')],
  ['trail', v => String(v)],
];
function syncSliders(fromInput) {
  for (const [id, fmtFn] of SLIDERS) {
    const el = $('#' + id);
    state[id] = Number(el.value);
    $('#' + id + 'Val').textContent = fmtFn(state[id]);
  }
  if (fromInput === 'density') particles?.seed();
}
for (const [id] of SLIDERS) {
  $('#' + id).addEventListener('input', () => syncSliders(id));
}
syncSliders();

$('#langBtn').addEventListener('click', () =>
  setLang(state.lang === 'is' ? 'en' : 'is'));

// Clicking a station row or table row flies to and opens that marker.
for (const sel of ['#stationList', '#cmpTable tbody']) {
  $(sel).addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const id = Number(row.dataset.id);
    const r = state.verify.rows.find(x => x.id === id);
    if (!r) return;
    if (isMobile()) setSheet('peek');       // get out of the way of the popup
    map.flyTo([r.lat, r.lon], Math.max(map.getZoom(), 12), { duration: 0.6 });
    markerLayer.eachLayer(m => { if (m.stationId === id) setTimeout(() => m.openPopup(), 620); });
  });
}

// ── Map events ─────────────────────────────────────────────────────────────
// The initial fitBounds fires these before the canvas layers are constructed.
let rasterDirty = false;
map.on('move', () => {
  if (!raster) return;
  raster.reposition(); particles.reposition();
  particles.buildField();
  rasterDirty = true;                 // coalesced into the next animation frame
});
map.on('zoomstart', () => { if (raster) { particles.clear(); raster.clear(); } });
map.on('resize', () => {
  if (!raster) return;
  fitToGrid(true);                    // a wider window may need a deeper zoom
  raster.resize(); particles.resize();
  particles.buildField(); particles.seed();
  rasterDirty = true;
});

// ── Animation loop ─────────────────────────────────────────────────────────
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (rasterDirty) { raster.draw(); rasterDirty = false; }
  particles?.step(dt);
  requestAnimationFrame(frame);
}

// ── Deep links ─────────────────────────────────────────────────────────────
// ?tab=accuracy&layers=particles,cloud&t=+6  — restores a view worth sharing.
function applyURLParams() {
  const q = new URLSearchParams(location.search);

  const layers = q.get('layers');
  if (layers != null) {
    const want = new Set(layers.split(',').map(x => x.trim()).filter(Boolean));
    for (const k of Object.keys(state.layers)) state.layers[k] = want.has(k);
    buildLayerToggles();
  }

  const sheet = q.get('sheet');
  if (sheet) setSheet(sheet, false);      // deep link, don't overwrite the saved choice

  const tab = q.get('tab');
  if (tab && $(`.tab[data-tab="${CSS.escape(tab)}"]`)) $(`.tab[data-tab="${CSS.escape(tab)}"]`).click();

  const t = q.get('t');
  if (t != null && state.grid) {
    const n = Number(t);
    if (Number.isFinite(n)) setTime(state.nowIndex + n);
  }
  const z = q.get('z'), c = q.get('c');
  if (c) {
    const [la, lo] = c.split(',').map(Number);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      map.setView([la, lo], Number(z) || map.getZoom(), { animate: false });
    }
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async function boot() {
  // The server already filled the static markup; this only matters when ?lang=
  // or a saved preference disagrees with what it chose.
  if (document.documentElement.lang !== state.lang) {
    document.documentElement.lang = state.lang;
    applyStaticI18n();
    syncSliders();
  }
  renderLegend();
  buildLayerToggles();
  initSheet();
  try {
    await loadGrid();
  } catch (err) {
    toast(t('toast.gridFail', { err: err.message }), 8000);
    console.error(err);
    return;
  }

  raster = new RasterLayer();
  particles = new ParticleLayer();
  raster.reposition(); particles.reposition();
  particles.buildField();
  particles.seed();
  raster.draw();
  requestAnimationFrame(frame);

  applyURLParams();
  renderLegend();

  loadObs().catch(err => { toast(t('toast.obsFail', { err: err.message }), 6000); console.error(err); });

  // Observations update hourly; the grid every ten minutes on the server.
  setInterval(() => loadObs().catch(() => {}), 90_000);
  setInterval(async () => {
    try {
      const fresh = await get('/api/grid');
      if (fresh.meta.generated === state.grid.meta.generated) return;
      state.grid = fresh;
      computeNowIndex();
      $('#timeSlider').max = String(fresh.times.length - 1);
      setTime(state.tIndex);
      renderModelInfo();
      toast(t('toast.refreshed'));
    } catch { /* keep the old grid */ }
  }, 300_000);
})();

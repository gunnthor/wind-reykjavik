/* Vindur yfir höfuðborgarsvæðinu
   ─────────────────────────────────────────────────────────────────────────────
   A 2 km DMI Harmonie wind field, animated as advected particles, with live
   Veðurstofan station observations laid over it so the model can be checked
   against reality.

   Iceland runs on UTC all year, so model times need no timezone conversion. */

import { STRINGS, LANGS, DEFAULT_LANG, translate } from './i18n.js';

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// How each background field is drawn. Everything the raster loop needs lives
// here, so adding a field is a table entry rather than another branch.
//
//   ramp     sequential through the wind ramp        (speed)
//   diverge  hue pivots at zero, faint tint + contours (temp, feels-like)
//   contour  faint tint by value + contour lines      (freezing level)
//   seq      one hue, alpha rises with value          (humidity, cloud, snow)
//   seqInv   one hue, alpha rises as value FALLS      (visibility: worse = louder)
//   precip   hue by type, alpha by rate
//
// `extra: true` means the field lives in the lazily fetched bundle.
const FIELDS = {
  speed:      { src: 'speed',  kind: 'ramp',    max: 24, alpha: 0.60 },
  temp:       { src: 'temp',   kind: 'diverge', span: 18, step: 2, tint: 0.22 },
  apparent:   { src: 'app',    kind: 'diverge', span: 18, step: 2, tint: 0.22, extra: true },
  humidity:   { src: 'rh',     kind: 'seq',     lo: 45, hi: 100, rgb: [27, 175, 122], alpha: 0.46, extra: true },
  precip:     { src: 'precip', kind: 'precip' },
  cloud:      { src: 'cloud',  kind: 'seq',     lo: 8, hi: 100, rgb: [226, 232, 240], alpha: 0.30, gamma: 1.6 },
  // Mean sea-level pressure is a synoptic field: measured across this domain it
  // spans under 1 hPa, so as a 2 km map layer it is a flat grey wash that says
  // nothing. It earns its place on the meteogram instead, where the trend is
  // the point. What does vary here is the dew-point spread — sea fog rolling
  // into Faxaflói is a local, visible thing.
  fog:        { derive: (S, la, lo) => sampleAt(S.temp, la, lo) - sampleAt(S.dew, la, lo),
                kind: 'seqInv', lo: 0, hi: 5, rgb: [201, 209, 222], alpha: 0.55, extra: true },
  visibility: { src: 'vis',    kind: 'seqInv',  lo: 200, hi: 20000, rgb: [237, 161, 0], alpha: 0.55, extra: true },
  snowdepth:  { src: 'snowd',  kind: 'seq',     lo: 0.5, hi: 50, rgb: [144, 133, 233], alpha: 0.62, extra: true },
  freezing:   { src: 'fzl',    kind: 'contour', step: 100, lo: 0, hi: 2400, rgb: [134, 182, 239], tint: 0.24, extra: true },
  none:       null,
};
const BASE_FIELDS = ['speed', 'temp', 'apparent', 'humidity', 'fog', 'precip', 'cloud',
                     'visibility', 'snowdepth', 'freezing', 'none'];
const OVERLAYS = ['particles', 'gusts', 'stations'];

const CORE_KEYS = ['u', 'v', 'speed', 'gust', 'cloud', 'precip', 'snow', 'temp'];
const EXTRA_KEYS = ['app', 'rh', 'dew', 'pprob', 'snowd', 'pmsl', 'vis', 'fzl', 'wcode'];

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

// Temperature is diverging, and in Iceland the meaningful midpoint is not the
// mean — it is freezing. So 0 °C is the neutral point: the wash fades out there
// and the two poles take opposite hues, with the 0° isotherm drawn on top.
const TEMP_COLD = '#3987e5', TEMP_WARM = '#e66767';
const TEMP_SPAN = 18;                       // |°C| at which the tint saturates
const TEMP_STEP = 2;                        // isotherm interval, °C
const FREEZE_LINE = [238, 242, 247];
const ISOTHERM = [214, 224, 238];
const CLOUD_RGB = [226, 232, 240];

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
  // Stacking speed + cloud + rain produced mud, and hid whichever you actually
  // wanted. The background field is now one choice; gusts stay independent
  // because a warning has to be able to sit on top of anything.
  base: 'speed',
  layers: { particles: true, gusts: false, stations: true },
  extraLoaded: false,
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
  buildBaseBar();
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
  for (const k of [...CORE_KEYS, ...EXTRA_KEYS]) {
    const series = g[k];
    if (!series) continue;                    // extra bundle not fetched yet
    const a = series[t0], b = series[t1], arr = new Float32Array(n);
    // Weather codes are categorical — blending 61 and 71 would invent a code
    // that means neither, so they step rather than interpolate.
    if (k === 'wcode') for (let i = 0; i < n; i++) arr[i] = f < 0.5 ? a[i] : b[i];
    else for (let i = 0; i < n; i++) arr[i] = a[i] + (b[i] - a[i]) * f;
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
    const spec = FIELDS[state.base];
    this.clear();
    if ((!spec && !state.layers.gusts) || !state.slice) return;

    const arr = spec && spec.src ? state.slice[spec.src] : null;
    // A derived field has no single source array — it is computed per sample.
    const derive = spec?.derive;
    const ready = !spec || arr || (derive && state.slice.temp && state.slice.dew);
    const contoured = !!spec && (spec.kind === 'diverge' || spec.kind === 'contour');
    // Contours need a finer sample step than a smooth wash does: at RC the
    // upscale smears a crossing into a ribbon roughly 2 * RC wide.
    const rc = contoured ? 3 : RC;
    const cols = Math.ceil(this.w / rc) + 1, rows = Math.ceil(this.h / rc) + 1;
    const { lats, lons } = axisLatLon(cols, rows, rc);
    this.off.width = cols; this.off.height = rows;
    const img = this.offCtx.createImageData(cols, rows);
    const px = img.data;
    const S = state.slice;

    for (let r = 0; r < rows; r++) {
      const lat = lats[r];
      const latBelow = lats[Math.min(r + 1, rows - 1)];
      for (let c = 0; c < cols; c++) {
        const lon = lons[c], o = (r * cols + c) * 4;
        let cr = 0, cg = 0, cb = 0, ca = 0;

        const v = derive ? derive(S, lat, lon) : (arr ? sampleAt(arr, lat, lon) : NaN);
        if (v === v) {
          const kind = spec.kind;

          if (kind === 'ramp') {
            const col = windRGB(v);
            cr = col[0]; cg = col[1]; cb = col[2];
            ca = Math.min(spec.alpha, 0.08 + Math.pow(Math.min(v, spec.max) / spec.max, 0.72) * (spec.alpha - 0.08));

          } else if (kind === 'seq' || kind === 'seqInv') {
            const span = spec.hi - spec.lo;
            let x = (v - spec.lo) / span;
            if (kind === 'seqInv') x = 1 - x;
            if (x > 0) {
              x = Math.min(1, x);
              cr = spec.rgb[0]; cg = spec.rgb[1]; cb = spec.rgb[2];
              ca = Math.pow(x, spec.gamma ?? 1) * spec.alpha;
            }

          } else if (kind === 'precip') {
            if (v > 0.02) {
              const sv = sampleAt(state.slice.snow, lat, lon);
              const col = hex2rgb(sv === sv && sv > 0.02 ? SNOW : RAIN);
              // No opacity floor: drizzle at 0.1 mm/h must not read like a downpour.
              cr = col[0]; cg = col[1]; cb = col[2];
              ca = Math.pow(Math.min(v, 1), 0.5) * 0.52;
            }

          } else {
            // diverge and contour share the contour pass; they differ only in
            // how the underlying tint is coloured.
            if (kind === 'diverge') {
              // Hue pivots at freezing, the threshold that actually matters
              // here. The tint stays faint because a full-strength wash floods
              // the map on any day sitting wholly on one side of zero — which,
              // in summer, is every day.
              const col = hex2rgb(v < 0 ? TEMP_COLD : TEMP_WARM);
              cr = col[0]; cg = col[1]; cb = col[2];
              ca = Math.pow(Math.min(Math.abs(v), spec.span) / spec.span, 0.9) * spec.tint;
            } else {
              const x = Math.max(0, Math.min(1, (v - spec.lo) / (spec.hi - spec.lo)));
              cr = spec.rgb[0]; cg = spec.rgb[1]; cb = spec.rgb[2];
              ca = (0.25 + x * 0.75) * spec.tint;
            }

            // A contour lands wherever a neighbouring sample falls in a
            // different band. Crisper than a neutral band, whose width would
            // otherwise vary with the local gradient.
            const nr = sampleAt(arr, lat, lons[Math.min(c + 1, cols - 1)]);
            const nb = sampleAt(arr, latBelow, lon);
            const band = Math.floor(v / spec.step);
            let line = 0;
            for (let k = 0; k < 2; k++) {
              const nv = k ? nb : nr;
              if (nv !== nv || Math.floor(nv / spec.step) === band) continue;
              // Zero is special for the diverging fields: it is the freezing line.
              line = Math.max(line, (kind === 'diverge' && (nv < 0) !== (v < 0)) ? 2 : 1);
            }
            if (line === 2) {
              cr = FREEZE_LINE[0]; cg = FREEZE_LINE[1]; cb = FREEZE_LINE[2]; ca = 0.9;
            } else if (line === 1) {
              cr = ISOTHERM[0]; cg = ISOTHERM[1]; cb = ISOTHERM[2]; ca = 0.42;
            }
          }
        }

        if (state.layers.gusts) {
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

        px[o] = cr; px[o + 1] = cg; px[o + 2] = cb; px[o + 3] = ca * 255;
      }
    }

    this.offCtx.putImageData(img, 0, 0);
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.off, 0, 0, cols, rows, -rc / 2, -rc / 2, cols * rc, rows * rc);
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

  // The remaining nine variables arrive in the lazy bundle, so these tiles
  // appear a moment after the first paint rather than holding it up.
  const at = (k) => (S && S[k] ? sampleAt(S[k], center.lat, center.lon) : NaN);
  if (state.extraLoaded) {
    const app = at('app'), rh = at('rh'), dew = at('dew');
    const pmsl = at('pmsl'), vis = at('vis'), fzl = at('fzl'), pprob = at('pprob');
    const temp = at('temp');
    const spread = (temp === temp && dew === dew) ? temp - dew : NaN;
    tiles.push(
      [t('tile.feels'), app === app ? app.toFixed(1) : '–', '°C', t('tile.modelNow')],
      [t('tile.humidity'), rh === rh ? rh.toFixed(0) : '–', '%', t('tile.modelNow')],
      [t('tile.dew'), dew === dew ? dew.toFixed(1) : '–', '°C',
        spread === spread && spread < 1.5 ? t('tile.fogNear') : t('tile.modelNow')],
      [t('tile.pressure'), pmsl === pmsl ? pmsl.toFixed(0) : '–', 'hPa', t('tile.modelNow')],
      [t('tile.visibility'), vis === vis ? (vis / 1000).toFixed(vis < 10000 ? 1 : 0) : '–', 'km', t('tile.modelNow')],
      [t('tile.freezing'), fzl === fzl ? fzl.toFixed(0) : '–', 'm', t('tile.modelNow')],
      [t('tile.pprob'), pprob === pprob ? pprob.toFixed(0) : '–', '%', t('tile.modelNow')],
    );
  }
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
  renderMeteogram();

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

// Nine of the sixteen variables are only needed once someone picks a field that
// uses them, so they ride a second endpoint and are fetched at most once.
let extraPromise = null;
function ensureExtra() {
  if (state.extraLoaded) return Promise.resolve();
  if (!extraPromise) {
    extraPromise = get('/api/grid/extra')
      .then(x => {
        for (const k of EXTRA_KEYS) if (x[k]) state.grid[k] = x[k];
        state.extraLoaded = true;
        rebuildSlice();
      })
      .finally(() => { extraPromise = null; });
  }
  return extraPromise;
}

// ── Field chips ────────────────────────────────────────────────────────────
function buildBaseBar() {
  $('#basebar').innerHTML = BASE_FIELDS.map(k =>
    `<button class="chip${state.base === k ? ' is-on' : ''}" data-base="${k}"
       role="radio" aria-checked="${state.base === k}"
       title="${t('base.' + k + '.d')}">${t('base.' + k)}</button>`).join('');
}

async function setBase(next, persist = true) {
  if (!BASE_FIELDS.includes(next)) return;
  state.base = next;
  if (persist) { try { localStorage.setItem('base', next); } catch { /* private mode */ } }
  for (const el of $$('#basebar .chip')) {
    const on = el.dataset.base === next;
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-checked', String(on));
  }
  for (const el of $$('#layerToggles input[data-base]')) el.checked = el.dataset.base === next;
  renderLegend();

  if (FIELDS[next]?.extra && !state.extraLoaded) {
    toast(t('toast.loadingField'), 1600);
    try { await ensureExtra(); } catch (err) {
      toast(String(err.message), 5000);
      return;
    }
    if (state.base !== next) return;          // someone picked something else meanwhile
  }
  raster?.draw();
  renderNow();
}

// ── Meteogram ──────────────────────────────────────────────────────────────
// Three measures on three stacked panels sharing one time axis, rather than one
// plot with several y-scales: temperature, precipitation and wind have nothing
// in common to calibrate against, so overlaying them would only invite false
// comparisons of slope and crossing points.
const MG_LAT = 64.135, MG_LON = -21.90;

function renderMeteogram() {
  const el = $('#meteogram');
  if (!el || !state.grid) return;
  const g = state.grid;
  const start = Math.max(0, Math.round(state.nowIndex));
  const end = Math.min(g.times.length, start + 49);
  const n = end - start;
  if (n < 6) { el.innerHTML = `<div class="mg-empty">${t('acc.noRounds')}</div>`; return; }

  const pick = (key) => {
    const series = g[key];
    if (!series) return null;
    const out = [];
    for (let i = start; i < end; i++) out.push(sampleAt(series[i], MG_LAT, MG_LON));
    return out.every(v => v === v) ? out : null;
  };
  const temp = pick('temp'), app = pick('app');
  const rain = pick('precip'), snow = pick('snow');
  const wind = pick('speed'), gust = pick('gust');
  if (!temp || !wind) { el.innerHTML = `<div class="mg-empty">${t('acc.noRounds')}</div>`; return; }

  const W = 320, PADL = 26, PADR = 8, GAP = 12, PH = 46;
  const X = (i) => PADL + i / (n - 1) * (W - PADL - PADR);
  const panels = [];
  let y = 0;

  // Shared chrome: day boundaries and the "now" marker, drawn on every panel.
  const marks = (top, h) => {
    let out = '';
    for (let i = 0; i < n; i++) {
      const hh = new Date(g.times[start + i] + 'Z').getUTCHours();
      if (hh === 0) out += `<line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${top}" y2="${top + h}" stroke="#2c2c2a" stroke-width="1"/>`;
    }
    const nowX = X(Math.max(0, state.nowIndex - start));
    out += `<line x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${top}" y2="${top + h}" stroke="#898781" stroke-width="1" stroke-dasharray="2 2"/>`;
    return out;
  };

  // Two series on one panel need identifying, so the title row doubles as a key.
  const label = (top, txt, keys = []) => {
    let out = `<text x="0" y="${top - 5}" fill="#898781" font-size="8.5" letter-spacing="0.06em">${txt.toUpperCase()}</text>`;
    let x = W - PADR;
    for (const [colour, name] of [...keys].reverse()) {
      out = `<text x="${x}" y="${top - 5}" fill="#c3c2b7" font-size="8" text-anchor="end">${name}</text>` + out;
      x -= name.length * 4.1 + 5;
      out = `<circle cx="${x.toFixed(1)}" cy="${top - 7.5}" r="2.4" fill="${colour}"/>` + out;
      x -= 9;
    }
    return out;
  };

  // 1 — temperature, with apparent temperature alongside it.
  {
    const all = app ? temp.concat(app) : temp;
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
    const Y = (v) => y + PH - (v - lo) / (hi - lo) * PH;
    const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
    let sec = label(y, t('mg.temp'),
      app ? [['#3987e5', t('mg.tempLine')], ['#d95926', t('mg.appLine')]] : []) + marks(y, PH);
    if (lo < 0 && hi > 0) {
      sec += `<line x1="${PADL}" x2="${W - PADR}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="#383835" stroke-width="1" stroke-dasharray="3 3"/>`;
    }
    if (app) sec += `<path d="${path(app)}" fill="none" stroke="#d95926" stroke-width="1.4" stroke-linejoin="round" opacity="0.85"/>`;
    sec += `<path d="${path(temp)}" fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round"/>`;
    sec += `<text x="${PADL - 4}" y="${Math.max(Y(hi), y) + 9}" fill="#898781" font-size="8" text-anchor="end">${hi.toFixed(0)}</text>`;
    sec += `<text x="${PADL - 4}" y="${Y(lo)}" fill="#898781" font-size="8" text-anchor="end">${lo.toFixed(0)}</text>`;
    panels.push(sec);
    y += PH + GAP + 8;
  }

  // 2 — precipitation, split rain vs snow.
  if (rain) {
    const hi = Math.max(0.6, ...rain);
    const bw = Math.max(1.5, (W - PADL - PADR) / n - 1);
    let sec = label(y, t('mg.precip')) + marks(y, PH);
    rain.forEach((v, i) => {
      if (v <= 0.02) return;
      const h = Math.max(1, v / hi * PH);
      const snowy = snow && snow[i] > 0.02;
      sec += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${(y + PH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${snowy ? SNOW : RAIN}" rx="1"/>`;
    });
    sec += `<line x1="${PADL}" x2="${W - PADR}" y1="${y + PH}" y2="${y + PH}" stroke="#383835" stroke-width="1"/>`;
    sec += `<text x="${PADL - 4}" y="${y + 9}" fill="#898781" font-size="8" text-anchor="end">${hi.toFixed(1)}</text>`;
    panels.push(sec);
    y += PH + GAP + 8;
  }

  // 3 — wind, with the gust envelope behind the mean.
  {
    const hi = Math.max(6, ...(gust ?? wind));
    const Y = (v) => y + PH - v / hi * PH;
    let sec = label(y, t('mg.wind'),
      gust ? [['#86b6ef', t('mg.windLine')], ['#2a5f96', t('mg.gustBand')]] : []) + marks(y, PH);
    if (gust) {
      const top = gust.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
      sec += `<path d="${top} L${X(n - 1).toFixed(1)} ${y + PH} L${X(0).toFixed(1)} ${y + PH} Z" fill="#3987e5" opacity="0.18"/>`;
    }
    sec += `<path d="${wind.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#86b6ef" stroke-width="2" stroke-linejoin="round"/>`;
    sec += `<line x1="${PADL}" x2="${W - PADR}" y1="${y + PH}" y2="${y + PH}" stroke="#383835" stroke-width="1"/>`;
    sec += `<text x="${PADL - 4}" y="${y + 9}" fill="#898781" font-size="8" text-anchor="end">${hi.toFixed(0)}</text>`;
    panels.push(sec);
    y += PH + GAP + 8;          // leave room for the next panel's title row
  }

  // 4 — pressure. Useless as a map layer at this scale, but its trend over two
  // days is exactly the thing a falling barometer is good for.
  const pmsl = pick('pmsl');
  if (pmsl) {
    let lo = Math.min(...pmsl), hi = Math.max(...pmsl);
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
    const Y = (v) => y + PH - (v - lo) / (hi - lo) * PH;
    let sec = label(y, t('mg.pressure')) + marks(y, PH);
    sec += `<path d="${pmsl.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#c3c2b7" stroke-width="1.6" stroke-linejoin="round"/>`;
    sec += `<text x="${PADL - 4}" y="${Math.max(Y(hi), y) + 9}" fill="#898781" font-size="8" text-anchor="end">${hi.toFixed(0)}</text>`;
    sec += `<text x="${PADL - 4}" y="${Y(lo).toFixed(1)}" fill="#898781" font-size="8" text-anchor="end">${lo.toFixed(0)}</text>`;
    panels.push(sec);
    y += PH + 4;
  }

  // Shared time axis.
  let axis = '';
  for (let i = 0; i < n; i += 6) {
    const d = new Date(g.times[start + i] + 'Z');
    axis += `<text x="${X(i).toFixed(1)}" y="${y + 9}" fill="#898781" font-size="8" text-anchor="middle">${String(d.getUTCHours()).padStart(2, '0')}</text>`;
  }
  const H = y + 14;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('sect.meteogram')}">
    ${panels.join('')}${axis}</svg>`;
}

// ── Legend ─────────────────────────────────────────────────────────────────
function renderLegend() {
  const stops = RAMP.map(([v, c]) => `${c} ${(v / 32 * 100).toFixed(1)}%`).join(', ');
  $('#ramp').style.background = `linear-gradient(90deg, ${stops})`;
  $('#rampTicks').innerHTML = [0, 8, 16, 24, 32]
    .map(v => `<span style="left:${(v / 32 * 100).toFixed(1)}%">${v}</span>`).join('');

  // Every encoded channel on screen gets its own scale — the wind ramp always,
  // since the particles are never off, plus one for the chosen background field.
  const scale = (title, unit, gradient, ticks, span) => `
    <div class="legend-row">
      <div class="legend-title"><span>${title}</span> <span class="unit">${unit}</span></div>
      <div class="ramp" style="background:${gradient}"></div>
      <div class="ramp-ticks">${ticks.map(v =>
        `<span style="left:${((v - span[0]) / (span[1] - span[0]) * 100).toFixed(1)}%">${v}</span>`
      ).join('')}</div>
    </div>`;

  // Wind always has a scale because the particles are never off; the chosen
  // field adds a second one whenever it is not already the wind ramp.
  const cfg = LEGEND_CFG[state.base];
  $('#legendExtra').innerHTML = cfg
    ? scale(t('base.' + state.base), cfg.unit, fieldGradient(state.base), cfg.ticks, cfg.span)
    : '';

  const parts = [];
  if (state.layers.gusts) parts.push(...GUST_TIERS.map(([thr, c]) =>
    `<div><i style="background:${c}"></i>${t('legend.gustTier', { v: thr })}</div>`));
  if (state.base === 'temp' || state.base === 'apparent') parts.push(
    `<div><i style="background:#eef2f7"></i>${t('legend.freezingLine')}</div>`,
    `<div><i style="background:#d6e0ee"></i>${t('legend.isotherm')}</div>`);
  if (state.base === 'fog') parts.push(
    `<div><i style="background:#c9d1de"></i>${t('legend.fog')}</div>`);
  if (state.base === 'freezing') parts.push(
    `<div><i style="background:#d6e0ee"></i>${t('legend.fzlLine')}</div>`);
  if (state.base === 'precip') parts.push(
    `<div><i style="background:${RAIN}"></i>${t('legend.rain')}</div>`,
    `<div><i style="background:${SNOW}"></i>${t('legend.snow')}</div>`);
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
// Derived from the spec rather than kept in a parallel table, so a swatch can
// never drift from what the raster actually paints.
function fieldGradient(k) {
  const f = FIELDS[k];
  if (!f) return 'linear-gradient(90deg,#2c2c2a,#2c2c2a)';
  const c = f.rgb;
  const rgba = (a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  switch (f.kind) {
    case 'ramp':    return 'linear-gradient(90deg,#1c5cab,#5598e7,#b7d3f6)';
    case 'diverge': return `linear-gradient(90deg,${TEMP_COLD},rgba(120,120,120,0.25),${TEMP_WARM})`;
    case 'precip':  return `linear-gradient(90deg,rgba(27,175,122,0.12),${RAIN})`;
    case 'seqInv':  return `linear-gradient(90deg,${rgba(0.95)},${rgba(0.06)})`;
    default:        return `linear-gradient(90deg,${rgba(0.06)},${rgba(0.95)})`;
  }
}

// Units and tick positions per field — the only thing the spec cannot infer.
const LEGEND_CFG = {
  temp:       { unit: '°C',   ticks: [-18, -9, 0, 9, 18], span: [-18, 18] },
  apparent:   { unit: '°C',   ticks: [-18, -9, 0, 9, 18], span: [-18, 18] },
  humidity:   { unit: '%',    ticks: [45, 70, 100],       span: [45, 100] },
  fog:        { unit: '°C',   ticks: [0, 2.5, 5],         span: [0, 5] },
  precip:     { unit: 'mm/h', ticks: [0, 0.5, 1],         span: [0, 1] },
  cloud:      { unit: '%',    ticks: [0, 50, 100],        span: [0, 100] },
  visibility: { unit: 'km',   ticks: [0, 10, 20],         span: [0, 20] },
  snowdepth:  { unit: 'cm',   ticks: [0, 25, 50],         span: [0, 50] },
  freezing:   { unit: 'm',    ticks: [0, 1200, 2400],     span: [0, 2400] },
};
const OVERLAY_SWATCH = {
  particles: 'linear-gradient(90deg,#1c5cab,#cde2fb)',
  gusts:     `linear-gradient(90deg,${STATUS.warning},${STATUS.critical})`,
  stations:  'linear-gradient(90deg,#86b6ef,#86b6ef)',
};

function buildLayerToggles() {
  const field = BASE_FIELDS.map(k =>
    `<label class="lay"><input type="radio" name="basefield" data-base="${k}" ${state.base === k ? 'checked' : ''}>
      <span class="lay-sw" style="background:${fieldGradient(k)}"></span>
      <span><span class="lay-t">${t('base.' + k)}</span><br>
        <span class="lay-d">${t('base.' + k + '.d')}</span></span></label>`).join('');

  const over = OVERLAYS.map(k =>
    `<label class="lay"><input type="checkbox" data-layer="${k}" ${state.layers[k] ? 'checked' : ''}>
      <span class="lay-sw" style="background:${OVERLAY_SWATCH[k]}"></span>
      <span><span class="lay-t">${t('layer.' + k)}</span><br>
        <span class="lay-d">${t('layer.' + k + '.d')}</span></span></label>`).join('');

  $('#layerToggles').innerHTML =
    `<div class="lay-group">${field}</div><div class="lay-group">${over}</div>`;

  $$('#layerToggles input[data-base]').forEach(el =>
    el.addEventListener('change', () => { if (el.checked) setBase(el.dataset.base); }));

  $$('#layerToggles input[data-layer]').forEach(el => el.addEventListener('change', () => {
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
    for (const k of OVERLAYS) state.layers[k] = want.has(k);
    // Links written before the fields became exclusive may still name a scalar
    // in ?layers=; honour the first one rather than silently dropping it.
    const scalar = BASE_FIELDS.find(b => want.has(b));
    setBase(scalar ?? 'none', false);
    buildLayerToggles();
  }
  const base = q.get('base');
  if (base) setBase(base, false);          // keeps chips and radios in step

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
  try {
    const savedBase = localStorage.getItem('base');
    if (BASE_FIELDS.includes(savedBase)) state.base = savedBase;
  } catch { /* private mode */ }
  buildBaseBar();
  renderLegend();
  buildLayerToggles();
  initSheet();

  $('#basebar').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-base]');
    if (chip) setBase(chip.dataset.base);
  });
  // A cold server paces its upstream chunks, so the grid can be up to a couple
  // of minutes away on first boot. Wait it out rather than showing a dead map.
  for (let attempt = 0; ; attempt++) {
    try { await loadGrid(); break; } catch (err) {
      if (attempt >= 12) {
        toast(t('toast.gridFail', { err: err.message }), 8000);
        console.error(err);
        return;
      }
      if (attempt === 0) toast(t('toast.loadingField'), 4000);
      await new Promise(r => setTimeout(r, 12000));
    }
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

  // Warm the lazy bundle in the background: the first paint does not need it,
  // but the detail tiles and the meteogram's feels-like trace do, and by the
  // time anyone reads that far it has arrived.
  setTimeout(() => ensureExtra().then(() => { renderNow(); }).catch(() => {}), 1200);

  // Observations update hourly; the grid every ten minutes on the server.
  setInterval(() => loadObs().catch(() => {}), 90_000);
  setInterval(async () => {
    try {
      const fresh = await get('/api/grid');
      if (fresh.meta.generated === state.grid.meta.generated) return;
      state.grid = fresh;
      const hadExtra = state.extraLoaded;
      state.extraLoaded = false;
      if (hadExtra) ensureExtra().catch(() => {});
      computeNowIndex();
      $('#timeSlider').max = String(fresh.times.length - 1);
      setTime(state.tIndex);
      renderModelInfo();
      toast(t('toast.refreshed'));
    } catch { /* keep the old grid */ }
  }, 300_000);
})();

# Vindur yfir höfuðborgarsvæðinu

Real-time wind flow over the Reykjavík capital region: a 2 km model wind field
animated as advected particles, with live Veðurstofan station observations laid
over it so you can see how well the model matches reality.

```
npm start          # → http://localhost:5173
```

No dependencies, no API keys, no build step. Node 18+ (uses global `fetch`).

---

## What's on screen

| Layer | Source | Notes |
|---|---|---|
| **Wind flow** | model | particles advected through the interpolated field |
| **Speed field** | model | continuous 10 m wind speed, blue sequential ramp |
| **Gust warnings** | model | zones above 20 / 28 / 35 m/s gusts |
| **Cloud cover** | model | total cloud fraction |
| **Precipitation** | model | rain (aqua) vs snow (violet), by rate |
| **Stations** | **observed** | 19 Veðurstofan sites, arrows pointing downwind |

The scrubber runs from 24 h in the past to 48 h ahead. Because observations only
exist for the present, scrubbing off "now" switches the station points to the
*model* sampled at those same coordinates, labelled as such — the map never mixes
a stale reading into a forecast.

Deep links: `?tab=accuracy`, `?layers=particles,cloud,precip`, `?t=27`,
`?c=64.13,-21.90&z=12`, `?lang=is`.

---

## Language

The site is bilingual — Icelandic and English — and **defaults to Icelandic for
visitors on Icelandic IP addresses**. The choice is made server-side and the page
is served already translated, so an Icelandic visitor never sees a flash of
English. The `IS` / `EN` button in the title card overrides it and remembers the
choice in a cookie and in `localStorage`.

Precedence, highest first:

1. `?lang=is` / `?lang=en`
2. the saved `lang` cookie
3. a CDN country header — `CF-IPCountry`, `X-Vercel-IP-Country`,
   `CloudFront-Viewer-Country`, `X-Country-Code`
4. **the client IP falling inside an Icelandic allocation**
5. `Accept-Language` asking for `is`
6. English

Step 4 uses `data/is-ip-ranges.json` — 160 IPv4 ranges (920,320 addresses) and 73
IPv6 ranges, compiled from the RIPE NCC delegation statistics by
`node scripts/build-geo.mjs`. It is a local binary search, not a lookup service,
so there is no external call and no per-visitor latency. Worth re-running
occasionally; allocations change.

`GET /api/locale` reports what was detected and why, which is the quickest way to
debug it behind a proxy.

Icelandic is not just a string swap: compass points use the Icelandic
abbreviations (**A**ustur / **V**estur, so `VNV` not `WNW`) and wind strength is
named on the Icelandic Beaufort scale — *kul*, *stinningsgola*, *hvassviðri*,
*ofsaveður*.

---

## The data, and how real-time it actually is

### Model — Open-Meteo, DMI Harmonie DINI

`api.open-meteo.com` serves the DMI Harmonie DINI run for Iceland at **~2 km**
native resolution. It is free, keyless and CORS-open, so the browser could hit it
directly; it is proxied here only to cache and to batch.

- Grid: **21 × 34 = 714 points** at 0.02° lat × 0.04° lon, matching the native mesh.
- Fields: wind speed/direction/gusts, cloud, precipitation, snowfall, temperature.
- Window: 72 hours (past 24 + next 48), hourly.
- Terrain in the grid spans **0–854 m**, so Esja and Bláfjöll are genuinely resolved
  — the speed contrast between the fjord, the city and the highland is real, not
  interpolation.
- One request per 300 points (the API is GET-only and rejects URIs past ~8 KB), so
  the grid is fetched in three parallel chunks and stitched. ~1.3 MB of JSON,
  330 KB gzipped, in about a second. Refreshed every 3 hours, 8 overnight — see
  [Staying inside the API budget](#staying-inside-the-api-budget).

### Observations — Veðurstofa Íslands

`xmlweather.vedur.is` returns live station XML. It sends **no CORS header**, which
is the reason this project has a server at all.

19 stations lie in the capital-region group, and they are dense — Hljómskálagarður,
Háahlíð, Fossvogsdalur, Geirsnef, Víðidalur, the airport, Geldinganes, Korpa,
Hólmsheiði, Straumsvík, Urriðaholt, Kauptún, Arnarnesvegur, Seltjarnarnes,
Blikastaðanes, Skrauthólar, Kjalarnes, Sandskeið, plus the manned Reykjavík site.
Coordinates and elevations were scraped from each station's page into
`data/stations.json`.

Available per station: 10-minute mean wind (`F`), highest 10-minute mean in the
hour (`FX`), peak gust (`FG`), direction as an Icelandic compass string (`D` —
`SSV`, `VNV`… mapped to degrees), temperature, dewpoint, humidity, pressure,
precipitation. Updated **hourly**.

Two caveats worth knowing:

- Cloud (`N`) and visibility (`V`) come back **empty** for the automatic stations —
  only manned sites report them. So every cloud and precipitation figure on screen
  is model output, and is labelled "model" in the UI.
- The XML API serves **current conditions only**. There is no observation history
  endpoint, which is why the accuracy chart has to accumulate while the server runs.

---

## How accurate is it?

The **Accuracy** tab compares each live station against the model interpolated to
that station's exact coordinates — read out of the same grid the map is drawing,
so the panel verifies precisely what is on screen — and reports bias, MAE and RMSE
across all of them.
The server appends one row per hourly observation round to
`data/verification.ndjson`, and the "Bias over time" chart draws from it.

Three rounds on 23 Aug 2026 (wind bias = model − observed, m/s):

| obs time | wind bias | wind MAE | gust bias | dir bias | n |
|---|---|---|---|---|---|
| 10:00 | −0.75 | 0.98 | −1.37 | −13° | 18 |
| 11:00 | −0.40 | 1.00 | −2.59 | −41° | 17 |
| 15:00 | **+0.78** | 0.84 | +1.65 | −17° | 19 |

**Magnitude is good; the sign is not stable.** MAE sits under 1 m/s for wind all
day, which is genuinely close. But the bias flipped from −0.75 in the morning to
+0.78 by afternoon — so "the model runs too calm" would have been the wrong
lesson to draw from the morning alone. In the light 1–3 m/s afternoon it ran too
windy instead. Gust bias flipped with it, and is the larger error either way.

Direction is the steadiest thing here: the bias sat between −13° and −41°,
consistently *anticlockwise* of the observed wind, and the typical error is around
one to two compass points.

Practical reading: trust the broad pattern and the direction to within a compass
point; treat any single-station speed as ±1 m/s, and don't assume the error has a
fixed sign. The longer the server runs, the more the chart is worth — this is
three rounds, not a season.

---

## Layout

```
server.mjs                 data server, vedur.is CORS proxy, language detection
scripts/build-geo.mjs      regenerates the Icelandic IP range table from RIPE
data/stations.json         19 capital-region stations, scraped coordinates
data/is-ip-ranges.json     Icelandic IPv4/IPv6 allocations, sorted and merged
data/verification.ndjson   accumulating model-vs-observation log (generated)
public/index.html          page shell, {{token}} placeholders filled server-side
public/i18n.js             string table, shared by server and browser
public/app.js              map, particle engine, raster overlays, panels
public/style.css           dark-surface design tokens
```

### Endpoints

| Route | What |
|---|---|
| `/api/grid` | the full wind/weather grid, gzipped, 3 h cache (8 h overnight) |
| `/api/obs` | live station observations as JSON, 1 min cache |
| `/api/verify` | per-station model-vs-observed comparison + summary stats |
| `/api/verify/history` | the accumulated hourly bias log |
| `/api/stations` | station metadata |
| `/api/locale` | detected language, and which signal decided it |
| `/api/health` | cache state, grid age, quiet-hour status, API budget |

---

## Staying inside the API budget

Open-Meteo's free tier allows about **10,000 calls/day** and bills roughly one
call per location. One grid fetch asks for 714, so refresh policy is the whole
ballgame. Three things keep it in hand:

**Refreshes are demand-driven.** `cached()` only refetches when a request arrives
after the TTL has lapsed. A night with no visitors costs nothing at all — there
is no background timer.

**The TTL widens overnight**, 3 h → 8 h between 22:00 and 06:00 UTC (Iceland runs
on UTC year-round, so those are local hours). This does nothing for a genuinely
idle night; it matters for the night that has an uptime monitor pinging every
five minutes, which demand-driven caching alone would refresh straight through.
The TTL is compared against cache age at *read* time, so the wide night window
cannot leak into the morning — at 08:00 the daytime TTL applies again and a grid
fetched at 01:00 is already stale.

**A daily budget, tracked across restarts** (`data/api-usage.json`), stops a
traffic spike or a restart loop from spending the allowance. Once it is gone the
server serves the disk grid flagged `stale` rather than failing.

Worst case — meaning traffic in literally every hour, the only way a
demand-driven cache reaches its ceiling:

| policy | refreshes/day | calls/day |
|---|---|---|
| flat 3 h, no quiet window | 8 | 5,712 |
| 3 h active / 8 h quiet, 01:00–06:00 | 8 | 5,712 |
| **3 h active / 8 h quiet, 22:00–06:00** *(default)* | **7** | **4,998** |
| 4 h active / 8 h quiet, 22:00–06:00 | 5 | 3,570 |
| 2 h active / 8 h quiet, 22:00–06:00 | 9 | 6,426 |

Note the second row: a 01:00–06:00 quiet window is intuitive but buys nothing,
because 19 active hours still round up to the same seven daytime refreshes. Eight
quiet hours remove a whole refresh from the day.

**A longer TTL costs less freshness than it looks like it does.** The grid carries
72 hours of valid times, so a grid fetched four hours ago still renders the
current hour correctly — the only difference is that it comes from an older model
run. And DMI Harmonie DINI only runs four times a day (00/06/12/18 UTC, published
a few hours later), so anything under ~4 h is already finer-grained than the data
changes. If you want more headroom, raising `GRID_TTL_MS` is close to free.

Knobs, all environment variables:

| var | default | what |
|---|---|---|
| `GRID_TTL_MS` | `10800000` (3 h) | active-hours refresh interval |
| `GRID_TTL_QUIET_MS` | `28800000` (8 h) | quiet-hours refresh interval |
| `QUIET_FROM` / `QUIET_TO` | `22` / `6` | quiet window, UTC hours; wraps midnight |
| `OPEN_METEO_DAILY_BUDGET` | `9000` | soft cap below the 10,000 hard limit |

`GET /api/health` reports the live picture: whether it is currently a quiet hour,
the TTL in force, budget used and remaining, grid age, and whether the grid being
served is stale and why.

---

## Deploying

`PORT` is read from the environment; everything else is self-contained. Behind a
reverse proxy, forward `X-Forwarded-For` so IP-based language detection sees the
real client — behind Cloudflare, `CF-IPCountry` is used first and is more reliable
than the address itself.

The HTML is served `no-store` with `Vary: Cookie, Accept-Language`, because the
same URL returns different languages. Don't put a naive shared cache in front of
`/` without honouring that.

`data/grid-cache.json` and `data/api-usage.json` are written at runtime and are
gitignored. Keep them on a persistent volume if you can — the budget counter and
the stale-grid fallback both survive restarts through those files.

---

## Notes on the rendering

- Particles live in **screen space** and are advected through a coarse screen-space
  vector field rebuilt on every map move. Web Mercator separates the axes —
  latitude depends only on screen y, longitude only on x — which turns the field
  build from O(w·h) unprojections into O(w+h).
- Trails come from fading the canvas with `destination-out` rather than repainting,
  so the basemap stays visible underneath.
- **Particle motion is exaggerated.** Direction and relative speed are true to the
  model; the wall-clock rate is not — real 10 m/s at this zoom would be about
  0.2 px/s. The "Flow speed" slider is in px/s per m/s.
- Wind speed uses a single-hue blue sequential ramp stepped dark→light for the dark
  basemap. The reserved warning/serious/critical steps are used *only* for gust
  thresholds, never as a series colour, and always with a label.

## Attribution

Wind and weather from [Open-Meteo](https://open-meteo.com/) (DMI Harmonie DINI).
Observations from [Veðurstofa Íslands](https://vedur.is/). Basemap ©
OpenStreetMap contributors, © CARTO. Icelandic IP allocations from RIPE NCC.

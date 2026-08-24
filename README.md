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

The chips above the map choose **one background field**. Stacking wind speed,
cloud and rain on top of each other produced mud and hid whichever one you
actually wanted, so they are now exclusive:

| Field | Source | Notes |
|---|---|---|
| **Wind** | model | continuous 10 m wind speed, blue sequential ramp |
| **Temp** | model | 2 m temperature — faint tint, hue pivoting at freezing, with isotherms every 2 °C and the 0 °C line picked out |
| **Rain** | model | precipitation rate, rain (aqua) vs snow (violet) |
| **Cloud** | model | total cloud fraction, kept to a thin veil |
| **None** | — | particles over a bare basemap |

On top of that, three independent overlays:

| Overlay | Source | Notes |
|---|---|---|
| **Wind flow** | model | particles advected through the interpolated field |
| **Gust warnings** | model | zones above 20 / 28 / 35 m/s — a warning has to be able to sit on anything |
| **Stations** | **observed** | 19 Veðurstofan sites, arrows pointing downwind |

**On temperature.** A fixed diverging scale flooded the map: for most of the
year every cell sits on one side of zero, so the whole domain washed to a single
hue and told you nothing. The tint is therefore kept faint and the structure is
carried by **isotherms** — a contour lands wherever a neighbouring sample falls
in a different 2 °C band, which is crisper than a neutral band whose width would
vary with the local gradient. Freezing gets its own brighter line, because in
Iceland that is the threshold that actually matters. The contour pass samples at
3 px rather than 6, since the upscale would otherwise smear each crossing into a
ribbon.

The scrubber runs from 24 h in the past to 48 h ahead. Because observations only
exist for the present, scrubbing off "now" switches the station points to the
*model* sampled at those same coordinates, labelled as such — the map never mixes
a stale reading into a forecast.

Deep links: `?base=temp`, `?tab=accuracy`, `?layers=particles,gusts,stations`,
`?t=27`, `?c=64.13,-21.90&z=12`, `?lang=is`, `?sheet=peek`. Older links that
name a scalar in `?layers=` still work — the first one becomes the base field.

---

## On a phone

The panel becomes a **bottom sheet** with three rest positions — collapsed, half
and full. Drag the handle, or tap it to toggle. The choice is remembered.

Collapsed, the handle itself carries the live reading (`1.0 m/s A · hviða 3`), so
folding the panel away to see the map costs you nothing you were actually looking
at. Expanded, that line disappears — the hero says it better — and the handle
shrinks to a grab strip so the rows get the space back.

Everything that floats above the sheet — time scrubber, legend, map credit —
stacks off a single `--stack` custom property, so it all rides up and down with
the sheet in one transition. The legend only appears when the sheet is collapsed,
since that is the only time there is a map worth reading it against. Tapping a
station in the list collapses the sheet on the way to its popup.

**Landscape is a different shape, so it gets a different pattern.** A bottom
sheet on a 390 px-tall screen leaves a sliver of map, so below 900 px wide in
landscape the panel becomes a side drawer that slides off to the right and leaves
a 30 px grab strip behind. Same states, same control, horizontal drag axis.

The map underneath is full-bleed and never resizes, so moving the sheet costs
nothing beyond the compositor — no canvas reallocation, no re-projection. Snap
heights and their transition live in CSS keyed off `body[data-sheet]`; JavaScript
only picks the state and, mid-drag, writes a live height override.

Also: `devicePixelRatio` is capped at 1.75 on phones (the trail fade touches
every pixel of the canvas every frame, and 3× is not worth it), popups are
clamped to the viewport width, and `viewport-fit=cover` plus
`env(safe-area-inset-bottom)` keep the sheet clear of the home indicator.

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
public/style.css           dark-surface design tokens, bottom sheet, side drawer
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

## What would it take to cover all of Iceland?

Short version: **the rendering scales fine, the API budget does not.**

Iceland's bounding box is 3.3° × 11.2° — about 367 × 527 km, or 194,000 km²
against the 44 × 64 km this covers today. At the current 2 km mesh that is
**46,646 grid points, 65× what the capital region needs.** Since Open-Meteo bills
roughly one call per location, that is 46,646 calls for a single refresh:

| resolution | grid | points | calls per fetch | free (10k/day) | Standard (33k/day) | Professional (166k/day) |
|---|---|---|---|---|---|---|
| 2 km (today's) | 166 × 281 | 46,646 | 46,646 | 0.2 | 0.7 | 3.6 |
| 3 km | 111 × 188 | 20,868 | 20,868 | 0.5 | 1.6 | 8.0 |
| 4 km | 83 × 141 | 11,703 | 11,703 | 0.9 | 2.9 | 14.2 |
| 7 km | 56 × 94 | 5,264 | 5,264 | 1.9 | 6.3 | 31.7 |
| 9 km | 42 × 71 | 2,982 | 2,982 | 3.4 | 11.2 | 55.9 |

(fetches affordable per day; you need ≥ 1 to work at all, and ≥ 4 to track every
Harmonie run)

So on the free tier, national coverage means **9 km cells** — which throws away
exactly the terrain detail that makes this worth looking at. Esja and Bláfjöll
stop existing. The 2 km field only becomes affordable on Professional, and even
then at 3.6 refreshes a day.

Two things are *not* blockers, which is worth knowing before anyone panics:

- **The particle renderer does not care.** It works in screen space against a
  vector field rebuilt per viewport, so its cost is set by pixels, not by grid
  size. Zooming out to the whole country costs exactly what it costs now.
- **The station network scales for free.** Probing the whole of `vedur.is`
  turns up **132 live stations** reporting wind nationally against the 19 here,
  and they all arrive in one XML request. The accuracy panel would get seven
  times the sample — the most interesting part of the expansion, and the
  cheapest.

The real architectural change is transport. Today the entire grid is shipped to
the browser and interpolated client-side, which is what makes it feel smooth.
That does not survive a 65× increase:

| | values | JSON | Float32 | Int16 |
|---|---|---|---|---|
| 2 km, 72 h, u+v | 6.72 M | ~47 MB | 26.9 MB | 13.4 MB |
| 2 km, 24 h, u+v | 2.24 M | ~16 MB | 9.0 MB | 4.5 MB |
| 4 km, 72 h, u+v | 1.69 M | ~12 MB | 6.7 MB | 3.4 MB |

The fix is to stop conflating two separate budgets: **API cost is a server
concern, payload is a client concern.** Have the server hold the national grid in
memory (46,646 × 72 × 8 fields × 4 B ≈ 110 MB — nothing for a server) and serve
each browser a downsampled window for its current viewport and zoom. API cost
then stays at one national fetch per refresh regardless of how many people are
watching, and the payload stays about what it is now. That plus a binary encoding
(Int16 with a scale factor, not JSON) is a weekend of work.

Which leaves the budget as the only hard problem, and it has three honest
answers:

1. **Pay for it.** Professional at 5M calls/month affords the 2 km national grid
   about 3–4 times a day, which matches the model's own run cadence. Simplest
   path by far.
2. **Mask to land.** Roughly half that bounding box is open ocean. Requesting
   only points within ~25 km of the coast cuts the grid by about 40 %, bringing
   2 km national to ~28,000 calls — still over the free tier, but it makes
   Standard viable.
3. **Stop using the hosted API.** Open-Meteo is open source and can be
   self-hosted, syncing the DMI Harmonie DINI dataset directly. Unlimited
   queries at full resolution, and no per-location billing at all. Much the
   biggest lift — tens of GB of model data to sync and keep current — but it is
   the only option that makes 2 km national coverage genuinely free.

My read: expanding the *map* is a small change, expanding the *data* is not. If
this stays a capital-region tool, the current design is right. If it goes
national, it wants the viewport-window architecture first and then either a paid
tier or a self-hosted Open-Meteo behind it.

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

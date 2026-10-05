# thai-water-way

Bangkok water map and flood simulation. Static app, model runs in the browser; a Worker cron pulls
live data into R2 every 5 min (sources that refuse Workers come from a laptop through the Worker's
ingest API); all data is public on the data domain. Free, non-commercial. Built
data lives in the sibling repo `thai-water-way-data` (contents and licences in its README).

## Run

```bash
bun install
bun run vite dev --port 5199     # Vite on Node: the CF Vite plugin refuses the Bun runtime
```

Dev reads built data from `public/data` (symlink to `../thai-water-way-data`) and live data from
the local Worker's R2. The cron doesn't fire by itself in dev; refresh every source with:
`curl -X POST "localhost:5199/cdn-cgi/local/explorer/api/local/scheduled?worker=thai-water-way" -H 'content-type: application/json' -d '{"cron":"all"}'`

## Deploy

Cost model: app = Workers static assets (free); data reads = R2 behind Cloudflare cache (free
egress); Worker = cron only (~0.1–0.2 s CPU a run, needs Workers Paid); builds run on the laptop.

- App: Workers Builds, build `bun run build`, deploy `bunx cf deploy --prebuilt`; build variables
  `BUN_VERSION=1.4.0` (bun.lock v2; the image default 1.2 is older) and `NODE_VERSION=24` (cf and
  Vite run on Node).
- Data: `bun run data:rebuild` (rebuild all after `data:network`: node ids change), commit the data
  repo, `bun run data:publish`.
- Live data the Worker can't fetch (BMA, ThaiWater: `RUNS_ON` in `worker/sources.ts`) and the news
  layer: `caffeinate -i bun run mirror` on the laptop fetches them and posts them to the Worker.
  News (`scripts/lib/news.ts`) reads FM91 / Khaosod / Matichon / Thairath / Google News feeds every
  30 min, asks Claude Haiku through the local `claude -p` (the user's Claude plan, no API key, no
  tools) for place + depth, and places reports with `data/gazetteer.json` (`bun run data:gazetteer`,
  OSM; `--cached` builds from snapshots when Overpass is slow).
- Satellite flood extent: `/tiles/gistda/<1day|3days|7days|30days>/{z}/{x}/{y}` proxies GISTDA's
  tiles (Thailand only, edge-cached 1 h) with the optional `GISTDA_KEY` Worker secret (dashboard;
  without it the layer is left out).
- Archive: `bun run data:compact` any time.
- Laptop scripts never hold R2 credentials: mirror, publish and compact go through the Worker's
  API (`worker/api.ts`, each route limited to the keys its script writes). Key: Worker secret
  `INGEST_KEY` (dashboard) = `~/.config/thai-water-way/ingest-key`. Dev: `INGEST_KEY=…` in
  `.dev.vars`, then `API_ORIGIN=http://localhost:5199 INGEST_KEY=… bun run mirror --once`.
- Data domain, once: set `DATA_ORIGIN` (`shared/data-layout.ts`) and add it as the bucket's custom
  domain; bucket CORS `GET, HEAD` from `*`; Cache Rules: `/v/*`, `/archive/*` edge TTL 1 year,
  `/live/*`, `/current.json` TTL 60 s (`.json` isn't cached by default); Smart Tiered Cache on.

Government sources: use moderately. Scripts cache history once settled (`scripts/lib/data.mjs`,
`POLITE` = 2 in flight, long backoff on 403/429); the Worker fetches each source only as often as
it changes (`every` in `worker/index.ts`). New sources follow the same rules.

## Public data

No key, CORS open, base `DATA_ORIGIN`. Layout `shared/data-layout.ts`, shapes `shared/types.ts`.
Stays available when a source site is down. Non-commercial use with attribution.

| Path | What |
|---|---|
| `live/<layer>.json` | latest GeoJSON per layer: `flood`, `pump`, `smallpump`, `flow`, `level`, `rain`, `river`, `reports` (5–15 min), `news` (30 min, unverified) |
| `live/status.json`, `live/tide.txt` | refresh status per layer; HII tide forecast (hourly) |
| `archive/raw/<layer>/<day>/<HHmm>.json` | every refresh of today, Bangkok time |
| `archive/<layer>/<YYYY>/<day>.ndjson.gz`, `archive/index.json` | past days, one line per distinct reading (`seen_at`, `id`, `lon`, `lat`, …) |
| `current.json`, `v/<version>/<file>` | built data of the live version |

Code: `worker/` refresh · `src/main.ts` map · `src/sim/` model, ponding, UI · `scripts/` pipeline.

## Methods and references

| Used for | Method | Reference |
|---|---|---|
| Canal flow between storage cells | Local-inertial shallow-water approximation, semi-implicit friction | Bates, Horritt & Fewtrell (2010), *J. Hydrology* 387, 33–45 |
| Channel friction | Manning's equation | Chow (1959), *Open-Channel Hydraulics*, McGraw-Hill |
| Sea/river gates | Free weir flow, one-way | Chow (1959) |
| Rain at a point | Inverse-distance weighting of 3 nearest gauges | Shepard (1968), *Proc. ACM National Conference*, 517–524 |
| Street ponding | Linear reservoir per spot (fill above drain capacity, exponential drainage), fitted per road sensor and per citizen-report hotspot, shrunk toward the group | Chow, Maidment & Mays (1988), *Applied Hydrology*, McGraw-Hill |
| Ground elevation | FABDEM (buildings and trees removed), bias-corrected with a Gaussian-weighted residual surface from BMA spot heights | Hawker et al. (2022), *Environ. Res. Lett.* 17, 024016 |
| Drainage direction | Shortest path along canals to the nearest outlet; upstream land area accumulated | Standard graph methods (Dijkstra) |

## Data sources

| Source | Used for |
|---|---|
| BMA Dept. of Drainage and Sewerage, weather.bangkok.go.th | Live road flood, pumps, canal flow and levels, rain; history for storm replays |
| BMA flood sensors, floodbangkok.bangkok.go.th | Road flood depth history |
| BMA GIS, cpudgiapp.bangkok.go.th (Drainage, CPUD basemap) | Canal network, tunnels, pump stations, spot heights |
| BMA open data, data.bangkok.go.th | Pump/gate capacities, tunnels, retention ponds, dikes |
| HII ThaiWater, api-v3.thaiwater.net | River and canal levels nationwide, history; boundary gauges; extra rain gauges (HII, TMD, DWR, RID) |
| HII tide table, fews2.hii.or.th | Gulf tide forecast |
| Traffy Fondue (BMA / NECTEC), publicapi.traffy.in.th | Citizen flood reports (location, time, status only) |
| OpenStreetMap contributors (ODbL) | Samut Prakan canals, Chao Phraya line, pond locations; place names for news reports |
| GISTDA disaster API, disaster.gistda.or.th | Flood extent from satellite (Sentinel-1 radar), map tiles |
| FM91 Traffic, Khaosod, Matichon, Thairath, Google News | News flood reports: place, depth words, link (no article text kept) |
| RainViewer | Rain radar tiles |
| Open-Meteo | Rain forecast for the forecast scenario |
| FABDEM V1-2, University of Bristol (CC BY-NC-SA 4.0) | Ground elevation (via per-tile mirror on Hugging Face) |
| Copernicus GLO-30 DEM (ESA) | Alternative elevation provider; FABDEM is derived from it |
| RID pump capacities: news reports cited per station | Samut Prakan sea pumps (5 of 8 estimated) |
| OpenFreeMap | Base map tiles |

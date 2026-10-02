# thai-water-way

Bangkok water map and flood simulation. One Cloudflare Worker: static page, `/api/*`, and a
5-minute cron that pulls live sensor data. The model runs in the browser. Free, non-commercial.
Built data lives in the sibling repo `thai-water-way-data` (contents and licences in its README).

## Run

```bash
bun install
bun run vite dev --port 5199     # Vite on Node: the CF Vite plugin refuses the Bun runtime
```

`public/data` and `data` are symlinks into `../thai-water-way-data`. Local cron:
`curl -X POST "localhost:5199/cdn-cgi/local/explorer/api/local/scheduled?worker=thai-water-way" -H 'content-type: application/json' -d '{"cron":"*/5 * * * *"}'`

## Data and deploy

- Rebuild data: `bun run data:rebuild` (network → infra → terrain → banks → boundary → levels →
  ponding → hotspots → `BUILD.json`). Rebuild all after `data:network` (node ids change).
- Deploy app: Workers Builds, build `bun run build`, deploy `bunx cf deploy --prebuilt`, `NODE_VERSION=24`.
- Publish data: commit the data repo, then `bun run data:publish` (R2, versioned by data commit).

Public government sources (BMA, HII/ThaiWater, RID, Traffy, …): use them moderately. Build
scripts download history once and cache it (`scripts/lib/data.mjs`: at most `POLITE` = 2 requests
in flight per server, long backoff on 403/429, a window is cached only once `settled`, 6 h after it
ends). The Worker makes one request per source per 5-minute refresh. New sources follow the same
rules.

Code map: `worker/` live data and API · `src/main.ts` map · `src/sim/` canal model, ponding,
UI · `scripts/` data pipeline · `shared/types.ts` data file shapes.

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
| HII ThaiWater, api-v3.thaiwater.net | River and canal levels nationwide, history; boundary gauges |
| HII tide table, fews2.hii.or.th | Gulf tide forecast |
| Traffy Fondue (BMA / NECTEC), publicapi.traffy.in.th | Citizen flood reports (location, time, status only) |
| OpenStreetMap contributors (ODbL) | Samut Prakan canals, Chao Phraya line, pond locations |
| FABDEM V1-2, University of Bristol (CC BY-NC-SA 4.0) | Ground elevation (via per-tile mirror on Hugging Face) |
| Copernicus GLO-30 DEM (ESA) | Alternative elevation provider; FABDEM is derived from it |
| RID pump capacities: news reports cited per station | Samut Prakan sea pumps (5 of 8 estimated) |
| OpenFreeMap | Base map tiles |

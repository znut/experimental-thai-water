// Builds public/data/boundary.json: canal ends where the network stops at the city edge (north,
// east, west) but the real canal carries on into Pathum Thani / Nonthaburi / Chachoengsao /
// Nakhon Pathom, each tied to the nearest outside water-level gauge. The model exchanges water
// with that gauge's recorded level, both ways. Gauges used here are boundary inputs, so they
// must not also be used to score the model.
// Run: bun scripts/build-boundary.mjs
import { readFile, writeFile } from "node:fs/promises";
import { chaoPhraya, distToLines } from "./lib/data.mjs";

const MIN_WIDTH_M = 6; // ignore ditches
const EDGE_TOL_DEG = 0.004; // ~400 m from the network's outer envelope
const RIVER_CLEAR_M = 600; // canal ends at the Chao Phraya are river outlets, not boundaries
const MAX_GAUGE_KM = 10;
// Canal gauges just outside or on the edge of the network. Main-river gauges are excluded: the
// river is handled by pumps/gates. BKK005 has a broken datum.
const GAUGES = ["BKK002", "BKK015", "BKK016", "BKK019", "VLGE20", "BKK006"];

const dataDir = new URL("../public/data/", import.meta.url);
const J = async (f) => JSON.parse(await readFile(new URL(f, dataDir), "utf8"));
const [net, infra] = await Promise.all([J("network.geojson"), J("infra.json")]);
const river = await chaoPhraya();

const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;
const deg = new Map(), pos = new Map(), width = new Map(), name = new Map();
for (const f of net.features) {
	const p = f.properties;
	for (const [k, c] of [[p.a, f.geometry.coordinates[0]], [p.b, f.geometry.coordinates.at(-1)]]) {
		deg.set(k, (deg.get(k) ?? 0) + 1);
		pos.set(k, c);
		width.set(k, Math.max(width.get(k) ?? 0, p.width_m ?? 0));
		name.set(k, p.name);
	}
}
const outlets = new Set([...infra.pumps.map((p) => p.node), ...(infra.gravity ?? []).map((g) => g.node), ...infra.tunnels.flatMap((t) => t.inlets)]);

// Outer envelope of the network in 1 km bins: northmost per column, east/westmost per row.
const bin = (v) => Math.floor(v / 1000);
const north = new Map(), east = new Map(), west = new Map();
for (const [, [lon, lat]] of pos) {
	const bx = bin(lon * KX), by = bin(lat * KY);
	north.set(bx, Math.max(north.get(bx) ?? -Infinity, lat));
	east.set(by, Math.max(east.get(by) ?? -Infinity, lon));
	west.set(by, Math.min(west.get(by) ?? Infinity, lon));
}

const wl = (await (await fetch("https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load")).json()).waterlevel_data.data;
const gauges = GAUGES.map((code) => wl.find((r) => r.station.tele_station_oldcode === code))
	.filter(Boolean)
	.map((r) => ({ code: r.station.tele_station_oldcode, tw_id: r.station.id, lon: r.station.tele_station_long, lat: r.station.tele_station_lat, canal: r.river_name }));

const nodes = [];
for (const [k, [lon, lat]] of pos) {
	if (deg.get(k) !== 1 || outlets.has(k) || (width.get(k) ?? 0) < MIN_WIDTH_M) continue;
	const bx = bin(lon * KX), by = bin(lat * KY);
	const side =
		lat > 13.78 && north.get(bx) - lat < EDGE_TOL_DEG ? "north" : lat > 13.6 && east.get(by) - lon < EDGE_TOL_DEG ? "east" : lat > 13.65 && lon - west.get(by) < EDGE_TOL_DEG ? "west" : null;
	if (!side || distToLines([lon, lat], river) < RIVER_CLEAR_M) continue;
	const g = gauges.map((g) => ({ g, d: Math.hypot((g.lon - lon) * KX, (g.lat - lat) * KY) / 1000 })).sort((a, b) => a.d - b.d)[0];
	if (!g || g.d > MAX_GAUGE_KM) continue;
	nodes.push({ node: k, side, width_m: width.get(k), canal: name.get(k), gauge: g.g.code, gauge_km: +g.d.toFixed(1) });
}

const used = new Set(nodes.map((n) => n.gauge));
await writeFile(new URL("boundary.json", dataDir), JSON.stringify({ builtFrom: net.build, gauges: gauges.filter((g) => used.has(g.code)), nodes }));
const bySide = nodes.reduce((m, n) => ((m[n.side] = (m[n.side] ?? 0) + 1), m), {});
console.log(`boundary nodes ${nodes.length} ${JSON.stringify(bySide)}; gauges used: ${[...used].map((c) => `${c}×${nodes.filter((n) => n.gauge === c).length}`).join(", ")}`);

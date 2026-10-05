// Builds data/gazetteer.json (data repo): Thai place names -> points, for placing news flood reports
// (scripts/lib/news.ts) without a geocoding service. From OpenStreetMap (ODbL):
//   - every province, district (อำเภอ/เขต) and subdistrict (ตำบล/แขวง) in Thailand, at its centre;
//   - around greater Bangkok (REGION) also named roads, junctions and landmarks (schools,
//     universities, temples, hospitals, markets, malls, stations, villages and housing estates).
// Run: bun run data:gazetteer             (Overpass answers are cached; snapshots in data/osm/)
//      bun run data:gazetteer --cached    (only street tiles already fetched; the mirrors can be slow)
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { placeKey } from "./lib/places.ts";
import { overpass } from "./lib/data.mjs";

const CACHED_ONLY = process.argv.includes("--cached");
const snapshot = (name) => new URL(`../data/osm/${name}.json`, import.meta.url);
// --cached: use the snapshots in data/osm/ as they are (no Overpass at all); a missing one is null.
const osm = async (name, query, opts) =>
	CACHED_ONLY ? (existsSync(snapshot(name)) ? JSON.parse(await readFile(snapshot(name), "utf8")) : null) : overpass(name, query, opts);

// South, west, north, east: Bangkok, Nonthaburi, Pathum Thani, Samut Prakan, Samut Sakhon,
// Nakhon Pathom east, Chachoengsao west, Nakhon Nayok south (the rain layer's area).
const REGION = "13.4,100.1,14.4,101.1";
const THIN_KM = 0.4; // keep one point per road name every ~400 m

// Thai names a feature goes by (OSM "name" is Thai in Thailand; the others are variants).
const names = (t) => [...new Set([t.name, t["name:th"], t.alt_name, t.official_name, t.short_name].filter(Boolean).flatMap((n) => n.split(";")))];
const center = (e) => (e.type === "node" ? [e.lon, e.lat] : e.center ? [e.center.lon, e.center.lat] : null);
const round = (v) => Math.round(v * 1e5) / 1e5;

const admin = [];
const adminOsm = await osm(
	"gazetteer-admin",
	`[out:json][timeout:300];area["ISO3166-1"="TH"][admin_level=2]->.th;
	rel(area.th)["boundary"="administrative"]["admin_level"~"^(4|6|8)$"];out tags center;`,
);
for (const e of adminOsm.elements) {
	const at = center(e);
	if (!at) continue;
	for (const n of names(e.tags)) admin.push([placeKey(n), Number(e.tags.admin_level), round(at[0]), round(at[1])]);
}

const places = [];
const kindOf = (t) => (t.highway && /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)$/.test(t.highway) && !t.junction ? "road" : t.junction || t.highway === "traffic_signals" ? "junction" : "landmark");
// In parts: one answer for the whole region is too slow for the Overpass mirrors.
const parts = [
	await osm(
		"gazetteer-landmarks",
		`[out:json][timeout:300][bbox:${REGION}];
		(
		  node["highway"="traffic_signals"]["name"];
		  nwr["junction"]["name"];
		  nwr["amenity"~"^(school|university|college|kindergarten|hospital|clinic|place_of_worship|marketplace|police|fire_station|townhall|bus_station|community_centre)$"]["name"];
		  nwr["shop"~"^(mall|department_store|supermarket)$"]["name"];
		  nwr["railway"~"^(station|halt)$"]["name"];
		  nwr["public_transport"="station"]["name"];
		  nwr["place"~"^(suburb|quarter|neighbourhood|village|hamlet)$"]["name"];
		  nwr["landuse"="residential"]["name"];
		  nwr["man_made"="bridge"]["name"];
		);out tags center qt;`,
	),
	await osm("gazetteer-main-roads", `[out:json][timeout:300][bbox:${REGION}];way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]["name"];out tags center qt;`),
];
// Sois and small streets: many more ways, in tiles; optional, a tile the mirrors can't answer is
// skipped (rerun later: answered tiles are cached).
const [S, W, N, E] = REGION.split(",").map(Number);
const GRID = 3;
for (let i = 0; i < GRID * GRID; i++) {
	const r = Math.floor(i / GRID), c = i % GRID, dy = (N - S) / GRID, dx = (E - W) / GRID;
	const t = [S + r * dy, W + c * dx, S + (r + 1) * dy, W + (c + 1) * dx].map((v) => +v.toFixed(4));
	const name = `gazetteer-streets-${t.join("_")}`;
	try {
		const part = await osm(name, `[out:json][timeout:300][bbox:${t.join(",")}];way["highway"~"^(unclassified|residential|living_street)$"]["name"];out tags center qt;`, { timeoutMs: 280_000 });
		if (part) parts.push(part);
		else console.warn(`streets tile ${t.join(",")} not fetched yet, skipped (--cached)`);
	} catch (e) {
		console.warn(`streets tile ${t.join(",")} skipped: ${e.message}`);
	}
}
const placesOsm = { elements: parts.filter(Boolean).flatMap((p) => p.elements) };
// Roads come as many segments: keep a point per name every THIN_KM so long roads stay findable
// near any district without storing every segment.
const kept = new Map(); // key -> points kept
for (const e of placesOsm.elements) {
	const at = center(e);
	if (!at) continue;
	const kind = kindOf(e.tags);
	for (const n of names(e.tags)) {
		const key = placeKey(n);
		if (key.length < 2) continue;
		const pts = kept.get(`${kind} ${key}`) ?? [];
		if (pts.some((p) => Math.hypot((p[0] - at[0]) * 108, (p[1] - at[1]) * 111) < THIN_KM)) continue;
		pts.push(at);
		kept.set(`${kind} ${key}`, pts);
		places.push([key, kind, round(at[0]), round(at[1])]);
	}
}

const out = { built: new Date().toISOString().slice(0, 10), source: "© OpenStreetMap contributors (ODbL)", admin, places };
await writeFile(new URL("../data/gazetteer.json", import.meta.url), JSON.stringify(out));
const count = (k) => places.filter((p) => p[1] === k).length;
console.log(`gazetteer: ${admin.length} admin names, ${count("road")} road points, ${count("junction")} junctions, ${count("landmark")} landmarks`);

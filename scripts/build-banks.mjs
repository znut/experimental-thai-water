// Builds public/data/banks.json: canal bank-top height (m MSL) for every graph node.
//
// Surveyed banks come from BMA DDS canal-level stations and HII ThaiWater stations snapped to
// the graph (public/data/sensors.json). Leave-one-out tests (2026-10-01) showed banks vary too
// much locally to interpolate well (RMSE ~0.8 m whatever the method), so:
//   1. a node with a station uses that station's surveyed bank;
//   2. otherwise the nearest station on the same canal within SAME_CANAL_M (RMSE 0.77 m);
//   3. otherwise inverse-distance weighting of the 3 nearest stations (RMSE 0.71 m) within MAX_M;
//   4. otherwise the median corrected ground of the node catchment (terrain.json);
//   5. otherwise null, and the model falls back to its default.
// Run: bun scripts/build-banks.mjs   (needs the live API for current station metadata)
import { readFile, writeFile } from "node:fs/promises";

const API = process.env.API ?? "http://localhost:5199/api/layers";
const SAME_CANAL_M = 4000;
const MAX_M = 6000;

const dataDir = new URL("../public/data/", import.meta.url);
const net = JSON.parse(await readFile(new URL("network.geojson", dataDir), "utf8"));
const sensors = JSON.parse(await readFile(new URL("sensors.json", dataDir), "utf8"));
const [level, river] = await Promise.all(["level", "river"].map(async (l) => (await fetch(`${API}/${l}`)).json()));

const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;
const xy = new Map();
const names = new Map();
for (const f of net.features) {
	const { a, b, name } = f.properties;
	for (const [k, c] of [[a, f.geometry.coordinates[0]], [b, f.geometry.coordinates.at(-1)]]) {
		xy.set(k, [(c[0] - LON0) * KX, (c[1] - LAT0) * KY]);
		if (!names.has(k)) names.set(k, new Set());
		names.get(k).add(name);
	}
}
const n = Math.max(...xy.keys()) + 1;
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// Surveyed banks per node (several stations on one node are averaged).
const acc = new Map();
const add = (code, bank, src) => {
	const s = sensors[code];
	if (!s || typeof bank !== "number" || bank < 0.3 || bank > 5) return; // 0 = missing in BMA data
	const a = acc.get(s.node) ?? { sum: 0, k: 0, codes: [] };
	a.sum += bank;
	a.k++;
	a.codes.push(`${src}:${code}`);
	acc.set(s.node, a);
};
for (const f of level.features) add(f.properties.id, f.properties.bank_m, "bma");
// ThaiWater banks go onto BMA's reference via the station's datum offset; without a co-located
// BMA gauge the offset is unknown, so those banks are skipped rather than mixed in raw.
for (const f of river.features) {
	const s = sensors[f.properties.id];
	if (s?.source === "thaiwater" && typeof s.datum_offset_m === "number" && typeof f.properties.bank_msl === "number")
		add(f.properties.id, f.properties.bank_msl - s.datum_offset_m, "tw");
}
const stations = [...acc].map(([node, a]) => ({ node, bank: a.sum / a.k, codes: a.codes, xy: xy.get(node), names: names.get(node) }));

const bank = new Array(n).fill(null);
const method = new Array(n).fill(null);
const count = { station: 0, canal: 0, idw: 0, terrain: 0, none: 0 };
const terrain = await readFile(new URL("terrain.json", dataDir), "utf8").then(JSON.parse).catch(() => null);
for (let i = 0; i < n; i++) {
	const p = xy.get(i);
	if (!p) continue;
	const own = acc.get(i);
	if (own) {
		bank[i] = +(own.sum / own.k).toFixed(2);
		method[i] = "station";
		count.station++;
		continue;
	}
	const near = stations.map((s) => ({ s, d: dist(p, s.xy) })).sort((x, y) => x.d - y.d);
	const mine = names.get(i);
	const canal = near.find((x) => x.d <= SAME_CANAL_M && [...x.s.names].some((nm) => mine.has(nm)));
	if (canal) {
		bank[i] = +canal.s.bank.toFixed(2);
		method[i] = "canal";
		count.canal++;
		continue;
	}
	const k3 = near.slice(0, 3).filter((x) => x.d <= MAX_M);
	if (k3.length) {
		const w = k3.map((x) => 1 / Math.max(x.d, 200) ** 2);
		bank[i] = +(k3.reduce((s, x, j) => s + w[j] * x.s.bank, 0) / w.reduce((a, b) => a + b, 0)).toFixed(2);
		method[i] = "idw";
		count.idw++;
		continue;
	}
	// 4. Far from any station: median corrected ground of the node's catchment (terrain.json).
	// Against surveyed banks it has ~0 bias but ~1.1 m RMSE, still better than a flat default.
	const q = terrain?.builtFrom === net.build ? terrain.q[i] : null;
	if (q) {
		bank[i] = +q[terrain.quantiles.indexOf(0.5)].toFixed(2);
		method[i] = "terrain";
		count.terrain++;
		continue;
	}
	count.none++;
}

await writeFile(
	new URL("banks.json", dataDir),
	JSON.stringify({ builtFrom: net.build, stations: stations.length, method: "station > same canal within 4 km > IDW of 3 nearest within 6 km > terrain median", bank, how: method }),
);
console.log(`banks from ${stations.length} surveyed stations: ${JSON.stringify(count)}`);

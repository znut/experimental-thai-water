// Turns data/canals.geojson into public/data/network.geojson (edges between junction nodes a/b)
// and public/data/sensors.json (live stations snapped onto those edges).
// Canals rarely share exact endpoints (most meet as a T), so we split each canal wherever
// another canal's end touches it or another canal crosses it, then merge points within TOL.
// Run: bun scripts/build-network.mjs
//   EXTRA=samutprakan  also merge data/extra/canals-<name>.geojson (comma-separated names)
//   OUT_DIR=data/staging  write outputs there instead of public/data
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const TOL = 25; // metres: max gap treated as a real connection
const CELL = 200; // metres: spatial index cell size

// Local equirectangular projection around Bangkok, accurate to well under 1% here.
const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;
const toXY = ([lon, lat]) => [(lon - LON0) * KX, (lat - LAT0) * KY];
const toLonLat = ([x, y]) => [+(x / KX + LON0).toFixed(6), +(y / KY + LAT0).toFixed(6)];

const dataDir = process.env.OUT_DIR ? new URL(`file://${resolve(process.env.OUT_DIR)}/`) : new URL("../public/data/", import.meta.url);
const canals = JSON.parse(await readFile(new URL("../data/canals.geojson", import.meta.url), "utf8"));
// Extra canal datasets beyond BMA (e.g. Samut Prakan from OSM), tagged so the two sets can be
// stitched together at their borders.
const EXTRA = (process.env.EXTRA ?? "").split(",").filter(Boolean);
for (const name of EXTRA) {
	const extra = JSON.parse(await readFile(new URL(`../data/extra/canals-${name}.geojson`, import.meta.url), "utf8"));
	for (const f of extra.features) canals.features.push({ ...f, properties: { ...f.properties, dataset: name } });
}
const STITCH = 60; // metres: across datasets, line ends this close to the other set are pulled onto it

// "10 - 14" -> 12, "8" -> 8
function parseWidth(w) {
	const nums = String(w ?? "").match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
	return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// 1. Flatten to simple lines in metres, with cumulative distance per vertex.
const lines = [];
for (const f of canals.features) {
	const g = f.geometry;
	if (!g) continue;
	const parts = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
	for (const part of parts) {
		const pts = part.map(toXY).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
		if (pts.length < 2) continue;
		const dist = [0];
		for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
		lines.push({ props: f.properties, pts, dist, cuts: [0, dist.at(-1)] });
	}
}

// 1b. Stitch datasets: move each line end onto the nearest point of a line from the OTHER
// dataset when within STITCH, so the normal TOL-based junction logic connects them.
if (EXTRA.length) {
	const idx = new Map();
	lines.forEach((l, li) => {
		for (let si = 0; si < l.pts.length - 1; si++) {
			const k = `${Math.floor(l.pts[si][0] / CELL)},${Math.floor(l.pts[si][1] / CELL)}`;
			if (!idx.has(k)) idx.set(k, []);
			idx.get(k).push([li, si]);
		}
	});
	let stitched = 0;
	for (const l of lines)
		for (const end of [0, l.pts.length - 1]) {
			const p = l.pts[end];
			const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
			let best = null;
			for (let dx = -1; dx <= 1; dx++)
				for (let dy = -1; dy <= 1; dy++)
					for (const [lj, sj] of idx.get(`${cx + dx},${cy + dy}`) ?? []) {
						const o = lines[lj];
						if ((o.props.dataset ?? "bma") === (l.props.dataset ?? "bma")) continue;
						const a = o.pts[sj], b = o.pts[sj + 1];
						const vx = b[0] - a[0], vy = b[1] - a[1];
						const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
						const q = [a[0] + t * vx, a[1] + t * vy];
						const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
						if (d <= STITCH && (!best || d < best.d)) best = { d, q };
					}
			if (best && best.d > 1) {
				l.pts[end] = best.q;
				stitched++;
			}
		}
	for (const l of lines) {
		l.dist = [0];
		for (let i = 1; i < l.pts.length; i++) l.dist.push(l.dist[i - 1] + Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]));
		l.cuts = [0, l.dist.at(-1)];
	}
	console.log(`stitched ${stitched} line ends across datasets (<= ${STITCH} m)`);
}

// 2. Spatial index of segments.
const grid = new Map();
const cellKey = (cx, cy) => `${cx},${cy}`;
lines.forEach((l, li) => {
	for (let si = 0; si < l.pts.length - 1; si++) {
		const [a, b] = [l.pts[si], l.pts[si + 1]];
		const x0 = Math.floor((Math.min(a[0], b[0]) - TOL) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + TOL) / CELL);
		const y0 = Math.floor((Math.min(a[1], b[1]) - TOL) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + TOL) / CELL);
		for (let cx = x0; cx <= x1; cx++)
			for (let cy = y0; cy <= y1; cy++) {
				const k = cellKey(cx, cy);
				if (!grid.has(k)) grid.set(k, []);
				grid.get(k).push([li, si]);
			}
	}
});
const nearbySegments = ([x, y]) => grid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))) ?? [];

function project(p, a, b) {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
	const q = [a[0] + t * dx, a[1] + t * dy];
	return { t, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

function intersect(a, b, c, d) {
	const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
	const den = r[0] * s[1] - r[1] * s[0];
	if (Math.abs(den) < 1e-9) return null;
	const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
	const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
	return t > 0 && t < 1 && u > 0 && u < 1 ? [t, u] : null;
}

// 3a. T-junctions: another line's endpoint lies on this line's interior.
lines.forEach((l, li) => {
	for (const p of [l.pts[0], l.pts.at(-1)]) {
		for (const [lj, sj] of nearbySegments(p)) {
			if (lj === li) continue;
			const o = lines[lj];
			const { t, d } = project(p, o.pts[sj], o.pts[sj + 1]);
			if (d <= TOL) o.cuts.push(o.dist[sj] + t * (o.dist[sj + 1] - o.dist[sj]));
		}
	}
});

// 3b. X-crossings between segments of different lines.
const seen = new Set();
for (const cell of grid.values()) {
	for (let i = 0; i < cell.length; i++)
		for (let j = i + 1; j < cell.length; j++) {
			const [li, si] = cell[i], [lj, sj] = cell[j];
			if (li === lj) continue;
			const k = li < lj ? `${li}:${si}:${lj}:${sj}` : `${lj}:${sj}:${li}:${si}`;
			if (seen.has(k)) continue;
			seen.add(k);
			const A = lines[li], B = lines[lj];
			const hit = intersect(A.pts[si], A.pts[si + 1], B.pts[sj], B.pts[sj + 1]);
			if (!hit) continue;
			A.cuts.push(A.dist[si] + hit[0] * (A.dist[si + 1] - A.dist[si]));
			B.cuts.push(B.dist[sj] + hit[1] * (B.dist[sj + 1] - B.dist[sj]));
		}
}

// Point at distance s along a line.
function pointAt(l, s) {
	let i = 0;
	while (i < l.dist.length - 2 && l.dist[i + 1] < s) i++;
	const seg = l.dist[i + 1] - l.dist[i] || 1;
	const t = Math.max(0, Math.min(1, (s - l.dist[i]) / seg));
	return [l.pts[i][0] + t * (l.pts[i + 1][0] - l.pts[i][0]), l.pts[i][1] + t * (l.pts[i + 1][1] - l.pts[i][1])];
}

// 4. Merge cut points within TOL into nodes (grid hashing on TOL-sized cells).
const nodes = []; // [x, y]
const nodeGrid = new Map();
function nodeFor(p) {
	const cx = Math.floor(p[0] / TOL), cy = Math.floor(p[1] / TOL);
	for (let dx = -1; dx <= 1; dx++)
		for (let dy = -1; dy <= 1; dy++)
			for (const n of nodeGrid.get(cellKey(cx + dx, cy + dy)) ?? [])
				if (Math.hypot(nodes[n][0] - p[0], nodes[n][1] - p[1]) <= TOL) return n;
	nodes.push(p);
	const k = cellKey(cx, cy);
	if (!nodeGrid.has(k)) nodeGrid.set(k, []);
	nodeGrid.get(k).push(nodes.length - 1);
	return nodes.length - 1;
}

// 5. Split each line at its cuts into edges.
const edges = [];
for (const l of lines) {
	const cuts = [...new Set(l.cuts.map((c) => Math.round(c * 10) / 10))].sort((a, b) => a - b);
	for (let i = 0; i < cuts.length - 1; i++) {
		const [s0, s1] = [cuts[i], cuts[i + 1]];
		if (s1 - s0 < 1) continue;
		const a = nodeFor(pointAt(l, s0)), b = nodeFor(pointAt(l, s1));
		if (a === b) continue;
		const inner = l.pts.filter((_, k) => l.dist[k] > s0 && l.dist[k] < s1);
		edges.push({
			a,
			b,
			len: s1 - s0,
			coords: [nodes[a], ...inner, nodes[b]],
			props: l.props,
		});
	}
}

// 6. Connected components (union-find), for a quick quality check.
const parent = nodes.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
for (const e of edges) parent[find(e.a)] = find(e.b);
const compLen = new Map();
for (const e of edges) compLen.set(find(e.a), (compLen.get(find(e.a)) ?? 0) + e.len);
const ranked = [...compLen.entries()].sort((a, b) => b[1] - a[1]);
const compRank = new Map(ranked.map(([root], i) => [root, i]));
const totalLen = ranked.reduce((s, [, v]) => s + v, 0);

const degree = new Array(nodes.length).fill(0);
for (const e of edges) degree[e.a]++, degree[e.b]++;

await mkdir(dataDir, { recursive: true });
await writeFile(
	new URL("network.geojson", dataDir),
	JSON.stringify({
		type: "FeatureCollection",
		// Node ids are only stable within one build; infra.json records which build it used.
		build: `${nodes.length}n-${edges.length}e-tol${TOL}${EXTRA.length ? `+${EXTRA.join("+")}` : ""}`,
		features: edges.map((e, i) => ({
			type: "Feature",
			geometry: { type: "LineString", coordinates: e.coords.map(toLonLat) },
			properties: {
				id: i,
				a: e.a,
				b: e.b,
				name: e.props.name,
				len_m: Math.round(e.len),
				width_m: parseWidth(e.props.width_m),
				depth_m: e.props.depth_m,
				comp: compRank.get(find(e.a)),
				...(e.props.dataset ? { dataset: e.props.dataset } : {}),
			},
		})),
	}),
);

// 7. Snap sensor stations onto edges. Station locations are static; values come live from the Worker.
const SNAP = 150; // metres: pumps and gates often sit beside the digitised canal line
const BMA = "https://weather.bangkok.go.th";
const getJson = async (path, init) => (await fetch(BMA + path, { ...init, headers: { "user-agent": "thai-water-way" } })).json();

const STATIONS = {
	flow: async () => (await getJson("/flow/PageMap/GetData?id=0")).dtStn.map((r) => [r.flow_code, r.latitude, r.longitude, r.river_name]),
	level: async () =>
		(await getJson("/Klongmap/GetDataForUpdate")).waterStation
			.map((r) => r.water_station_info)
			.filter((i) => i?.water_code)
			.map((i) => [i.water_code, i.latitude, i.longitude, i.river_name]),
	pump: async () => (await getJson("/Station/Map/GetData?id=0")).LastPump.map((r) => [r.pumpStation_code, r.latitude, r.longitude, null]),
	// HII ThaiWater telemetry (canal/river levels, incl. Samut Prakan and outer Bangkok). Stations
	// off the canal network simply don't snap. tw_id is ThaiWater's id for its history endpoint.
	thaiwater: async () => {
		// ThaiWater (HII) and BMA DDS gauges can sit on different vertical references: co-located
		// pairs differ by -0.3 to +1.3 m in both water level and bank height. Where a BMA gauge is on
		// the same canal within PAIR_M, record the offset (ThaiWater minus BMA, from live readings)
		// so ThaiWater data can be put on BMA's reference, which the model's banks use.
		const PAIR_M = 1500;
		const bma = (await getJson("/Klongmap/GetDataForUpdate")).waterStation
			.filter((r) => r.water_station_info?.latitude && typeof r.water_level_last?.wl_in === "number" && r.water_level_last.wl_in !== -99)
			.map((r) => ({ code: r.water_station_info.water_code, canal: r.water_station_info.river_name, xy: toXY([r.water_station_info.longitude, r.water_station_info.latitude]), wl: r.water_level_last.wl_in }));
		const offsetFor = (r) => {
			if (typeof num(r.waterlevel_msl) !== "number") return null;
			const p = toXY([r.station.tele_station_long, r.station.tele_station_lat]);
			const pair = bma.filter((b) => b.canal === r.river_name).map((b) => ({ b, d: Math.hypot(b.xy[0] - p[0], b.xy[1] - p[1]) })).filter((x) => x.d <= PAIR_M).sort((x, y) => x.d - y.d)[0];
			return pair ? { datum_offset_m: +(num(r.waterlevel_msl) - pair.b.wl).toFixed(2), datum_pair: pair.b.code } : null;
		};
		return (await (await fetch("https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load")).json()).waterlevel_data.data
			// Main-river gauges (แม่น้ำ…) measure the river, not the canal they happen to sit near.
			.filter((r) => r.station?.tele_station_oldcode && !/^แม่น้ำ/.test(r.river_name ?? ""))
			// BKK005 (Bang Khae) reads -6 to -2 m MSL, impossible for a canal: broken datum.
			.filter((r) => r.station.tele_station_oldcode !== "BKK005")
			.map((r) => [r.station.tele_station_oldcode, r.station.tele_station_lat, r.station.tele_station_long, r.river_name, { source: "thaiwater", tw_id: r.station.id, ...offsetFor(r) }]);
	},
};
function num(v) {
	const n = Number(v);
	return v === null || v === "" || !Number.isFinite(n) ? null : n;
}
// Loader key -> sensor kind.
const KIND = { flow: "flow", level: "level", pump: "pump", thaiwater: "level" };

const edgeGrid = new Map();
edges.forEach((e, ei) => {
	for (let si = 0; si < e.coords.length - 1; si++) {
		const [a, b] = [e.coords[si], e.coords[si + 1]];
		for (let cx = Math.floor((Math.min(a[0], b[0]) - SNAP) / CELL); cx <= Math.floor((Math.max(a[0], b[0]) + SNAP) / CELL); cx++)
			for (let cy = Math.floor((Math.min(a[1], b[1]) - SNAP) / CELL); cy <= Math.floor((Math.max(a[1], b[1]) + SNAP) / CELL); cy++) {
				const k = cellKey(cx, cy);
				if (!edgeGrid.has(k)) edgeGrid.set(k, []);
				edgeGrid.get(k).push([ei, si]);
			}
	}
});

const sensors = {};
const unmatched = [];
for (const [key, load] of Object.entries(STATIONS)) {
	const kind = KIND[key];
	let rows;
	try {
		rows = await load();
	} catch (err) {
		console.warn(`skip ${kind} stations: ${err}`);
		continue;
	}
	for (const [code, lat, lon, canal, extra] of rows) {
		if (!code || !lat || !lon || sensors[code]) continue;
		const p = toXY([lon, lat]);
		let best = null;
		for (const [ei, si] of edgeGrid.get(cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL))) ?? []) {
			const e = edges[ei];
			const { t, d } = project(p, e.coords[si], e.coords[si + 1]);
			// Prefer the canal the station says it is on, if the name matches.
			const score = d - (canal && e.props.name === canal ? 50 : 0);
			if (d <= SNAP && (!best || score < best.score)) {
				let along = 0;
				for (let k = 0; k < si; k++) along += Math.hypot(e.coords[k + 1][0] - e.coords[k][0], e.coords[k + 1][1] - e.coords[k][1]);
				along += t * Math.hypot(e.coords[si + 1][0] - e.coords[si][0], e.coords[si + 1][1] - e.coords[si][1]);
				best = { score, ei, d, along };
			}
		}
		if (!best) {
			if (key !== "thaiwater") unmatched.push(`${kind}:${code}`);
			continue;
		}
		const e = edges[best.ei];
		const frac = Math.min(1, best.along / e.len);
		sensors[code] = {
			kind,
			edge: best.ei,
			frac: +frac.toFixed(3),
			node: frac < 0.5 ? e.a : e.b, // nearest junction
			dist_m: Math.round(best.d),
			at: toLonLat(pointAt({ pts: e.coords, dist: cumulative(e.coords) }, best.along)),
			...extra,
		};
	}
}
await writeFile(new URL("sensors.json", dataDir), JSON.stringify(sensors));

function cumulative(pts) {
	const d = [0];
	for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
	return d;
}

const pct = (v) => ((100 * v) / totalLen).toFixed(1) + "%";
const byKind = Object.values(sensors).reduce((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {});
console.log(`sensors snapped: ${JSON.stringify(byKind)}; unmatched ${unmatched.length}: ${unmatched.slice(0, 12).join(" ")}`);
console.log(`lines ${lines.length} -> nodes ${nodes.length}, edges ${edges.length}`);
console.log(`components ${ranked.length}; largest holds ${pct(ranked[0][1])} of ${(totalLen / 1000).toFixed(0)} km`);
console.log(`top 5 by length: ${ranked.slice(0, 5).map(([, v]) => pct(v)).join(", ")}`);
console.log(`dead ends (degree 1): ${degree.filter((d) => d === 1).length}, junctions (>=3): ${degree.filter((d) => d >= 3).length}`);

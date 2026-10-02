// Builds public/data/terrain.json: for every canal-graph node, the land that drains to it
// (DEM pixels nearest that node within MAX_CATCH_M) summarised as elevation quantiles.
// The simulation uses these as a stage-volume curve: street water fills the lowest land first.
//
// Run: bun scripts/build-terrain.mjs [provider] [--calibrate <id>]
//   providers: scripts/terrain/providers.mjs; calibrations: scripts/terrain/calibrations.mjs
import { readFile, writeFile } from "node:fs/promises";
import { CALIBRATIONS } from "./terrain/calibrations.mjs";
import { PROVIDERS } from "./terrain/providers.mjs";

const MAX_CATCH_M = 1500; // keep in sync with src/sim/model.ts
const QUANTILES = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1];

const args = process.argv.slice(2);
const calIdx = args.indexOf("--calibrate");
const calId = calIdx >= 0 ? args.splice(calIdx, 2)[1] : null;
const id = args[0] ?? "fabdem";
const provider = PROVIDERS[id];
if (!provider) throw new Error(`unknown provider ${id}; have ${Object.keys(PROVIDERS).join(", ")}`);
const calibrations = (calId ? calId.split(",") : []).map((c) => {
	if (!CALIBRATIONS[c]) throw new Error(`unknown calibration ${c}; have ${Object.keys(CALIBRATIONS).join(", ")}`);
	return CALIBRATIONS[c];
});
// Survey points further than this from the raw DEM are treated as misplaced/on structures.
const MAX_RESIDUAL_M = 4;
const CELL_M = 100; // ground raster cell (public/data/ground.bin)

const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;
const toXY = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];

const dataDir = new URL("../public/data/", import.meta.url);
const network = JSON.parse(await readFile(new URL("network.geojson", dataDir), "utf8"));

// Node positions from edge endpoints.
const nodes = new Map();
for (const f of network.features) {
	const c = f.geometry.coordinates;
	nodes.set(f.properties.a, c[0]);
	nodes.set(f.properties.b, c.at(-1));
}
const n = Math.max(...nodes.keys()) + 1;
const nodeXY = new Float64Array(2 * n).fill(NaN);
let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
for (const [k, [lon, lat]] of nodes) {
	nodeXY.set(toXY(lon, lat), 2 * k);
	west = Math.min(west, lon), east = Math.max(east, lon), south = Math.min(south, lat), north = Math.max(north, lat);
}
const pad = MAX_CATCH_M / 100_000;
const bbox = [west - pad, south - pad, east + pad, north + pad];

const H = 1000;
const hash = new Map();
for (let k = 0; k < n; k++) {
	if (Number.isNaN(nodeXY[2 * k])) continue;
	const key = `${Math.floor(nodeXY[2 * k] / H)},${Math.floor(nodeXY[2 * k + 1] / H)}`;
	if (!hash.has(key)) hash.set(key, []);
	hash.get(key).push(k);
}
function nearestNode(x, y) {
	let best = -1, bd = MAX_CATCH_M;
	const cx = Math.floor(x / H), cy = Math.floor(y / H);
	for (let dx = -2; dx <= 2; dx++)
		for (let dy = -2; dy <= 2; dy++)
			for (const k of hash.get(`${cx + dx},${cy + dy}`) ?? []) {
				const d = Math.hypot(nodeXY[2 * k] - x, nodeXY[2 * k + 1] - y);
				if (d < bd) (bd = d), (best = k);
			}
	return best;
}

// Residual surface: Gaussian-weighted mean of (DEM - survey) residuals, blended toward the
// global mean residual where survey points are sparse (e.g. outside BMA).
const BANDWIDTH_M = 2000;
const PRIOR_WEIGHT = 0.5; // the global mean counts as this many nearby points
function residualSurface(points) {
	const mean = points.reduce((s, p) => s + p.r, 0) / points.length;
	const R = 3 * BANDWIDTH_M;
	const idx = new Map();
	for (const p of points) {
		const k = `${Math.floor(p.x / R)},${Math.floor(p.y / R)}`;
		if (!idx.has(k)) idx.set(k, []);
		idx.get(k).push(p);
	}
	return (x, y) => {
		let sw = PRIOR_WEIGHT, sr = PRIOR_WEIGHT * mean;
		const cx = Math.floor(x / R), cy = Math.floor(y / R);
		for (let dx = -1; dx <= 1; dx++)
			for (let dy = -1; dy <= 1; dy++)
				for (const p of idx.get(`${cx + dx},${cy + dy}`) ?? []) {
					const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
					if (d2 > R * R) continue;
					const w = Math.exp(-d2 / (2 * BANDWIDTH_M ** 2));
					sw += w;
					sr += w * p.r;
				}
		return sr / sw;
	};
}

function sampleGrids(grids, lon, lat) {
	for (const g of grids) {
		const i = Math.floor((lon - g.lon0) / g.dLon), j = Math.floor((lat - g.lat0) / g.dLat);
		if (i < 0 || j < 0 || i >= g.width || j >= g.height) continue;
		const z = g.data[j * g.width + i];
		return z === g.nodata || !Number.isFinite(z) ? null : z + provider.offset_m;
	}
	return null;
}

const rmse = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const meanOf = (a) => a.reduce((s, v) => s + v, 0) / a.length;

console.log(`${provider.label}: loading bbox ${bbox.map((v) => v.toFixed(3)).join(", ")}`);
const grids = await provider.load(bbox);
const pixelM2 = Math.abs(grids[0].dLon * KX * grids[0].dLat * KY);

let correction = null;
let calibrationReport = null;
if (calibrations.length) {
	const survey = [];
	for (const cal of calibrations) {
		const pts = (await cal.load(bbox))
			.map((p) => ({ ...p, dem: sampleGrids(grids, p.lon, p.lat) }))
			.filter((p) => p.dem !== null);
		const kept = pts.filter((p) => Math.abs(p.dem - p.z) <= MAX_RESIDUAL_M);
		if (kept.length < pts.length) console.log(`${cal.id}: dropped ${pts.length - kept.length} of ${pts.length} points more than ${MAX_RESIDUAL_M} m from the DEM`);
		// Hold out every 5th point of each source.
		kept.forEach((p, i) => {
			const [x, y] = toXY(p.lon, p.lat);
			survey.push({ x, y, r: p.dem - p.z, src: cal.id, test: i % 5 === 0 });
		});
	}
	const stats = (pts, fit) => {
		const before = pts.map((p) => p.r), after = pts.map((p) => p.r - (fit ? fit(p.x, p.y) : 0));
		return {
			holdout: pts.length,
			bias_before_m: +meanOf(before).toFixed(3),
			rmse_before_m: +rmse(before).toFixed(3),
			bias_after_m: +meanOf(after).toFixed(3),
			rmse_after_m: +rmse(after).toFixed(3),
		};
	};
	const fitted = residualSurface(survey.filter((p) => !p.test));
	const bySource = {};
	for (const cal of calibrations) {
		const test = survey.filter((p) => p.test && p.src === cal.id);
		bySource[cal.id] = stats(test, fitted);
		// With several sources, also score each source using a fit on its own points only.
		if (calibrations.length > 1) {
			const own = residualSurface(survey.filter((p) => !p.test && p.src === cal.id));
			bySource[cal.id].rmse_after_own_only_m = +rmse(test.map((p) => p.r - own(p.x, p.y))).toFixed(3);
		}
	}
	calibrationReport = {
		ids: calibrations.map((c) => c.id),
		labels: calibrations.map((c) => c.label),
		licenses: calibrations.map((c) => `${c.id}: ${c.license}`),
		points: survey.length,
		...stats(survey.filter((p) => p.test), fitted),
		by_source: bySource,
	};
	const c = calibrationReport;
	console.log(`calibration ${c.ids.join("+")}: ${c.points} points; on ${c.holdout} held out: bias ${c.bias_before_m} -> ${c.bias_after_m} m, RMSE ${c.rmse_before_m} -> ${c.rmse_after_m} m`);
	for (const [id, b] of Object.entries(bySource))
		console.log(`  ${id}: ${b.holdout} held out: RMSE ${b.rmse_before_m} -> ${b.rmse_after_m} m${b.rmse_after_own_only_m !== undefined ? ` (own-source fit: ${b.rmse_after_own_only_m})` : ""}, bias -> ${b.bias_after_m}`);
	correction = residualSurface(survey);
}

// Evaluate the correction on a 250 m grid rather than per 30 m pixel.
const CORR_CELL = 250;
const corrCache = new Map();
function corrAt(x, y) {
	if (!correction) return 0;
	const cx = Math.floor(x / CORR_CELL), cy = Math.floor(y / CORR_CELL);
	const k = `${cx},${cy}`;
	let v = corrCache.get(k);
	if (v === undefined) corrCache.set(k, (v = correction((cx + 0.5) * CORR_CELL, (cy + 0.5) * CORR_CELL)));
	return v;
}

const buckets = Array.from({ length: n }, () => []);
let used = 0;

// Ground raster: up to SLOTS corrected pixel values per 100 m cell; median taken below.
const [bw, bs, be, bn] = bbox;
const gDLon = CELL_M / KX, gDLat = -CELL_M / KY;
const gW = Math.ceil((be - bw) / gDLon), gH = Math.ceil((bs - bn) / gDLat);
const SLOTS = 16;
const cellVals = new Float32Array(gW * gH * SLOTS);
const cellN = new Uint8Array(gW * gH);
for (const grid of grids)
	for (let j = 0; j < grid.height; j++) {
		const lat = grid.lat0 + (j + 0.5) * grid.dLat;
		for (let i = 0; i < grid.width; i++) {
			const z = grid.data[j * grid.width + i];
			if (z === grid.nodata || !Number.isFinite(z) || z < -50) continue;
			const [x, y] = toXY(grid.lon0 + (i + 0.5) * grid.dLon, lat);
			const k = nearestNode(x, y);
			if (k < 0) continue;
			const zc = z + provider.offset_m - corrAt(x, y);
			buckets[k].push(zc);
			used++;
			const gi = Math.floor((grid.lon0 + (i + 0.5) * grid.dLon - bw) / gDLon), gj = Math.floor((lat - bn) / gDLat);
			if (gi >= 0 && gj >= 0 && gi < gW && gj < gH) {
				const c = gj * gW + gi;
				if (cellN[c] < SLOTS) cellVals[c * SLOTS + cellN[c]++] = zc;
			}
		}
	}

const q = buckets.map((b) => {
	if (!b.length) return null;
	b.sort((a, c) => a - c);
	return QUANTILES.map((p) => +b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))].toFixed(2));
});
const catch_m2 = buckets.map((b) => Math.round(b.length * pixelM2));

await writeFile(
	new URL("terrain.json", dataDir),
	JSON.stringify({
		source: provider.id,
		label: provider.label + (calibrations.length ? ` + ${calibrations.map((c) => c.id).join("+")} correction` : ""),
		license: provider.license,
		attribution: provider.attribution,
		kind: provider.kind,
		datum: calibrations.length ? "MSL (survey-corrected)" : provider.datum,
		resolution_m: provider.resolution_m,
		calibration: calibrationReport,
		builtFrom: network.build,
		quantiles: QUANTILES,
		catch_m2,
		q,
	}),
);

// Ground raster files (see GroundMeta in shared/types.ts).
const groundCm = new Int16Array(gW * gH).fill(-32768);
const groundNode = new Uint16Array(gW * gH).fill(65535);
const tmp = new Float32Array(SLOTS);
for (let gj = 0; gj < gH; gj++)
	for (let gi = 0; gi < gW; gi++) {
		const c = gj * gW + gi;
		const cnt = cellN[c];
		if (cnt) {
			for (let k = 0; k < cnt; k++) tmp[k] = cellVals[c * SLOTS + k];
			const v = tmp.subarray(0, cnt).sort();
			const med = cnt % 2 ? v[cnt >> 1] : (v[cnt / 2 - 1] + v[cnt / 2]) / 2;
			groundCm[c] = Math.max(-32767, Math.min(32767, Math.round(med * 100)));
		}
		const k = nearestNode(...toXY(bw + (gi + 0.5) * gDLon, bn + (gj + 0.5) * gDLat));
		if (k >= 0 && k < 65535) groundNode[c] = k;
	}
const groundMeta = {
	lon0: bw,
	lat0: bn,
	dLon: gDLon,
	dLat: gDLat,
	width: gW,
	height: gH,
	cell_m: CELL_M,
	builtFrom: network.build,
	source: provider.label + (calibrations.length ? ` + ${calibrations.map((c) => c.id).join("+")} correction` : ""),
};
await writeFile(new URL("ground.json", dataDir), JSON.stringify(groundMeta));
const bin = new Uint8Array(gW * gH * 4);
bin.set(new Uint8Array(groundCm.buffer), 0);
bin.set(new Uint8Array(groundNode.buffer), gW * gH * 2);
await writeFile(new URL("ground.bin", dataDir), bin);
console.log(`ground raster ${gW}x${gH} @ ${CELL_M} m: ${(bin.length / 1e6).toFixed(2)} MB, cells with data ${groundCm.filter((v) => v !== -32768).length}`);

// Sanity check: overall distribution, and DEM vs surveyed canal bank heights.
const medians = q.filter(Boolean).map((v) => v[QUANTILES.indexOf(0.5)]).sort((a, b) => a - b);
const pct = (p) => medians[Math.floor(p * (medians.length - 1))];
console.log(`pixels used ${used} (${((used * pixelM2) / 1e6).toFixed(0)} km²); nodes with terrain ${medians.length}/${nodes.size}`);
console.log(`node median ground m: p5 ${pct(0.05)} p25 ${pct(0.25)} p50 ${pct(0.5)} p75 ${pct(0.75)} p95 ${pct(0.95)}`);

try {
	const level = await (await fetch("http://localhost:5199/live/level.json")).json();
	const diffs = [];
	for (const f of level.features) {
		const bank = f.properties.bank_m;
		if (typeof bank !== "number" || bank < 0.5 || bank > 4) continue;
		const k = nearestNode(...toXY(...f.geometry.coordinates));
		if (k >= 0 && q[k]) diffs.push(q[k][QUANTILES.indexOf(0.5)] - bank);
	}
	diffs.sort((a, b) => a - b);
	const d = (p) => diffs[Math.floor(p * (diffs.length - 1))].toFixed(2);
	console.log(`DEM median ground minus surveyed bank at ${diffs.length} level stations: p10 ${d(0.1)} p50 ${d(0.5)} p90 ${d(0.9)} m`);
} catch {
	console.log("(dev server not running: skipped bank comparison)");
}

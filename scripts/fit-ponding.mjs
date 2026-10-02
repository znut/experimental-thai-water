// Fits the street-ponding model (src/sim/ponding.ts) per BMA road flood sensor on one recorded
// event and validates it on other events, against the physical model's street flooding and a
// naive "rain > 60 mm/h" rule. Writes public/data/ponding.json.
// Run: bun scripts/fit-ponding.mjs [fitScenarioId] [validationScenarioId ...]
//   (dev server on :5199 supplies surveyed bank levels; without it default banks are used)
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DEFAULT_PARAMS, buildModel, run } from "../src/sim/model.ts";
import { rainAt, runPonding } from "../src/sim/ponding.ts";

const FIT_ID = process.argv[2] ?? "rainbomb-2026-09";
const VAL_IDS = process.argv.length > 3 ? process.argv.slice(3) : ["storm-2025-05", "storm-2025-11"];
const WET_CM = 10; // "flooded" threshold for hit/false-alarm scoring
const NAIVE_MM_H = 60; // BMA's design drain capacity, used as the naive rule
const SHRINK_N0 = 8; // wet steps at which a sensor's own fit and the group get equal weight

const data = new URL("../public/data/", import.meta.url);
const J = (f) => JSON.parse(readFileSync(new URL(f, data), "utf8"));
const network = J("network.geojson");
const infra = J("infra.json");
const terrain = J("terrain.json");
const nodeBanks = J("banks.json").bank;
const gm = J("ground.json");
const gb = readFileSync(new URL("ground.bin", data));
const cells = gm.width * gm.height;
const gz = new Int16Array(gb.buffer, gb.byteOffset, cells);
const gn = new Uint16Array(gb.buffer, gb.byteOffset + cells * 2, cells);
const cellOf = (lon, lat) => {
	const i = Math.floor((lon - gm.lon0) / gm.dLon), j = Math.floor((lat - gm.lat0) / gm.dLat);
	return i < 0 || j < 0 || i >= gm.width || j >= gm.height ? -1 : j * gm.width + i;
};
const edges = network.features.map((f) => ({ ...f.properties, coords: f.geometry.coordinates }));

// Nearest graph node for spots whose ground cell drains to no node.
const nodePos = new Map();
for (const e of edges) nodePos.set(e.a, e.coords[0]), nodePos.set(e.b, e.coords.at(-1));
function nodeOf(lon, lat) {
	const c = cellOf(lon, lat);
	if (c >= 0 && gn[c] !== 65535) return gn[c];
	let best = -1, bd = Infinity;
	for (const [k, [x, y]] of nodePos) {
		const d = (x - lon) ** 2 + (y - lat) ** 2;
		if (d < bd) (bd = d), (best = k);
	}
	return best;
}

let banks = [];
try {
	const level = await (await fetch("http://localhost:5199/live/level.json")).json();
	banks = level.features
		.filter((f) => typeof f.properties.bank_m === "number")
		.map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bank: f.properties.bank_m }));
} catch {
	console.warn("dev server not reachable: physical model uses default bank levels");
}
const model = buildModel(edges, infra, banks, DEFAULT_PARAMS, terrain, nodeBanks);

function load(id) {
	const p = new URL(`scenarios/${id}.json`, data);
	if (!existsSync(p)) return null;
	const sc = JSON.parse(readFileSync(p, "utf8"));
	const t0 = performance.now();
	const frames = run(model, sc, DEFAULT_PARAMS);
	console.log(`${id}: physical model ${Math.round(performance.now() - t0)} ms, ${sc.observed.flood.length} sensors`);
	return { sc, frames };
}

// ---- Fit ------------------------------------------------------------------------------------
const C_GRID = Array.from({ length: 31 }, (_, i) => i * 5);
const K_GRID = [0.005, 0.01, 0.02, 0.035, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 3, 4];
const A_MAX = 5;

function bestA(F, obs) {
	let num = 0, den = 0;
	for (let t = 0; t < obs.length; t++) (num += obs[t] * F[t]), (den += F[t] * F[t]);
	return den > 0 ? Math.min(A_MAX, Math.max(0, num / den)) : 0;
}
function rmse(a, F, obs) {
	let s = 0;
	for (let t = 0; t < obs.length; t++) s += (a * F[t] - obs[t]) ** 2;
	return Math.sqrt(s / obs.length);
}
function fitOne(obs, rain, stepH, canal, bank) {
	let best = { loss: Infinity };
	const tryCK = (c, k) => {
		const F = runPonding({ a: 1, c, k }, rain, stepH, canal, bank);
		const a = bestA(F, obs);
		const loss = rmse(a, F, obs);
		if (loss < best.loss) best = { a, c, k, loss };
	};
	for (const c of C_GRID) for (const k of K_GRID) tryCK(c, k);
	const { c: c0, k: k0 } = best;
	for (let c = Math.max(0, c0 - 4); c <= c0 + 4; c++) for (const f of [0.8, 0.9, 1, 1.1, 1.25]) tryCK(c, k0 * f);
	return best;
}

const fit = load(FIT_ID);
if (!fit) throw new Error(`missing scenario ${FIT_ID}`);
const stepH = fit.sc.step_min / 60;
const canalAt = (frames, node) => (node >= 0 ? Float32Array.from(frames, (f) => f.level[node]) : undefined);

const fitted = [];
for (const s of fit.sc.observed.flood) {
	const obs = s.depth_cm.map((v) => v ?? 0);
	const node = nodeOf(s.lon, s.lat);
	const wet = obs.filter((v) => v >= 5).length;
	const peak = Math.max(...obs);
	const rain = rainAt(fit.sc, s.lon, s.lat);
	const canal = canalAt(fit.frames, node);
	const bank = node >= 0 ? model.bank[node] : undefined;
	const base = { code: s.code, lon: s.lon, lat: s.lat, node, obs, rain, canal, bank, wet, peak };
	if (peak < 5) fitted.push({ ...base, kind: "dry" });
	else fitted.push({ ...base, kind: peak >= WET_CM && wet >= 4 ? "fitted" : "weak", ...fitOne(obs, rain, stepH, canal, bank) });
}

const median = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length ? s[s.length >> 1] : NaN;
};
const strong = fitted.filter((f) => f.kind === "fitted" && f.a > 0);
const group = {
	a: +Math.exp(median(strong.map((f) => Math.log(f.a)))).toFixed(4),
	c: median(strong.map((f) => f.c)),
	k: +Math.exp(median(strong.map((f) => Math.log(f.k)))).toFixed(4),
};

// Partial pooling toward the group: weight on a sensor's own (c, k) grows with its wet steps;
// a is then refitted for the pooled (c, k) so the depth scale still matches that sensor.
const params = {};
for (const f of fitted) {
	let p;
	if (f.kind === "dry") p = { a: 0, c: group.c, k: group.k, fit: "dry" };
	else {
		const w = f.wet / (f.wet + SHRINK_N0);
		const c = Math.round(w * f.c + (1 - w) * group.c);
		const k = Math.exp(w * Math.log(f.k) + (1 - w) * Math.log(group.k));
		const a = bestA(runPonding({ a: 1, c, k }, f.rain, stepH, f.canal, f.bank), f.obs);
		p = { a, c, k, fit: f.kind === "fitted" ? "fitted" : "shrunk" };
	}
	params[f.code] = { a: +p.a.toFixed(4), c: p.c, k: +p.k.toFixed(4), lon: f.lon, lat: f.lat, node: f.node, fit: p.fit };
}

// ---- Evaluate -------------------------------------------------------------------------------
function physicalDepth(frames, lon, lat) {
	const c = cellOf(lon, lat);
	return frames.map((f) => {
		if (c < 0 || gn[c] === 65535 || gz[c] === -32768) return 0;
		const s = f.surface_m?.[gn[c]];
		return s === undefined || Number.isNaN(s) ? 0 : Math.max(0, s * 100 - gz[c]);
	});
}
const pearson = (x, y) => {
	const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
	let sxy = 0, sxx = 0, syy = 0;
	for (let i = 0; i < n; i++) (sxy += (x[i] - mx) * (y[i] - my)), (sxx += (x[i] - mx) ** 2), (syy += (y[i] - my) ** 2);
	return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
};
const argmax = (a) => a.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);

function score(sc, predict) {
	let tp = 0, fn = 0, fp = 0, tn = 0;
	const peakErr = [], lag = [], corr = [];
	const h = sc.step_min / 60;
	for (const s of sc.observed.flood) {
		const obs = s.depth_cm.map((v) => v ?? 0);
		const pred = predict(s);
		if (!pred) continue;
		const oWet = Math.max(...obs) >= WET_CM, pWet = Math.max(...pred) >= WET_CM;
		if (oWet && pWet) tp++;
		else if (oWet) fn++;
		else if (pWet) fp++;
		else tn++;
		if (oWet && typeof pred[0] === "number" && pred.depth !== false) {
			peakErr.push(Math.abs(Math.max(...pred) - Math.max(...obs)));
			corr.push(pearson(Array.from(pred), obs));
			if (pWet) lag.push(Math.abs(argmax(pred) - argmax(obs)) * h);
		}
	}
	const r = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);
	return {
		sensors: tp + fn + fp + tn,
		observed_wet: tp + fn,
		hit_rate: r(tp / Math.max(1, tp + fn)),
		false_alarm_ratio: r(fp / Math.max(1, tp + fp)),
		median_peak_err_cm: r(median(peakErr)),
		median_timing_err_h: r(median(lag)),
		median_corr: r(median(corr.filter(Number.isFinite))),
	};
}

function evaluate({ sc, frames }) {
	const bankOf = (node) => (node >= 0 ? model.bank[node] : undefined);
	const ponding = score(sc, (s) => {
		const p = params[s.code] ?? { ...group, node: nodeOf(s.lon, s.lat) };
		const node = p.node ?? nodeOf(s.lon, s.lat);
		return runPonding(p, rainAt(sc, s.lon, s.lat), sc.step_min / 60, canalAt(frames, node), bankOf(node));
	});
	const physical = score(sc, (s) => physicalDepth(frames, s.lon, s.lat));
	// Naive rule: wet while the last hour of rain at the spot is at least the design capacity.
	const perHour = Math.round(60 / sc.step_min);
	const naive = score(sc, (s) => {
		const r = rainAt(sc, s.lon, s.lat);
		const out = Array.from(r, (_, t) => {
			let mm = 0;
			for (let j = Math.max(0, t - perHour + 1); j <= t; j++) mm += (r[j] * sc.step_min) / 60;
			return mm >= NAIVE_MM_H ? WET_CM : 0;
		});
		out.depth = false;
		return out;
	});
	for (const k of ["median_peak_err_cm", "median_timing_err_h", "median_corr"]) naive[k] = null;
	return { ponding, physical, naive };
}

const metrics = { [FIT_ID + " (in-sample)"]: evaluate(fit) };
for (const id of VAL_IDS) {
	const v = load(id);
	if (v) metrics[id] = evaluate(v);
	else console.warn(`validation scenario ${id} not found; skipped`);
}

const counts = Object.values(params).reduce((m, p) => ((m[p.fit] = (m[p.fit] ?? 0) + 1), m), {});
const cs = strong.map((f) => f.c).sort((a, b) => a - b);
const summary = {
	sensors: fitted.length,
	by_fit: counts,
	c_mm_h: { p25: cs[Math.floor(cs.length * 0.25)], median: median(cs), p75: cs[Math.floor(cs.length * 0.75)] },
	k_per_h_median: +median(strong.map((f) => f.k)).toFixed(3),
	a_median: +median(strong.map((f) => f.a)).toFixed(3),
};

await writeFile(
	new URL("ponding.json", data),
	JSON.stringify({ builtFrom: network.build, fittedOn: FIT_ID, params, group, metrics: { summary, ...metrics } }),
);
console.log(JSON.stringify({ group, summary }, null, 1));
for (const [id, m] of Object.entries(metrics)) {
	console.log(`\n${id}`);
	console.table(m);
}

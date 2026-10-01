// Street-ponding hotspots from Traffy Fondue citizen flood reports, used as weak labels.
//
// Road sensors (ponding.json) measure depth at ~250 spots; citizens report flooding at thousands
// more. We cluster the rain-bomb reports into hotspots and fit each one's ponding parameters so
// the modelled water crosses WET_CM around when people started reporting and stays up while
// reports keep coming. Reports carry no depth, so the depth scale `a` is fixed to the road-sensor
// group value. Reports keep arriving for days (BMA ticket backlog), so they say little about how
// fast water recedes: fitting `k` drove it to the grid floor (water never drains) and produced
// mostly false alarms on other storms. So `k` is also fixed to the road-sensor group value
// (FIT_K=1 re-enables fitting it) and each hotspot fits only its drain capacity `c`, which the
// onset of reports relative to rain intensity does constrain.
//
// Loss per hotspot (hours):
//   onset:   |first crossing of WET_CM − (first report − REPORT_LAG_H)|, or MISS_H if never wet
//   + DUR_W × hours of the label window [onset, end] that stay dry
//   + OUT_W × hours wet outside [onset − EARLY_H, end + LATE_H]
//   + shrinkage toward the group: SHRINK × (Δc/10)² + SHRINK × (Δln k)², divided by sqrt(reports)
// where end = max(last report, first report + median hours-to-close), capped at MAX_WET_H.
//
// Validation: other storms (their Traffy reports are fetched into observed.reports, location and
// time only). A hotspot is "observed wet" when ≥ MIN_VAL_REPORTS reports fall within its radius.
//
// Run: bun scripts/fit-hotspots.mjs   (dev server on :5199 supplies surveyed banks if running)
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DEFAULT_PARAMS, buildModel, run } from "../src/sim/model.ts";
import { rainAt, runPonding } from "../src/sim/ponding.ts";
import { cachedJson } from "./lib/data.mjs";

const FIT_ID = "rainbomb-2026-09";
const VAL_IDS = ["storm-2025-05", "storm-2025-11"];
const CELL_M = 200; // hotspot grid
const MIN_REPORTS = Number(process.env.MIN_REPORTS ?? 6); // reports a cell needs to be a hotspot
const NEAR_SENSOR_M = 150;
const WET_CM = 10;
const REPORT_LAG_H = 1; // people report a little after water appears
const MISS_H = 48;
const DUR_W = 0.25;
const OUT_W = 0.1;
const EARLY_H = 6;
const LATE_H = 12;
const MAX_WET_H = 72;
const SHRINK = 2;
const MIN_VAL_REPORTS = Number(process.env.MIN_VAL_REPORTS ?? 2);
const NAIVE_MM_H = 60;

const data = new URL("../public/data/", import.meta.url);
const J = (f) => JSON.parse(readFileSync(new URL(f, data), "utf8"));
const network = J("network.geojson");
const pond = J("ponding.json");
const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;
const xy = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
const bkkMs = (s) => Date.parse(String(s).replace(" ", "T") + "+07:00");
const median = (a) => {
	const b = [...a].sort((x, y) => x - y);
	return b.length ? b[b.length >> 1] : null;
};
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// ---- Traffy reports for validation storms (location + time + hours open only) ----------------
async function traffy(sc) {
	const t0 = Date.parse(sc.start), days = Math.ceil((sc.steps * sc.step_min) / 1440);
	const byTicket = new Map();
	for (let d = 0; d <= days; d++) {
		const day = new Date(t0 + d * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
		for (let offset = 0; ; offset += 1000) {
			const j = await cachedJson(`https://publicapi.traffy.in.th/teamchadchart-stat-api/geojson/v1?limit=1000&start=${day}&end=${day}&offset=${offset}`);
			for (const f of j.features ?? []) {
				const p = f.properties;
				if (!p.problem_type_fondue?.includes("น้ำท่วม") || !f.geometry?.coordinates) continue;
				const [lon, lat] = f.geometry.coordinates;
				byTicket.set(p.ticket_id, { lon: round(lon, 5), lat: round(lat, 5), time: p.timestamp, hours_open: p.duration_minutes_finished == null ? null : round(p.duration_minutes_finished / 60, 1) });
			}
			if ((j.features?.length ?? 0) < 1000) break;
		}
	}
	return [...byTicket.values()];
}

for (const id of VAL_IDS) {
	const path = new URL(`scenarios/${id}.json`, data);
	if (!existsSync(path)) continue;
	const sc = JSON.parse(readFileSync(path, "utf8"));
	if (sc.observed?.reports?.length) continue;
	sc.observed.reports = await traffy(sc);
	const note = "publicapi.traffy.in.th teamchadchart-stat-api — Traffy Fondue citizen reports tagged น้ำท่วม (flood); location, report time, hours until closed. Credit: Traffy Fondue / BMA";
	if (!sc.sources.includes(note)) sc.sources.push(note);
	await writeFile(path, JSON.stringify(sc));
	console.log(`${id}: fetched ${sc.observed.reports.length} Traffy flood reports`);
}

// ---- Physical model (canal levels slow street drainage) --------------------------------------
const edges = network.features.map((f) => ({ ...f.properties, coords: f.geometry.coordinates }));
let banks = [];
try {
	const level = await (await fetch("http://localhost:5199/api/layers/level")).json();
	banks = level.features.filter((f) => typeof f.properties.bank_m === "number").map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bank: f.properties.bank_m }));
} catch {
	console.warn("dev server not reachable: default banks for stations without banks.json");
}
const boundary = existsSync(new URL("boundary.json", data)) ? J("boundary.json") : null;
const model = buildModel(edges, J("infra.json"), banks, DEFAULT_PARAMS, J("terrain.json"), J("banks.json").bank, boundary?.builtFrom === network.build ? boundary.nodes : null);

const gm = J("ground.json");
const gb = readFileSync(new URL("ground.bin", data));
const cells = gm.width * gm.height;
const gn = new Uint16Array(gb.buffer, gb.byteOffset + cells * 2, cells);
const nodePos = new Map();
for (const e of edges) nodePos.set(e.a, e.coords[0]), nodePos.set(e.b, e.coords.at(-1));
function nodeOf(lon, lat) {
	const i = Math.floor((lon - gm.lon0) / gm.dLon), j = Math.floor((lat - gm.lat0) / gm.dLat);
	if (i >= 0 && j >= 0 && i < gm.width && j < gm.height && gn[j * gm.width + i] !== 65535) return gn[j * gm.width + i];
	let best = -1, bd = Infinity;
	for (const [k, [x, y]] of nodePos) {
		const d = (x - lon) ** 2 + (y - lat) ** 2;
		if (d < bd) (bd = d), (best = k);
	}
	return best;
}

function load(id) {
	const sc = J(`scenarios/${id}.json`);
	const t0 = performance.now();
	const frames = run(model, sc, DEFAULT_PARAMS);
	console.log(`${id}: physical model ${Math.round(performance.now() - t0)} ms, ${sc.observed.reports?.length ?? 0} reports`);
	return { sc, frames };
}

// ---- Hotspots from the rain-bomb reports ----------------------------------------------------
const fit = load(FIT_ID);
const stepH = fit.sc.step_min / 60;
const startMs = Date.parse(fit.sc.start);
const grid = new Map();
for (const r of fit.sc.observed.reports) {
	const [x, y] = xy(r.lon, r.lat);
	const k = `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;
	if (!grid.has(k)) grid.set(k, []);
	grid.get(k).push(r);
}
const sensorXY = Object.values(pond.params).map((s) => xy(s.lon, s.lat));
const hotspots = [...grid.values()]
	.filter((rs) => rs.length >= MIN_REPORTS)
	.map((rs, i) => {
		const lon = rs.reduce((s, r) => s + r.lon, 0) / rs.length, lat = rs.reduce((s, r) => s + r.lat, 0) / rs.length;
		const times = rs.map((r) => bkkMs(r.time)).filter(Number.isFinite).sort((a, b) => a - b);
		const p = xy(lon, lat);
		return {
			id: `H${String(i + 1).padStart(3, "0")}`,
			lon: round(lon, 5),
			lat: round(lat, 5),
			node: nodeOf(lon, lat),
			reports: rs.length,
			first_h: (times[0] - startMs) / 3600_000,
			last_h: (times.at(-1) - startMs) / 3600_000,
			median_hours_open: median(rs.map((r) => r.hours_open).filter((v) => v !== null)),
			near_sensor: sensorXY.some(([sx, sy]) => Math.hypot(sx - p[0], sy - p[1]) <= NEAR_SENSOR_M),
		};
	});
const covered = hotspots.reduce((s, h) => s + h.reports, 0);
console.log(`hotspots: ${hotspots.length} cells of ${CELL_M} m with ≥${MIN_REPORTS} reports, covering ${covered} of ${fit.sc.observed.reports.length} reports; ${hotspots.filter((h) => h.near_sensor).length} near a road sensor`);

// ---- Fit ------------------------------------------------------------------------------------
const A = pond.group.a;
const C_GRID = Array.from({ length: 31 }, (_, i) => i * 5);
const K_GRID = process.env.FIT_K ? [0.005, 0.01, 0.02, 0.035, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5, 0.7, 1] : [pond.group.k];

const series = (frames, node) => Float32Array.from(frames, (f) => f.level[node]);
const firstWet = (d) => {
	for (let t = 0; t < d.length; t++) if (d[t] >= WET_CM) return t;
	return -1;
};

function lossFor(h, depth) {
	const onsetStep = (h.first_h - REPORT_LAG_H) / stepH;
	const endH = Math.min(h.first_h + MAX_WET_H, Math.max(h.last_h, h.first_h + (h.median_hours_open ?? 0)));
	const t1 = firstWet(depth);
	let loss = t1 < 0 ? MISS_H : Math.abs(t1 - onsetStep) * stepH;
	const lo = Math.max(0, Math.floor(h.first_h / stepH)), hi = Math.min(depth.length - 1, Math.ceil(endH / stepH));
	for (let t = lo; t <= hi; t++) if (depth[t] < WET_CM) loss += DUR_W * stepH;
	const outLo = (h.first_h - EARLY_H) / stepH, outHi = (endH + LATE_H) / stepH;
	for (let t = 0; t < depth.length; t++) if (depth[t] >= WET_CM && (t < outLo || t > outHi)) loss += OUT_W * stepH;
	return loss;
}

// Precompute per hotspot inputs and every grid candidate's loss.
const inputs = hotspots.map((h) => ({ rain: rainAt(fit.sc, h.lon, h.lat), canal: series(fit.frames, h.node), bank: model.bank[h.node] }));
const losses = hotspots.map((h, i) => {
	const L = [];
	for (const c of C_GRID) for (const k of K_GRID) L.push(lossFor(h, runPonding({ a: A, c, k }, inputs[i].rain, stepH, inputs[i].canal, inputs[i].bank)));
	return L;
});
const idx = (ci, ki) => ci * K_GRID.length + ki;
let gBest = { loss: Infinity, ci: 0, ki: 0 };
for (let ci = 0; ci < C_GRID.length; ci++)
	for (let ki = 0; ki < K_GRID.length; ki++) {
		const s = losses.reduce((acc, L) => acc + L[idx(ci, ki)], 0);
		if (s < gBest.loss) gBest = { loss: s, ci, ki };
	}
const group = { a: A, c: C_GRID[gBest.ci], k: K_GRID[gBest.ki] };

const params = {};
hotspots.forEach((h, i) => {
	let best = { loss: Infinity, c: group.c, k: group.k };
	for (let ci = 0; ci < C_GRID.length; ci++)
		for (let ki = 0; ki < K_GRID.length; ki++) {
			const pen = (SHRINK * (((C_GRID[ci] - group.c) / 10) ** 2 + Math.log(K_GRID[ki] / group.k) ** 2)) / Math.sqrt(h.reports);
			const l = losses[i][idx(ci, ki)] + pen;
			if (l < best.loss) best = { loss: l, c: C_GRID[ci], k: K_GRID[ki] };
		}
	const own = best.c !== group.c || best.k !== group.k;
	params[h.id] = { a: A, c: best.c, k: best.k, lon: h.lon, lat: h.lat, node: h.node, fit: own ? "fitted" : "shrunk", reports: h.reports, median_hours_open: h.median_hours_open, near_sensor: h.near_sensor };
});

// ---- Scoring --------------------------------------------------------------------------------
const RADIUS_M = CELL_M * 0.75;
function score(id, sc, frames, paramsOf) {
	const sh = sc.step_min / 60, t0 = Date.parse(sc.start);
	const reps = (sc.observed.reports ?? []).map((r) => ({ p: xy(r.lon, r.lat), h: (bkkMs(r.time) - t0) / 3600_000 })).filter((r) => r.h >= 0 && r.h <= sc.steps * sh);
	let tp = 0, fn = 0, fp = 0, tn = 0, ntp = 0, nfn = 0, nfp = 0, ntn = 0;
	const onset = [];
	for (const h of hotspots) {
		const p = xy(h.lon, h.lat);
		const near = reps.filter((r) => Math.hypot(r.p[0] - p[0], r.p[1] - p[1]) <= RADIUS_M).map((r) => r.h).sort((a, b) => a - b);
		const obs = near.length >= MIN_VAL_REPORTS;
		const rain = rainAt(sc, h.lon, h.lat);
		const depth = runPonding(paramsOf(h), rain, sh, series(frames, h.node), model.bank[h.node]);
		const t1 = firstWet(depth), wet = t1 >= 0;
		if (obs && wet) tp++, onset.push(t1 * sh - near[0]);
		else if (obs) fn++;
		else if (wet) fp++;
		else tn++;
		const naive = Math.max(...rain) >= NAIVE_MM_H;
		if (obs && naive) ntp++;
		else if (obs) nfn++;
		else if (naive) nfp++;
		else ntn++;
	}
	const rate = (a, b) => (a + b ? round(a / (a + b)) : null);
	return {
		observed_wet: tp + fn,
		hit_rate: rate(tp, fn),
		false_alarm_ratio: rate(fp, tp),
		median_onset_err_h: onset.length ? round(median(onset), 1) : null,
		naive_hit_rate: rate(ntp, nfn),
		naive_false_alarm_ratio: rate(nfp, ntp),
		_counts: { tp, fn, fp, tn },
	};
}

// Report clusters in a storm that a road sensor (ponding.json) already covers.
function sensorCoverage(sc) {
	const g = new Map();
	for (const r of sc.observed.reports ?? []) {
		const [x, y] = xy(r.lon, r.lat);
		const k = `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;
		g.set(k, (g.get(k) ?? 0) + 1);
	}
	const busy = [...g].filter(([, n]) => n >= MIN_VAL_REPORTS);
	const near = busy.filter(([k]) => {
		const [cx, cy] = k.split(",").map(Number);
		const p = [(cx + 0.5) * CELL_M, (cy + 0.5) * CELL_M];
		return sensorXY.some(([sx, sy]) => Math.hypot(sx - p[0], sy - p[1]) <= 300);
	});
	return { report_clusters: busy.length, with_road_sensor_within_300m: near.length };
}

const metrics = { config: { CELL_M, MIN_REPORTS, MIN_VAL_REPORTS, WET_CM, REPORT_LAG_H, a_fixed: A }, hotspots: hotspots.length, fit: {}, group, events: {} };
metrics.fit = Object.values(params).reduce((m, p) => ((m[p.fit] = (m[p.fit] ?? 0) + 1), m), {});
const perHotspot = (h) => params[h.id];
const groupOnly = () => group;
const events = [[FIT_ID, fit], ...VAL_IDS.filter((id) => existsSync(new URL(`scenarios/${id}.json`, data))).map((id) => [id, load(id)])];
for (const [id, ev] of events) {
	metrics.events[id] = {
		in_sample: id === FIT_ID,
		hotspot_fit: score(id, ev.sc, ev.frames, perHotspot),
		group_params: score(id, ev.sc, ev.frames, groupOnly),
		road_sensor_coverage: sensorCoverage(ev.sc),
		reports: ev.sc.observed.reports?.length ?? 0,
	};
}

await writeFile(
	new URL("hotspots.json", data),
	JSON.stringify({ builtFrom: network.build, fittedOn: FIT_ID, params, group, metrics }),
);

const cs = Object.values(params).map((p) => p.c), ks = Object.values(params).map((p) => p.k);
console.log(`group c ${group.c} mm/h, k ${group.k}/h; per-hotspot c median ${median(cs)} (p25 ${median(cs.filter((v) => v <= median(cs)))}), k median ${median(ks)}; fits ${JSON.stringify(metrics.fit)}`);
for (const [id, m] of Object.entries(metrics.events)) {
	console.log(`\n${id}${m.in_sample ? " (in-sample)" : ""}: ${m.reports} reports; road-sensor coverage ${JSON.stringify(m.road_sensor_coverage)}`);
	console.table({ hotspot_fit: m.hotspot_fit, group_params: m.group_params, naive_60mm: { observed_wet: m.hotspot_fit.observed_wet, hit_rate: m.hotspot_fit.naive_hit_rate, false_alarm_ratio: m.hotspot_fit.naive_false_alarm_ratio } });
}

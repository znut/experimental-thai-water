// Storage-cell drainage model on the canal graph. Pure TS (no DOM) so it runs in a Web
// Worker and in Node for testing.
//
// Each graph node is a storage cell: canal water (surface area from half of every attached
// canal) plus a "street" store for its land catchment. Rain lands on the street, drains into
// the canal no faster than the local pipes allow (or, for land below the canal level, as
// fast as the small pump wells lift it), canals exchange water by a local-inertial scheme
// (Bates et al. 2010, semi-implicit Manning friction), and pumps/tunnels remove water from
// their nodes. Canal water above bank spills back to the street; street water is flooding.
//
// Numerics: nodes joined by canal edges shorter than MERGE_M share one storage cell (short
// edges and tiny cells otherwise force a sub-3 s time step). The hydraulic step is
// CFL-limited per run (see stableDt); street processes run on a slower STREET_DT_S clock.
//
// Deliberate simplifications: no gates, pump outlets to canals are treated as leaving the
// system, river level does not limit pumping, banks/beds are rough.

import type { Infra, Scenario, Terrain } from "../../shared/types.ts";

export interface EdgeIn {
	a: number;
	b: number;
	len_m: number;
	width_m: number | null;
	depth_m: number | null;
	coords: [number, number][];
}

export interface Params {
	dt_s: number; // upper bound on the hydraulic step; the CFL limit usually binds first
	cfl: number; // fraction of the stability limit used for the hydraulic step
	rainScale: number; // multiply all rain
	runoffCoef: number; // share of rain that reaches the street drains
	pipeCap_mm_h: number; // street-to-canal gravity drain capacity
	pumpedDrain_mm_h: number; // small pump wells lifting water from land below canal level
	lowLyingFrac: number; // share of catchment where street water collects (sets flood depth)
	manningN: number;
	conveyanceScale: number; // "what if canals carried N times more"
	pumpScale: number;
	tunnels: boolean;
	gates: boolean; // gravity outlets to the Gulf / tidal river (one-way flap gates)
	boundary: boolean; // two-way exchange with outside canal levels at the city edge (boundary.json)
	boundaryCapPerWidth_m3s: number; // max exchange per metre of canal width (border gates/culverts)
	gateCap_m3s: number; // max discharge per gravity outlet (wide canals); narrower ones get less
	gateCapPerWidth_m3s: number; // per metre of canal width at the outlet
	tideMean_m: number; // sea level at the Gulf, m MSL (simple tide when no series is given)
	tideAmp_m: number;
	tidePeriod_h: number;
	initialLevel_m: number; // canal level at start (m MSL) where no observation
	pumpOn_m: number; // pumps run fully above this level, stop 0.5 m below
	defaultWidth_m: number;
	defaultBank_m: number;
	defaultDepth_m: number;
}

export const DEFAULT_PARAMS: Params = {
	dt_s: 60,
	cfl: 0.7,
	rainScale: 1,
	runoffCoef: 0.8,
	pipeCap_mm_h: 60,
	pumpedDrain_mm_h: 10,
	lowLyingFrac: 0.25,
	manningN: 0.035,
	conveyanceScale: 1,
	pumpScale: 1,
	tunnels: true,
	gates: true,
	boundary: true,
	boundaryCapPerWidth_m3s: 0.5,
	gateCap_m3s: 15,
	// No discharge data for BMA/RID sluices; scale by canal width so a 3 m ditch is not a 15 m³/s gate.
	gateCapPerWidth_m3s: 0.5,
	tideMean_m: 0,
	tideAmp_m: 1.2, // Fort Chula forecast swings roughly -1.5 to +1.1 m
	tidePeriod_h: 12.42,
	initialLevel_m: -0.5,
	pumpOn_m: -0.5,
	defaultWidth_m: 8,
	defaultBank_m: 1.5,
	defaultDepth_m: 3.5,
};

const CELL_M = 250; // catchment grid
const MAX_CATCH_M = 1500; // land further than this from any canal is not drained by the network
const SPREAD_S = 1800; // overland spreading time scale between neighbouring cells
const MERGE_M = 150; // canal edges shorter than this join their two nodes into one storage cell
const STREET_DT_S = 60; // clock for rain, street drainage, spill and overland spreading
const G = 9.81;
const MIN_FLOW_DEPTH = 0.01;
const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;
const toXY = (lon: number, lat: number): [number, number] => [(lon - LON0) * KX, (lat - LAT0) * KY];

export interface Model {
	n: number; // nodes
	m: number; // edges
	ea: Int32Array;
	eb: Int32Array;
	eLen: Float64Array;
	eWidth: Float64Array;
	nodeXY: Float64Array; // x,y pairs in metres
	canalArea: Float64Array; // m² of water surface at each node (incl. ponds)
	catchArea: Float64Array; // m² of land draining to each node
	bank: Float64Array; // m MSL
	bed: Float64Array; // m MSL
	pumpCap: Float64Array; // m³/s at each node
	tunnels: { name: string; inlets: number[]; cap: number }[];
	gravity: { node: number; kind: "sea" | "river"; width: number }[];
	boundary: { node: number; width: number; gauge: string }[];
	terrain: StageTable | null; // null = flat land (fixed low-lying share)
	// Storage cells: nodes joined by short edges share one canal water level.
	nc: number;
	cell: Int32Array; // node -> cell
	cellA: Float64Array; // canal surface area per cell
	cellBed: Float64Array; // area-weighted bed
	cellBank: Float64Array; // area-weighted bank
	// Edges between different cells (the hydraulic links), with the original edge index.
	links: { a: Int32Array; b: Int32Array; len: Float64Array; w: Float64Array; edge: Int32Array };
	maxDepth: Float64Array; // per link: bank - bed, for the stability limit
}

/**
 * Stage-volume table per node built from the catchment's ground-height quantiles: land
 * fraction below height z rises linearly between quantile points, so the water volume per
 * m² of catchment is piecewise quadratic in z and can be inverted exactly.
 */
interface StageTable {
	Q: number;
	z: Float64Array; // n*Q ground heights at the quantiles (NaN row = no terrain for node)
	p: Float64Array; // Q land fractions
	v: Float64Array; // n*Q water volume per m² of catchment when the surface is at z
}

function stageTable(terrain: Terrain, n: number): StageTable {
	const Q = terrain.quantiles.length;
	const z = new Float64Array(n * Q).fill(NaN), v = new Float64Array(n * Q);
	const p = Float64Array.from(terrain.quantiles);
	for (let i = 0; i < n; i++) {
		const row = terrain.q[i];
		if (!row) continue;
		for (let k = 0; k < Q; k++) {
			z[i * Q + k] = row[k];
			v[i * Q + k] = k ? v[i * Q + k - 1] + ((row[k] - row[k - 1]) * (p[k - 1] + p[k])) / 2 : 0;
		}
	}
	return { Q, z, p, v };
}

/** Water surface height for `vol` m³ on node i's catchment of area A. */
function surface(t: StageTable, i: number, vol: number, A: number): number {
	const { Q, z, p, v } = t, o = i * Q;
	const u = vol / A;
	if (u <= 0) return z[o];
	if (u >= v[o + Q - 1]) return z[o + Q - 1] + (u - v[o + Q - 1]);
	let k = 0;
	while (v[o + k + 1] <= u) k++;
	const dz = z[o + k + 1] - z[o + k];
	if (dz <= 0) return z[o + k];
	const a = (p[k + 1] - p[k]) / (2 * dz), b = p[k], c = v[o + k] - u;
	const s = a > 1e-12 ? (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a) : -c / b;
	return z[o + k] + s;
}

/** Share of node i's catchment whose ground lies below height zz. */
function wetShare(t: StageTable, i: number, zz: number): number {
	const { Q, z, p } = t, o = i * Q;
	if (zz <= z[o]) return 0;
	if (zz >= z[o + Q - 1]) return 1;
	let k = 0;
	while (z[o + k + 1] < zz) k++;
	const dz = z[o + k + 1] - z[o + k];
	return dz > 0 ? p[k] + ((p[k + 1] - p[k]) * (zz - z[o + k])) / dz : p[k + 1];
}

/** Precomputes everything that does not change between runs. */
export function buildModel(
	edges: EdgeIn[],
	infra: Infra | null,
	banks: { lon: number; lat: number; bank: number }[],
	p: Params,
	terrain: Terrain | null = null,
	nodeBanks: (number | null)[] | null = null, // public/data/banks.json `bank`, per node
	boundaryNodes: { node: number; width_m: number; gauge: string }[] | null = null, // boundary.json nodes
): Model {
	const n = edges.reduce((mx, e) => Math.max(mx, e.a, e.b), 0) + 1;
	const m = edges.length;
	const ea = new Int32Array(m), eb = new Int32Array(m), eLen = new Float64Array(m), eWidth = new Float64Array(m);
	const nodeXY = new Float64Array(2 * n);
	const canalArea = new Float64Array(n), depthSum = new Float64Array(n), depthN = new Float64Array(n);

	edges.forEach((e, i) => {
		ea[i] = e.a;
		eb[i] = e.b;
		eLen[i] = Math.max(e.len_m, 1);
		eWidth[i] = e.width_m ?? p.defaultWidth_m;
		const [ax, ay] = toXY(...e.coords[0]);
		const [bx, by] = toXY(...e.coords.at(-1)!);
		nodeXY.set([ax, ay], 2 * e.a);
		nodeXY.set([bx, by], 2 * e.b);
		for (const k of [e.a, e.b]) {
			canalArea[k] += (eLen[i] / 2) * eWidth[i];
			if (e.depth_m) (depthSum[k] += e.depth_m), depthN[k]++;
		}
	});
	for (let i = 0; i < n; i++) canalArea[i] = Math.max(canalArea[i], 200);

	// Spatial hash of nodes for nearest-node lookups.
	const H = 1000;
	const hash = new Map<string, number[]>();
	for (let i = 0; i < n; i++) {
		const k = `${Math.floor(nodeXY[2 * i] / H)},${Math.floor(nodeXY[2 * i + 1] / H)}`;
		if (!hash.has(k)) hash.set(k, []);
		hash.get(k)!.push(i);
	}
	const nearestNode = (x: number, y: number, maxD: number) => {
		let best = -1, bd = maxD;
		const r = Math.ceil(maxD / H);
		const cx = Math.floor(x / H), cy = Math.floor(y / H);
		for (let dx = -r; dx <= r; dx++)
			for (let dy = -r; dy <= r; dy++)
				for (const i of hash.get(`${cx + dx},${cy + dy}`) ?? []) {
					const d = Math.hypot(nodeXY[2 * i] - x, nodeXY[2 * i + 1] - y);
					if (d < bd) (bd = d), (best = i);
				}
		return best;
	};

	// Catchments: each grid cell drains to its nearest node.
	const catchArea = new Float64Array(n);
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < n; i++) {
		minX = Math.min(minX, nodeXY[2 * i]), maxX = Math.max(maxX, nodeXY[2 * i]);
		minY = Math.min(minY, nodeXY[2 * i + 1]), maxY = Math.max(maxY, nodeXY[2 * i + 1]);
	}
	for (let x = minX; x <= maxX; x += CELL_M)
		for (let y = minY; y <= maxY; y += CELL_M) {
			const k = nearestNode(x, y, MAX_CATCH_M);
			if (k >= 0) catchArea[k] += CELL_M * CELL_M;
		}
	// With terrain, use its (finer) catchment areas so the stage tables and areas agree.
	if (terrain) for (let i = 0; i < n; i++) if (terrain.q[i]) catchArea[i] = terrain.catch_m2[i];

	// Bank per node from banks.json (scripts/build-banks.mjs) when given; otherwise the nearest
	// level station. Bed = bank - depth. Several stations report bank 0 (missing) or ~0.15 m;
	// Bangkok canal banks are 0.5-3.5 m MSL.
	const bankPts = banks.filter((b) => b.bank >= 0.5 && b.bank <= 4).map((b) => ({ xy: toXY(b.lon, b.lat), bank: b.bank }));
	const bank = new Float64Array(n), bed = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let best = p.defaultBank_m, bd = 5000;
		const given = nodeBanks?.[i];
		if (typeof given === "number") best = Math.min(5, Math.max(0.3, given));
		else
			for (const b of bankPts) {
				const d = Math.hypot(b.xy[0] - nodeXY[2 * i], b.xy[1] - nodeXY[2 * i + 1]);
				if (d < bd) (bd = d), (best = b.bank);
			}
		bank[i] = best;
		bed[i] = best - (depthN[i] ? depthSum[i] / depthN[i] : p.defaultDepth_m);
	}

	const pumpCap = new Float64Array(n);
	for (const pump of infra?.pumps ?? []) if (pump.node < n) pumpCap[pump.node] += pump.capacity_m3s;
	// Ponds add storage area at their node, taken as 2 m deep.
	for (const pond of infra?.ponds ?? []) if (pond.node < n) canalArea[pond.node] += pond.storage_m3 / 2;
	const tunnels = (infra?.tunnels ?? [])
		.filter((t) => t.status === "open" && t.inlets.length)
		.map((t) => ({ name: t.name, inlets: t.inlets.filter((k) => k < n), cap: t.capacity_m3s }));

	const widest = new Float64Array(n);
	for (let e = 0; e < m; e++) for (const k of [ea[e], eb[e]]) widest[k] = Math.max(widest[k], eWidth[e]);
	const gravity = (infra?.gravity ?? []).filter((g) => g.node < n).map((g) => ({ node: g.node, kind: g.kind, width: widest[g.node] || p.defaultWidth_m }));
	const boundary = (boundaryNodes ?? []).filter((b) => b.node < n).map((b) => ({ node: b.node, width: b.width_m || p.defaultWidth_m, gauge: b.gauge }));

	// Merge nodes joined by short edges into storage cells.
	const par = Int32Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		while (par[i] !== i) (par[i] = par[par[i]]), (i = par[i]);
		return i;
	};
	for (let e = 0; e < m; e++) if (eLen[e] < MERGE_M) par[find(ea[e])] = find(eb[e]);
	const rootCell = new Int32Array(n).fill(-1);
	const cell = new Int32Array(n);
	let nc = 0;
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (rootCell[r] < 0) rootCell[r] = nc++;
		cell[i] = rootCell[r];
	}
	const cellA = new Float64Array(nc), cellBed = new Float64Array(nc), cellBank = new Float64Array(nc);
	for (let i = 0; i < n; i++) {
		const c = cell[i];
		cellA[c] += canalArea[i];
		cellBed[c] += bed[i] * canalArea[i];
		cellBank[c] += bank[i] * canalArea[i];
	}
	for (let c = 0; c < nc; c++) (cellBed[c] /= cellA[c]), (cellBank[c] /= cellA[c]);
	const kept: number[] = [];
	for (let e = 0; e < m; e++) if (cell[ea[e]] !== cell[eb[e]]) kept.push(e);
	const links = {
		a: Int32Array.from(kept, (e) => cell[ea[e]]),
		b: Int32Array.from(kept, (e) => cell[eb[e]]),
		len: Float64Array.from(kept, (e) => eLen[e]),
		w: Float64Array.from(kept, (e) => eWidth[e]),
		edge: Int32Array.from(kept),
	};
	const maxDepth = Float64Array.from(kept, (_, k) => Math.max(0.5, Math.max(cellBank[links.a[k]], cellBank[links.b[k]]) - Math.max(cellBed[links.a[k]], cellBed[links.b[k]])));

	return {
		n, m, ea, eb, eLen, eWidth, nodeXY, canalArea, catchArea, bank, bed, pumpCap, tunnels, gravity, boundary,
		terrain: terrain ? stageTable(terrain, n) : null,
		nc, cell, cellA, cellBed, cellBank, links, maxDepth,
	};
}

/**
 * Largest stable hydraulic step: for each cell, the gravity-wave limit
 * sqrt(A / (g * sum(w * d / L))) over its links, at full bank depth (conservative).
 */
export function stableDt(model: Model, conveyanceScale = 1): number {
	const k = new Float64Array(model.nc);
	const { a, b, len, w } = model.links;
	for (let e = 0; e < a.length; e++) {
		const c = (w[e] * conveyanceScale * model.maxDepth[e]) / len[e];
		k[a[e]] += c;
		k[b[e]] += c;
	}
	let dt = Infinity;
	for (let c = 0; c < model.nc; c++) if (k[c] > 0) dt = Math.min(dt, Math.sqrt(model.cellA[c] / (G * k[c])));
	return dt;
}

/** Inverse-distance weights from each node to its 3 nearest rain gauges. */
function rainWeights(model: Model, gauges: Scenario["rain"]) {
	const xy = gauges.map((g) => toXY(g.lon, g.lat));
	const idx = new Int32Array(model.n * 3), w = new Float64Array(model.n * 3);
	for (let i = 0; i < model.n; i++) {
		const d = xy.map(([x, y], g) => [Math.hypot(x - model.nodeXY[2 * i], y - model.nodeXY[2 * i + 1]), g]).sort((a, b) => a[0] - b[0]).slice(0, 3);
		const inv = d.map(([dist]) => 1 / Math.max(dist, 100) ** 2);
		const s = inv.reduce((a, b) => a + b, 0);
		d.forEach(([, g], j) => ((idx[3 * i + j] = g), (w[3 * i + j] = inv[j] / s)));
	}
	return { idx, w };
}

export interface Frame {
	t: string;
	level: Float32Array; // canal level per node, m MSL
	flood_cm: Float32Array; // street water depth per node (mean over wet land with terrain)
	surface_m: Float32Array; // street water surface per node, m MSL (NaN when dry or no terrain)
	q: Float32Array; // edge flow a->b, m³/s (0 on short edges merged into one cell)
	rain_m3s: number;
	pumped_m3s: number;
	gravity_m3s: number; // out through sea/river gates
	boundary_m3s: number; // net exchange at the city edge, + = into the city
	tunnel_m3s: number[]; // per tunnel, aligned with model.tunnels
	flooded_km2: number; // catchment area with > 10 cm street water
	street_m3: number; // total water on land
	canal_m3: number; // total water in canals (above bed)
}

/** Runs a whole scenario and returns one frame per scenario step. */
export function run(model: Model, sc: Scenario, p: Params, initial?: Float64Array): Frame[] {
	const { n, m, canalArea, catchArea, bank, pumpCap, terrain: T, nc, cell, cellA, cellBed, cellBank, links } = model;
	const L = links.a.length;
	// Nodes with a stage table use real ground heights; the rest fall back to flat land.
	const hasT = new Uint8Array(n);
	if (T) for (let i = 0; i < n; i++) hasT[i] = Number.isNaN(T.z[i * T.Q]) ? 0 : 1;
	const zs = new Float64Array(n); // street water surface (m), terrain nodes only

	// Canal level per storage cell, from the area-weighted starting level of its nodes.
	const h = new Float64Array(nc);
	for (let i = 0; i < n; i++) {
		const start = initial && !Number.isNaN(initial[i]) ? initial[i] : p.initialLevel_m;
		h[cell[i]] += Math.min(start, bank[i]) * canalArea[i];
	}
	for (let c = 0; c < nc; c++) h[c] = Math.min(cellBank[c], Math.max(cellBed[c], h[c] / cellA[c]));

	const street = new Float64Array(n); // m³ of water on the land
	const share = Float64Array.from({ length: n }, (_, i) => canalArea[i] / cellA[cell[i]]); // spill split
	const q = new Float64Array(L);
	const dV = new Float64Array(nc), outV = new Float64Array(nc), scale = new Float64Array(nc);
	const inflow = new Float64Array(nc); // m³/s into each cell from rain on water + street drains
	const spill = new Float64Array(nc);

	const cellPump = new Float64Array(nc);
	for (let i = 0; i < n; i++) cellPump[cell[i]] += pumpCap[i];
	const pumpCells: number[] = [];
	for (let c = 0; c < nc; c++) if (cellPump[c] > 0) pumpCells.push(c);
	const tunnels = model.tunnels.map((t) => ({ cap: t.cap, cells: [...new Set(t.inlets.map((i) => cell[i]))] }));
	const gates = model.gravity.map((g) => ({ ...g, c: cell[g.node] }));
	// City-edge links to outside gauges: level per step (last good value carried forward).
	const BOUNDARY_L = 1000; // m, notional canal length between the edge and the gauge level
	const gaugeSeries = new Map(
		(sc.boundary ?? []).map((g) => {
			let last: number | null = null;
			return [g.code, g.level_m.map((v) => (v == null ? last : (last = v)))] as const;
		}),
	);
	const edgeLinks = p.boundary
		? model.boundary.filter((b) => gaugeSeries.has(b.gauge)).map((b) => ({ c: cell[b.node], w: b.width, series: gaugeSeries.get(b.gauge)!, q: 0 }))
		: [];
	// Outside water: a simple Gulf tide; the river side follows the scenario river level if given.
	const tide = (s: number) => p.tideMean_m + p.tideAmp_m * Math.sin((2 * Math.PI * (s * sc.step_min)) / 60 / p.tidePeriod_h);
	const outside = (kind: "sea" | "river", s: number) => (kind === "river" ? sc.river_level_msl?.[s] ?? tide(s) : tide(s));
	const SQRT2G = Math.sqrt(2 * G), CD = 0.4;

	const { idx, w } = rainWeights(model, sc.rain);
	const stepS = sc.step_min * 60;
	const nStreet = Math.max(1, Math.round(stepS / STREET_DT_S));
	const dtS = stepS / nStreet;
	const dtMax = Math.min(p.dt_s, p.cfl * stableDt(model, p.conveyanceScale));
	const nH = Math.max(1, Math.ceil(dtS / dtMax));
	const dt = dtS / nH;
	const pipe = p.pipeCap_mm_h / 1000 / 3600; // m/s over catchment
	const pumpedDrain = p.pumpedDrain_mm_h / 1000 / 3600;
	const n2 = p.manningN ** 2;
	const W = Float64Array.from(links.w, (v) => v * p.conveyanceScale);
	const frames: Frame[] = [];
	const t0 = Date.parse(sc.start);
	const ramp = (c: number) => Math.min(1, Math.max(0, (h[c] - (p.pumpOn_m - 0.5)) / 0.5));

	for (let s = 0; s < sc.steps; s++) {
		// Rain rate per node this step (m/s); gauges with gaps contribute nothing.
		const rate = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			let r = 0, ws = 0;
			for (let j = 0; j < 3; j++) {
				const v = sc.rain[idx[3 * i + j]]?.mm[s];
				if (v != null) (r += w[3 * i + j] * v), (ws += w[3 * i + j]);
			}
			rate[i] = ws ? ((r / ws) * p.rainScale) / 1000 / stepS : 0;
		}
		let pumpedSum = 0, rainSum = 0, gravitySum = 0, boundarySum = 0;
		const headSea = outside("sea", s), headRiver = outside("river", s);
		const tunnelSum = tunnels.map(() => 0);

		for (let ks = 0; ks < nStreet; ks++) {
			// --- Street clock: rain, drainage into canals, overland spreading.
			inflow.fill(0);
			if (T) for (let i = 0; i < n; i++) if (hasT[i]) zs[i] = surface(T, i, street[i], catchArea[i]);
			for (let i = 0; i < n; i++) {
				const c = cell[i];
				street[i] += rate[i] * catchArea[i] * p.runoffCoef * dtS;
				inflow[c] += rate[i] * canalArea[i];
				rainSum += rate[i] * (catchArea[i] * p.runoffCoef + canalArea[i]) * dtS;
				if (street[i] <= 0 || h[c] >= cellBank[c]) continue;
				// Gravity drains while the street water stands above the canal; land lying below the
				// canal level can only be lifted out by the small pump wells.
				const cap = !hasT[i] || zs[i] > h[c] ? pipe : pumpedDrain;
				const d = Math.min(street[i], cap * catchArea[i] * dtS);
				street[i] -= d;
				inflow[c] += d / dtS;
			}
			for (let e = 0; e < m; e++) {
				const a = model.ea[e], b = model.eb[e];
				if (hasT[a] && hasT[b]) {
					// Downhill by water surface height, from the wet part of the higher cell.
					if (!street[a] && !street[b]) continue;
					const dz = zs[a] - zs[b];
					const from = dz > 0 ? a : b, to = dz > 0 ? b : a;
					const wet = catchArea[from] * wetShare(T!, from, zs[from]);
					const v = Math.min(0.25 * Math.abs(dz) * wet * Math.min(1, dtS / SPREAD_S), 0.25 * street[from]);
					street[from] -= v;
					street[to] += v;
					continue;
				}
				const la = catchArea[a] * p.lowLyingFrac, lb = catchArea[b] * p.lowLyingFrac;
				if (!la || !lb) continue;
				const da = street[a] / la, db = street[b] / lb;
				if (Math.max(da, db) < 0.05) continue;
				const v = 0.25 * (da - db) * Math.min(la, lb) * Math.min(1, dtS / SPREAD_S);
				street[a] -= v;
				street[b] += v;
			}

			// --- Hydraulic clock: canal links (local inertial), pumps, tunnels.
			for (let kh = 0; kh < nH; kh++) {
				outV.fill(0);
				for (let c = 0; c < nc; c++) dV[c] = inflow[c] * dt;
				for (let e = 0; e < L; e++) {
					const a = links.a[e], b = links.b[e];
					const ha = h[a], hb = h[b];
					const hf = Math.max(ha, hb) - Math.max(cellBed[a], cellBed[b]);
					if (hf <= MIN_FLOW_DEPTH) {
						q[e] = 0;
						continue;
					}
					const A = W[e] * hf;
					const R = A / (W[e] + 2 * hf);
					const r3 = Math.cbrt(R);
					q[e] = (q[e] + (G * A * dt * (ha - hb)) / links.len[e]) / (1 + (G * dt * n2 * Math.abs(q[e])) / (A * r3 * r3 * r3 * r3));
					outV[q[e] > 0 ? a : b] += Math.abs(q[e]) * dt;
				}
				// A cell can't send more than the water it holds; scale its outflows down.
				for (let c = 0; c < nc; c++) {
					const held = Math.max(0, (h[c] - cellBed[c]) * cellA[c] + dV[c]);
					scale[c] = outV[c] > held ? held / outV[c] : 1;
				}
				for (let e = 0; e < L; e++) {
					if (!q[e]) continue;
					q[e] *= scale[q[e] > 0 ? links.a[e] : links.b[e]];
					dV[links.a[e]] -= q[e] * dt;
					dV[links.b[e]] += q[e] * dt;
				}
				// Pumps: full capacity above pumpOn, ramping to zero 0.5 m below.
				for (const c of pumpCells) {
					const avail = Math.max(0, (h[c] - cellBed[c]) * cellA[c] + dV[c]);
					const out = Math.min(cellPump[c] * p.pumpScale * ramp(c) * dt, avail);
					dV[c] -= out;
					pumpedSum += out;
				}
				// Tunnels: each draws what its inlet cells can deliver, up to its capacity.
				if (p.tunnels)
					tunnels.forEach((t, ti) => {
						let want = t.cap * dt;
						for (const c of t.cells) {
							const avail = Math.max(0, (h[c] - cellBed[c]) * cellA[c] + dV[c]);
							const got = Math.min(want, avail) * ramp(c);
							dV[c] -= got;
							want -= got;
							tunnelSum[ti] += got;
							if (want <= 0) break;
						}
					});
				// Gravity outlets: free weir flow through a one-way gate while the canal is higher.
				if (p.gates)
					for (const g of gates) {
						const dh = h[g.c] - (g.kind === "sea" ? headSea : headRiver);
						if (dh <= 0) continue;
						const avail = Math.max(0, (h[g.c] - cellBed[g.c]) * cellA[g.c] + dV[g.c]);
						const cap = Math.min(p.gateCap_m3s, p.gateCapPerWidth_m3s * g.width);
						const out = Math.min(Math.min(cap, CD * g.width * SQRT2G * dh ** 1.5) * dt, avail);
						dV[g.c] -= out;
						gravitySum += out;
					}
				// City edge: local-inertial exchange with the outside gauge level, capped per metre width.
				for (const b of edgeLinks) {
					const head = b.series[s];
					if (head == null) continue;
					const hf = Math.max(head, h[b.c]) - cellBed[b.c];
					if (hf <= MIN_FLOW_DEPTH) {
						b.q = 0;
						continue;
					}
					const A = b.w * hf, R = A / (b.w + 2 * hf), r3 = Math.cbrt(R);
					b.q = (b.q + (G * A * dt * (head - h[b.c])) / BOUNDARY_L) / (1 + (G * dt * n2 * Math.abs(b.q)) / (A * r3 * r3 * r3 * r3));
					const cap = p.boundaryCapPerWidth_m3s * b.w;
					b.q = Math.max(-cap, Math.min(cap, b.q));
					if (b.q < 0) b.q = -Math.min(-b.q, Math.max(0, (h[b.c] - cellBed[b.c]) * cellA[b.c] + dV[b.c]) / dt);
					dV[b.c] += b.q * dt;
					boundarySum += b.q * dt;
				}
				// Apply volumes; canal water above bank spills onto the land.
				for (let c = 0; c < nc; c++) {
					h[c] = Math.max(cellBed[c], h[c] + dV[c] / cellA[c]);
					if (h[c] > cellBank[c]) {
						spill[c] += (h[c] - cellBank[c]) * cellA[c];
						h[c] = cellBank[c];
					}
				}
			}
			for (let i = 0; i < n; i++) street[i] += spill[cell[i]] * share[i];
			spill.fill(0);
		}

		const level = new Float32Array(n), flood = new Float32Array(n), surf = new Float32Array(n).fill(NaN);
		let floodedM2 = 0;
		for (let i = 0; i < n; i++) {
			level[i] = h[cell[i]];
			if (hasT[i]) {
				// Mean depth over the land that is under water; flooded area = land > 10 cm deep.
				if (street[i] <= 1e-6 * catchArea[i]) continue;
				const z = surface(T!, i, street[i], catchArea[i]);
				const wet = wetShare(T!, i, z);
				flood[i] = wet > 0 ? (street[i] / (catchArea[i] * wet)) * 100 : 0;
				surf[i] = z;
				floodedM2 += catchArea[i] * wetShare(T!, i, z - 0.1);
				continue;
			}
			const low = catchArea[i] * p.lowLyingFrac;
			flood[i] = low > 0 ? (street[i] / low) * 100 : 0;
			if (flood[i] > 10) floodedM2 += low;
		}
		const qEdge = new Float32Array(m);
		for (let e = 0; e < L; e++) qEdge[links.edge[e]] = q[e];
		let canal = 0;
		for (let c = 0; c < nc; c++) canal += (h[c] - cellBed[c]) * cellA[c];
		frames.push({
			t: new Date(t0 + (s + 1) * stepS * 1000).toISOString(),
			level,
			flood_cm: flood,
			surface_m: surf,
			q: qEdge,
			rain_m3s: rainSum / stepS,
			pumped_m3s: pumpedSum / stepS,
			gravity_m3s: gravitySum / stepS,
			boundary_m3s: boundarySum / stepS,
			tunnel_m3s: tunnelSum.map((v) => v / stepS),
			flooded_km2: floodedM2 / 1e6,
			street_m3: street.reduce((a, b) => a + b, 0),
			canal_m3: canal,
		});
	}
	return frames;
}

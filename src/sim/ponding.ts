// Street ponding at BMA road flood sensors: a small data-driven model next to the physical
// canal model. Each sensor spot is a linear reservoir on water depth S (cm):
//
//   dS/dt = a · max(0, R(t) − c) − k · g(canal) · S
//
// R = rain intensity at the spot (mm/h), c = what the local drains take (mm/h), a = how much
// the street concentrates excess rain (cm per mm), k = recession rate (1/h), and
// g = clamp((bank − canal level) / 0.5, 0.15, 1): drainage slows as the receiving canal fills.
// a, c, k are fitted per sensor (scripts/fit-ponding.mjs) and stored in public/data/ponding.json.
// Pure TS (no DOM) so it runs in the browser, a worker, or Bun.

import type { Scenario } from "../../shared/types.ts";

export interface PondParams {
	a: number; // cm per mm of excess rain
	c: number; // mm/h
	k: number; // 1/h
}

export interface PondSensor extends PondParams {
	lon: number;
	lat: number;
	node: number; // canal-graph node whose level slows drainage (-1 = none)
	fit: "fitted" | "shrunk" | "dry" | "group"; // how the params were obtained
}

export interface PondingFile {
	builtFrom: string; // network build the node ids belong to
	fittedOn: string; // scenario id
	params: Record<string, PondSensor>;
	group: PondParams; // used for sensors not in params
	metrics: unknown;
}

/** Canal-full drainage factor. */
export const canalFactor = (bank: number, level: number) => Math.min(1, Math.max(0.15, (bank - level) / 0.5));

/**
 * Depth series (cm) for one spot. `rain` is intensity per step (mm/h); `canalLevel` and `bank`
 * (m MSL) are optional. Each step uses the exact solution for constant inflow and decay.
 */
export function runPonding(p: PondParams, rain: ArrayLike<number>, stepH: number, canalLevel?: ArrayLike<number>, bank?: number): Float32Array {
	const out = new Float32Array(rain.length);
	let S = 0;
	for (let t = 0; t < rain.length; t++) {
		const inflow = p.a * Math.max(0, rain[t] - p.c); // cm/h
		const g = canalLevel && bank !== undefined ? canalFactor(bank, canalLevel[t]) : 1;
		const lam = p.k * g;
		if (lam > 1e-9) {
			const e = Math.exp(-lam * stepH);
			S = S * e + (inflow / lam) * (1 - e);
		} else S += inflow * stepH;
		out[t] = S;
	}
	return out;
}

const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;

/** Rain intensity (mm/h) per step at a point: inverse-distance weights of the 3 nearest gauges (as model.ts). */
export function rainAt(sc: Scenario, lon: number, lat: number): Float32Array {
	const near = sc.rain
		.map((g, i) => [Math.hypot((g.lon - lon) * KX, (g.lat - lat) * KY), i] as const)
		.sort((x, y) => x[0] - y[0])
		.slice(0, 3);
	const w = near.map(([d]) => 1 / Math.max(d, 100) ** 2);
	const stepH = sc.step_min / 60;
	const out = new Float32Array(sc.steps);
	for (let t = 0; t < sc.steps; t++) {
		let r = 0, ws = 0;
		near.forEach(([, gi], j) => {
			const v = sc.rain[gi].mm[t];
			if (v != null) (r += w[j] * v), (ws += w[j]);
		});
		out[t] = ws ? r / ws / stepH : 0;
	}
	return out;
}

/**
 * Runs every sensor in `pond` (plus any extra spots, with group params) for a scenario.
 * `sim` supplies the physical model's canal level per step and bank per node; without it
 * drainage is never slowed by canals. Returns depth (cm) per step, indexed like `codes`.
 */
export function pondScenario(
	pond: PondingFile,
	sc: Scenario,
	sim?: { level: (step: number) => ArrayLike<number>; bank: ArrayLike<number> },
	extra: { code: string; lon: number; lat: number; node: number }[] = [],
): { codes: string[]; lon: Float32Array; lat: Float32Array; depth: Float32Array[] } {
	const spots = [
		...Object.entries(pond.params).map(([code, s]) => ({ code, ...s })),
		...extra.filter((e) => !pond.params[e.code]).map((e) => ({ ...e, ...pond.group, fit: "group" as const })),
	];
	const stepH = sc.step_min / 60;
	const series = spots.map((s) => {
		const canal = sim && s.node >= 0 ? Float32Array.from({ length: sc.steps }, (_, t) => sim.level(t)[s.node]) : undefined;
		return runPonding(s, rainAt(sc, s.lon, s.lat), stepH, canal, canal ? sim!.bank[s.node] : undefined);
	});
	return {
		codes: spots.map((s) => s.code),
		lon: Float32Array.from(spots, (s) => s.lon),
		lat: Float32Array.from(spots, (s) => s.lat),
		depth: Array.from({ length: sc.steps }, (_, t) => Float32Array.from(series, (d) => d[t])),
	};
}

import type { SensorSnap, Snapshot } from "../shared/types.ts";
import { speedClass, type Edge } from "./flow.ts";

// Manning's n for an earth/concrete canal and an assumed hydraulic radius; with no
// cross-section data this only ranks canals as slow/medium/fast, it is not a measurement.
const MANNING_N = 0.03;
const HYDRAULIC_RADIUS_M = 1.0;
// Below this gradient (2 mm per km) we call the water still: sensor datum error is larger.
const MIN_SLOPE = 2e-6;

/**
 * Canal water levels (m MSL) pinned to graph nodes; several stations on one node are averaged.
 *
 * Only stations with no "outside" reading are used. Gate stations sit on a level step
 * (polder inside vs outside), and pump sumps and flow-station levels made agreement with
 * measured flow direction worse (checked 2026-10-01: 33/103 with them, 52/90 without).
 * Even 52/90 is barely better than chance, which is why this layer is off by default.
 */
export function knownHeads(sensors: Record<string, SensorSnap>, level: Snapshot | null | undefined) {
	const acc = new Map<number, { sum: number; n: number }>();
	for (const f of level?.features ?? []) {
		if (f.properties.level_out_m !== null) continue;
		const s = sensors[f.properties.id];
		const h = f.properties.level_in_m;
		if (!s || typeof h !== "number" || h < -5 || h > 5) continue; // outside any plausible Bangkok canal level
		const a = acc.get(s.node) ?? { sum: 0, n: 0 };
		a.sum += h;
		a.n++;
		acc.set(s.node, a);
	}
	return new Map([...acc].map(([node, a]) => [node, a.sum / a.n]));
}

/**
 * Fills in water level at every junction by harmonic interpolation along the canals
 * (each unknown node becomes the length-weighted average of its neighbours), with
 * station nodes held fixed. Nodes in canal groups with no station stay NaN.
 */
export function interpolateHeads(edges: Edge[], known: Map<number, number>) {
	const maxNode = edges.reduce((m, e) => Math.max(m, e.a, e.b), 0);
	const nbrs: { to: number; w: number }[][] = Array.from({ length: maxNode + 1 }, () => []);
	for (const e of edges) {
		const w = 1 / Math.max(e.len_m, 1);
		nbrs[e.a].push({ to: e.b, w });
		nbrs[e.b].push({ to: e.a, w });
	}

	// Mark which nodes can reach a station; the rest have no information.
	const reach = new Uint8Array(maxNode + 1);
	const stack = [...known.keys()];
	for (const n of stack) reach[n] = 1;
	while (stack.length) for (const { to } of nbrs[stack.pop()!]) if (!reach[to]) (reach[to] = 1), stack.push(to);

	const h = new Float64Array(maxNode + 1).fill(NaN);
	let mean = 0;
	for (const v of known.values()) mean += v / known.size;
	for (let i = 0; i <= maxNode; i++) if (reach[i]) h[i] = known.get(i) ?? mean;

	// Successive over-relaxation; long canal chains converge slowly with plain Gauss-Seidel.
	const OMEGA = 1.8;
	for (let it = 0; it < 3000; it++) {
		let change = 0;
		for (let i = 0; i <= maxNode; i++) {
			if (!reach[i] || known.has(i) || !nbrs[i].length) continue;
			let sw = 0, sh = 0;
			for (const { to, w } of nbrs[i]) (sw += w), (sh += w * h[to]);
			const next = h[i] + OMEGA * (sh / sw - h[i]);
			change = Math.max(change, Math.abs(next - h[i]));
			h[i] = next;
		}
		if (change < 1e-6) break;
	}
	return h;
}

/** Edges oriented from high to low interpolated level, skipping edges already shown as measured. */
export function inferredFlowLines(edges: Edge[], heads: Float64Array, skip: Set<number>) {
	const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
	for (const e of edges) {
		if (skip.has(e.id)) continue;
		const ha = heads[e.a], hb = heads[e.b];
		if (Number.isNaN(ha) || Number.isNaN(hb)) continue;
		const slope = Math.abs(ha - hb) / Math.max(e.len_m, 1);
		if (slope < MIN_SLOPE) continue;
		const v = (1 / MANNING_N) * HYDRAULIC_RADIUS_M ** (2 / 3) * Math.sqrt(slope);
		const cls = speedClass(v);
		if (!cls) continue;
		features.push({
			type: "Feature",
			geometry: { type: "LineString", coordinates: ha > hb ? e.coords : [...e.coords].reverse() },
			properties: {
				canal: e.name,
				level_from_m: +Math.max(ha, hb).toFixed(3),
				level_to_m: +Math.min(ha, hb).toFixed(3),
				slope_cm_per_km: +(slope * 1e5).toFixed(2),
				v_est_ms: +v.toFixed(3),
				speed: cls,
				basis: "inferred from water levels",
			},
		});
	}
	return { type: "FeatureCollection" as const, features };
}

import type { SensorSnap, Snapshot } from "../shared/types.ts";

export interface Edge {
	id: number;
	a: number;
	b: number;
	name: string;
	len_m: number;
	width_m: number | null;
	depth_m: number | null;
	coords: [number, number][];
}

export type SpeedClass = "slow" | "medium" | "fast";

// How far along its own canal one flow station's reading is shown.
const REACH_M = 2000;

export function speedClass(v: number): SpeedClass | null {
	const s = Math.abs(v);
	// < 0.01 is effectively still; > 3 m/s is not physical for a canal (seen: 6, 26, 50 at
	// FW.PWT.03 and the Saen Saep tunnel stations), so treat it as bad data.
	if (s < 0.01 || s > 3) return null;
	return s < 0.05 ? "slow" : s < 0.2 ? "medium" : "fast";
}

/**
 * Turns flow-station readings into line features oriented in the direction water moves,
 * so a dash animation that runs "forward" along each line shows the flow.
 *
 * Assumption (BMA does not document the sign): positive velocity means water moving
 * toward the gate/pump at the station's nearest junction. We show it on the station's
 * edge and on the same-named canal upstream of it, up to REACH_M.
 */
export function measuredFlowLines(edges: Edge[], sensors: Record<string, SensorSnap>, flow: Snapshot) {
	const byNode = new Map<number, Edge[]>();
	for (const e of edges)
		for (const n of [e.a, e.b]) {
			if (!byNode.has(n)) byNode.set(n, []);
			byNode.get(n)!.push(e);
		}

	const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
	for (const st of flow.features) {
		const snap = sensors[st.properties.id];
		const v = st.properties.velocity_ms;
		if (!snap || typeof v !== "number") continue;
		const cls = speedClass(v);
		if (!cls) continue;

		const e0 = edges[snap.edge];
		const down = snap.node; // the junction the station drains toward when v > 0
		// Walk upstream along the same canal; each edge is stored pointing toward `toward`.
		const queue: { e: Edge; toward: number; dist: number }[] = [{ e: e0, toward: down, dist: 0 }];
		const seen = new Set<number>();
		while (queue.length) {
			const { e, toward, dist } = queue.shift()!;
			if (seen.has(e.id) || dist > REACH_M) continue;
			seen.add(e.id);
			const pointsToward = e.b === toward ? e.coords : [...e.coords].reverse();
			features.push({
				type: "Feature",
				geometry: { type: "LineString", coordinates: v > 0 ? pointsToward : [...pointsToward].reverse() },
				properties: { edge: e.id, station: st.properties.id, velocity_ms: v, flow_m3s: st.properties.flow_m3s, speed: cls, basis: "measured" },
			});
			const upstream = e.a === toward ? e.b : e.a;
			for (const next of byNode.get(upstream) ?? [])
				if (next.name === e0.name && !seen.has(next.id)) queue.push({ e: next, toward: upstream, dist: dist + e.len_m });
		}
	}
	return { type: "FeatureCollection" as const, features };
}

/** Junctions (3+ edges meeting) derived from edge endpoints. */
export function junctions(edges: Edge[]) {
	const deg = new Map<number, { n: number; at: [number, number] }>();
	for (const e of edges) {
		for (const [node, at] of [[e.a, e.coords[0]], [e.b, e.coords.at(-1)!]] as const) {
			const d = deg.get(node) ?? { n: 0, at };
			d.n++;
			deg.set(node, d);
		}
	}
	return {
		type: "FeatureCollection" as const,
		features: [...deg.entries()]
			.filter(([, d]) => d.n >= 3)
			.map(([id, d]) => ({
				type: "Feature" as const,
				geometry: { type: "Point" as const, coordinates: d.at },
				properties: { id, degree: d.n },
			})),
	};
}

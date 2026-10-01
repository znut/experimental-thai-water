// Design drainage direction: every canal is pointed toward its nearest outlet (a pump station
// discharging to the river, or a deep-tunnel inlet) along the network, and each canal carries
// the land area draining through it. Small canals feed bigger ones, which feed the outlets.
// This is the network's topology, not a measurement: gates and pump operation can reverse it.
import type { Infra } from "../shared/types.ts";
import type { Edge } from "./flow.ts";

export interface DrainageEdge {
	edge: number;
	coords: [number, number][]; // oriented downstream
	acc_km2: number; // land draining through this canal
	outlet: string | null;
	dist_km: number; // along-canal distance to the outlet
}

/** Binary min-heap keyed by number. */
class Heap {
	private k: number[] = [];
	private v: number[] = [];
	get size() {
		return this.k.length;
	}
	push(key: number, val: number) {
		const k = this.k, v = this.v;
		let i = k.length;
		k.push(key), v.push(val);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (k[p] <= key) break;
			(k[i] = k[p]), (v[i] = v[p]), (i = p);
		}
		(k[i] = key), (v[i] = val);
	}
	pop(): [number, number] {
		const k = this.k, v = this.v;
		const top: [number, number] = [k[0], v[0]];
		const lk = k.pop()!, lv = v.pop()!;
		if (k.length) {
			let i = 0;
			for (;;) {
				let c = 2 * i + 1;
				if (c >= k.length) break;
				if (c + 1 < k.length && k[c + 1] < k[c]) c++;
				if (k[c] >= lk) break;
				(k[i] = k[c]), (v[i] = v[c]), (i = c);
			}
			(k[i] = lk), (v[i] = lv);
		}
		return top;
	}
}

export function drainageTree(edges: Edge[], infra: Infra | null, catchM2: number[] | null): DrainageEdge[] {
	const n = edges.reduce((m, e) => Math.max(m, e.a, e.b), 0) + 1;
	const adj: number[][] = Array.from({ length: n }, () => []);
	edges.forEach((e, i) => (adj[e.a].push(i), adj[e.b].push(i)));

	const outletName = new Map<number, string>();
	for (const p of infra?.pumps ?? []) if (p.outlet === "river" && p.capacity_m3s > 0) outletName.set(p.node, p.name);
	for (const t of infra?.tunnels ?? []) if (t.status === "open") for (const k of t.inlets) outletName.set(k, t.name);
	for (const g of infra?.gravity ?? []) if (!outletName.has(g.node)) outletName.set(g.node, `${g.name} (${g.kind === "sea" ? "sea" : "river"} gate)`);

	// Multi-source Dijkstra from all outlets.
	const dist = new Float64Array(n).fill(Infinity);
	const via = new Int32Array(n).fill(-1); // edge toward the outlet
	const src = new Int32Array(n).fill(-1);
	const heap = new Heap();
	for (const k of outletName.keys()) if (k < n) (dist[k] = 0), (src[k] = k), heap.push(0, k);
	while (heap.size) {
		const [d, u] = heap.pop();
		if (d > dist[u]) continue;
		for (const ei of adj[u]) {
			const e = edges[ei];
			const w = e.a === u ? e.b : e.a;
			const nd = d + e.len_m;
			if (nd < dist[w]) (dist[w] = nd), (via[w] = ei), (src[w] = src[u]), heap.push(nd, w);
		}
	}

	// Accumulate land area downstream, farthest nodes first.
	const acc = Float64Array.from({ length: n }, (_, i) => (catchM2?.[i] ?? 62_500) / 1e6);
	const order = [...Array(n).keys()].filter((i) => Number.isFinite(dist[i])).sort((x, y) => dist[y] - dist[x]);
	for (const u of order) {
		const ei = via[u];
		if (ei < 0) continue;
		const e = edges[ei];
		acc[e.a === u ? e.b : e.a] += acc[u];
	}

	return edges.map((e, i) => {
		const da = dist[e.a], db = dist[e.b];
		if (!Number.isFinite(da) && !Number.isFinite(db)) return { edge: i, coords: e.coords, acc_km2: 0, outlet: null, dist_km: NaN };
		// Downstream end = lower distance to an outlet.
		const toB = db <= da;
		const up = toB ? e.a : e.b, down = toB ? e.b : e.a;
		const onTree = via[up] === i;
		return {
			edge: i,
			coords: toB ? e.coords : [...e.coords].reverse(),
			acc_km2: onTree ? acc[up] : (catchM2?.[up] ?? 62_500) / 1e6,
			outlet: outletName.get(src[down]) ?? null,
			dist_km: dist[down] / 1000,
		};
	});
}

// Runs the simulation off the main thread.
import type { Infra, Scenario, Terrain } from "../../shared/types.ts";
import { buildModel, run, type EdgeIn, type Model, type Params } from "./model.ts";

export interface SimRequest {
	edges: EdgeIn[];
	infra: Infra | null;
	terrain: Terrain | null;
	nodeBanks: (number | null)[] | null; // banks.json, per node
	boundaryNodes: { node: number; width_m: number; gauge: string }[] | null; // boundary.json nodes
	banks: { lon: number; lat: number; bank: number }[];
	scenario: Scenario;
	params: Params;
}

export interface SimResult {
	frames: ReturnType<typeof run>;
	model: Pick<Model, "n" | "bank" | "bed" | "catchArea" | "eWidth" | "tunnels" | "pumpCap">;
	ms: number;
}

let cache: { key: string; model: Model } | null = null;

self.onmessage = (ev: MessageEvent<SimRequest>) => {
	const t0 = performance.now();
	const { edges, infra, terrain, nodeBanks, boundaryNodes, banks, scenario, params } = ev.data;
	// The model only depends on static inputs and a few params; rebuild when they change.
	const key = JSON.stringify([edges.length, infra?.builtFrom, infra?.pumps.length, terrain?.source ?? "flat", nodeBanks?.length ?? 0, boundaryNodes?.length ?? 0, banks.length, params.defaultBank_m, params.defaultDepth_m, params.defaultWidth_m]);
	if (cache?.key !== key) cache = { key, model: buildModel(edges, infra, banks, params, terrain, nodeBanks, boundaryNodes) };
	const model = cache.model;
	const frames = run(model, scenario, params);
	const result: SimResult = {
		frames,
		model: { n: model.n, bank: model.bank, bed: model.bed, catchArea: model.catchArea, eWidth: model.eWidth, tunnels: model.tunnels, pumpCap: model.pumpCap },
		ms: performance.now() - t0,
	};
	self.postMessage(result);
};

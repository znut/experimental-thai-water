// Simulation panel: pick a scenario, tweak a few what-if knobs, run it in a worker, and
// play the result back on the map.
//
// Two models, each shown where it holds up against observations:
//  - the physical canal model (worker): canal levels, flow, pumps, tunnels, gates;
//  - the street-ponding model (ponding.ts): water on roads at known flood spots, fitted on
//    the road sensors and slowed when the physical model's canals are full.
import type * as maplibregl from "maplibre-gl";
import type { Infra, Scenario, Snapshot, Terrain } from "../../shared/types.ts";
import { FloodShade, type Ground } from "../flood.ts";
import { speedClass, type Edge } from "../flow.ts";
import { addMovement, animate, popupOnClick } from "../mapkit.ts";
import { DEFAULT_PARAMS, type Params } from "./model.ts";
import { pondScenario, type PondingFile } from "./ponding.ts";
import type { SimRequest, SimResult } from "./worker.ts";

const fromFile = (id: string, label: string) => ({
	id,
	label,
	load: async (): Promise<Scenario | null> => {
		const r = await fetch(`/data/scenarios/${id}.json`);
		return r.ok ? r.json() : null;
	},
});

const SCENARIOS: { id: string; label: string; load: () => Promise<Scenario | null> }[] = [
	fromFile("rainbomb-2026-09", "Rain bomb, 24–28 Sep 2026 (recorded)"),
	fromFile("storm-2025-05", "Storm, 10–12 May 2025 (recorded)"),
	fromFile("storm-2025-11", "Storm, 2–4 Nov 2025 (recorded)"),
	{
		id: "design-133",
		label: "Design check: 133 mm in 24 h, uniform",
		load: async () => {
			const steps = 72;
			const mm = Array.from({ length: steps }, (_, i) => (i >= 6 && i < 30 ? 133 / 24 : 0));
			return { id: "design-133", title: "133 mm / 24 h", start: "2026-09-26T00:00:00+07:00", step_min: 60, steps, rain: [{ code: "uniform", lon: 100.6, lat: 13.8, mm }], sources: ["synthetic"] };
		},
	},
];

const KNOBS: { key: keyof Params; label: string; min: number; max: number; step: number; unit: string }[] = [
	{ key: "rainScale", label: "Rain ×", min: 0.25, max: 2, step: 0.05, unit: "" },
	{ key: "pipeCap_mm_h", label: "Street drains", min: 20, max: 150, step: 5, unit: " mm/h" },
	{ key: "conveyanceScale", label: "Canal capacity ×", min: 0.25, max: 4, step: 0.25, unit: "" },
	{ key: "pumpScale", label: "Pumps ×", min: 0, max: 2, step: 0.1, unit: "" },
];

const WET_CM = 10; // a road spot counts as flooded from here (same threshold as validation)

interface Spots {
	codes: string[];
	kind: ("sensor" | "report")[]; // road sensor spot, or hotspot fitted from citizen reports
	lon: Float32Array;
	lat: Float32Array;
	depth: Float32Array[]; // model, per step
	observed: (Float32Array | null)[]; // per spot, per step (null = no sensor record)
}

export function setupSim(
	map: maplibregl.Map,
	edges: Edge[],
	level: Snapshot | null,
	networkBuild: string | undefined,
	live: { ground: Ground | null; liveShade: FloodShade | null; wet: unknown[] },
) {
	const root = document.getElementById("sim")!;
	const params: Params = { ...DEFAULT_PARAMS };
	root.innerHTML = `
		<h2>Simulation</h2>
		<select id="sim-scenario">${SCENARIOS.map((s) => `<option value="${s.id}">${s.label}</option>`).join("")}</select>
		${KNOBS.map((k) => `<label class="knob">${k.label} <output id="o-${k.key}"></output>
			<input type="range" id="k-${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${params[k.key]}"></label>`).join("")}
		<label><input type="checkbox" id="k-tunnels" checked> Deep tunnels</label>
		<label><input type="checkbox" id="k-gates" checked> Sea and river gates</label>
		<label><input type="checkbox" id="k-boundary" checked> Water from outside the city edge (recorded)</label>
		<label><input type="checkbox" id="k-terrain" disabled> Ground elevation <span id="terrain-src"></span></label>
		<label><input type="checkbox" id="k-overflow"> Also shade canal-overflow areas (less reliable)</label>
		<button id="sim-run">Run</button> <button id="sim-live" hidden>Back to live</button> <span id="sim-msg"></span>
		<div id="sim-play" hidden>
			<button id="sim-toggle">Pause</button>
			<input type="range" id="sim-time" min="0" value="0">
			<div id="sim-clock"></div>
			<canvas id="sim-chart" width="520" height="200"></canvas>
			<div id="sim-legend"></div>
		</div>`;

	for (const k of KNOBS) {
		const input = root.querySelector<HTMLInputElement>(`#k-${k.key}`)!;
		const out = root.querySelector<HTMLOutputElement>(`#o-${k.key}`)!;
		const sync = () => {
			(params[k.key] as number) = Number(input.value);
			out.textContent = `${input.value}${k.unit}`;
		};
		input.addEventListener("input", sync);
		sync();
	}
	root.querySelector<HTMLInputElement>("#k-tunnels")!.addEventListener("change", (e) => (params.tunnels = (e.target as HTMLInputElement).checked));
	root.querySelector<HTMLInputElement>("#k-gates")!.addEventListener("change", (e) => (params.gates = (e.target as HTMLInputElement).checked));
	root.querySelector<HTMLInputElement>("#k-boundary")!.addEventListener("change", (e) => (params.boundary = (e.target as HTMLInputElement).checked));
	const overflowBox = root.querySelector<HTMLInputElement>("#k-overflow")!;

	// Map layers for the simulation, hidden until a run finishes.
	addMovement(map, "sim", { type: "FeatureCollection", features: [] }, "#08306b", 3, false);
	const shade = live.ground ? new FloodShade(map, "sim-shade", live.ground, false, "canals") : null;
	map.addSource("sim-spots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
	map.addLayer({
		id: "sim-spots",
		type: "circle",
		source: "sim-spots",
		layout: { visibility: "none" },
		filter: [">=", ["get", "model_cm"], 5],
		paint: {
			"circle-color": ["interpolate", ["linear"], ["get", "model_cm"], 5, "#fdae6b", 30, "#e6550d", 60, "#a63603"],
			"circle-radius": ["interpolate", ["linear"], ["get", "model_cm"], 5, 3, 60, 11],
			"circle-opacity": 0.85,
			// Hotspots fitted from citizen reports get a purple rim: their depth scale is borrowed.
			"circle-stroke-color": ["case", ["==", ["get", "kind"], "report"], "#7b3294", "#ffffff"],
			"circle-stroke-width": ["case", ["==", ["get", "kind"], "report"], 1.2, 0.5],
		},
	});
	// Hollow ring = what the road sensor actually recorded at this time.
	map.addLayer({
		id: "sim-spots-obs",
		type: "circle",
		source: "sim-spots",
		layout: { visibility: "none" },
		filter: [">=", ["coalesce", ["get", "observed_cm"], 0], 5],
		paint: {
			"circle-color": "rgba(0,0,0,0)",
			"circle-radius": ["interpolate", ["linear"], ["get", "observed_cm"], 5, 5, 60, 14],
			"circle-stroke-color": "#252525",
			"circle-stroke-width": 1.5,
		},
	});
	// Citizen reports as they arrived during a recorded storm (last 3 h of sim time).
	map.addSource("sim-reports", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
	map.addLayer({
		id: "sim-reports",
		type: "circle",
		source: "sim-reports",
		layout: { visibility: "none" },
		paint: { "circle-color": "#7b3294", "circle-radius": 2.5, "circle-opacity": 0.8 },
	});
	let reportTimes: { t: number; lon: number; lat: number }[] = [];
	const setReports = (sc: Scenario) => {
		reportTimes = (sc.observed?.reports ?? []).map((r) => ({ t: Date.parse(r.time), lon: r.lon, lat: r.lat })).filter((r) => Number.isFinite(r.t));
	};
	const showReports = (iso: string) => {
		const now = Date.parse(iso);
		const recent = reportTimes.filter((r) => r.t <= now && r.t > now - 3 * 3600_000);
		(map.getSource("sim-reports") as maplibregl.GeoJSONSource).setData({
			type: "FeatureCollection",
			features: recent.map((r) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] }, properties: {} })),
		});
		return recent.length;
	};
	popupOnClick(map, "sim-spots");
	popupOnClick(map, "sim-spots-obs");

	const LIVE_IDS = ["measured-slow", "measured-medium", "measured-fast", "inferred-slow", "inferred-medium", "inferred-fast", "flood", "flood-shade"];
	const SIM_IDS = ["sim-shade", "sim-slow", "sim-medium", "sim-fast", "sim-spots", "sim-spots-obs", "sim-reports"];
	const liveVisibility = new Map<string, string>();
	const backToLive = () => {
		clearInterval(timer);
		for (const id of SIM_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
		for (const [id, v] of liveVisibility) map.setLayoutProperty(id, "visibility", v as "visible" | "none");
		root.querySelector<HTMLDivElement>("#sim-play")!.hidden = true;
		root.querySelector<HTMLButtonElement>("#sim-live")!.hidden = true;
	};
	root.querySelector<HTMLButtonElement>("#sim-live")!.addEventListener("click", backToLive);
	animate();

	const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
	const banks = (level?.features ?? [])
		.filter((f) => typeof f.properties.bank_m === "number")
		.map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bank: f.properties.bank_m as number }));
	const edgesIn = edges.map(({ a, b, len_m, width_m, depth_m, coords }) => ({ a, b, len_m, width_m, depth_m, coords }));
	let infra: Infra | null | undefined;
	let pond: PondingFile | null | undefined;
	let hotspots: PondingFile | null | undefined;
	let nodeBanks: (number | null)[] | null | undefined;
	let boundaryNodes: { node: number; width_m: number; gauge: string }[] | null | undefined;

	// Terrain is optional and pluggable (scripts/build-terrain.mjs <provider>); flat land without it.
	let terrain: Terrain | null = null;
	const terrainBox = root.querySelector<HTMLInputElement>("#k-terrain")!;
	const terrainSrc = root.querySelector<HTMLSpanElement>("#terrain-src")!;
	fetch("/data/terrain.json")
		.then((r) => (r.ok ? (r.json() as Promise<Terrain>) : null))
		.then((t) => {
			if (!t) return void (terrainSrc.textContent = "(none built: flat land)");
			if (t.builtFrom !== networkBuild) return void (terrainSrc.textContent = "(stale: rebuild terrain for this network)");
			terrain = t;
			terrainBox.disabled = false;
			// A surface model (buildings, trees) reads metres too high in a city; default it off.
			terrainBox.checked = t.kind === "dtm";
			terrainSrc.textContent = `(${t.label}${t.kind === "dsm" ? ": includes buildings, testing only" : ""})`;
			terrainSrc.title = `${t.license}. ${t.attribution}`;
		});

	const msg = root.querySelector<HTMLSpanElement>("#sim-msg")!;
	root.querySelector<HTMLButtonElement>("#sim-run")!.addEventListener("click", async () => {
		const choice = SCENARIOS.find((s) => s.id === root.querySelector<HTMLSelectElement>("#sim-scenario")!.value)!;
		msg.textContent = "Loading…";
		const scenario = await choice.load();
		if (!scenario) return void (msg.textContent = "Scenario data not built yet.");
		if (infra === undefined) infra = await fetch("/data/infra.json").then((r) => (r.ok ? r.json() : null));
		const loadPond = (url: string) => fetch(url).then((r) => (r.ok ? (r.json() as Promise<PondingFile>) : null)).then((p) => (p?.builtFrom === networkBuild ? p : null));
		if (pond === undefined) pond = await loadPond("/data/ponding.json");
		if (hotspots === undefined) hotspots = await loadPond("/data/hotspots.json");
		if (nodeBanks === undefined)
			nodeBanks = await fetch("/data/banks.json")
				.then((r) => (r.ok ? (r.json() as Promise<{ builtFrom: string; bank: (number | null)[] }>) : null))
				.then((b) => (b && b.builtFrom === networkBuild ? b.bank : null));
		if (boundaryNodes === undefined)
			boundaryNodes = await fetch("/data/boundary.json")
				.then((r) => (r.ok ? (r.json() as Promise<{ builtFrom: string; nodes: { node: number; width_m: number; gauge: string }[] }>) : null))
				.then((b) => (b && b.builtFrom === networkBuild ? b.nodes : null));
		msg.textContent = "Running…";
		const req: SimRequest = { edges: edgesIn, infra: infra ?? null, terrain: terrainBox.checked ? terrain : null, nodeBanks: nodeBanks ?? null, boundaryNodes: boundaryNodes ?? null, banks, scenario, params: { ...params } };
		worker.postMessage(req);
		worker.onmessage = (ev: MessageEvent<SimResult>) => {
			const r = ev.data;
			const spots = pond ? roadSpots(pond, hotspots ?? null, scenario, r) : null;
			setReports(scenario);
			msg.textContent = `${r.frames.length} steps in ${Math.round(r.ms)} ms` + (infra ? "" : " · no pump/tunnel data yet") + (pond ? "" : " · no street-ponding fit for this network");
			play(scenario, r, spots);
		};
	});

	let timer: number | undefined;
	function play(sc: Scenario, r: SimResult, spots: Spots | null) {
		root.querySelector<HTMLDivElement>("#sim-play")!.hidden = false;
		if (!liveVisibility.size)
			for (const id of LIVE_IDS) if (map.getLayer(id)) liveVisibility.set(id, String(map.getLayoutProperty(id, "visibility") ?? "visible"));
		for (const id of LIVE_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
		for (const id of SIM_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
		root.querySelector<HTMLButtonElement>("#sim-live")!.hidden = false;

		const slider = root.querySelector<HTMLInputElement>("#sim-time")!;
		const toggle = root.querySelector<HTMLButtonElement>("#sim-toggle")!;
		slider.max = String(r.frames.length - 1);
		const counts = spots ? spotCounts(spots) : null;
		let i = 0;
		const show = (k: number) => {
			i = k;
			slider.value = String(k);
			drawFrame(map, edges, r, k, shade, spots, overflowBox.checked);
			drawChart(root.querySelector<HTMLCanvasElement>("#sim-chart")!, r, k, counts);
			const f = r.frames[k];
			const when = new Date(f.t).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
			const reportsNow = showReports(f.t);
			root.querySelector("#sim-clock")!.textContent =
				`${when} BKK` +
				(counts ? ` · road sensors flooded: model ${counts.model[k]}, measured ${counts.observed ? counts.observed[k] : "n/a"} · report hotspots wet: ${counts.hotspots[k]}` : "") +
				(reportTimes.length ? ` · citizen reports in last 3 h: ${reportsNow}` : "");
		};
		slider.oninput = () => show(Number(slider.value));
		overflowBox.onchange = () => show(i);
		const start = () => {
			clearInterval(timer);
			timer = window.setInterval(() => show((i + 1) % r.frames.length), 300);
			toggle.textContent = "Pause";
		};
		toggle.onclick = () => {
			if (toggle.textContent === "Pause") clearInterval(timer), (toggle.textContent = "Play");
			else start();
		};
		root.querySelector("#sim-legend")!.innerHTML = legend(r, !!counts?.observed);
		show(0);
		start();
	}
}

/**
 * Street ponding at every road-sensor spot (with its sensor record when the scenario has one)
 * plus every hotspot fitted from citizen reports (no depth record: reports carry no depth).
 */
function roadSpots(pond: PondingFile, hotspots: PondingFile | null, sc: Scenario, r: SimResult): Spots {
	const sim = { level: (k: number) => r.frames[Math.min(k, r.frames.length - 1)].level, bank: r.model.bank };
	const a = pondScenario(pond, sc, sim);
	const b = hotspots ? pondScenario(hotspots, sc, sim) : { codes: [], lon: new Float32Array(), lat: new Float32Array(), depth: a.depth.map(() => new Float32Array()) };
	const obs = new Map((sc.observed?.flood ?? []).map((s) => [s.code, Float32Array.from(s.depth_cm, (v) => v ?? 0)]));
	const cat = (x: Float32Array, y: Float32Array) => { const o = new Float32Array(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
	return {
		codes: [...a.codes, ...b.codes],
		kind: [...a.codes.map(() => "sensor" as const), ...b.codes.map(() => "report" as const)],
		lon: cat(a.lon, b.lon),
		lat: cat(a.lat, b.lat),
		depth: a.depth.map((d, k) => cat(d, b.depth[k])),
		observed: [...a.codes.map((c) => obs.get(c) ?? null), ...b.codes.map(() => null)],
	};
}

function spotCounts(s: Spots) {
	const model = s.depth.map((d) => d.reduce((n, v, j) => n + (s.kind[j] === "sensor" && v >= WET_CM ? 1 : 0), 0));
	const hotspots = s.depth.map((d) => d.reduce((n, v, j) => n + (s.kind[j] === "report" && v >= WET_CM ? 1 : 0), 0));
	const hasObs = s.observed.some(Boolean);
	const observed = hasObs ? s.depth.map((_, k) => s.observed.reduce((n, o) => n + (o && o[k] >= WET_CM ? 1 : 0), 0)) : null;
	return { model, observed, hotspots };
}

function drawFrame(map: maplibregl.Map, edges: Edge[], r: SimResult, k: number, shade: FloodShade | null, spots: Spots | null, overflow: boolean) {
	const f = r.frames[k];
	const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
	edges.forEach((e, i) => {
		const q = f.q[i];
		if (!q) return;
		const depth = Math.max(0.2, (f.level[e.a] + f.level[e.b]) / 2 - (r.model.bed[e.a] + r.model.bed[e.b]) / 2);
		const v = Math.abs(q) / (r.model.eWidth[i] * depth);
		const cls = speedClass(v);
		if (!cls) return;
		features.push({
			type: "Feature",
			geometry: { type: "LineString", coordinates: q > 0 ? e.coords : [...e.coords].reverse() },
			properties: { canal: e.name, flow_m3s: +Math.abs(q).toFixed(2), velocity_ms: +v.toFixed(3), speed: cls, basis: "simulated" },
		});
	});
	(map.getSource("sim") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features });

	const pts: { lon: number; lat: number; depth_cm: number }[] = [];
	if (spots) {
		const spotFeatures = spots.codes.map((code, j) => {
			const model = Math.round(spots.depth[k][j]);
			const o = spots.observed[j];
			if (model >= 5) pts.push({ lon: spots.lon[j], lat: spots.lat[j], depth_cm: model });
			return {
				type: "Feature" as const,
				geometry: { type: "Point" as const, coordinates: [spots.lon[j], spots.lat[j]] },
				properties: { id: code, kind: spots.kind[j], model_cm: model, observed_cm: o ? Math.round(o[k]) : null },
			};
		});
		(map.getSource("sim-spots") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: spotFeatures });
	}
	if (shade) void shade.paintSim(pts, overflow ? f.surface_m : null);
}

const C = { rain: "#756bb1", out: "#31a354", tunnel: "#08519c", model: "#e6550d", obs: "#252525" };

function legend(r: SimResult, observed: boolean) {
	const cap = r.model.tunnels.reduce((s, t) => s + t.cap, 0);
	const pumps = r.model.pumpCap.reduce((s, v) => s + v, 0);
	return `<span style="color:${C.rain}">■ rain in</span> <span style="color:${C.out}">■ pumped + gates out</span>
		<span style="color:${C.tunnel}">■ tunnels (cap ${cap} m³/s)</span><br>
		<span style="color:${C.model}">■ flooded road spots, model</span>${observed ? ` <span style="color:${C.obs}">┄ measured</span>` : ""}<br>
		Map: filled dot = model (purple rim = hotspot from citizen reports), black ring = sensor reading, small purple dot = citizen report in the last 3 h. Pump capacity ${Math.round(pumps)} m³/s.`;
}

function drawChart(cv: HTMLCanvasElement, r: SimResult, k: number, counts: ReturnType<typeof spotCounts> | null) {
	const g = cv.getContext("2d")!;
	const W = cv.width, H = cv.height, P = 4;
	g.clearRect(0, 0, W, H);
	const fr = r.frames;
	const series = {
		rain: fr.map((f) => f.rain_m3s),
		out: fr.map((f) => f.pumped_m3s + (f.gravity_m3s ?? 0)),
		tunnel: fr.map((f) => f.tunnel_m3s.reduce((a, b) => a + b, 0)),
	};
	const maxQ = Math.max(1, ...series.rain, ...series.out, ...series.tunnel);
	const maxS = Math.max(1, ...(counts?.model ?? []), ...(counts?.observed ?? []));
	const x = (i: number) => P + (i / Math.max(1, fr.length - 1)) * (W - 2 * P);
	const line = (vals: number[], max: number, color: string, dash: number[] = []) => {
		g.strokeStyle = color;
		g.lineWidth = 2;
		g.setLineDash(dash);
		g.beginPath();
		vals.forEach((v, i) => (i ? g.lineTo(x(i), H - P - (v / max) * (H - 2 * P)) : g.moveTo(x(i), H - P - (v / max) * (H - 2 * P))));
		g.stroke();
		g.setLineDash([]);
	};
	line(series.rain, maxQ, C.rain);
	line(series.out, maxQ, C.out);
	line(series.tunnel, maxQ, C.tunnel);
	if (counts) {
		line(counts.model, maxS, C.model);
		if (counts.observed) line(counts.observed, maxS, C.obs, [6, 4]);
	}
	g.strokeStyle = "#888";
	g.lineWidth = 1;
	g.beginPath();
	g.moveTo(x(k), 0);
	g.lineTo(x(k), H);
	g.stroke();
	g.fillStyle = "#888";
	g.font = "20px system-ui";
	g.fillText(`${Math.round(maxQ)} m³/s`, P + 4, 22);
	g.textAlign = "right";
	if (counts) g.fillText(`${maxS} spots`, W - P - 4, 22);
}

import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { LAYERS, type Infra, type LayerName, type SensorSnap, type Snapshot, type Status, type Terrain } from "../shared/types.ts";
import { fetchBuilt, fetchLive } from "./data.ts";
import { drainageTree } from "./drainage.ts";
import { FLOOD_LEGEND, FloodShade, loadGround, type Ground } from "./flood.ts";
import { junctions, measuredFlowLines, type Edge } from "./flow.ts";
import { bkkTime } from "./labels.ts";
import { inferredFlowLines, interpolateHeads, knownHeads } from "./infer.ts";
import { addMovement, animate, popupOnClick } from "./mapkit.ts";
import { setupSim } from "./sim/ui.ts";

// MapLibre locates its worker next to its own module file, which Vite's dep
// pre-bundling moves. Let Vite bundle the worker and hand MapLibre the URL.
maplibregl.setWorkerUrl(workerUrl);

type Toggle = { label: string; color: string; on: boolean; ids: string[] };

// Panel groups, most glanceable first. Ids are map layer ids.
const GROUPS: { title: string; items: Record<string, Toggle> }[] = [
	{
		title: "Now",
		items: {
			radar: { label: 'Rain radar, last 2 h (RainViewer)<span id="radar-time"></span>', color: "#2b8cbe", on: true, ids: [] },
			satellite: { label: "Flooded area seen by satellite, last 7 days (GISTDA)", color: "#00a6e8", on: true, ids: ["satellite"] },
			shade: { label: "Estimated flooded area", color: "#e6550d", on: true, ids: ["flood-shade"] },
			flood: { label: "Flooded road sensors", color: "#d62728", on: true, ids: ["flood"] },
			pump: { label: "Pump stations (% running)", color: "#238b45", on: true, ids: ["pump", "pump-label"] },
			river: { label: "River stations, all Thailand (red = over bank)", color: "#b2182b", on: true, ids: ["river", "river-label"] },
			reports: { label: "Citizen flood reports, last 3 days (Traffy)", color: "#7b3294", on: true, ids: ["reports", "reports-heat"] },
			news: { label: "News reports, last 24 h (unverified)", color: "#e7298a", on: true, ids: ["news"] },
		},
	},
	{
		title: "Canals",
		items: {
			canals: { label: "Canals by drainage size", color: "#3182bd", on: true, ids: ["canals"] },
			arrows: { label: "Drainage direction (design)", color: "#08519c", on: true, ids: ["drain-arrows"] },
			measured: { label: "Measured flow (animated)", color: "#08519c", on: true, ids: ["measured-slow", "measured-medium", "measured-fast"] },
			inferred: { label: "Level-gradient flow (experimental)", color: "#9ecae1", on: false, ids: ["inferred-slow", "inferred-medium", "inferred-fast"] },
			junctions: { label: "Canal junctions", color: "#555", on: false, ids: ["junctions"] },
		},
	},
	{
		title: "More sensors",
		items: {
			level: { label: "Canal water levels", color: "#17becf", on: false, ids: ["level"] },
			flow: { label: "Flow stations", color: "#1f77b4", on: false, ids: ["flow"] },
			smallpump: { label: "Small pump wells", color: "#98df8a", on: false, ids: ["smallpump"] },
			rain: { label: "Rain gauges", color: "#9467bd", on: false, ids: ["rain"] },
			dry: { label: "Dry & broken road sensors", color: "#9aa0a6", on: false, ids: [] },
		},
	},
];
const item = (key: string) => GROUPS.flatMap((g) => Object.entries(g.items)).find(([k]) => k === key)![1];

const map = new maplibregl.Map({
	container: "map",
	style: "https://tiles.openfreemap.org/styles/positron",
	center: [100.55, 13.78],
	zoom: 10.5,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

const getJson = async <T>(req: Promise<Response>): Promise<T | null> => {
	const res = await req.catch(() => null);
	return res?.ok ? res.json() : null;
};
const vis = (on: boolean) => (on ? "visible" : "none") as "visible" | "none";

/** Pump status string "1,0,1,-,-,-" (from the Worker) -> running pumps of pump_count. */
function pumpUse(props: Record<string, unknown>): { running: number; pumps: number } {
	const n = Number(props.pump_count) || 0;
	const states = String(props.pumps ?? "").split(",").slice(0, n);
	return { running: states.filter((s) => s === "1").length, pumps: n };
}

// Road flood sensors: only wet, working ones unless "dry & broken" is on.
const WET_FILTER: maplibregl.FilterSpecification = ["all", ["!=", ["get", "status"], "Out of order"], [">", ["coalesce", ["get", "depth_cm"], 0], 0]];

function addSensorLayer(layer: LayerName, snap: Snapshot, sensors: Record<string, SensorSnap>) {
	// Draw canal sensors where they sit on the graph, not at their raw GPS point.
	for (const f of snap.features) {
		const s = sensors[f.properties.id];
		if (s) f.geometry.coordinates = s.at;
	}
	const t = item(layer);
	map.addSource(layer, { type: "geojson", data: snap });

	if (layer === "pump") return addPumpLayer();
	if (layer === "river") return addRiverLayer();
	if (layer === "reports") return addReportsLayer();
	if (layer === "news") return addNewsLayer();
	map.addLayer({
		id: layer,
		type: "circle",
		source: layer,
		layout: { visibility: vis(t.on) },
		...(layer === "flood" ? { filter: WET_FILTER } : {}),
		paint: {
			"circle-color":
				layer === "flood"
					? ["case", ["==", ["get", "status"], "Out of order"], "#9aa0a6", ["==", ["coalesce", ["get", "depth_cm"], 0], 0], "#bdbdbd", t.color]
					: t.color,
			"circle-radius": layer === "flood" ? ["interpolate", ["linear"], ["coalesce", ["get", "depth_cm"], 0], 0, 3, 10, 6, 50, 14] : 5,
			"circle-stroke-color": "#fff",
			"circle-stroke-width": 1,
			"circle-opacity": 0.9,
		},
	});
	popupOnClick(map, layer);
}

// Pump stations: size = capacity, fill = share of pumps running, dark ring = discharges to river.
function addPumpLayer() {
	map.addLayer({
		id: "pump",
		type: "circle",
		source: "pump",
		layout: { visibility: vis(item("pump").on) },
		paint: {
			"circle-radius": ["interpolate", ["linear"], ["sqrt", ["coalesce", ["get", "cap_m3s"], 4]], 1, 4, 5, 8, 12, 15],
			"circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "use_pct"], 0], 0, "#f0f0f0", 1, "#c7e9c0", 50, "#41ab5d", 100, "#00441b"],
			"circle-stroke-color": ["case", ["==", ["get", "outlet"], "river"], "#08306b", "#74c476"],
			"circle-stroke-width": ["case", ["==", ["get", "outlet"], "river"], 2, 1],
		},
	});
	map.addLayer({
		id: "pump-label",
		type: "symbol",
		source: "pump",
		minzoom: 12,
		layout: {
			visibility: vis(item("pump").on),
			"text-field": ["concat", ["to-string", ["get", "running"]], "/", ["to-string", ["get", "pump_count"]]],
			"text-font": ["Noto Sans Regular"],
			"text-size": 11,
			"text-offset": [0, 1.4],
		},
		paint: { "text-color": "#00441b", "text-halo-color": "#fff", "text-halo-width": 1.5 },
	});
	popupOnClick(map, "pump");
}

// Citizen flood reports: density when zoomed out, dots (purple = still open) when zoomed in.
function addReportsLayer() {
	const on = vis(item("reports").on);
	map.addLayer({
		id: "reports-heat",
		type: "heatmap",
		source: "reports",
		maxzoom: 13,
		layout: { visibility: on },
		paint: {
			// Recent reports count most; an open ticket is BMA's backlog, not proof of water now.
			"heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "age_h"], 72], 0, 1, 24, 0.5, 72, 0.15],
			"heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 13, 25],
			"heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.7, 13, 0],
			"heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(123,50,148,0)", 0.3, "rgba(194,165,207,0.6)", 0.7, "rgba(123,50,148,0.8)", 1, "rgb(64,0,75)"],
		},
	});
	map.addLayer({
		id: "reports",
		type: "circle",
		source: "reports",
		minzoom: 11,
		layout: { visibility: on },
		paint: {
			"circle-color": ["case", ["<=", ["coalesce", ["get", "age_h"], 99], 24], "#7b3294", "#c2a5cf"],
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 6],
			"circle-stroke-color": "#fff",
			"circle-stroke-width": 0.8,
			"circle-opacity": ["interpolate", ["linear"], ["coalesce", ["get", "age_h"], 0], 0, 0.95, 24, 0.5, 72, 0.3],
		},
	});
	popupOnClick(map, "reports");
}

// News reports: fill = reported depth (flood-depth colours; grey = no depth given), pink ring =
// second-hand. Placed only at a district or subdistrict: bigger and fainter, it's an area.
function addNewsLayer() {
	const area = ["match", ["get", "precision"], ["district", "province"], 2, "subdistrict", 1, 0] as maplibregl.ExpressionSpecification;
	map.addLayer({
		id: "news",
		type: "circle",
		source: "news",
		layout: { visibility: vis(item("news").on) },
		paint: {
			"circle-color": ["case", ["==", ["get", "reported_cm"], null], "#bdbdbd", ["step", ["get", "reported_cm"], FLOOD_LEGEND[0].css, ...FLOOD_LEGEND.slice(1).flatMap((l) => [l.from_cm, l.css])]],
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 8, ["+", 4, ["*", 3, area]], 14, ["+", 8, ["*", 8, area]]],
			"circle-opacity": ["match", area, 2, 0.35, 1, 0.6, 0.9],
			"circle-stroke-color": item("news").color,
			"circle-stroke-width": 2,
		},
	});
	popupOnClick(map, "news");
}

// River stations nationwide, coloured by ThaiWater situation level (5 = over bank).
function addRiverLayer() {
	const sit = ["coalesce", ["get", "situation"], 0] as maplibregl.ExpressionSpecification;
	map.addLayer({
		id: "river",
		type: "circle",
		source: "river",
		layout: { visibility: vis(item("river").on), "circle-sort-key": sit },
		paint: {
			"circle-color": ["match", sit, 1, "#9ecae1", 2, "#4292c6", 3, "#fdae61", 4, "#f46d43", 5, "#b2182b", "#bdbdbd"],
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["==", sit, 5], 4, 2.5], 10, ["case", ["==", sit, 5], 9, 5]],
			"circle-stroke-color": "#fff",
			"circle-stroke-width": 1,
		},
	});
	map.addLayer({
		id: "river-label",
		type: "symbol",
		source: "river",
		minzoom: 8.5,
		filter: ["!=", ["get", "over_bank_m"], null],
		layout: {
			visibility: vis(item("river").on),
			"text-field": ["concat", "+", ["number-format", ["get", "over_bank_m"], { "max-fraction-digits": 2 }], " m"],
			"text-font": ["Noto Sans Regular"],
			"text-size": 11,
			"text-offset": [0, 1.3],
		},
		paint: { "text-color": "#b2182b", "text-halo-color": "#fff", "text-halo-width": 1.5 },
	});
	popupOnClick(map, "river");
}

function arrowImage() {
	const s = 24, c = document.createElement("canvas");
	c.width = c.height = s;
	const g = c.getContext("2d")!;
	g.fillStyle = "#08519c";
	g.beginPath();
	g.moveTo(6, 5);
	g.lineTo(19, 12);
	g.lineTo(6, 19);
	g.lineTo(9, 12);
	g.closePath();
	g.fill();
	return g.getImageData(0, 0, s, s);
}

/** Canals drawn by the land area draining through them, with arrows toward their outlet. */
function addDrainage(edges: Edge[], infra: Infra | null, terrain: Terrain | null) {
	const tree = drainageTree(edges, infra, terrain?.catch_m2 ?? null);
	const data: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
		type: "FeatureCollection",
		features: tree.map((t) => ({
			type: "Feature",
			geometry: { type: "LineString", coordinates: t.coords },
			properties: {
				canal: edges[t.edge].name,
				width_m: edges[t.edge].width_m,
				drains_km2: +t.acc_km2.toFixed(2),
				to_outlet: t.outlet ?? "none (no pump or tunnel on this canal group)",
				outlet_km: Number.isFinite(t.dist_km) ? +t.dist_km.toFixed(1) : null,
			},
		})),
	};
	map.addSource("canals", { type: "geojson", data });
	const area = ["coalesce", ["get", "drains_km2"], 0] as maplibregl.ExpressionSpecification;
	map.addLayer({
		id: "canals",
		type: "line",
		source: "canals",
		layout: { "line-cap": "round", visibility: vis(item("canals").on) },
		paint: {
			"line-color": ["case", ["==", area, 0], "#bdbdbd", ["interpolate", ["linear"], area, 0.1, "#9ecae1", 5, "#4292c6", 50, "#08519c", 200, "#08306b"]],
			"line-width": ["interpolate", ["linear"], ["zoom"],
				10, ["interpolate", ["linear"], area, 0, 0.4, 5, 1, 50, 2.5, 200, 4],
				15, ["interpolate", ["linear"], area, 0, 1.5, 5, 3, 50, 7, 200, 11]],
		},
	});
	popupOnClick(map, "canals");
	map.addImage("drain-arrow", arrowImage());
	map.addLayer({
		id: "drain-arrows",
		type: "symbol",
		source: "canals",
		// Only bigger canals at city zoom; every canal when zoomed in.
		filter: [">", area, 0],
		layout: {
			visibility: vis(item("arrows").on),
			"symbol-placement": "line",
			"symbol-spacing": ["interpolate", ["linear"], ["zoom"], 10, 400, 15, 120],
			"icon-image": "drain-arrow",
			"icon-size": ["interpolate", ["linear"], area, 0, 0.45, 50, 0.8],
			"icon-allow-overlap": false,
		},
		paint: { "icon-opacity": ["step", ["zoom"], ["case", [">=", area, 5], 0.8, 0], 13, 0.8] },
	});
}

function addJunctions(edges: Edge[]) {
	map.addSource("junctions", { type: "geojson", data: junctions(edges) });
	map.addLayer({
		id: "junctions",
		type: "circle",
		source: "junctions",
		layout: { visibility: vis(item("junctions").on) },
		paint: { "circle-radius": 2, "circle-color": "#555" },
	});
}

// Quick jumps; the four non-Bangkok areas are where the family watch list looks.
const PLACES: { label: string; bounds: [number, number, number, number] }[] = [
	{ label: "Bangkok", bounds: [100.3, 13.48, 100.95, 14.0] },
	{ label: "Chachoengsao", bounds: [100.85, 13.2, 101.95, 13.95] },
	{ label: "Prachin Buri / Kabin Buri", bounds: [101.1, 13.65, 102.2, 14.35] },
	{ label: "Rayong", bounds: [100.95, 12.55, 101.85, 13.1] },
	{ label: "All Thailand", bounds: [97.3, 5.6, 105.7, 20.5] },
];

// Side panel: collapsible; on a phone it starts collapsed and folds away after a place is picked,
// so the map isn't hidden behind it.
const narrow = matchMedia("(max-width: 640px)");
function setPanel(open: boolean) {
	document.getElementById("panel")!.classList.toggle("collapsed", !open);
	const b = document.getElementById("panel-toggle")!;
	b.textContent = open ? "Hide" : "Layers";
	b.setAttribute("aria-expanded", String(open));
}
document.getElementById("panel-toggle")!.onclick = () => setPanel(document.getElementById("panel")!.classList.contains("collapsed"));
setPanel(!narrow.matches);

function renderPlaces() {
	const box = document.getElementById("places")!;
	for (const p of PLACES) {
		const b = document.createElement("button");
		b.textContent = p.label;
		b.onclick = () => {
			map.fitBounds(p.bounds, { padding: 40, duration: 800 });
			if (narrow.matches) setPanel(false);
		};
		box.append(b);
	}
}

function renderToggles() {
	const box = document.getElementById("layers")!;
	for (const g of GROUPS) {
		const h = document.createElement("h3");
		h.textContent = g.title;
		box.append(h);
		for (const [key, t] of Object.entries(g.items)) {
			const el = document.createElement("label");
			el.innerHTML = `<input type="checkbox" ${t.on ? "checked" : ""}><span class="swatch" style="background:${t.color}"></span><span>${t.label}</span>`;
			el.querySelector("input")!.addEventListener("change", (e) => {
				const on = (e.target as HTMLInputElement).checked;
				t.on = on;
				if (key === "dry") return void (map.getLayer("flood") && map.setFilter("flood", on ? null : WET_FILTER));
				for (const id of t.ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(on));
			});
			box.append(el);
		}
	}
	document.getElementById("legend")!.innerHTML =
		`<span>Flood depth:</span>` + FLOOD_LEGEND.map((l) => `<i style="background:${l.css}"></i>${l.from_cm}+`).join("") + " cm";
}

// Rain radar (RainViewer's global composite): the last ~2 h of frames, looped so storm cells
// show which way they move. Free tiles stop at zoom 7, so it's coarse up close.
async function addRadar() {
	const j = await getJson<{ host: string; radar: { past: { time: number; path: string }[] } }>(fetch("https://api.rainviewer.com/public/weather-maps.json"));
	const frames = j?.radar.past ?? [];
	if (!frames.length) return;
	const t = item("radar");
	const below = map.getStyle().layers.find((l) => l.type === "symbol")?.id; // under place names and our layers
	frames.forEach((f, i) => {
		const id = `radar-${i}`;
		map.addSource(id, { type: "raster", tiles: [`${j!.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`], tileSize: 256, maxzoom: 7, attribution: "Radar © RainViewer" });
		map.addLayer({ id, type: "raster", source: id, layout: { visibility: vis(t.on) }, paint: { "raster-opacity": 0, "raster-fade-duration": 0 } }, below);
		t.ids.push(id);
	});
	const time = document.getElementById("radar-time")!;
	let k = 0;
	const tick = () => {
		frames.forEach((_, i) => map.setPaintProperty(`radar-${i}`, "raster-opacity", i === k ? 0.6 : 0));
		time.textContent = `: ${bkkTime(new Date(frames[k].time * 1000).toISOString())}`;
		const last = k === frames.length - 1;
		k = (k + 1) % frames.length;
		setTimeout(tick, last ? 2500 : 500); // hold on the latest frame
	};
	tick();
}

async function renderStatus() {
	const el = document.getElementById("status")!;
	const status = await getJson<Status>(fetchLive("status.json"));
	if (!status) return void (el.textContent = "No data yet: waiting for the first refresh.");
	const times = Object.values(status).map((s) => s?.fetchedAt).filter(Boolean).sort();
	// Name the source's answer: a 404 is the source site down or moved, 403/429 is it refusing us.
	const failed = Object.entries(status)
		.filter(([, s]) => !s?.ok)
		.map(([k, s]) => {
			const code = /HTTP (\d{3})/.exec(s?.error ?? "")?.[1];
			return code === "404" ? `${k} (source page missing)` : code === "403" || code === "429" ? `${k} (source refusing, ${code})` : k;
		});
	// A runner that stops (laptop asleep, run killed) leaves no failure behind, only an old time.
	// Name those layers so a days-old snapshot isn't read as current.
	const stale = Object.entries(status)
		.filter(([k, s]) => s?.ok && Date.now() - Date.parse(s.fetchedAt) > (k === "tide" ? 3 : 0.5) * 3600_000)
		.map(([k, s]) => `${k} (${bkkTime(s!.fetchedAt)})`);
	el.textContent =
		`Updated ${times.length ? bkkTime(times.at(-1)) : "never"}` +
		(failed.length ? ` · no update: ${failed.join(", ")}` : "") +
		(stale.length ? ` · not updating: ${stale.join(", ")}` : "");
	el.classList.toggle("warn", failed.length + stale.length > 0);
}

// GISTDA's satellite flood extent (radar sees through cloud; little inside dense city blocks).
// Tiles come through our Worker, which holds the key (worker/index.ts).
function addSatellite() {
	map.addSource("satellite", { type: "raster", tiles: [`${location.origin}/tiles/gistda/7days/{z}/{x}/{y}`], tileSize: 256, maxzoom: 16, attribution: "Flood extent © GISTDA" });
	map.addLayer({ id: "satellite", type: "raster", source: "satellite", layout: { visibility: vis(item("satellite").on) }, paint: { "raster-opacity": 0.7 } }, map.getStyle().layers.find((l) => l.type === "symbol")?.id);
}

async function init() {
	void addRadar();
	addSatellite();
	const [network, sensors, infra, terrain, ...snaps] = await Promise.all([
		getJson<GeoJSON.FeatureCollection<GeoJSON.LineString> & { build?: string }>(fetchBuilt("network.geojson")),
		getJson<Record<string, SensorSnap>>(fetchBuilt("sensors.json")),
		getJson<Infra>(fetchBuilt("infra.json")),
		getJson<Terrain>(fetchBuilt("terrain.json")),
		...LAYERS.map((l) => getJson<Snapshot>(fetchLive(`${l}.json`))),
	]);
	const snap = (l: LayerName) => snaps[LAYERS.indexOf(l)] ?? null;
	const edges: Edge[] = (network?.features ?? []).map((f) => ({ ...(f.properties as Omit<Edge, "coords">), coords: f.geometry.coordinates as [number, number][] }));
	const ground: Ground | null = await loadGround(network?.build);

	// Shading goes under everything else.
	const shade = ground ? new FloodShade(map, "flood-shade", ground, item("shade").on) : null;
	addDrainage(edges, infra, terrain?.builtFrom === network?.build ? terrain : null);
	addJunctions(edges);

	const flow = snap("flow");
	if (sensors) {
		const measured = flow ? measuredFlowLines(edges, sensors, flow) : { type: "FeatureCollection" as const, features: [] };
		const heads = interpolateHeads(edges, knownHeads(sensors, snap("level")));
		const skip = new Set(measured.features.map((f) => f.properties!.edge as number));
		addMovement(map, "inferred", inferredFlowLines(edges, heads, skip), item("inferred").color, 2, item("inferred").on);
		addMovement(map, "measured", measured, item("measured").color, 3.5, item("measured").on);
		animate();
	}

	// Pump capacity per station: infra.json pumps sharing the station's graph node.
	const capByNode = new Map<number, number>();
	const outletByNode = new Map<number, string>();
	for (const p of infra?.pumps ?? []) {
		capByNode.set(p.node, (capByNode.get(p.node) ?? 0) + p.capacity_m3s);
		if (p.outlet === "river") outletByNode.set(p.node, "river");
	}
	for (const f of snap("pump")?.features ?? []) {
		const s = sensors?.[f.properties.id];
		const cap = s ? capByNode.get(s.node) ?? null : null;
		const u = pumpUse(f.properties);
		Object.assign(f.properties, {
			running: u.running,
			use_pct: u.pumps ? Math.round((100 * u.running) / u.pumps) : 0,
			cap_m3s: cap,
			outlet: s ? outletByNode.get(s.node) ?? "canal" : null,
			lift_m: typeof f.properties.level_out_m === "number" && typeof f.properties.level_in_m === "number" ? +((f.properties.level_out_m as number) - (f.properties.level_in_m as number)).toFixed(2) : null,
		});
	}

	LAYERS.forEach((l) => snap(l) && addSensorLayer(l, snap(l)!, sensors ?? {}));

	const wet = (snap("flood")?.features ?? [])
		.filter((f) => f.properties.status !== "Out of order" && (f.properties.depth_cm as number) > 0)
		.map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth_cm: f.properties.depth_cm as number }));
	await shade?.paintFromSensors(wet);
	if (!ground) document.getElementById("legend")!.insertAdjacentHTML("beforeend", " (flood shading needs ground data)");

	setupSim(map, edges, snap("level"), network?.build, { ground, liveShade: shade, wet });
	await renderStatus();
}

renderPlaces();
renderToggles();
map.on("load", init);

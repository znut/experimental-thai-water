// Small MapLibre helpers shared by the live view and the simulation view.
import * as maplibregl from "maplibre-gl";
import type { SpeedClass } from "./flow.ts";
import { popupHtml } from "./labels.ts";

export function popupOnClick(map: maplibregl.Map, layerId: string) {
	map.on("click", layerId, (e) => {
		const f = e.features?.[0];
		if (!f) return;
		new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(popupHtml(f.properties)).addTo(map);
	});
	map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
	map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
}

// Dash patterns that, stepped through in order, make dashes march along the line direction.
const DASH_STEPS = [
	[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
	[0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];
const STEP_MS: Record<SpeedClass, number> = { slow: 260, medium: 110, fast: 45 };

export const SPEEDS: SpeedClass[] = ["slow", "medium", "fast"];
const animated: { map: maplibregl.Map; id: string; cls: SpeedClass }[] = [];

/** Adds one animated-dash line layer per speed class; ids are `${source}-${class}`. */
export function addMovement(map: maplibregl.Map, source: string, lines: GeoJSON.FeatureCollection, color: string, width: number, visible: boolean) {
	map.addSource(source, { type: "geojson", data: lines });
	for (const cls of SPEEDS) {
		const id = `${source}-${cls}`;
		map.addLayer({
			id,
			type: "line",
			source,
			filter: ["==", ["get", "speed"], cls],
			layout: { "line-cap": "butt", visibility: visible ? "visible" : "none" },
			paint: { "line-color": color, "line-width": width, "line-dasharray": DASH_STEPS[0] },
		});
		popupOnClick(map, id);
		animated.push({ map, id, cls });
	}
}

let running = false;
/** Steps every movement layer's dash pattern at its speed class's rate. Safe to call more than once. */
export function animate() {
	if (running) return;
	running = true;
	const step: Record<SpeedClass, number> = { slow: -1, medium: -1, fast: -1 };
	const tick = (t: number) => {
		for (const cls of SPEEDS) {
			const s = Math.floor(t / STEP_MS[cls]) % DASH_STEPS.length;
			if (s === step[cls]) continue;
			step[cls] = s;
			for (const a of animated) if (a.cls === cls) a.map.setPaintProperty(a.id, "line-dasharray", DASH_STEPS[s]);
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

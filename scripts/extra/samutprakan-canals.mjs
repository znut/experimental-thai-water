// Canals outside Bangkok that take east-Bangkok water to the Gulf (Samut Prakan: Bang Phli,
// Bang Sao Thong, Bang Bo, Mueang east bank, Bang Pu, Khlong Dan), from OpenStreetMap.
// Output: data/extra/canals-samutprakan.geojson in the same schema as data/canals.geojson.
//
// No RID canal GIS was reachable (gis.rid.go.th has no public ArcGIS REST), so widths come from
// OSM `width` where tagged (85 of 2,445 ways) and otherwise from the waterway class:
//   river (big khlongs tagged river in OSM) 20 m, named canal 10 m, unnamed canal 6 m,
//   drain 3 m, ditch 2 m. Depth is left null (the model's default applies).
// The Chao Phraya and Bang Pakong are excluded: the model treats rivers as outside water.
// Parts inside Bangkok are dropped (BMA's own canal layer covers them); each kept run keeps one
// vertex past the border so it reaches the BMA canal it joins.
//
// Run: bun scripts/extra/samutprakan-canals.mjs   (REFRESH=1 to re-query Overpass)
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { overpass } from "../lib/data.mjs";

const BBOX = "13.45,100.55,13.78,101.0";
const snap = new URL("../../data/osm/waterways-samutprakan.json", import.meta.url);
const osm =
	existsSync(snap) && !process.env.REFRESH
		? JSON.parse(await readFile(snap, "utf8"))
		: await overpass("waterways-samutprakan", `[out:json][timeout:120];(way["waterway"~"^(canal|drain|river|ditch)$"](${BBOX}););out geom tags;`);
const boundary = JSON.parse(await readFile(new URL("../../data/osm/bangkok-boundary.json", import.meta.url), "utf8"));

// Bangkok polygon test: even-odd ray casting over all outer member segments (no ring assembly needed).
const segs = [];
for (const m of boundary.elements[0].members)
	if (m.type === "way" && m.role === "outer" && m.geometry)
		for (let i = 0; i < m.geometry.length - 1; i++) segs.push([m.geometry[i].lon, m.geometry[i].lat, m.geometry[i + 1].lon, m.geometry[i + 1].lat]);
function inBangkok(lon, lat) {
	let inside = false;
	for (const [x1, y1, x2, y2] of segs) if (y1 > lat !== y2 > lat && lon < x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
	return inside;
}

const EXCLUDE = /แม่น้ำเจ้าพระยา|แม่น้ำบางปะกง/;
function width(t) {
	const w = parseFloat(String(t.width ?? "").replace(",", "."));
	if (Number.isFinite(w) && w > 0 && w < 200) return w;
	return { river: 20, canal: t.name ? 10 : 6, drain: 3, ditch: 2 }[t.waterway] ?? 4;
}

const features = [];
let id = 100_000, dropped = 0;
for (const w of osm.elements) {
	if (w.type !== "way" || !w.geometry || EXCLUDE.test(w.tags.name ?? "")) continue;
	const pts = w.geometry.map((g) => [+g.lon.toFixed(5), +g.lat.toFixed(5)]);
	const out = pts.map(([lon, lat]) => !inBangkok(lon, lat));
	// Runs of outside vertices, each extended by one vertex across the border.
	for (let i = 0; i < pts.length; ) {
		if (!out[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < pts.length && out[j + 1]) j++;
		const run = pts.slice(Math.max(0, i - 1), Math.min(pts.length, j + 2));
		if (run.length >= 2)
			features.push({
				type: "Feature",
				geometry: { type: "LineString", coordinates: run },
				properties: {
					id: id++,
					name: w.tags.name ?? `(${w.tags.waterway} osm ${w.id})`,
					from: null,
					to: null,
					width_m: String(width(w.tags)),
					depth_m: null,
					source: `OSM way ${w.id} (${w.tags.waterway}${w.tags.width ? `, width ${w.tags.width}` : ", width by class"})`,
				},
			});
		i = j + 1;
	}
	if (out.every((o) => !o)) dropped++;
}

await writeFile(new URL("../../data/extra/canals-samutprakan.geojson", import.meta.url), JSON.stringify({ type: "FeatureCollection", source: "OpenStreetMap (ODbL)", features }));
console.log(`kept ${features.length} canal pieces from ${osm.elements.length} OSM ways; ${dropped} ways entirely inside Bangkok dropped`);

// Downloads the BMA canal network (Drainage MapServer layer 6) into data/canals.geojson (input for build-network).
// Run: node scripts/fetch-canals.mjs
import { writeFile } from "node:fs/promises";

const LAYER = "https://cpudgiapp.bangkok.go.th/arcgis/rest/services/Thematic/Drainage/MapServer/6/query";
const PAGE = 1000;

const blank = (v) => (v === null || String(v).trim() === "" ? null : String(v).trim());

const features = [];
for (let offset = 0; ; offset += PAGE) {
	const q = new URLSearchParams({
		where: "1=1",
		outFields: "OBJECTID,KHONG_NAME,FROM_,TO_,WIDTH_M,DEEP_M",
		outSR: "4326",
		f: "geojson",
		resultOffset: String(offset),
		resultRecordCount: String(PAGE),
		geometryPrecision: "5",
		// About 5 m: plenty for a city-scale map and keeps the file small.
		maxAllowableOffset: "0.00005",
	});
	const res = await fetch(`${LAYER}?${q}`);
	if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${offset}`);
	const page = await res.json();
	for (const f of page.features) {
		const p = f.properties;
		features.push({
			type: "Feature",
			geometry: f.geometry,
			properties: {
				id: p.OBJECTID,
				name: p.KHONG_NAME,
				from: blank(p.FROM_),
				to: blank(p.TO_),
				width_m: blank(p.WIDTH_M),
				depth_m: p.DEEP_M ? Math.abs(p.DEEP_M) : null,
			},
		});
	}
	if (page.features.length < PAGE) break;
}

await writeFile(
	new URL("../data/canals.geojson", import.meta.url),
	JSON.stringify({ type: "FeatureCollection", source: "BMA DDS Drainage MapServer layer 6", features }),
);
console.log(`wrote ${features.length} canals`);

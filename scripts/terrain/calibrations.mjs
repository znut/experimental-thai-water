// Survey points used to correct a DEM's vertical bias. Like providers.mjs, each entry is a
// plug: build-terrain.mjs fits a smooth residual surface (DEM minus survey) and subtracts it.
// Several can be combined: --calibrate bma-spot,bma-benchmark (points are pooled).
//
// Calibration shape: id, label, license, load(bbox) -> Promise<{ lon, lat, z }[]> (z in m MSL)

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CACHE = new URL("../../data/dem/", import.meta.url);

async function arcgisFeatures(url, fields, pageSize, cacheName) {
	const path = new URL(cacheName, CACHE);
	if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
	const rows = [];
	for (let offset = 0; ; offset += pageSize) {
		const q = new URLSearchParams({ where: "1=1", outFields: fields.join(","), outSR: "4326", f: "geojson", resultOffset: String(offset), resultRecordCount: String(pageSize) });
		const res = await fetch(`${url}/query?${q}`);
		if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
		const page = await res.json();
		for (const f of page.features) if (f.geometry) rows.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], ...f.properties });
		if (page.features.length < pageSize) break;
	}
	await mkdir(CACHE, { recursive: true });
	await writeFile(path, JSON.stringify(rows));
	return rows;
}

export const CALIBRATIONS = {
	"bma-spot": {
		id: "bma-spot",
		label: "BMA spot heights 2564 (2021), CPUD basemap",
		// No licence is stated on the service; we use the points only to correct the DEM and do
		// not display or redistribute them. Ask BMA City Planning before doing either.
		license: "not stated (used for calibration only)",
		load: async () =>
			(
				await arcgisFeatures(
					"https://cpudgiapp.bangkok.go.th/arcgis/rest/services/Basemap_Service/CPUD_Basemap_2568/MapServer/1",
					["SP_ELEV"],
					2000,
					"bma_spot_2564_rows.json",
				)
			)
				.filter((r) => typeof r.SP_ELEV === "number")
				.map((r) => ({ lon: r.lon, lat: r.lat, z: r.SP_ELEV })),
	},

	"bma-benchmark": {
		id: "bma-benchmark",
		label: "BMA vertical benchmarks (MSL 2550/2007), non-bridge marks",
		license: "CC BY (data.go.th)",
		// 989 marks: 550 brass pins on bridge footpaths and 379 cast-iron pins on pillars/beams
		// sit on structures above ground; 60 brass pins on drilled pile heads are at ground.
		// Keep pile-head marks plus any mark whose location text doesn't mention a bridge (สะพาน).
		// Heights are from 2007; pile-head marks are anchored deep and don't follow surface
		// subsidence (~1-3 cm/yr), so the ground around them may now sit lower.
		load: async () =>
			(
				await arcgisFeatures(
					`https://bmagis.bangkok.go.th/arcgis/rest/services/Hosted/${encodeURIComponent("หมุดหลักฐานทางดิ่ง")}/FeatureServer/0`,
					["mark_type", "location", "sea_level_2007"],
					2000,
					"bma_benchmarks.json",
				)
			)
				.filter((r) => typeof r.sea_level_2007 === "number")
				.filter((r) => /หัวเข็มเจาะ/.test(r.mark_type ?? "") || !/สะพาน/.test(`${r.mark_type ?? ""} ${r.location ?? ""}`))
				.map((r) => ({ lon: r.lon, lat: r.lat, z: r.sea_level_2007 })),
	},
};

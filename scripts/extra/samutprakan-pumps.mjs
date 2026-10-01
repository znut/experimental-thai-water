// RID coastal pump stations that lift east-Bangkok / Samut Prakan water into the Gulf.
// Output: data/extra/pumps-samutprakan.json [{name, lon, lat, capacity_m3s|null, estimate_m3s?,
// outlet, canal, source}].
//
// Locations: no station coordinates were obtainable (Overpass was down; RID publishes none), so
// each station sits at the sea end of the canal it is named after (the canal vertex nearest the
// open sea in FABDEM). Capacities are cited where a source gives a per-station figure; for the
// rest capacity_m3s is null and estimate_m3s splits the remainder of Thairath's 233 m³/s total
// for the 8 stations RID ran on 30 Sep 2026.
//
// Run: bun scripts/extra/samutprakan-pumps.mjs   (after samutprakan-canals.mjs)
import { readFile, writeFile } from "node:fs/promises";
import { seaMask } from "../lib/data.mjs";

const THAIRATH = "https://www.thairath.co.th/news/local/central/2963198 (30 Sep 2026: 8 stations, 37 pumps, 233 m³/s total)";
const STATIONS = [
	{ name: "สถานีสูบน้ำสุวรรณภูมิ", canal: /สุวรรณภูมิ/, capacity_m3s: 100, source: "Suvarnabhumi drainage project, 4 pumps, max 100 m³/s: sites.google.com/dei.ac.th/nfe-bangpu (สะพานคลองส่งน้ำสุวรรณภูมิ)" },
	{ name: "สถานีสูบน้ำเจริญราษฎร์", canal: /เจริญราษฎร์/, capacity_m3s: 75, source: "5 x 15 m³/s: https://siamrath.co.th/agriculture/38577bc1-b7f9-4718-a267-127b0fe6a826 (2022)" },
	{ name: "สถานีสูบน้ำชลหารพิจิตร 3 (คลองด่าน)", canal: /^คลองด่าน$/, capacity_m3s: 60, source: "4 x 15 m³/s: https://siamrath.co.th/agriculture/38577bc1-b7f9-4718-a267-127b0fe6a826 (2022); another report says 2 x 15" },
	{ name: "สถานีสูบน้ำคลองด่าน 2", canal: /คลองด่าน 2/, capacity_m3s: null, source: THAIRATH },
	{ name: "สถานีสูบน้ำพระยาวิสูตร", canal: /วิสูตร/, capacity_m3s: null, source: THAIRATH },
	{ name: "สถานีสูบน้ำนางหงส์", canal: /นางหง/, capacity_m3s: null, source: THAIRATH },
	{ name: "สถานีสูบน้ำตำหรุ", canal: /ตำหรุ/, capacity_m3s: null, source: THAIRATH },
	{ name: "สถานีสูบน้ำบางปลา", canal: /^คลองบางปลา$/, capacity_m3s: null, source: THAIRATH },
	{ name: "สถานีสูบน้ำบางปลาร้า", canal: /บางปลาร้า/, capacity_m3s: null, source: THAIRATH },
];
// The 8 Thairath stations (not Chonlaharn Phichit 3) total 233 m³/s; split what's left evenly.
const named8 = STATIONS.filter((s) => !/ชลหารพิจิตร/.test(s.name));
const unknown = named8.filter((s) => s.capacity_m3s === null);
const estimate = +((233 - named8.reduce((a, s) => a + (s.capacity_m3s ?? 0), 0)) / unknown.length).toFixed(1);

const canals = JSON.parse(await readFile(new URL("../../data/extra/canals-samutprakan.geojson", import.meta.url), "utf8"));
const { distToSea } = await seaMask();

const out = [], missing = [];
for (const s of STATIONS) {
	let best = null;
	for (const f of canals.features) {
		if (!s.canal.test(f.properties.name)) continue;
		for (const [lon, lat] of f.geometry.coordinates) {
			const d = distToSea(lon, lat, 3000);
			if (!best || d < best.d || (d === best.d && lat < best.lat)) best = { lon, lat, d, canal: f.properties.name };
		}
	}
	if (!best || !Number.isFinite(best.d)) {
		missing.push(s.name);
		continue;
	}
	out.push({
		name: s.name,
		lon: best.lon,
		lat: best.lat,
		capacity_m3s: s.capacity_m3s,
		...(s.capacity_m3s === null && unknown.includes(s) ? { estimate_m3s: estimate } : {}),
		outlet: "sea",
		canal: best.canal,
		source: `${s.source}; location: sea end of ${best.canal} (${Math.round(best.d)} m from open sea)`,
	});
}

await writeFile(new URL("../../data/extra/pumps-samutprakan.json", import.meta.url), JSON.stringify(out, null, "\t"));
console.log(`placed ${out.length} stations; missing ${missing.length}: ${missing.join(", ")}; estimate for unknown capacity ${estimate} m³/s each`);
for (const p of out) console.log(` ${p.name} ${p.lat},${p.lon} cap ${p.capacity_m3s ?? `~${p.estimate_m3s}`} via ${p.canal}`);

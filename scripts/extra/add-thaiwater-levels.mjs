// Adds HII ThaiWater canal-level history to recorded scenarios:
//  - observed.level: every ThaiWater station snapped onto the canal graph (sensors.json source
//    "thaiwater"), used to score the model; covers Samut Prakan and outer Bangkok;
//  - boundary: the outside gauges in boundary.json, used as model INPUT at the city edge. A gauge
//    that drives the boundary is removed from observed.level so the model isn't scored on it.
// Run: bun scripts/extra/add-thaiwater-levels.mjs [scenario-id ...]   (default: all recorded)
import { readdir, readFile, writeFile } from "node:fs/promises";
import { POLITE, cachedJson, pool, settled } from "../lib/data.mjs";

const API = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_graph";
const dir = new URL("../../public/data/scenarios/", import.meta.url);
const sensors = JSON.parse(await readFile(new URL("../../public/data/sensors.json", import.meta.url), "utf8"));
const boundary = JSON.parse(await readFile(new URL("../../public/data/boundary.json", import.meta.url), "utf8").catch(() => '{"gauges":[]}'));
const boundaryCodes = new Set(boundary.gauges.map((g) => g.code));
const stations = Object.entries(sensors).filter(([code, s]) => s.source === "thaiwater" && s.tw_id && !boundaryCodes.has(code));

const ids = process.argv.slice(2).length ? process.argv.slice(2) : (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

const pad = (n) => String(n).padStart(2, "0");
// ThaiWater takes and returns Bangkok local time ("YYYY-MM-DD HH:mm").
const bkk = (ms) => {
	const d = new Date(ms + 7 * 3600_000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const fromBkk = (s) => Date.parse(s.replace(" ", "T") + ":00+07:00");

for (const id of ids) {
	const file = new URL(`${id}.json`, dir);
	const sc = JSON.parse(await readFile(file, "utf8"));
	if (sc.id === "design-133") continue;
	const t0 = Date.parse(sc.start), stepMs = sc.step_min * 60_000, end = t0 + sc.steps * stepMs;
	sc.observed ??= { flood: [], level: [] };
	sc.observed.level ??= [];
	// Re-fetch ThaiWater series every run so datum offsets stay current.
	sc.observed.level = sc.observed.level.filter((l) => !sensors[l.code] || sensors[l.code].source !== "thaiwater");
	const have = new Set(sc.observed.level.map((l) => l.code));

	const history = async (tw_id) => {
		const q = new URLSearchParams({ station_type: "tele_waterlevel", station_id: String(tw_id), start_date: bkk(t0).slice(0, 10), end_date: bkk(end) });
		const j = await cachedJson(`${API}?${q}`, {}, { cache: settled(end) });
		const sum = new Array(sc.steps).fill(0), n = new Array(sc.steps).fill(0);
		for (const r of j.data?.graph_data ?? []) {
			if (typeof r.value !== "number") continue;
			// A reading at time t belongs to the step ending at or after t.
			const k = Math.ceil((fromBkk(r.datetime) - t0) / stepMs) - 1;
			if (k < 0 || k >= sc.steps) continue;
			sum[k] += r.value;
			n[k]++;
		}
		return sum.map((v, k) => (n[k] ? Math.round((v / n[k]) * 100) / 100 : null));
	};

	// Boundary gauges: model input, never scored.
	sc.observed.level = sc.observed.level.filter((l) => !boundaryCodes.has(l.code));
	sc.boundary = (
		await pool(boundary.gauges, POLITE, async (g) => {
			const level_m = await history(g.tw_id);
			return level_m.some((v) => v !== null) ? { code: g.code, lon: g.lon, lat: g.lat, level_m } : null;
		})
	).filter(Boolean);

	const added = (
		await pool(
			stations.filter(([code]) => !have.has(code)),
			POLITE,
			async ([code, s]) => {
				// Put the station on BMA's vertical reference where a co-located BMA gauge gave an offset.
				const off = s.datum_offset_m ?? 0;
				const level_m = (await history(s.tw_id)).map((v) => (v === null ? null : Math.round((v - off) * 100) / 100));
				return level_m.some((v) => v !== null) ? { code, lon: s.at[0], lat: s.at[1], level_m, ...(off ? { datum_offset_m: off } : {}) } : null;
			},
		)
	).filter(Boolean);

	sc.observed.level.push(...added);
	const note = `${API} — HII ThaiWater canal level (m MSL), 10-min readings averaged per step, stations snapped to the canal graph`;
	if (added.length && !sc.sources.includes(note)) sc.sources.push(note);
	await writeFile(file, JSON.stringify(sc));
	const cover = added.map((a) => `${a.code} ${Math.round((100 * a.level_m.filter((v) => v !== null).length) / sc.steps)}%`);
	console.log(`${id}: +${added.length} ThaiWater level stations (${cover.join(", ")}); boundary gauges ${sc.boundary.map((b) => `${b.code} ${Math.round((100 * b.level_m.filter((v) => v !== null).length) / sc.steps)}%`).join(", ")}`);
}

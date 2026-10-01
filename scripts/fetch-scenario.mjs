// Builds public/data/scenarios/rainbomb-2026-09.json: the 24–28 Sep 2026 Bangkok rain event,
// from recorded BMA/HII data, binned to STEP_MIN for replay through the simulation.
// Run: node scripts/fetch-scenario.mjs   (first run ~30 min; raw responses are cached)
// Other events: SCENARIO_ID=storm-2025-05 SCENARIO_START=2025-05-10 SCENARIO_DAYS=3 \
//   SCENARIO_TITLE="..." SCENARIO_SKIP=level,traffy bun scripts/fetch-scenario.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cachedJson, cachedText, pool, toXY } from "./lib/data.mjs";

const ID = process.env.SCENARIO_ID ?? "rainbomb-2026-09";
const START_DAY = process.env.SCENARIO_START ?? "2026-09-24";
const START = Date.parse(`${START_DAY}T00:00:00+07:00`);
const DAYS = Number(process.env.SCENARIO_DAYS ?? 5);
const TITLE = process.env.SCENARIO_TITLE ?? "Bangkok rain bomb, 24–28 Sep 2026";
const SKIP = new Set((process.env.SCENARIO_SKIP ?? "").split(",").filter(Boolean));
const STEP_MIN = 15;
const STEPS = (DAYS * 24 * 60) / STEP_MIN;
const BMA = "https://weather.bangkok.go.th";
const LEVEL_STATIONS = Number(process.env.LEVEL_STATIONS ?? 40);

const sources = [];
const log = (...a) => console.log(...a);

// Step index for an epoch ms (null outside the window). Step i covers [START+i*step, START+(i+1)*step).
const stepOf = (ms) => {
	const i = Math.floor((ms - START) / (STEP_MIN * 60_000));
	return i >= 0 && i < STEPS ? i : null;
};
// BMA tables use "dd/mm/yyyy HH:MM" in the Buddhist year (2569 = 2026), local time.
const bmaTime = (s) => {
	const m = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)$/.exec(s);
	if (!m) return null;
	const year = Number(m[3]) > 2400 ? Number(m[3]) - 543 : Number(m[3]);
	return Date.parse(`${year}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+07:00`);
};
const ymd = (ms) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);
const dmy = (ms) => {
	const d = new Date(ms + 7 * 3600_000);
	return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};
// The BMA history forms reject ranges longer than 3 days, so fetch in chunks.
const CHUNKS = [];
for (let d = 0; d < DAYS; d += 3) CHUNKS.push([START + d * 86400_000, START + Math.min(DAYS, d + 3) * 86400_000 - 5 * 60_000]);
const tableRows = (html, width, codeRe) => {
	const tds = [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1].trim());
	const rows = [];
	for (let i = 0; i < tds.length; i++)
		if (codeRe.test(tds[i]) && bmaTime(tds[i + 3] ?? "") !== null) rows.push(tds.slice(i, i + width)), (i += width - 1);
	return rows;
};
const num = (s) => (s === "" || s === undefined || s === null || Number.isNaN(Number(s)) ? null : Number(s));
const round = (v, d) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const bmaForm = (path, fields) =>
	cachedText(
		`${BMA}${path}`,
		{ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() },
		// ASP.NET error pages come back as HTTP 200; don't cache them.
		{ valid: (t) => !/Object reference not set|Server Error in/.test(t) },
	);

// ---- Rain: BMA DDS gauges, 5-minute history ------------------------------------------------
async function rain() {
	const page = await cachedText(`${BMA}/rain/RainHistory`);
	const stations = JSON.parse(page.match(/var\s+datawater\s*=\s*(\[[\s\S]*?\]);/)[1]).filter((s) => s.latitude && s.longitude);
	log(`rain: ${stations.length} BMA gauges, fetching 5-min history…`);
	let done = 0;
	const series = await pool(stations, 6, async (st) => {
		const mm = new Array(STEPS).fill(null);
		const seen = new Array(STEPS).fill(0);
		for (const [a, b] of CHUNKS) {
			const html = await bmaForm("/rain/RainHistory", {
				datePick_start: dmy(a),
				StationTime_start: "00:00",
				datePick_end: dmy(b),
				StationTime_end: "23:55",
				rain_station: String(st.rain_id),
				rain_station_top: "0",
				rain_data: "1",
				rain_field_selected: "0",
				txtFilter: "0.0",
			});
			// Columns: code, district, name, time, rf5min, rf15min, rf30min, rf1hr, rf3hr, rf6hr, rf12hr, rf24hr
			for (const r of tableRows(html, 12, /^RF\./)) {
				const i = stepOf(bmaTime(r[3]));
				const v = num(r[4]);
				if (i === null || v === null || v < 0) continue;
				mm[i] = (mm[i] ?? 0) + v;
				seen[i]++;
			}
		}
		if (++done % 20 === 0) log(`  rain ${done}/${stations.length}`);
		return { code: st.rain_code, lon: st.longitude, lat: st.latitude, mm: mm.map((v) => round(v, 1)) };
	});
	sources.push(`${BMA}/rain/RainHistory — BMA DDS rain gauges, 5-min rf5min history per station, summed to ${STEP_MIN}-min steps; null = no record in that step`);
	return series.filter((s) => s.mm.some((v) => v !== null));
}

// ---- Chao Phraya level at Bangkok: HII telemetry ---------------------------------------------
async function riverLevel() {
	const tries = [
		[4, "CPY015 Krungthep Bridge (HII)"],
		[2599, "C.12 Samsen (RID)"],
	];
	for (const [id, label] of tries) {
		const j = await cachedJson(
			`https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_graph?station_type=tele_waterlevel&station_id=${id}&start_date=${ymd(START)}&end_date=${ymd(START + (DAYS - 1) * 86400_000)}%2023:59`,
		);
		const sum = new Array(STEPS).fill(0), n = new Array(STEPS).fill(0);
		for (const p of j.data?.graph_data ?? []) {
			const i = stepOf(Date.parse(p.datetime.replace(" ", "T") + ":00+07:00"));
			if (i === null || p.value === null) continue;
			sum[i] += p.value;
			n[i]++;
		}
		const out = sum.map((s, i) => (n[i] ? round(s / n[i], 2) : null));
		if (out.some((v) => v !== null)) {
			sources.push(`api-v3.thaiwater.net waterlevel_graph station ${id} — Chao Phraya at ${label}, m MSL, step mean`);
			return out;
		}
	}
	return undefined;
}

// ---- Road flood sensors: floodbangkok (Directus) 5-min history -----------------------------------
async function floodSensors() {
	const sensors = (await cachedJson(`${BMA}/Flood/PageMap/GetData?id=0`)).dtTbl.filter((r) => r.latitude && r.longitude);
	const depth = new Map(sensors.map((s) => [s.flood_code, new Array(STEPS).fill(0)]));
	const readings = new Map();
	const from = new Date(START).toISOString(), to = new Date(START + DAYS * 86400_000).toISOString();
	// Only non-zero rows are fetched (~54k); every other 5-minute reading in the window was 0.
	for (let page = 1; ; page++) {
		const q = new URLSearchParams({
			"filter[date_created][_between]": `${from},${to}`,
			"filter[value][_neq]": "0.0",
			limit: "20000",
			page: String(page),
		});
		const j = await cachedJson(`https://floodbangkok.bangkok.go.th/api/flood/sensor_flood/history?${q}`);
		for (const r of j.data) {
			const s = depth.get(r.sensor_name);
			const i = stepOf(Date.parse(r.date_created));
			const v = num(r.value);
			if (!s || i === null || v === null) continue;
			s[i] = Math.max(s[i], v);
			if (!readings.has(r.sensor_name)) readings.set(r.sensor_name, []);
			readings.get(r.sensor_name).push(v);
		}
		if (j.data.length < 20000) break;
	}
	// Broken sensors report one constant value (often 20 cm) for days; drop those.
	const stuck = [...readings].filter(([, v]) => v.length >= 200 && new Set(v).size === 1).map(([k]) => k);
	sources.push(
		"floodbangkok.bangkok.go.th /api/flood/sensor_flood/history — BMA road flood sensors (cm), max per step; absent rows = 0; " +
			`dropped ${stuck.length} stuck sensors (constant value ≥ 200 readings): ${stuck.join(" ")}`,
	);
	return sensors
		.filter((s) => !stuck.includes(s.flood_code))
		.map((s) => ({ code: s.flood_code, lon: s.longitude, lat: s.latitude, depth_cm: depth.get(s.flood_code).map((v) => round(v, 1)) }));
}

// ---- Canal water levels: BMA DDS history for a spatial spread of stations ---------------------
async function canalLevels() {
	const klong = (await cachedJson(`${BMA}/Klongmap/GetDataForUpdate`)).waterStation
		.map((r) => r.water_station_info)
		.filter((i) => i?.water_code && i.latitude && i.longitude);
	const snapped = JSON.parse(await readFile(new URL("../public/data/sensors.json", import.meta.url), "utf8"));
	// One station per ~3 km cell, preferring stations already snapped onto the canal graph.
	const cells = new Map();
	for (const s of klong.sort((a, b) => Number(!!snapped[b.water_code]) - Number(!!snapped[a.water_code]))) {
		const [x, y] = toXY([s.longitude, s.latitude]);
		const k = `${Math.floor(x / 3000)},${Math.floor(y / 3000)}`;
		if (!cells.has(k)) cells.set(k, s);
	}
	const chosen = [...cells.values()].slice(0, LEVEL_STATIONS);
	log(`levels: ${chosen.length} of ${klong.length} stations (one per 3 km cell), fetching 5-min history…`);
	let done = 0;
	const out = await pool(chosen, 4, async (st) => {
		const sum = new Array(STEPS).fill(0), n = new Array(STEPS).fill(0);
		for (const [a, b] of CHUNKS) {
			const html = await bmaForm("/water/WaterHistory", {
				datePick_start: dmy(a),
				StationTime_start: "00:00",
				datePick_end: dmy(b),
				StationTime_end: "23:55",
				water_station: String(st.water_id),
				rain_station_top: "0",
				rain_data: "1",
				rain_field_selected: "0",
				txtFilter: "0.0",
			});
			// Columns: code, canal, station, time, level inside, outside, river (m MSL)
			for (const r of tableRows(html, 7, /^WL\./)) {
				const i = stepOf(bmaTime(r[3]));
				const v = num(r[4]);
				if (i === null || v === null || v === -99) continue;
				sum[i] += v;
				n[i]++;
			}
		}
		if (++done % 10 === 0) log(`  levels ${done}/${chosen.length}`);
		return { code: st.water_code, lon: st.longitude, lat: st.latitude, level_m: sum.map((s, i) => (n[i] ? round(s / n[i], 2) : null)) };
	});
	sources.push(`${BMA}/water/WaterHistory — BMA DDS canal water level inside gate (m MSL), step mean, ${chosen.length} stations spread one per ~3 km`);
	return out.filter((s) => s.level_m.some((v) => v !== null));
}

// ---- Citizen flood reports: Traffy Fondue -----------------------------------------------------
async function traffy() {
	const byTicket = new Map();
	for (let d = 0; d <= DAYS; d++) {
		const day = new Date(START + d * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
		for (let offset = 0; ; offset += 1000) {
			const j = await cachedJson(
				`https://publicapi.traffy.in.th/teamchadchart-stat-api/geojson/v1?limit=1000&start=${day}&end=${day}&offset=${offset}`,
			);
			for (const f of j.features ?? []) {
				const p = f.properties;
				if (!p.problem_type_fondue?.includes("น้ำท่วม") || !f.geometry?.coordinates) continue;
				const [lon, lat] = f.geometry.coordinates;
				byTicket.set(p.ticket_id, {
					lon: round(lon, 5),
					lat: round(lat, 5),
					time: p.timestamp,
					hours_open: p.duration_minutes_finished == null ? null : round(p.duration_minutes_finished / 60, 1),
				});
			}
			if ((j.features?.length ?? 0) < 1000) break;
		}
	}
	sources.push(
		`publicapi.traffy.in.th teamchadchart-stat-api — Traffy Fondue citizen reports tagged น้ำท่วม (flood), ${ymd(START)} to ${ymd(START + DAYS * 86400_000)}; location, report time, hours until closed (null if not closed). Credit: Traffy Fondue / BMA`,
	);
	return [...byTicket.values()];
}

const [rainSeries, river, flood, level, reports] = await Promise.all([
	rain(),
	riverLevel(),
	floodSensors(),
	SKIP.has("level") ? [] : canalLevels(),
	SKIP.has("traffy") ? [] : traffy(),
]);

const scenario = {
	id: ID,
	title: TITLE,
	start: `${START_DAY}T00:00:00+07:00`,
	step_min: STEP_MIN,
	steps: STEPS,
	rain: rainSeries,
	river_level_msl: river,
	observed: { flood, level, reports },
	sources,
};
const outDir = new URL("../public/data/scenarios/", import.meta.url);
await mkdir(outDir, { recursive: true });
const json = JSON.stringify(scenario);
await writeFile(new URL(`${ID}.json`, outDir), json);

// Summary
const nonNull = (a) => a.filter((v) => v !== null).length;
const pct = (n, d) => `${((100 * n) / d).toFixed(0)}%`;
const totals = rainSeries.map((s) => ({ code: s.code, total: s.mm.reduce((a, v) => a + (v ?? 0), 0), mm: s.mm }));
const peak = totals.sort((a, b) => b.total - a.total)[0];
const window = (mm, n) => Math.max(...mm.map((_, i) => mm.slice(i, i + n).reduce((a, v) => a + (v ?? 0), 0)));
log(`wrote ${ID}.json (${(json.length / 1e6).toFixed(2)} MB), ${STEPS} steps × ${STEP_MIN} min`);
log(`rain: ${rainSeries.length} gauges, ${pct(rainSeries.reduce((a, s) => a + nonNull(s.mm), 0), rainSeries.length * STEPS)} non-null`);
log(`peak gauge ${peak.code}: ${peak.total.toFixed(0)} mm total, max 24 h ${window(peak.mm, (24 * 60) / STEP_MIN).toFixed(0)} mm, max 48 h ${window(peak.mm, (48 * 60) / STEP_MIN).toFixed(0)} mm`);
const max24 = Math.max(...rainSeries.map((s) => window(s.mm, (24 * 60) / STEP_MIN)));
log(`max 24 h at any gauge: ${max24.toFixed(0)} mm; median gauge total ${totals.map((t) => t.total).sort((a, b) => a - b)[Math.floor(totals.length / 2)].toFixed(0)} mm`);
log(`river: ${river ? `${pct(nonNull(river), STEPS)} non-null, range ${Math.min(...river.filter((v) => v !== null))}..${Math.max(...river.filter((v) => v !== null))} m MSL` : "none"}`);
log(`flood sensors: ${flood.length}, with any depth > 0: ${flood.filter((s) => s.depth_cm.some((v) => v > 0)).length}, max ${Math.max(...flood.flatMap((s) => s.depth_cm))} cm`);
log(`canal levels: ${level.length} stations, ${pct(level.reduce((a, s) => a + nonNull(s.level_m), 0), level.length * STEPS)} non-null`);
log(`traffy reports: ${reports.length}, closed ${reports.filter((r) => r.hours_open !== null).length}`);

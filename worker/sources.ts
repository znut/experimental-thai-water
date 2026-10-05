// Live sources and one refresh, shared by the Worker cron and the laptop mirror
// (scripts/mirror.mjs): both write identical files to R2 (layout in shared/data-layout.ts).
// No Worker-only imports here, so Bun can run it too.
import { KEY, bkkParts } from "../shared/data-layout.ts";
import { LAYERS, type LayerName, type PointFeature, type Props, type Snapshot, type Status } from "../shared/types.ts";

const BMA = "https://weather.bangkok.go.th";
const THAIWATER = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public";
export const TIDE = "https://fews2.hii.or.th/model-output/data_portal/tide_table/summary.txt";
const TRAFFY = "https://publicapi.traffy.in.th/teamchadchart-stat-api/geojson/v1";

// Traffy Fondue state (Thai) -> short English.
const TRAFFY_STATE: Record<string, string> = {
	"รอรับเรื่อง": "waiting",
	"รับเรื่อง": "received",
	"ส่งต่อ": "forwarded",
	"กำลังดำเนินการ": "in progress",
	"เสร็จสิ้น": "resolved",
	"ไม่เกี่ยวข้อง / ยกเลิก": "cancelled",
};
// ThaiWater rain gauges kept for the rain layer: Bangkok and its neighbouring provinces
// (west, south, east, north).
const RAIN_BBOX = [100.1, 13.4, 101.1, 14.3];
// "2026-10-01 21:55:43" is Bangkok time.
const bkkMs = (s: unknown) => (typeof s === "string" ? Date.parse(s.replace(" ", "T") + "+07:00") : NaN);


type Row = Record<string, any>;

async function get(url: string, init?: RequestInit<RequestInitCfProperties>): Promise<Response> {
	const res = await fetch(url, {
		...init,
		headers: { "user-agent": "thai-water-way", accept: "application/json", ...init?.headers },
		signal: AbortSignal.timeout(25_000),
	});
	if (!res.ok) {
		// Who refused and how (a Cloudflare block page names its rule, e.g. "error code: 1010").
		const by = ["server", "cf-mitigated", "retry-after"].map((h) => res.headers.get(h) && `${h}=${res.headers.get(h)}`).filter(Boolean).join(" ");
		const body = (await res.text().catch(() => "")).replace(/<(script|style)[^]*?<\/\1>|<[^>]*>/gi, " ").replace(/\s+/g, " ").trim().slice(0, 200);
		throw new Error(`${url} -> HTTP ${res.status} ${by} ${body}`.trim());
	}
	return res;
}
const getJson = async (url: string, init?: RequestInit<RequestInitCfProperties>): Promise<any> => (await get(url, init)).json();

// "น้ำท่วม" (flooding) as Traffy writes it (non-ASCII escaped), and unescaped in case that changes.
const FLOOD_TAG = ["น้ำท่วม", [..."น้ำท่วม"].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("")];
const FEATURE = '{"type":"Feature"';

/** One Traffy page: its feature count and the features tagged as flooding. Parsing every
 * complaint (~35 MB per refresh, ~3 in 4 not about flooding) was most of the cron's CPU, so the
 * page is cut into features as text and only the ones tagged as flooding are parsed. */
function traffyPage(text: string): { count: number; features: Row[] } {
	try {
		const parts = text.split(FEATURE);
		const count = Number(/"count":(\d+)/.exec(parts[0])?.[1]);
		if (parts.length - 1 !== count) throw new Error("unexpected layout");
		const features: Row[] = [];
		for (let i = 1; i < parts.length; i++) {
			const p = parts[i];
			// Its tags (problem_type_fondue) come first in the properties; free text mentioning
			// flooding doesn't count.
			const at = p.indexOf('"problem_type_fondue":[');
			const tags = at < 0 ? "" : p.slice(at, p.indexOf("]", at));
			if (!FLOOD_TAG.some((t) => tags.includes(t))) continue;
			// Drop the separator: "," between features, "]}" after the last.
			features.push(JSON.parse(FEATURE + p.slice(0, i < count ? -1 : p.lastIndexOf("]"))));
		}
		return { count, features };
	} catch {
		// Layout changed (spacing, key order): parse it all rather than lose reports.
		const j = JSON.parse(text);
		return { count: j.features?.length ?? 0, features: j.features ?? [] };
	}
}

// BMA timestamps come as "/Date(1790852400000)/".
function msDate(v: unknown): string | null {
	const m = typeof v === "string" && /\/Date\((\d+)\)\//.exec(v);
	return m ? new Date(Number(m[1])).toISOString() : null;
}

function num(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function point(lat: unknown, lon: unknown, properties: PointFeature["properties"]): PointFeature | null {
	const y = num(lat), x = num(lon);
	if (y === null || x === null || (y === 0 && x === 0)) return null;
	return { type: "Feature", geometry: { type: "Point", coordinates: [x, y] }, properties };
}

const pumpStates = (r: Row, n: number) =>
	Array.from({ length: n }, (_, i) => r[`pump_status${i + 1}`] ?? "-").join(",");

// Each source returns point features for one layer.
// `every`: refresh interval in minutes (default 5), matched to how often the source changes, so
// slow or bulky sources aren't re-downloaded every run (polite use, less CPU).
export const SOURCES: Record<LayerName, { source: string; every?: number; load: () => Promise<(PointFeature | null)[]> }> = {
	flood: {
		source: "BMA DDS road flood sensors",
		load: async () => {
			const j = await getJson(`${BMA}/Flood/PageMap/GetData?id=0`);
			return (j.dtTbl as Row[]).map((r) =>
				point(r.latitude, r.longitude, {
					id: r.flood_code,
					name: r.flood_name_en || r.flood_name,
					depth_cm: num(r.flood),
					max_cm: num(r.flood_max),
					status: r.chkStatustxt_en ?? null,
					time: msDate(r.site_timestamp),
				}),
			);
		},
	},
	pump: {
		source: "BMA DDS main pump stations",
		load: async () => {
			const j = await getJson(`${BMA}/Station/Map/GetData?id=0`);
			return (j.LastPump as Row[]).map((r) =>
				point(r.latitude, r.longitude, {
					id: r.pumpStation_code,
					name: r.pumpStation_name_en || r.pumpStation_name,
					pump_count: num(r.pump_count),
					pumps: pumpStates(r, 6),
					level_in_m: num(r.water_level),
					level_out_m: num(r.water_level_out),
					time: msDate(r.site_timestamp_last),
				}),
			);
		},
	},
	smallpump: {
		source: "BMA DDS small pump wells",
		load: async () => {
			const j = await getJson(`${BMA}/Pump/Map/GetData?id=0`);
			return (j.LastPump as Row[]).map((r) =>
				point(r.latitude, r.longitude, {
					id: r.pumpStation_code,
					name: r.pumpStation_name_en || r.pumpStation_name,
					pump_count: num(r.pump_count),
					pumps: pumpStates(r, 5),
					level_m: num(r.water_level),
					time: msDate(r.site_timestamp_last),
				}),
			);
		},
	},
	flow: {
		source: "BMA DDS canal flow stations",
		load: async () => {
			const j = await getJson(`${BMA}/flow/PageMap/GetData?id=0`);
			return (j.dtStn as Row[]).map((r) =>
				point(r.latitude, r.longitude, {
					id: r.flow_code,
					name: r.flow_name_en || r.flow_name,
					flow_m3s: num(r.flow),
					level_m: num(r.wl),
					velocity_ms: num(r.mean_velocity),
					warning_m: num(r.warning),
					critical_m: num(r.critical),
					time: msDate(r.site_timestamp),
				}),
			);
		},
	},
	level: {
		source: "BMA DDS canal water levels",
		load: async () => {
			const j = await getJson(`${BMA}/Klongmap/GetDataForUpdate`);
			return (j.waterStation as Row[])
				.filter((r) => r.water_station_info?.water_code)
				.map(({ water_station_info: i, water_level_last: v }) => {
					// -99 means "no sensor on this side of the gate".
					const wl = (x: unknown) => (num(x) === -99 ? null : num(x));
					return point(i.latitude, i.longitude, {
						id: i.water_code,
						name: i.water_shortname_en || i.water_name,
						canal: i.river_name ?? null,
						level_in_m: wl(v?.wl_in),
						level_out_m: wl(v?.wl_out01),
						bank_m: num(Math.min(i.left_bank ?? Infinity, i.right_bank ?? Infinity)),
						bed_m: num(i.bed_bank),
						warning_m: num(i.warning),
						critical_m: num(i.critical),
						time: msDate(v?.site_timestamp),
					});
				});
		},
	},
	rain: {
		source: "BMA DDS rain gauges + ThaiWater gauges (HII, TMD, DWR, …) in and around Bangkok",
		load: async () => {
			const [rows, tw] = await Promise.all([
				getJson(`${BMA}/rain/PageMap/GetDataForUpdate`, { method: "POST", body: "" }) as Promise<Row[]>,
				// Fills gaps outside BMA's network (Samut Prakan, Nonthaburi, …). Optional: BMA alone
				// is still a useful layer, so a ThaiWater failure only drops these gauges.
				// Nationwide (~4 MB) and updated about hourly: let Cloudflare's cache answer between updates.
				getJson(`${THAIWATER}/rain_24h`, { cf: { cacheTtl: 900, cacheEverything: true } }).catch((e) => (console.warn("thaiwater rain_24h", String(e)), { data: [] })),
			]);
			const bma = rows.map((r) =>
				point(r.latitude, r.longitude, {
					id: r.rain_code,
					name: r.rain_name_en || r.rain_name,
					agency: "BMA",
					rf1hr_mm: num(r.rf1hr),
					rf3hr_mm: num(r.rf3hr),
					rf24hr_mm: num(r.rf24hr),
					time: msDate(r.site_timestamp),
				}),
			);
			const [w, s, e, n] = RAIN_BBOX;
			const others = (tw.data as Row[])
				.filter((r) => {
					const lon = num(r.station?.tele_station_long), lat = num(r.station?.tele_station_lat);
					return lon !== null && lat !== null && lon >= w && lon <= e && lat >= s && lat <= n;
				})
				.map((r) => {
					const at = bkkMs(r.rainfall_datetime);
					return point(r.station.tele_station_lat, r.station.tele_station_long, {
						id: r.station.tele_station_oldcode || String(r.station.id),
						name: r.station.tele_station_name?.en || r.station.tele_station_name?.th,
						agency: r.agency?.agency_shortname?.en ?? null,
						rf1hr_mm: num(r.rain_1h), // TMD stations report 24 h only
						rf3hr_mm: null,
						rf24hr_mm: num(r.rain_24h),
						time: Number.isFinite(at) ? new Date(at).toISOString() : null,
					});
				});
			return [...bma, ...others];
		},
	},
	reports: {
		source: "Traffy Fondue citizen flood reports (BMA / NECTEC)",
		// The API can't filter by type: 3 days is ~8 pages (~35 MB) of all complaints. Its
		// problem_type filter matches the whole tag list exactly, so "อื่นๆ,น้ำท่วม" (other +
		// flooding, ~1 in 5 flood reports) can't be asked for.
		every: 15,
		load: async () => {
			// Last 3 days; keep reports still open plus anything from the last 24 h. Photos and
			// free text are personal and not ours to re-host, so only location, state and times.
			const now = Date.now();
			const day = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);
			const rows: Row[] = [];
			for (let offset = 0; offset < 10_000; offset += 1000) {
				const page = traffyPage(await (await get(`${TRAFFY}?limit=1000&offset=${offset}&start=${day(now - 3 * 86400_000)}&end=${day(now)}`)).text());
				rows.push(...page.features);
				if (page.count < 1000) break;
			}
			return rows
				.filter((f) => JSON.stringify(f.properties?.problem_type_fondue ?? "").includes("น้ำท่วม"))
				.map((f) => {
					const p = f.properties;
					const at = bkkMs(p.timestamp);
					const state = TRAFFY_STATE[p.state] ?? p.state;
					const open = !["resolved", "cancelled"].includes(state);
					if (!open && now - at > 86400_000) return null;
					return point(f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0], {
						id: p.ticket_id,
						name: [...new Set([p.subdistrict, p.district].filter(Boolean))].join(", ") || "Flood report",
						district: p.district ?? null,
						state,
						open,
						age_h: Number.isFinite(at) ? Math.round((now - at) / 360_000) / 10 : null,
						hours_to_close: typeof p.duration_minutes_finished === "number" ? Math.round(p.duration_minutes_finished / 6) / 10 : null,
						time: Number.isFinite(at) ? new Date(at).toISOString() : null,
					});
				});
		},
	},
	river: {
		source: "HII ThaiWater telemetry, all Thailand (incl. RID)",
		every: 10,
		load: async () => {
			const j = await getJson(`${THAIWATER}/waterlevel_load`);
			return (j.waterlevel_data.data as Row[]).map((r) =>
					point(r.station?.tele_station_lat, r.station?.tele_station_long, {
						id: r.station?.tele_station_oldcode || String(r.station?.id),
						name: r.station?.tele_station_name?.en || r.station?.tele_station_name?.th,
						river: r.river_name ?? null,
						level_msl: num(r.waterlevel_msl),
						bank_msl: num(r.station?.min_bank),
						discharge_m3s: num(r.discharge),
						// ThaiWater situation 1-5; 5 = over bank ("ล้นตลิ่ง").
						situation: num(r.situation_level),
						over_bank_m: r.diff_wl_bank_text?.startsWith("ล้น") ? num(r.diff_wl_bank) : null,
						province: r.geocode?.province_name?.en ?? null,
						district: r.geocode?.amphoe_name?.en ?? null,
						time: r.waterlevel_datetime ?? null,
					}),
				);
		},
	},
};

// Which runner refreshes each source; a file is only ever written by one of them. BMA's site
// (behind Cloudflare) answers Workers with 403 and ThaiWater rate-limits Cloudflare's shared
// addresses (429), so those run from the laptop. "tide" is the HII tide table.
export type Runner = "worker" | "laptop";
export const RUNS_ON: Record<LayerName | "tide", Runner> = {
	flood: "worker", // retest 2026-10-05: see the cron logs
	pump: "worker", // retest 2026-10-05: see the cron logs
	smallpump: "worker", // retest 2026-10-05: see the cron logs
	flow: "worker", // retest 2026-10-05: see the cron logs
	level: "worker", // retest 2026-10-05: see the cron logs
	rain: "worker", // retest 2026-10-05: see the cron logs
	river: "worker", // retest 2026-10-05: see the cron logs
	reports: "worker",
	tide: "worker",
};

/** Sources due at this time for a runner. Runs are every 5 min; a source is due when the
 * (5-min rounded) minute is a multiple of its interval; the tide table hourly. */
export function due(ms: number, runner: Runner): { layers: LayerName[]; tide: boolean } {
	const minute = Math.round(new Date(ms).getUTCMinutes() / 5) * 5;
	return {
		layers: LAYERS.filter((l) => RUNS_ON[l] === runner && minute % (SOURCES[l].every ?? 5) === 0),
		tide: RUNS_ON.tide === runner && minute % 60 === 0,
	};
}

// Where a refresh writes: the R2 binding in the Worker, R2's S3 API on the laptop.
export interface Store {
	get(key: string): Promise<string | null>;
	put(key: string, body: string, contentType: string, cacheControl: string): Promise<unknown>;
}

// Cache lifetimes for written objects (the data domain's Cache Rules set the same).
const LIVE_CACHE = "public, max-age=60, stale-while-revalidate=300";
const RAW_CACHE = "public, max-age=86400";

// One refresh: latest snapshot per layer to live/, the same bytes to the raw archive. Returns
// this run's results (live/status.json gets them merged with the other runner's).
export async function refresh(store: Store, layers: readonly LayerName[], tide: boolean): Promise<Status> {
	const now = Date.now();
	const fetchedAt = new Date(now).toISOString();
	const { day, hhmm } = bkkParts(now);
	const results: Status = {};

	await Promise.all([
		...layers.map(async (layer) => {
			try {
				const features = (await SOURCES[layer].load()).filter((f): f is PointFeature => f !== null);
				const snap: Snapshot = { type: "FeatureCollection", layer, source: SOURCES[layer].source, fetchedAt, features };
				const body = JSON.stringify(snap);
				await Promise.all([
					store.put(KEY.live(`${layer}.json`), body, "application/json", LIVE_CACHE),
					store.put(KEY.raw(layer, day, hhmm), body, "application/json", RAW_CACHE),
				]);
				results[layer] = { ok: true, fetchedAt, count: features.length };
			} catch (e) {
				// Keep the last good snapshot; just record the failure.
				results[layer] = { ok: false, fetchedAt, error: String(e) };
			}
		}),
		tide &&
			(async () => {
				try {
					const res = await fetch(TIDE, { signal: AbortSignal.timeout(25_000) });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					await store.put(KEY.live("tide.txt"), await res.text(), "text/plain; charset=utf-8", LIVE_CACHE);
					results.tide = { ok: true, fetchedAt };
				} catch (e) {
					results.tide = { ok: false, fetchedAt, error: String(e) };
				}
			})(),
	]);

	// Merge into the shared status file. Both runners write it; the laptop runs offset from the
	// cron (scripts/mirror.mjs), so the read-merge-write windows don't overlap.
	const prev: Status = JSON.parse((await store.get(KEY.live("status.json"))) ?? "{}");
	await store.put(KEY.live("status.json"), JSON.stringify({ ...prev, ...results }), "application/json", LIVE_CACHE);
	return results;
}

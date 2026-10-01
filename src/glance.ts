// "Right now" summary card: the few numbers that answer "is Bangkok flooding and is the
// drainage keeping up" without reading the map.
import type { Snapshot } from "../shared/types.ts";

export interface PumpUse {
	running: number;
	pumps: number;
	cap_m3s: number | null; // capacity of the station from infra.json, if matched
}

/** Pump status string "1,0,1,-,-,-" (from the Worker) -> running pumps of pump_count. */
export function pumpUse(props: Record<string, unknown>, cap: number | null): PumpUse {
	const n = Number(props.pump_count) || 0;
	const states = String(props.pumps ?? "").split(",").slice(0, n);
	return { running: states.filter((s) => s === "1").length, pumps: n, cap_m3s: cap };
}

interface Tide {
	name: string;
	now_m: number;
	high_m: number;
	high_at: string;
}

/** HII tide table CSV: today's 4-hourly predictions per Navy station. */
export function parseTide(csv: string, code: string, now = new Date()): Tide | null {
	const [head, ...rows] = csv.trim().split("\n").map((l) => l.split(","));
	const row = rows.find((r) => r[0] === code);
	if (!row) return null;
	const col = (name: string) => head.indexOf(name);
	const hours = [0, 4, 8, 12, 16, 20];
	const vals = hours.map((h) => Number(row[col(`time_${String(h).padStart(2, "0")}00`)]));
	const bkk = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
	const hr = bkk.getHours() + bkk.getMinutes() / 60;
	const k = Math.min(5, Math.floor(hr / 4));
	// After 20:00 there is no later point today; hold the 20:00 value.
	const now_m = k === 5 ? vals[5] : vals[k] + ((vals[k + 1] - vals[k]) * (hr - hours[k])) / 4;
	return { name: row[2], now_m, high_m: Number(row[col("max_value")]), high_at: row[col("max_time")] };
}

// Areas outside Bangkok that we watch (province/district names as ThaiWater spells them).
const WATCH = [
	{ label: "Kabin Buri", province: "Prachin Buri", district: "Kabin Buri District" },
	{ label: "Prachin Buri (all)", province: "Prachin Buri" },
	{ label: "Chachoengsao", province: "Chachoengsao" },
	{ label: "Rayong", province: "Rayong" },
];

const fmt = (v: number, d = 2) => (v >= 0 ? "+" : "") + v.toFixed(d);

export function renderGlance(
	el: HTMLElement,
	d: { flood?: Snapshot | null; pump?: Snapshot | null; river?: Snapshot | null; rain?: Snapshot | null; reports?: Snapshot | null; tide?: string | null; caps: Map<string, number> },
) {
	const lines: string[] = [];

	const wet = (d.flood?.features ?? [])
		.map((f) => f.properties)
		.filter((p) => p.status !== "Out of order" && typeof p.depth_cm === "number" && p.depth_cm > 0)
		.sort((a, b) => (b.depth_cm as number) - (a.depth_cm as number));
	lines.push(
		wet.length
			? `<b class="bad">${wet.length} roads flooded</b> · deepest ${wet[0].depth_cm} cm, ${wet[0].name}`
			: `<b class="ok">No road flooding</b> on ${d.flood?.features.length ?? 0} sensors`,
	);

	// Citizen reports: how many people are reporting flooding, and where most.
	const reps = (d.reports?.features ?? []).map((f) => f.properties);
	if (reps.length) {
		const recent = reps.filter((p) => typeof p.age_h === "number" && (p.age_h as number) <= 24);
		const open = reps.filter((p) => p.open);
		const byDistrict = new Map<string, number>();
		for (const p of recent) {
			const dist = String(p.district ?? "");
			byDistrict.set(dist, (byDistrict.get(dist) ?? 0) + 1);
		}
		const top = [...byDistrict].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ");
		lines.push(`<b class="${recent.length > 20 ? "bad" : "ok"}">${recent.length} flood reports in 24 h</b> (${open.length} tickets from the last 3 days not yet closed)${top ? ` · most in ${top}` : ""}`);
	}

	let running = 0, pumps = 0, capOn = 0, capAll = 0;
	for (const f of d.pump?.features ?? []) {
		const u = pumpUse(f.properties, d.caps.get(f.properties.id) ?? null);
		running += u.running;
		pumps += u.pumps;
		if (u.cap_m3s && u.pumps) (capOn += (u.cap_m3s * u.running) / u.pumps), (capAll += u.cap_m3s);
	}
	if (pumps)
		lines.push(
			`Pumps: <b>${running} of ${pumps}</b> running` + (capAll ? ` · ~${Math.round(capOn)} of ${Math.round(capAll)} m³/s capacity (${Math.round((100 * capOn) / capAll)}%)` : ""),
		);

	const rain = (d.rain?.features ?? []).map((f) => f.properties).filter((p) => typeof p.rf24hr_mm === "number");
	if (rain.length) {
		const top = rain.reduce((a, b) => ((b.rf24hr_mm as number) > (a.rf24hr_mm as number) ? b : a));
		const hr = Math.max(...rain.map((p) => (p.rf1hr_mm as number) ?? 0));
		lines.push(`Rain: max ${hr} mm last hour · ${top.rf24hr_mm} mm in 24 h at ${top.name}`);
	}

	// Chao Phraya at Bangkok: how far below its bank, i.e. how much room pumps are lifting into.
	const river = (d.river?.features ?? []).map((f) => f.properties);
	const gauge = river.find((p) => p.id === "C.12") ?? river.find((p) => p.id === "CPY015");
	if (gauge && typeof gauge.level_msl === "number" && typeof gauge.bank_msl === "number") {
		const room = (gauge.bank_msl as number) - (gauge.level_msl as number);
		lines.push(
			`Chao Phraya at ${gauge.id === "C.12" ? "Samsen" : "Krungthep Br."}: ${gauge.level_msl} m MSL · <b class="${room < 0.3 ? "bad" : "ok"}">${room.toFixed(2)} m below bank</b>`,
		);
	}

	const tide = d.tide ? parseTide(d.tide, "N03") : null;
	if (tide) lines.push(`Sea at river mouth (forecast tide): ${fmt(tide.now_m)} m now · high ${fmt(tide.high_m)} m at ${tide.high_at}`);

	// Watch areas outside Bangkok: river stations over their bank right now.
	const watch = WATCH.map((w) => {
		const st = river.filter((p) => p.province === w.province && (!w.district || p.district === w.district));
		const over = st.filter((p) => typeof p.over_bank_m === "number").sort((a, b) => (b.over_bank_m as number) - (a.over_bank_m as number));
		return over.length
			? `<b class="bad">${w.label}: ${over.length} of ${st.length} river stations over bank</b> · up to +${(over[0].over_bank_m as number).toFixed(2)} m (${over[0].id}, ${over[0].district})`
			: `<b class="ok">${w.label}: no station over bank</b> (${st.length} stations)`;
	});

	el.innerHTML = lines.map((l) => `<div>${l}</div>`).join("") + `<div class="watch">${watch.map((l) => `<div>${l}</div>`).join("")}</div>`;
}

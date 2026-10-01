// Human-readable popups: label, unit and formatting per property key (shared by every layer).

const BKK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** "2026-10-01T13:10:14Z" -> "1 Oct, 20:10 BKK". ThaiWater's "2026-10-01 20:00" is already Bangkok time. */
export function bkkTime(v: unknown): string {
	const s = String(v);
	const local = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s);
	const d = new Date(local ? s.replace(" ", "T") + ":00+07:00" : s);
	return Number.isNaN(d.getTime()) ? s : `${BKK.format(d)} BKK`;
}

const m = (v: number) => `${v.toFixed(2)} m`;
const signedM = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} m`;
const msl = (v: number) => `${signedM(v)} MSL`;

// ThaiWater situation levels.
const SITUATION: Record<number, string> = { 1: "Very low", 2: "Low", 3: "Normal", 4: "High", 5: "Over the bank" };
const SPEED: Record<string, string> = { slow: "Slow (< 0.05 m/s)", medium: "Moderate (0.05–0.2 m/s)", fast: "Fast (> 0.2 m/s)" };

// html: the formatter builds markup from numbers only; every other value is escaped.
type Fmt = { label: string; fmt?: (v: any, p: Record<string, any>) => string | null; html?: true };

const FIELDS: Record<string, Fmt> = {
	// road flood sensors
	depth_cm: { label: "Water on road", fmt: (v) => `${v} cm` },
	max_cm: { label: "Highest today", fmt: (v) => `${v} cm` },
	status: { label: "Sensor" },
	// pumps
	running: {
		label: "Pumps running",
		fmt: (v, p) => {
			const states = String(p.pumps ?? "").split(",").slice(0, Number(p.pump_count) || 0);
			const dots = states.map((s) => (s === "1" ? "●" : "○")).join(" ");
			return `${Number(v)} of ${Number(p.pump_count)} ${dots ? `<span class="dots">${dots}</span>` : ""}`;
		},
		html: true,
	},
	cap_m3s: { label: "Capacity", fmt: (v, p) => `${v} m³/s` + (typeof p.use_pct === "number" && p.cap_m3s ? ` · ~${Math.round((v * p.use_pct) / 100)} m³/s in use` : "") },
	outlet: { label: "Pumps into", fmt: (v) => (v === "river" ? "Chao Phraya / sea (leaves the city)" : "Another canal") },
	level_in_m: { label: "Water level, canal side", fmt: msl },
	level_out_m: { label: "Water level, outside", fmt: msl },
	lift_m: { label: "Lifting water by", fmt: m },
	level_m: { label: "Water level", fmt: msl },
	// flow stations / animated canals
	flow_m3s: { label: "Flow", fmt: (v) => `${Math.abs(v)} m³/s` },
	velocity_ms: { label: "Speed", fmt: (v) => `${Math.abs(v).toFixed(2)} m/s` },
	v_est_ms: { label: "Estimated speed", fmt: (v) => `${v.toFixed(2)} m/s` },
	speed: { label: "Speed class", fmt: (v) => SPEED[v] ?? v },
	basis: { label: "Based on" },
	station: { label: "Measured at" },
	level_from_m: { label: "Level upstream", fmt: msl },
	level_to_m: { label: "Level downstream", fmt: msl },
	slope_cm_per_km: { label: "Water slope", fmt: (v) => `${v} cm per km` },
	warning_m: { label: "Warning level", fmt: msl },
	critical_m: { label: "Critical level", fmt: msl },
	// canal water level stations
	canal: { label: "Canal" },
	bank_m: { label: "Bank top", fmt: msl },
	bed_m: { label: "Canal bed", fmt: msl },
	// rain
	rf1hr_mm: { label: "Rain, last hour", fmt: (v) => `${v} mm` },
	rf3hr_mm: { label: "Rain, last 3 h", fmt: (v) => `${v} mm` },
	rf24hr_mm: { label: "Rain, last 24 h", fmt: (v) => `${v} mm` },
	// river stations
	river: { label: "River" },
	level_msl: { label: "Water level", fmt: msl },
	bank_msl: { label: "Bank top", fmt: msl },
	discharge_m3s: { label: "Flow", fmt: (v) => `${v} m³/s` },
	situation: { label: "Situation", fmt: (v) => SITUATION[v] ?? String(v) },
	over_bank_m: { label: "Above the bank by", fmt: m },
	district: { label: "District", fmt: (v, p) => [v, p.province].filter(Boolean).join(", ") },
	// canal network
	width_m: { label: "Canal width", fmt: (v) => `~${v} m` },
	drains_km2: { label: "Land draining through here", fmt: (v) => `${v} km²` },
	to_outlet: { label: "Drains to" },
	outlet_km: { label: "Distance to that outlet", fmt: (v) => `${v} km along canals` },
	// simulation road spots
	model_cm: { label: "Model: water on road", fmt: (v) => `${v} cm` },
	observed_cm: { label: "Sensor recorded", fmt: (v) => `${v} cm` },
	kind: { label: "Spot type", fmt: (v) => (v === "report" ? "Hotspot from citizen reports (depth estimated)" : "Road flood sensor") },
	// citizen reports
	state: { label: "Report status" },
	open: { label: "Ticket still open", fmt: (v) => (v ? "yes (BMA has not closed it)" : "no") },
	age_h: { label: "Reported", fmt: (v) => (v < 1 ? "under an hour ago" : `${v} h ago`) },
	hours_to_close: { label: "Took to resolve", fmt: (v) => `${v} h` },
	// timestamps
	time: { label: "Updated", fmt: bkkTime },
};

// Shown elsewhere (title) or folded into another row.
const HIDDEN = new Set(["id", "name", "pumps", "pump_count", "use_pct", "province", "edge"]);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function popupHtml(p: Record<string, any>): string {
	const title = p.name ?? p.canal ?? p.river ?? "";
	const rows: string[] = [];
	for (const [k, v] of Object.entries(p)) {
		if (HIDDEN.has(k) || v === null || v === "" || (k === "canal" && title === v)) continue;
		const f = FIELDS[k];
		const shown = f?.fmt ? f.fmt(v, p) : String(v);
		if (shown === null) continue;
		rows.push(`<tr><td>${esc(f?.label ?? k.replace(/_/g, " "))}</td><td>${f?.html ? shown : esc(shown)}</td></tr>`);
	}
	return `<div class="pop-title">${esc(String(title))}</div>${p.id && p.id !== title ? `<div class="pop-id">${esc(String(p.id))}</div>` : ""}<table>${rows.join("")}</table>`;
}

// Thai place names as written in the news and in OpenStreetMap, reduced to one comparable key,
// plus the gazetteer lookup (data/gazetteer.json, built by scripts/build-gazetteer.mjs). Laptop only.

// Leading words that say what kind of place follows ("ถ.", "แยก", "อ.") rather than which one.
const KIND_WORDS = /^(?:จังหวัด|จ\.|อำเภอ|อ\.|เขต|ตำบล|ต\.|แขวง|ถนน|ถ\.|ซอย|ซ\.|แยก|ทางแยก|หมู่บ้าน|ม\.|ชุมชน|หน้า|บริเวณ|ปากซอย|สะพาน)\s*/;
const THAI_DIGITS = /[๐-๙]/g;

/** "ถ. พระราม ๒" and "ถนนพระราม 2" -> "พระราม2". */
export function placeKey(name: string): string {
	let s = name.normalize("NFC").trim().replace(THAI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0e50));
	for (let prev = ""; prev !== s; ) (prev = s), (s = s.replace(KIND_WORDS, ""));
	return s.replace(/[\s.,()"'“”‘’-]/g, "").toLowerCase();
}

export type AdminLevel = 4 | 6 | 8; // province, district (อำเภอ/เขต), subdistrict (ตำบล/แขวง)
export type PlaceKind = "landmark" | "junction" | "road";
export interface GazetteerFile {
	built: string;
	source: string;
	admin: [key: string, level: AdminLevel, lon: number, lat: number][];
	places: [key: string, kind: PlaceKind, lon: number, lat: number][];
}

export interface Where {
	province?: string | null;
	district?: string | null;
	subdistrict?: string | null;
	road?: string | null;
	landmark?: string | null; // or junction ("แยกบางกะปิ")
}
export interface Located {
	lon: number;
	lat: number;
	precision: "landmark" | "junction" | "road" | "subdistrict" | "district" | "province";
}

const km = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 108, (a[1] - b[1]) * 111);
// No admin area named: assume the Bangkok region, the only area with road-level detail.
const BANGKOK: [number, number] = [100.55, 13.75];

/** Resolves extracted place fields, most specific first, each search near the admin area found. */
export function gazetteer(g: GazetteerFile) {
	const byKey = (rows: { 0: string }[]) => {
		const m = new Map<string, number[]>();
		rows.forEach((r, i) => m.set(r[0], [...(m.get(r[0]) ?? []), i]));
		return m;
	};
	const adminIdx = byKey(g.admin), placeIdx = byKey(g.places);
	const placeKeys = [...placeIdx.keys()];

	// Nearest row among `ids` to `near` within `maxKm` (any distance if no anchor yet).
	const nearest = <T extends [string, ...unknown[]]>(rows: T[], ids: number[], near: [number, number] | null, maxKm: number, at: (r: T) => [number, number]) => {
		let best: T | null = null, bestD = Infinity;
		for (const i of ids) {
			const d = near ? km(at(rows[i]), near) : 0;
			if (d <= maxKm && d < bestD) (best = rows[i]), (bestD = d);
		}
		return best;
	};
	const adminAt = (r: GazetteerFile["admin"][number]): [number, number] => [r[2], r[3]];
	const placeAt = (r: GazetteerFile["places"][number]): [number, number] => [r[2], r[3]];

	return function locate(w: Where): Located | null {
		let anchor: [number, number] | null = null, radius = Infinity;
		let found: Located | null = null;
		for (const [name, level, maxKm] of [[w.province, 4, Infinity], [w.district, 6, 80], [w.subdistrict, 8, 30]] as const) {
			if (!name) continue;
			const ids = (adminIdx.get(placeKey(name)) ?? []).filter((i) => g.admin[i][1] === level);
			const hit = nearest(g.admin, ids, anchor, anchor ? maxKm : Infinity, adminAt);
			if (!hit) continue;
			anchor = adminAt(hit);
			radius = level === 4 ? 150 : level === 6 ? 25 : 10;
			found = { lon: hit[2], lat: hit[3], precision: level === 4 ? "province" : level === 6 ? "district" : "subdistrict" };
		}
		const near = anchor ?? BANGKOK, within = anchor ? radius : 60;
		for (const [name, kinds] of [[w.landmark, ["landmark", "junction"]], [w.road, ["road", "junction"]]] as const) {
			if (!name) continue;
			const k = placeKey(name);
			if (k.length < 2) continue;
			// Exact name first; otherwise names containing it or contained in it (abbreviated or longer forms).
			let ids = (placeIdx.get(k) ?? []).filter((i) => (kinds as readonly string[]).includes(g.places[i][1]));
			if (!ids.length && k.length >= 4)
				ids = placeKeys.filter((p) => p.includes(k) || (p.length >= 4 && k.includes(p))).flatMap((p) => placeIdx.get(p)!).filter((i) => (kinds as readonly string[]).includes(g.places[i][1]));
			const hit = nearest(g.places, ids, near, within, placeAt);
			if (hit) return { lon: hit[2], lat: hit[3], precision: hit[1] };
		}
		return found;
	};
}

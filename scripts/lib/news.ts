// News reports of flooding: secondary, unverified data. Reporters and traffic radio say where water
// stands and how deep ("หน้า มศว องครักษ์ น้ำท่วมขังสูง 18-35 ซม.", "ระดับเข่า"); this turns that into
// points. Each run reads the newest items of a few public feeds, asks Claude Haiku (the local
// `claude -p`, on the user's Claude plan) to pull place + depth out of the flood-related ones it
// hasn't seen, places them with the gazetteer (places.ts, data/gazetteer.json), and keeps each
// report for 24 h. Stores only those facts and the link, never article text.
// Laptop only (scripts/mirror.mjs): the result is posted to the Worker like the BMA layers.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { PointFeature, Snapshot } from "../../shared/types.ts";
import { gazetteer, type GazetteerFile } from "./places.ts";

const KEEP_MS = 24 * 3600_000; // a report's life on the map
const SEEN_MS = 48 * 3600_000; // items remembered as processed (feeds repeat them for hours)
const BATCH = 25; // items per Claude call (each call has ~30 s of start-up)
const MAX_CHARS = 3000; // per article: place and depth come early; bounds the cost of long pieces

const FLOOD = /น้ำท่วม|ท่วมขัง|ท่วมสูง|ท่วมถนน|น้ำป่า|น้ำหลาก|น้ำล้นตลิ่ง/;

interface Item {
	id: string;
	source: string;
	url: string;
	published: number; // ms
	text: string;
}

const strip = (html: string) =>
	html
		.replace(/<!\[CDATA\[|\]\]>/g, "")
		.replace(/<(script|style)[^]*?<\/\1>|<[^>]*>/gi, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();

/** RSS 2.0: title, link, pubDate, and the article body when the feed carries it. */
function rss(source: string, xml: string): Omit<Item, "id">[] {
	return [...xml.matchAll(/<item>([^]*?)<\/item>/g)].map(([, it]) => {
		const tag = (t: string) => new RegExp(`<${t}[^>]*>([^]*?)</${t}>`).exec(it)?.[1] ?? "";
		const title = strip(tag("title")), body = strip(tag("content:encoded") || tag("description"));
		return { source, url: strip(tag("link")), published: Date.parse(strip(tag("pubDate"))), text: body.startsWith(title) ? body : `${title}\n${body}` };
	});
}

/** FM91 traffic radio homepage: headline per report; the upload time is in the image path. */
function fm91(source: string, html: string): Omit<Item, "id">[] {
	const out = new Map<string, Omit<Item, "id">>();
	for (const m of html.matchAll(/<a href="(https:\/\/www\.fm91bkk\.com\/newsarticle\/\d+)"[^>]*>\s*<img[^>]*data-src="[^"]*\/(\d{10})_[^"]*"[^>]*alt="([^"]*)"/g))
		out.set(m[1], { source, url: m[1], published: Number(m[2]) * 1000, text: strip(m[3]) });
	return [...out.values()];
}

const FEEDS: { source: string; url: string; parse: (source: string, body: string) => Omit<Item, "id">[] }[] = [
	{ source: "FM91 Traffic", url: "https://www.fm91bkk.com/", parse: fm91 },
	{ source: "Khaosod", url: "https://www.khaosod.co.th/feed", parse: rss },
	{ source: "Matichon", url: "https://www.matichon.co.th/feed", parse: rss },
	{ source: "Thairath", url: "https://www.thairath.co.th/rss/news", parse: rss },
	{ source: "Google News", url: `https://news.google.com/rss/search?q=${encodeURIComponent("น้ำท่วม when:1d")}&hl=th&gl=TH&ceid=TH:th`, parse: rss },
];

async function itemId(url: string): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url)));
	return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SYSTEM = `You read Thai news articles and traffic-radio reports and list every report of floodwater observed at a specific place at the time of reporting.

Include: water standing on or flowing over roads, in villages, communities, homes, markets or farmland, now. Also include water reported as receding but still present.
Exclude: forecasts and warnings, relief and compensation news, dam or river levels without a place that is flooded, past events, and anything outside Thailand.

For each report give:
- item: the item id it came from.
- place_text: the place as the article names it, short (e.g. "หน้า มศว องครักษ์").
- province, district, subdistrict: in Thai, without prefixes (no จังหวัด/จ./อำเภอ/อ./เขต/ตำบล/ต./แขวง). Bangkok is กรุงเทพมหานคร; its เขต is the district, its แขวง the subdistrict. Fill in the province and district when the article makes them clear, even if implied by a well-known place. null when unknown.
- road: road or soi name without ถนน/ถ./ซอย/ซ. (e.g. "ศรีนครินทร์", "สุขุมวิท 101/1"), or null.
- landmark: the most specific named place: junction (with แยก), school, university, temple, market, mall, hospital, village or housing estate, station, bridge. Expand abbreviations to the full official name (มศว -> มหาวิทยาลัยศรีนครินทรวิโรฒ). null when none.
- depth_text: the depth words exactly as written (e.g. "สูง 18-35 ซม.", "ระดับเข่า"), or null.
- depth_cm_min, depth_cm_max: depth in cm. Use the numbers given; otherwise ตาตุ่ม 5-10, ข้อเท้า 10-15, หน้าแข้ง 20-30, เข่า 40-50, ต้นขา 60-70, เอว 80-100, หน้าอก/อก 110-130, คอ 140-160, มิดหลังคา/ท่วมมิดบ้าน 200-300. null when the article gives no depth.

One article can give several places; list each. Return an empty list when there is none.`;

const NULLABLE_STR = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const NULLABLE_INT = { anyOf: [{ type: "integer" }, { type: "null" }] } as const;
const SCHEMA = {
	type: "object",
	properties: {
		reports: {
			type: "array",
			items: {
				type: "object",
				properties: {
					item: { type: "string" },
					place_text: { type: "string" },
					province: NULLABLE_STR,
					district: NULLABLE_STR,
					subdistrict: NULLABLE_STR,
					road: NULLABLE_STR,
					landmark: NULLABLE_STR,
					depth_text: NULLABLE_STR,
					depth_cm_min: NULLABLE_INT,
					depth_cm_max: NULLABLE_INT,
				},
				required: ["item", "place_text", "province", "district", "subdistrict", "road", "landmark", "depth_text", "depth_cm_min", "depth_cm_max"],
				additionalProperties: false,
			},
		},
	},
	required: ["reports"],
	additionalProperties: false,
} as const;

interface Extracted {
	item: string;
	place_text: string;
	province: string | null;
	district: string | null;
	subdistrict: string | null;
	road: string | null;
	landmark: string | null;
	depth_text: string | null;
	depth_cm_min: number | null;
	depth_cm_max: number | null;
}

/** One `claude -p` call: Haiku, no tools (article text can't make it do anything), schema-checked. */
function extract(items: Item[]): Promise<Extracted[]> {
	const bkk = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
	const content = items.map((it) => `<item id="${it.id}" source="${it.source}" published="${bkk(it.published)} (Bangkok)">\n${it.text.slice(0, MAX_CHARS)}\n</item>`).join("\n\n");
	const args = ["-p", "--model", "haiku", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(SCHEMA)];
	return new Promise((resolve, reject) => {
		const p = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "", err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("error", reject);
		p.on("close", (code) => {
			try {
				const r = JSON.parse(out);
				if (code !== 0 || r.is_error || !r.structured_output) throw new Error(r.result ?? `exit ${code}`);
				resolve(r.structured_output.reports);
			} catch (e) {
				reject(new Error(`claude -p failed: ${String(e).slice(0, 200)} ${err.slice(0, 200)}`));
			}
		});
		p.stdin.end(content);
	});
}

export interface NewsSnapshot extends Snapshot {
	seen?: Record<string, number>; // item id -> published ms: processed, don't send again
}

/** Flood-related items from the feeds, published in the last day and not in `seen`. Feeds one by
 * one is plenty (5 requests per run); a feed that fails is skipped this run. */
export async function floodItems(get: (url: string) => Promise<string>, seen: Record<string, number>, now = Date.now()): Promise<Item[]> {
	const fresh: Item[] = [];
	for (const f of FEEDS) {
		const raw = await get(f.url).then((body) => f.parse(f.source, body), (e) => (console.warn("news feed", f.source, String(e)), []));
		for (const r of raw) {
			if (!r.url || !Number.isFinite(r.published) || now - r.published > KEEP_MS || !FLOOD.test(r.text)) continue;
			const id = await itemId(r.url);
			if (!(id in seen) && !fresh.some((x) => x.id === id)) fresh.push({ id, ...r });
		}
	}
	return fresh;
}

/** One refresh of the news layer. `prev` is the last published snapshot (reports and seen items). */
export async function loadNews(prev: NewsSnapshot | null, get: (url: string) => Promise<string>): Promise<{ features: PointFeature[]; seen: Record<string, number> }> {
	const now = Date.now();
	const seen = Object.fromEntries(Object.entries(prev?.seen ?? {}).filter(([, t]) => now - t < SEEN_MS));
	const kept = (prev?.features ?? []).filter((f) => now - Date.parse(String(f.properties.time)) < KEEP_MS);

	const fresh = await floodItems(get, seen, now);
	if (!fresh.length) return { features: kept, seen };

	const locate = gazetteer(JSON.parse(await readFile(new URL("../../data/gazetteer.json", import.meta.url), "utf8")) as GazetteerFile);
	const byId = new Map(fresh.map((it) => [it.id, it]));
	const added: PointFeature[] = [];
	for (let i = 0; i < fresh.length; i += BATCH) {
		const batch = fresh.slice(i, i + BATCH);
		for (const r of await extract(batch)) {
			const it = byId.get(r.item);
			const at = it && locate(r);
			// Left out: unknown item, a place the gazetteer doesn't know, or only a province (a dot
			// in the middle of a province says nothing about where the water is).
			if (!it || !at || at.precision === "province") continue;
			const mid = r.depth_cm_min !== null && r.depth_cm_max !== null ? Math.round((r.depth_cm_min + r.depth_cm_max) / 2) : (r.depth_cm_max ?? r.depth_cm_min);
			added.push({
				type: "Feature",
				geometry: { type: "Point", coordinates: [at.lon, at.lat] },
				properties: {
					id: `${it.id}-${added.length}`,
					name: r.place_text,
					place: [r.landmark, r.road, r.subdistrict, r.district, r.province].filter(Boolean).join(", "),
					precision: at.precision,
					reported_cm: mid,
					depth_text: r.depth_text,
					source: it.source,
					url: it.url,
					time: new Date(it.published).toISOString(),
				},
			});
		}
		for (const it of batch) seen[it.id] = it.published; // processed, whether or not it gave reports
	}
	return { features: [...kept, ...added], seen };
}

// The laptop's only write access to R2 (only the Worker holds the binding). Each route accepts
// just the keys its script needs:
//   POST /api/ingest              live batch for laptop-run sources            scripts/mirror.mjs
//   PUT  /api/r2/v/<version>/…    built data (a clean version is write-once)   scripts/publish-data.mjs
//   PUT  /api/r2/current.json     switch version, once all its files are in    scripts/publish-data.mjs
//   GET  /api/r2?prefix=&cursor=  list archive/ or v/                          scripts/compact-archive.mjs
//   PUT  /api/r2/archive/…        compacted day files, archive/index.json      scripts/compact-archive.mjs
//   POST /api/r2/delete {keys}    raw snapshots of days already compacted      scripts/compact-archive.mjs
// Reads go through the public paths. Key: `Authorization: Bearer <INGEST_KEY>` (Worker secret).
import { env } from "cloudflare:workers";
import { KEY, bkkParts } from "../shared/data-layout.ts";
import { LAYERS } from "../shared/types.ts";
import { RUNS_ON, save, type Batch, type Store } from "./sources.ts";

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });

/** `Authorization: Bearer <INGEST_KEY>`, compared in constant time. */
function authorized(req: Request): boolean {
	const enc = new TextEncoder();
	const got = enc.encode(req.headers.get("authorization") ?? "");
	const want = enc.encode(`Bearer ${env.INGEST_KEY}`);
	return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

export async function api(req: Request, path: string, r2: Store): Promise<Response> {
	if (!env.INGEST_KEY) return text(503, "api not configured (INGEST_KEY secret)");
	if (!authorized(req)) return text(401, "unauthorized");
	if (Number(req.headers.get("content-length") ?? 0) > 90e6) return text(413, "too large");
	if (req.method === "POST" && path === "/api/ingest") return ingest(req, r2);
	if (req.method === "GET" && path === "/api/r2") return list(new URL(req.url).searchParams);
	if (req.method === "POST" && path === "/api/r2/delete") return remove(req);
	if (req.method === "PUT" && path.startsWith("/api/r2/")) return put(req, path.slice("/api/r2/".length));
	return text(404, "no such route");
}

// Live data -------------------------------------------------------------------------------

/** A batch from the laptop, or why it's refused. Only laptop sources, recent, well-formed layers. */
function checkBatch(b: Batch): string | null {
	if (typeof b?.fetchedAt !== "string" || !b.results || !b.files) return "expected {fetchedAt, results, files}";
	// The archive key comes from fetchedAt: no backfilling old slots or writing future ones.
	if (!(Math.abs(Date.now() - Date.parse(b.fetchedAt)) < 30 * 60_000)) return "fetchedAt not within 30 min of now";
	const laptop = (k: string) => (RUNS_ON as Record<string, string>)[k] === "laptop";
	for (const [k, r] of Object.entries(b.results)) {
		if (!laptop(k)) return `${k} isn't a laptop source`;
		if (typeof r?.ok !== "boolean" || r.fetchedAt !== b.fetchedAt) return `bad result for ${k}`;
	}
	for (const [k, body] of Object.entries(b.files)) {
		if (!laptop(k) || b.results[k as keyof typeof b.results]?.ok !== true) return `file ${k} without a good result`;
		if (typeof body !== "string") return `file ${k} isn't text`;
		if (k === "tide") continue;
		let snap: { type?: string; layer?: string; features?: unknown };
		try {
			snap = JSON.parse(body);
		} catch {
			return `file ${k} isn't JSON`;
		}
		if (snap.type !== "FeatureCollection" || snap.layer !== k || !Array.isArray(snap.features)) return `file ${k} isn't a ${k} snapshot`;
	}
	return null;
}

async function ingest(req: Request, r2: Store): Promise<Response> {
	const batch = (await req.json().catch(() => null)) as Batch;
	const bad = checkBatch(batch);
	if (bad) return text(400, bad);
	await save(r2, batch);
	return text(200, "ok");
}

// Built data and archive ------------------------------------------------------------------------

const BUILT = /^v\/([0-9a-f]{7,40}(?:-dirty)?)\/[\w.-]+(?:\/[\w.-]+)*$/;
const DAY_FILE = /^archive\/(\w+)\/(\d{4})\/(\d{4}-\d\d-\d\d)\.ndjson\.gz$/;
const RAW = /^archive\/raw\/(\w+)\/(\d{4}-\d\d-\d\d)\/\d{4}\.json$/;
const isLayer = (l: string) => (LAYERS as readonly string[]).includes(l);
const today = () => bkkParts(Date.now()).day;
const exists = async (key: string) => (await env.DATA.head(key)) !== null;

async function list(q: URLSearchParams): Promise<Response> {
	const prefix = q.get("prefix") ?? "";
	if (!/^(archive|v)\//.test(prefix)) return text(400, "prefix must start with archive/ or v/");
	const r = await env.DATA.list({ prefix, cursor: q.get("cursor") ?? undefined, limit: 1000 });
	return Response.json({ objects: r.objects.map((o) => ({ key: o.key, size: o.size })), cursor: r.truncated ? r.cursor : null });
}

async function put(req: Request, key: string): Promise<Response> {
	if (key.includes("..")) return text(400, "bad key");
	let cacheControl: string;
	const built = BUILT.exec(key), day = DAY_FILE.exec(key);
	if (built) {
		// Immutable once published; a "-dirty" version (uncommitted data) may be re-uploaded.
		if (!built[1].endsWith("-dirty") && (await exists(key))) return text(409, "already published");
		cacheControl = "public, max-age=31536000, immutable";
	} else if (key === KEY.current) {
		const cur = (await req.clone().json().catch(() => null)) as { version?: string; files?: string[] } | null;
		if (typeof cur?.version !== "string" || !Array.isArray(cur.files) || !cur.files.length) return text(400, "expected {version, files}");
		const missing = [];
		for (const f of cur.files) if (!(await exists(KEY.built(cur.version, f)))) missing.push(f);
		if (missing.length) return text(409, `not uploaded yet: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`);
		cacheControl = "public, max-age=60";
	} else if (day && isLayer(day[1]) && day[3].startsWith(day[2]) && day[3] < today()) {
		cacheControl = "public, max-age=86400"; // a re-run may merge into it
	} else if (key === KEY.archiveIndex) {
		cacheControl = "public, max-age=300";
	} else return text(403, `can't write ${key}`);
	const body = await req.arrayBuffer();
	await env.DATA.put(key, body, { httpMetadata: { contentType: req.headers.get("content-type") ?? "application/octet-stream", cacheControl } });
	return Response.json({ key, size: body.byteLength });
}

async function remove(req: Request): Promise<Response> {
	const { keys } = ((await req.json().catch(() => null)) ?? {}) as { keys?: unknown };
	if (!Array.isArray(keys) || !keys.length || keys.length > 1000) return text(400, "expected {keys: [1..1000 keys]}");
	// Only raw snapshots of finished days, and only once that day's compacted file is in place.
	const days = new Set<string>();
	for (const k of keys) {
		const m = typeof k === "string" ? RAW.exec(k) : null;
		if (!m || !isLayer(m[1]) || m[2] >= today()) return text(403, `can't delete ${k}`);
		days.add(KEY.day(m[1], m[2]));
	}
	for (const d of days) if (!(await exists(d))) return text(409, `${d} not written yet`);
	await env.DATA.delete(keys as string[]);
	return Response.json({ deleted: keys.length });
}

import { env } from "cloudflare:workers";
import { LAYERS } from "../shared/types.ts";
import { RUNS_ON, collect, due, save, type Batch, type Store } from "./sources.ts";

const r2: Store = {
	get: async (key) => (await env.DATA.get(key))?.text() ?? null,
	put: (key, body, contentType, cacheControl) => env.DATA.put(key, body, { httpMetadata: { contentType, cacheControl } }),
};

// In production the data domain serves R2 directly. This handler serves the same keys on the
// app's own origin, for local dev (local R2) and as a fallback before the domain is set up.
const SERVED = /^\/(current\.json|(?:live|archive|v)\/[\w./-]+)$/;

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });

/** `Authorization: Bearer <INGEST_KEY>`, compared in constant time. */
function authorized(req: Request): boolean {
	if (!env.INGEST_KEY) return false;
	const enc = new TextEncoder();
	const got = enc.encode(req.headers.get("authorization") ?? "");
	const want = enc.encode(`Bearer ${env.INGEST_KEY}`);
	return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

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

// Sources the Worker can't fetch (RUNS_ON "laptop") come in here from scripts/mirror.mjs, so only
// the Worker writes R2. POST /api/ingest, JSON Batch, key in the INGEST_KEY secret.
async function ingest(req: Request): Promise<Response> {
	if (!env.INGEST_KEY) return text(503, "ingest not configured");
	if (!authorized(req)) return text(401, "unauthorized");
	if (Number(req.headers.get("content-length") ?? 0) > 20e6) return text(413, "batch too large");
	const batch = (await req.json().catch(() => null)) as Batch;
	const bad = checkBatch(batch);
	if (bad) return text(400, bad);
	await save(r2, batch);
	return text(200, "ok");
}

export default {
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === "/api/ingest") return req.method === "POST" ? ingest(req) : text(405, "POST only");
		const m = SERVED.exec(path);
		const obj = m && !m[1].includes("..") ? await env.DATA.get(m[1]) : null;
		if (!obj) return new Response("not found", { status: 404, headers: { "access-control-allow-origin": "*" } });
		const headers = new Headers({ "access-control-allow-origin": "*", etag: obj.httpEtag });
		obj.writeHttpMetadata(headers);
		return new Response(obj.body, { headers });
	},

	async scheduled(controller) {
		// The Worker's share of the sources (RUNS_ON in sources.ts); the laptop posts the rest.
		// Local dev triggers {"cron":"all"} to refresh everything into local R2 (nothing blocks a laptop).
		const { layers, tide } = controller.cron === "all" ? { layers: LAYERS, tide: true } : due(controller.scheduledTime, "worker");
		const batch = await collect(layers, tide);
		await save(r2, batch);
		const failed = Object.entries(batch.results).filter(([, s]) => !s?.ok);
		if (failed.length) console.warn("refresh failures", JSON.stringify(failed));
	},
} satisfies ExportedHandler;

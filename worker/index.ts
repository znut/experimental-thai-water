import { env } from "cloudflare:workers";
import { KEY } from "../shared/data-layout.ts";
import { LAYERS } from "../shared/types.ts";
import { api } from "./api.ts";
import { collect, due, save, type SourceContext, type Store } from "./sources.ts";

const r2: Store = {
	get: async (key) => (await env.DATA.get(key))?.text() ?? null,
	put: (key, body, contentType, cacheControl) => env.DATA.put(key, body, { httpMetadata: { contentType, cacheControl } }),
};

const ctx: SourceContext = {
	previous: async (layer) => JSON.parse((await r2.get(KEY.live(`${layer}.json`))) ?? "null"),
};

// In production the data domain serves R2 directly. This handler serves the same keys on the
// app's own origin, for local dev (local R2) and as a fallback before the domain is set up.
const SERVED = /^\/(current\.json|(?:live|archive|v)\/[\w./-]+)$/;

// GISTDA satellite flood extent tiles (disaster.gistda.or.th), proxied so the key stays in the
// Worker. Thailand only; each tile cached at the edge for an hour (GISTDA updates after a pass).
const GISTDA_TILE = /^\/tiles\/gistda\/(1day|3days|7days|30days)\/(\d{1,2})\/(\d+)\/(\d+)$/;
const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

async function gistdaTile(req: Request, [, window, zs, xs, ys]: RegExpExecArray, ctx: ExecutionContext): Promise<Response> {
	const z = Number(zs), x = Number(xs), y = Number(ys);
	const inThailand = z <= 16 && x >= tileX(97.3, z) && x <= tileX(105.7, z) && y >= tileY(20.5, z) && y <= tileY(5.6, z);
	if (!inThailand) return new Response("outside Thailand", { status: 404 });
	if (!env.GISTDA_KEY) return new Response("GISTDA_KEY not set", { status: 503 });
	const key = new Request(new URL(req.url).origin + new URL(req.url).pathname);
	const hit = await caches.default.match(key);
	if (hit) return hit;
	const res = await fetch(`https://api-gateway.gistda.or.th/api/2.0/resources/maps/flood/${window}/tms/${z}/${x}/${y}?api_key=${encodeURIComponent(env.GISTDA_KEY)}`);
	if (!res.ok) return new Response(`GISTDA -> HTTP ${res.status}`, { status: 502 });
	const out = new Response(res.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
	ctx.waitUntil(caches.default.put(key, out.clone()));
	return out;
}

export default {
	async fetch(req, _env, ctx) {
		const path = new URL(req.url).pathname;
		if (path.startsWith("/api/")) return api(req, path, r2);
		const tile = GISTDA_TILE.exec(path);
		if (tile) return gistdaTile(req, tile, ctx);
		const m = SERVED.exec(path);
		const obj = m && !m[1].includes("..") ? await env.DATA.get(m[1]) : null;
		if (!obj) return new Response("not found", { status: 404, headers: { "access-control-allow-origin": "*" } });
		const headers = new Headers({ "access-control-allow-origin": "*", etag: obj.httpEtag });
		obj.writeHttpMetadata(headers);
		return new Response(obj.body, { headers });
	},

	async scheduled(controller) {
		// The Worker's share of the sources (RUNS_ON in sources.ts); the laptop posts the rest (api.ts).
		// Local dev triggers {"cron":"all"} to refresh everything into local R2 (nothing blocks a laptop).
		const { layers, tide } = controller.cron === "all" ? { layers: LAYERS, tide: true } : due(controller.scheduledTime, "worker");
		const batch = await collect(layers, tide, ctx);
		await save(r2, batch);
		const failed = Object.entries(batch.results).filter(([, s]) => !s?.ok);
		if (failed.length) console.warn("refresh failures", JSON.stringify(failed));
	},
} satisfies ExportedHandler;

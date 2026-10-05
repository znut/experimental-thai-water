import { env } from "cloudflare:workers";
import { LAYERS } from "../shared/types.ts";
import { api } from "./api.ts";
import { collect, due, save, type Store } from "./sources.ts";

const r2: Store = {
	get: async (key) => (await env.DATA.get(key))?.text() ?? null,
	put: (key, body, contentType, cacheControl) => env.DATA.put(key, body, { httpMetadata: { contentType, cacheControl } }),
};

// In production the data domain serves R2 directly. This handler serves the same keys on the
// app's own origin, for local dev (local R2) and as a fallback before the domain is set up.
const SERVED = /^\/(current\.json|(?:live|archive|v)\/[\w./-]+)$/;

export default {
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (path.startsWith("/api/")) return api(req, path, r2);
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
		const batch = await collect(layers, tide);
		await save(r2, batch);
		const failed = Object.entries(batch.results).filter(([, s]) => !s?.ok);
		if (failed.length) console.warn("refresh failures", JSON.stringify(failed));
	},
} satisfies ExportedHandler;

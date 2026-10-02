// The public data layout, shared by the Worker, the client and the laptop scripts. Kept apart
// from deploy.ts: modules imported by cloudflare.config.ts don't load inside the dev Worker.

// The R2 bucket served on a custom domain (a Cloudflare zone in the same account). Reads there hit
// Cloudflare's cache, never the Worker. This is also the public API base.
export const DATA_ORIGIN = "https://data.example.org"; // TODO: your data domain

// R2 keys = public API paths under DATA_ORIGIN.
//   current.json                              {"version", "published_at", ...}: live built-data version
//   v/<version>/<path>                        built data (network, terrain, scenarios, …); immutable
//   live/<layer>.json, live/status.json, live/tide.txt   latest refresh (every 5 min)
//   archive/raw/<layer>/<YYYY-MM-DD>/<HHmm>.json       every refresh, Bangkok date/time (cron)
//   archive/<layer>/<YYYY>/<YYYY-MM-DD>.ndjson.gz      one day, deduplicated (laptop compaction)
//   archive/index.json                        compacted days per layer
export const KEY = {
	current: "current.json",
	built: (version: string, path: string) => `v/${version}/${path}`,
	live: (name: string) => `live/${name}`,
	raw: (layer: string, bkkDay: string, bkkHHmm: string) => `archive/raw/${layer}/${bkkDay}/${bkkHHmm}.json`,
	rawPrefix: (layer: string) => `archive/raw/${layer}/`,
	day: (layer: string, bkkDay: string) => `archive/${layer}/${bkkDay.slice(0, 4)}/${bkkDay}.ndjson.gz`,
	archiveIndex: "archive/index.json",
};

// Bangkok date and HHmm for an instant (archive keys use local days).
export function bkkParts(ms: number): { day: string; hhmm: string } {
	const iso = new Date(ms + 7 * 3600_000).toISOString();
	return { day: iso.slice(0, 10), hhmm: iso.slice(11, 13) + iso.slice(14, 16) };
}

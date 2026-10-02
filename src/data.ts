// Where the app reads data. Production: the public data domain (R2 behind Cloudflare's cache), with
// built files under the published version from current.json. Dev: built files from the symlinked
// data repo (/data/…) and live files from the local Worker's R2 (same paths as production).
import { DATA_ORIGIN, KEY } from "../shared/data-layout.ts";

const BASE = import.meta.env.DEV ? "" : DATA_ORIGIN;

let version: Promise<string> | null = null;
function currentVersion(): Promise<string> {
	version ??= fetch(`${BASE}/${KEY.current}`, { cache: "no-cache" })
		.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${KEY.current}: HTTP ${r.status}`))))
		.then((c: { version: string }) => c.version);
	return version;
}

/** Built data file (network.geojson, scenarios/<id>.json, …) from the published version. */
export async function fetchBuilt(path: string): Promise<Response> {
	if (import.meta.env.DEV) return fetch(`/data/${path}`);
	return fetch(`${BASE}/${KEY.built(await currentVersion(), path)}`);
}

/** Latest live file: `<layer>.json`, `status.json` or `tide.txt`. */
export const fetchLive = (name: string): Promise<Response> => fetch(`${BASE}/${KEY.live(name)}`);

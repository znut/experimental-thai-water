// The laptop's way to write R2: the Worker's API (worker/api.ts); nothing here holds R2 credentials.
// Key: ~/.config/thai-water-way/ingest-key, same value as the Worker's INGEST_KEY secret.
// Env: API_ORIGIN for another Worker (dev: http://localhost:5199), INGEST_KEY to override the file.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_HOST } from "../../shared/deploy.ts";

export const ORIGIN = process.env.API_ORIGIN ?? `https://${APP_HOST}`;
const KEY_FILE = join(homedir(), ".config", "thai-water-way", "ingest-key");
const key = process.env.INGEST_KEY ?? (await readFile(KEY_FILE, "utf8").catch(() => "")).trim();

/** An API call; throws on any status not in `accept` (default: 2xx). */
export async function api(path, { accept = [], ...init } = {}) {
	if (!key) throw new Error(`no API key: put it in ${KEY_FILE} (the Worker's INGEST_KEY secret)`);
	const res = await fetch(`${ORIGIN}${path}`, {
		...init,
		headers: { authorization: `Bearer ${key}`, ...init.headers },
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok && !accept.includes(res.status)) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}: ${await res.text()}`);
	return res;
}

/** Writes one object; resolves to {key, size} or, if the key is write-once and taken, null. */
export async function put(key, body, type) {
	const res = await api(`/api/r2/${key}`, { method: "PUT", headers: { "content-type": type }, body, accept: [409] });
	return res.status === 409 ? null : res.json();
}

/** Every {key, size} under a prefix (archive/ or v/). */
export async function list(prefix) {
	const out = [];
	let cursor = "";
	do {
		const r = await (await api(`/api/r2?${new URLSearchParams({ prefix, cursor })}`)).json();
		out.push(...r.objects);
		cursor = r.cursor;
	} while (cursor);
	return out;
}

/** An object's bytes from its public path, or null if it doesn't exist. */
export async function get(key) {
	const res = await fetch(`${ORIGIN}/${key}`, { signal: AbortSignal.timeout(120_000) });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GET ${key} -> HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

/** Deletes raw archive snapshots, up to 1000 per call. */
export async function remove(keys) {
	for (let i = 0; i < keys.length; i += 1000)
		await api("/api/r2/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: keys.slice(i, i + 1000) }) });
}

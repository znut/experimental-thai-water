// Shared helpers for the data build scripts (build-infra, fetch-scenario).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Local equirectangular projection around Bangkok (same as build-network.mjs).
const LAT0 = 13.75, LON0 = 100.55;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_540;
export const toXY = ([lon, lat]) => [(lon - LON0) * KX, (lat - LAT0) * KY];
export const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

export const UA = { "user-agent": "Mozilla/5.0 (thai-water-way data build)" };

// Public government sources: download history once and cache it; keep few requests in flight.
// A history window is "settled" (safe to cache) once it ended this long ago: sources backfill
// late records. Windows not settled yet are fetched fresh and not cached.
export const POLITE = 2; // max requests in flight to one government server
export const settled = (endMs) => endMs < Date.now() - 6 * 3600_000;

// Raw responses are cached so reruns don't hit the source servers again.
const CACHE = new URL("../../node_modules/.cache/thai-water-way/", import.meta.url);

/**
 * fetch() returning text, cached on disk by URL + body. Throws on HTTP errors.
 * `cache: false` for data that can still change (a history window not settled yet): always
 * fetched fresh, neither read from nor written to the cache.
 */
export async function cachedText(url, init = {}, { retries = 3, timeoutMs = 300_000, valid = () => true, cache = true } = {}) {
	const key = createHash("sha1").update(url + "\n" + (init.body ?? "")).digest("hex");
	const file = new URL(key, CACHE);
	if (cache)
		try {
			return await readFile(file, "utf8");
		} catch {}
	let lastErr;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const res = await fetch(url, { ...init, headers: { ...UA, ...init.headers }, signal: AbortSignal.timeout(timeoutMs) });
			if (!res.ok) throw Object.assign(new Error(`${url} -> HTTP ${res.status}`), { status: res.status });
			const text = await res.text();
			// Some servers answer errors with HTTP 200; don't cache those.
			if (!valid(text)) throw new Error(`${url} -> unexpected response: ${text.slice(0, 120)}`);
			if (cache) await mkdir(CACHE, { recursive: true }), await writeFile(file, text);
			return text;
		} catch (e) {
			lastErr = e;
			// 403/429: the server is pushing back; give it a long pause before retrying.
			const slow = e.status === 403 || e.status === 429;
			await new Promise((r) => setTimeout(r, (slow ? 30_000 : 2000) * (attempt + 1)));
		}
	}
	throw lastErr;
}

export const cachedJson = async (...args) => JSON.parse(await cachedText(...args));

/** Run fn over items with at most `n` in flight. */
export async function pool(items, n, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: n }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

/** Minimal RFC 4180 CSV parser (quoted fields may contain commas and newlines). */
export function parseCsv(text) {
	const s = text.replace(/^﻿/, "");
	const rows = [];
	let row = [], field = "", quoted = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quoted) {
			if (c === '"') {
				if (s[i + 1] === '"') (field += '"'), i++;
				else quoted = false;
			} else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") row.push(field), (field = "");
		else if (c === "\n" || c === "\r") {
			if (c === "\r" && s[i + 1] === "\n") i++;
			row.push(field), rows.push(row), (row = []), (field = "");
		} else field += c;
	}
	if (field || row.length) row.push(field), rows.push(row);
	const [header, ...body] = rows;
	return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** Download the first CSV resource of a data.bangkok.go.th (CKAN) dataset. */
export async function ckanCsv(dataset) {
	const meta = await cachedJson(`https://data.bangkok.go.th/api/3/action/package_show?id=${dataset}`);
	const res = meta.result.resources.find((r) => /csv/i.test(r.format));
	if (!res) throw new Error(`no CSV resource in CKAN dataset ${dataset}`);
	return { rows: parseCsv(await cachedText(res.url)), url: res.url };
}

const OVERPASS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter"];

/**
 * Overpass query with mirror fallback (mirrors are often busy and answer with HTML errors).
 * Each successful answer is also saved to data/osm/<name>.json; if every mirror fails we reuse
 * that snapshot, with a warning, so a busy Overpass doesn't block the build.
 */
export async function overpass(name, query) {
	const snapshot = new URL(`../../data/osm/${name}.json`, import.meta.url);
	for (const url of OVERPASS) {
		try {
			const text = await cachedText(
				url,
				{ method: "POST", body: new URLSearchParams({ data: query }) },
				{ retries: 1, timeoutMs: 90_000, valid: (t) => t.trimStart().startsWith("{") },
			);
			await mkdir(new URL(".", snapshot), { recursive: true });
			await writeFile(snapshot, text);
			return JSON.parse(text);
		} catch {}
	}
	try {
		const text = await readFile(snapshot, "utf8");
		console.warn(`Overpass unavailable; using snapshot data/osm/${name}.json`);
		return JSON.parse(text);
	} catch {
		throw new Error(`all Overpass mirrors failed and no snapshot data/osm/${name}.json`);
	}
}

/** Network nodes from network.geojson: id -> [lon, lat], plus a nearest-node lookup. */
export async function loadNetwork() {
	// OUT_DIR (e.g. data/staging) lets staged builds chain without touching public/data.
	const netPath = process.env.OUT_DIR ? `${process.env.OUT_DIR}/network.geojson` : new URL("../../public/data/network.geojson", import.meta.url);
	const net = JSON.parse(await readFile(netPath, "utf8"));
	const nodes = new Map();
	for (const f of net.features) {
		nodes.set(f.properties.a, f.geometry.coordinates[0]);
		nodes.set(f.properties.b, f.geometry.coordinates.at(-1));
	}
	const pts = [...nodes].map(([id, ll]) => ({ id, ll, xy: toXY(ll) }));
	const edgeNames = new Map(); // node id -> set of canal names touching it
	for (const f of net.features)
		for (const n of [f.properties.a, f.properties.b]) {
			if (!edgeNames.has(n)) edgeNames.set(n, new Set());
			edgeNames.get(n).add(f.properties.name);
		}
	/** Nearest node within maxM metres, optionally only nodes passing `filter`. */
	function nearestNode(ll, maxM, filter = () => true) {
		const p = toXY(ll);
		let best = null;
		for (const n of pts) {
			if (!filter(n.id)) continue;
			const d = dist(p, n.xy);
			if (d <= maxM && (!best || d < best.d)) best = { id: n.id, d };
		}
		return best;
	}
	const edges = net.features.map((f) => ({ a: f.properties.a, b: f.properties.b, name: f.properties.name, xy: f.geometry.coordinates.map(toXY) }));
	/**
	 * Snap to the nearest point on any canal edge within maxM, then return the nearer end node
	 * of that edge. Better than nearestNode for structures midway along long canal stretches.
	 */
	function nearestEdgeNode(ll, maxM) {
		const p = toXY(ll);
		let best = null;
		for (const e of edges) {
			let along = 0;
			const total = e.xy.reduce((s, q, i) => (i ? s + dist(q, e.xy[i - 1]) : 0), 0);
			for (let i = 0; i < e.xy.length - 1; i++) {
				const [a, b] = [e.xy[i], e.xy[i + 1]];
				const dx = b[0] - a[0], dy = b[1] - a[1];
				const len = Math.hypot(dx, dy) || 1;
				const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)));
				const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
				if (d <= maxM && (!best || d < best.d)) best = { d, id: along + t * len < total / 2 ? e.a : e.b, name: e.name };
				along += len;
			}
		}
		return best;
	}
	return { build: net.build, nodes, edgeNames, nearestNode, nearestEdgeNode, features: net.features };
}

/** Distance in metres from a point to a set of polylines ([lon,lat] arrays). */
export function distToLines(ll, lines) {
	const p = toXY(ll);
	let best = Infinity;
	for (const line of lines) {
		for (let i = 0; i < line.length - 1; i++) {
			const a = toXY(line[i]), b = toXY(line[i + 1]);
			const dx = b[0] - a[0], dy = b[1] - a[1];
			const len2 = dx * dx + dy * dy || 1;
			const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
			best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
		}
	}
	return best;
}

/** Chao Phraya centre-line ways inside Bangkok, from OSM. */
export async function chaoPhraya() {
	const j = await overpass("chao-phraya", '[out:json][timeout:90];way["waterway"="river"]["name"~"เจ้าพระยา"](13.50,100.40,13.98,100.65);out geom;');
	const lines = j.elements.map((e) => e.geometry.map((g) => [g.lon, g.lat]));
	if (!lines.length) throw new Error("Chao Phraya not found in OSM response");
	return lines;
}

/** Gulf of Thailand coastline near Bangkok and Samut Prakan, from OSM. */
export async function coastline() {
	const j = await overpass("coastline", '[out:json][timeout:90];way["natural"="coastline"](13.38,100.25,13.62,101.05);out geom;');
	const lines = j.elements.map((e) => e.geometry.map((g) => [g.lon, g.lat]));
	if (!lines.length) throw new Error("coastline not found in OSM response");
	return lines;
}

/**
 * Open-sea pixels around the Gulf coast, from the FABDEM tile (data/dem, see
 * scripts/terrain/providers.mjs): FABDEM flattens the sea to exactly 0 m, while rivers and
 * ponds sit at ~0.5 m, so we flood-fill exact-zero pixels inward from the tile's south edge.
 * Returns a lookup `isSea(lon, lat)` plus `distToSea(lon, lat, maxM)`.
 */
export async function seaMask() {
	const { fromFile } = await import("geotiff");
	const img = await (await fromFile(new URL("../../data/dem/N13E100_FABDEM_V1-2.tif", import.meta.url).pathname)).getImage();
	const [x0, , , y1] = img.getBoundingBox();
	const [rx, ry] = img.getResolution();
	const W = img.getWidth(), H = img.getHeight();
	const [band] = await img.readRasters();
	const sea = new Uint8Array(W * H);
	const stack = [];
	for (let i = 0; i < W; i++) if (band[(H - 1) * W + i] === 0) (sea[(H - 1) * W + i] = 1), stack.push((H - 1) * W + i);
	while (stack.length) {
		const c = stack.pop(), i = c % W, j = (c - i) / W;
		for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const ii = i + di, jj = j + dj;
			if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
			const k = jj * W + ii;
			if (!sea[k] && band[k] === 0) (sea[k] = 1), stack.push(k);
		}
	}
	const isSea = (lon, lat) => {
		const i = Math.floor((lon - x0) / rx), j = Math.floor((lat - y1) / ry);
		return i >= 0 && j >= 0 && i < W && j < H && sea[j * W + i] === 1;
	};
	/** Metres to the nearest sea pixel, searching up to maxM (Infinity if none). */
	const distToSea = (lon, lat, maxM) => {
		const r = Math.ceil(maxM / 30);
		const i0 = Math.floor((lon - x0) / rx), j0 = Math.floor((lat - y1) / ry);
		let best = Infinity;
		for (let dj = -r; dj <= r; dj++)
			for (let di = -r; di <= r; di++) {
				const i = i0 + di, j = j0 + dj;
				if (i < 0 || j < 0 || i >= W || j >= H || !sea[j * W + i]) continue;
				best = Math.min(best, Math.hypot(di * 30 * Math.cos((lat * Math.PI) / 180), dj * 30));
			}
		return best <= maxM ? best : Infinity;
	};
	return { isSea, distToSea };
}

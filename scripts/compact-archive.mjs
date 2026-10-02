// Compacts the raw 5-minute archive the refreshes write (archive/raw/<layer>/<day>/<HHmm>.json) into
// one deduplicated file per layer per finished Bangkok day (archive/<layer>/<YYYY>/<day>.ndjson.gz),
// deletes the raw objects, and rewrites archive/index.json. Runs on the laptop, any time: days
// wait in raw form until it does. Safe to re-run; a day already compacted is merged, not lost.
//
// Each output line is one distinct reading: {"seen_at", "id", "lon", "lat", ...properties}, the
// first refresh that saw it. Readings repeated across refreshes are dropped.
//
// Run: bun scripts/compact-archive.mjs [--dry-run]
// Needs an R2 API token in .env (scripts/lib/r2.mjs).
import { gunzipSync, gzipSync } from "node:zlib";
import { KEY, bkkParts } from "../shared/data-layout.ts";
import { LAYERS } from "../shared/types.ts";
import { pool } from "./lib/data.mjs";
import { r2 } from "./lib/r2.mjs";

const DRY = process.argv.includes("--dry-run");
const s3 = r2();
// Our own bucket, not a government server: more parallelism is fine.
const PARALLEL = 16;
// Derived from the fetch time, so it changes every refresh without new information.
const VOLATILE = new Set(["age_h"]);

async function listAll(prefix) {
	const keys = [];
	let continuationToken;
	do {
		const r = await s3.list({ prefix, continuationToken, maxKeys: 1000 });
		for (const o of r.contents ?? []) keys.push({ key: o.key, size: o.size });
		continuationToken = r.isTruncated ? r.nextContinuationToken : undefined;
	} while (continuationToken);
	return keys;
}

const today = bkkParts(Date.now()).day;
let rawRead = 0, rawBytes = 0, outBytes = 0;

for (const layer of LAYERS) {
	const raw = await listAll(KEY.rawPrefix(layer));
	const byDay = Map.groupBy(raw, (o) => o.key.slice(KEY.rawPrefix(layer).length, KEY.rawPrefix(layer).length + 10));
	for (const [day, objs] of [...byDay].sort()) {
		if (day >= today) continue; // still being written
		objs.sort((a, b) => a.key.localeCompare(b.key));
		const seen = new Map(); // reading (without seen_at) -> row
		const add = (row) => {
			const { seen_at, ...rest } = row;
			const k = JSON.stringify(rest);
			if (!seen.has(k)) seen.set(k, row);
		};
		// Merge a file from an earlier run for this day (e.g. a run that stopped before deleting).
		const dayKey = KEY.day(layer, day);
		if (await s3.exists(dayKey))
			for (const line of gunzipSync(Buffer.from(await s3.file(dayKey).arrayBuffer())).toString("utf8").split("\n")) if (line) add(JSON.parse(line));
		const snaps = await pool(objs, PARALLEL, (o) => s3.file(o.key).json());
		snaps.forEach((snap, i) => {
			rawRead++, (rawBytes += objs[i].size);
			for (const f of snap.features) {
				const props = Object.fromEntries(Object.entries(f.properties).filter(([k]) => !VOLATILE.has(k)));
				const [lon, lat] = f.geometry.coordinates;
				add({ seen_at: snap.fetchedAt, id: props.id, lon, lat, ...props });
			}
		});
		const rows = [...seen.values()].sort((a, b) => a.seen_at.localeCompare(b.seen_at) || String(a.id).localeCompare(String(b.id)));
		const gz = gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { level: 9 });
		outBytes += gz.length;
		console.log(`${layer} ${day}: ${objs.length} refreshes → ${rows.length} readings, ${(gz.length / 1e3).toFixed(0)} kB${DRY ? " (dry run)" : ""}`);
		if (DRY) continue;
		await s3.write(dayKey, gz, { type: "application/gzip" });
		// Delete raw only once the day file is confirmed in place.
		if ((await s3.size(dayKey)) !== gz.length) throw new Error(`${dayKey}: size mismatch after upload; raw objects kept`);
		await pool(objs, PARALLEL, (o) => s3.delete(o.key));
	}
}

if (!DRY) {
	// Index of compacted days, for API users: {layers: {flood: [{day, key, bytes}], …}}.
	const index = { updated_at: new Date().toISOString(), layers: {} };
	for (const layer of LAYERS) {
		const days = await listAll(`archive/${layer}/`);
		index.layers[layer] = days.map((o) => ({ day: o.key.slice(-20, -10), key: o.key, bytes: o.size }));
	}
	await s3.write(KEY.archiveIndex, JSON.stringify(index), { type: "application/json" });
}
console.log(`read ${rawRead} raw snapshots (${(rawBytes / 1e6).toFixed(0)} MB) → ${(outBytes / 1e6).toFixed(1)} MB compacted`);

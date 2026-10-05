// Laptop side of the live refresh: the sources Cloudflare can't fetch (RUNS_ON in
// worker/sources.ts: BMA and ThaiWater refuse Workers) are fetched here, with the same code as the
// cron, and posted to the Worker's ingest API, which writes R2. Nothing here touches R2.
// Runs every 5 min, 2.5 min after the cron's slots so the two never update live/status.json at
// once. Missed slots (laptop asleep) are skipped.
//
// Run: bun run mirror            (keep the Mac awake: caffeinate -i bun run mirror)
//      bun run mirror --once     (one refresh of every laptop source, then exit)
// Key: ~/.config/thai-water-way/ingest-key, same value as the Worker's INGEST_KEY secret.
// Env: INGEST_URL to post elsewhere (dev: http://localhost:5199/api/ingest), INGEST_KEY to override the file.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_HOST } from "../shared/deploy.ts";
import { LAYERS } from "../shared/types.ts";
import { RUNS_ON, collect, due } from "../worker/sources.ts";

const KEY_FILE = join(homedir(), ".config", "thai-water-way", "ingest-key");
const URL = process.env.INGEST_URL ?? `https://${APP_HOST}/api/ingest`;
const key = process.env.INGEST_KEY ?? (await readFile(KEY_FILE, "utf8").catch(() => "")).trim();
if (!key) throw new Error(`no ingest key: put it in ${KEY_FILE} (the Worker's INGEST_KEY secret)`);

async function refresh(layers, tide) {
	const batch = await collect(layers, tide);
	if (!Object.keys(batch.results).length) return batch.results;
	const res = await fetch(URL, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(batch),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`ingest -> HTTP ${res.status}: ${await res.text()}`);
	return batch.results;
}

const SLOT = 5 * 60_000, OFFSET = 150_000;
const log = (results) => {
	const t = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" });
	const parts = Object.entries(results).map(([k, s]) => (s.ok ? `${k} ${s.count ?? "ok"}` : `${k} FAILED ${s.error}`));
	console.log(`${t} ${parts.join(" · ") || "nothing due"}`);
};

if (process.argv.includes("--once")) {
	log(await refresh(LAYERS.filter((l) => RUNS_ON[l] === "laptop"), RUNS_ON.tide === "laptop"));
	process.exit(0);
}

console.log(`mirroring ${LAYERS.filter((l) => RUNS_ON[l] === "laptop").join(", ")} every 5 min to ${URL}`);
for (;;) {
	const slot = Math.floor((Date.now() - OFFSET) / SLOT) * SLOT + SLOT; // next cron slot
	await Bun.sleep(slot + OFFSET - Date.now());
	// Woke up late (sleep, lid closed): skip rather than run a stale slot.
	if (Date.now() - (slot + OFFSET) > 60_000) continue;
	const { layers, tide } = due(slot, "laptop");
	try {
		log(await refresh(layers, tide));
	} catch (e) {
		console.error(new Date().toISOString(), "refresh failed:", e);
	}
}

// Laptop side of the live refresh: the sources Cloudflare can't fetch (RUNS_ON in
// worker/sources.ts: BMA blocks Workers, ThaiWater rate-limits them) are fetched here and written
// to R2, same files and code as the Worker cron. Runs every 5 min, 2.5 min after the cron's slots so
// the two never update live/status.json at once. Missed slots (laptop asleep) are skipped.
//
// Run: bun run mirror            (keep the Mac awake: caffeinate -i bun run mirror)
//      bun run mirror --once     (one refresh of every laptop source, then exit)
// Needs an R2 API token in .env (scripts/lib/r2.mjs).
import { LAYERS } from "../shared/types.ts";
import { RUNS_ON, due, refresh } from "../worker/sources.ts";
import { r2 } from "./lib/r2.mjs";

const s3 = r2();
const store = {
	get: async (key) => {
		const f = s3.file(key);
		return (await f.exists()) ? f.text() : null;
	},
	// S3 uploads can't set Cache-Control; the data domain's Cache Rules provide it.
	put: (key, body, contentType) => s3.write(key, body, { type: contentType }),
};

const SLOT = 5 * 60_000, OFFSET = 150_000;
const log = (results) => {
	const t = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" });
	const parts = Object.entries(results).map(([k, s]) => (s.ok ? `${k} ${s.count ?? "ok"}` : `${k} FAILED ${s.error}`));
	console.log(`${t} ${parts.join(" · ") || "nothing due"}`);
};

if (process.argv.includes("--once")) {
	log(await refresh(store, LAYERS.filter((l) => RUNS_ON[l] === "laptop"), RUNS_ON.tide === "laptop"));
	process.exit(0);
}

console.log(`mirroring ${LAYERS.filter((l) => RUNS_ON[l] === "laptop").join(", ")} every 5 min`);
for (;;) {
	const slot = Math.floor((Date.now() - OFFSET) / SLOT) * SLOT + SLOT; // next cron slot
	await Bun.sleep(slot + OFFSET - Date.now());
	// Woke up late (sleep, lid closed): skip rather than run a stale slot.
	if (Date.now() - (slot + OFFSET) > 60_000) continue;
	const { layers, tide } = due(slot, "laptop");
	try {
		log(await refresh(store, layers, tide));
	} catch (e) {
		console.error(new Date().toISOString(), "refresh failed:", e);
	}
}

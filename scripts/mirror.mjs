// Laptop side of the live refresh: the sources Cloudflare can't fetch (RUNS_ON in
// worker/sources.ts: BMA and ThaiWater refuse Workers) are fetched here, with the same code as the
// cron, and posted to the Worker's ingest API, which writes R2. Nothing here touches R2.
// Runs every 5 min, 2.5 min after the cron's slots so the two never update live/status.json at
// once. Missed slots (laptop asleep) are skipped.
//
// Run: bun run mirror            (keep the Mac awake: caffeinate -i bun run mirror)
//      bun run mirror --once     (one refresh of every laptop source, then exit)
// Key and target: scripts/lib/api.mjs.
import { LAYERS } from "../shared/types.ts";
import { RUNS_ON, collect, due } from "../worker/sources.ts";
import { KEY } from "../shared/data-layout.ts";
import { ORIGIN, api, get } from "./lib/api.mjs";
import { loadNews } from "./lib/news.ts";

const page = async (url) => {
	const res = await fetch(url, { headers: { "user-agent": "thai-water-way", accept: "*/*" }, signal: AbortSignal.timeout(25_000) });
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	return res.text();
};
const ctx = {
	previous: async (layer) => JSON.parse((await get(KEY.live(`${layer}.json`)))?.toString("utf8") ?? "null"),
	news: (prev) => loadNews(prev, page),
};

async function post(layers, tide) {
	const batch = await collect(layers, tide, ctx);
	if (Object.keys(batch.results).length)
		await api("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
	return batch.results;
}

// News (minutes of claude -p) goes in its own batch, so sensor layers aren't held up behind it.
async function refresh(layers, tide) {
	const results = await post(layers.filter((l) => l !== "news"), tide);
	return layers.includes("news") ? { ...results, ...(await post(["news"], false)) } : results;
}

const SLOT = 5 * 60_000, OFFSET = 150_000;
const log = (results) => {
	const t = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" });
	// Failures in short (full text in live/status.json): "pump HTTP 404".
	const parts = Object.entries(results).map(([k, s]) => (s.ok ? `${k} ${s.count ?? "ok"}` : `${k} ${/HTTP \d{3}/.exec(s.error)?.[0] ?? s.error.slice(0, 80)}`));
	console.log(`${t} ${parts.join(" · ") || "nothing due"}`);
};

if (process.argv.includes("--once")) {
	log(await refresh(LAYERS.filter((l) => RUNS_ON[l] === "laptop"), RUNS_ON.tide === "laptop"));
	process.exit(0);
}

console.log(`mirroring ${LAYERS.filter((l) => RUNS_ON[l] === "laptop").join(", ")} every 5 min to ${ORIGIN}`);
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

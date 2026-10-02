import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };
import { DATA_BUCKET } from "./shared/deploy.ts";

// The Worker only refreshes live data (cron) into R2. The app is static assets (free, no Worker
// run); data is read from the R2 bucket on its custom domain (shared/data-layout.ts DATA_ORIGIN).
// Built data comes from the thai-water-way-data repo via scripts/publish-data.mjs.

export default defineConfig({
	worker: {
		name: "thai-water-way",
		compatibilityDate: "2026-09-30",
		entrypoint,
		assets: {
			notFoundHandling: "single-page-application",
			// Same R2 keys as the data domain, for local dev; production clients use DATA_ORIGIN.
			runWorkerFirst: ["/current.json", "/live/*", "/archive/*", "/v/*"],
		},
		env: {
			// All public data: built versions, live snapshots, archive (key layout in shared/data-layout.ts).
			DATA: bindings.r2({ name: DATA_BUCKET }),
		},
		// Matches the dashboard: Workers Logs (incl. the cron's console.warn) and traces kept.
		observability: {
			enabled: false,
			headSamplingRate: 1,
			redactQueryString: false,
			logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
			traces: { enabled: true, headSamplingRate: 1, persist: true },
			issues: { enabled: false },
		},
		// BMA sensors update every 5 minutes.
		triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
	},
});

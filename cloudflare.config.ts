import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };
import { DATA_BUCKET } from "./shared/deploy.ts";

// Built data files (network, terrain, scenarios, …) live in the thai-water-way-data repo and are
// served from R2, not bundled; see scripts/publish-data.mjs.

export default defineConfig({
	worker: {
		name: "thai-water-way",
		compatibilityDate: "2026-09-30",
		entrypoint,
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*", "/data/*"],
		},
		env: {
			// Latest normalized snapshot per layer, written by the cron below.
			SNAPSHOTS: bindings.kv(),
			// Published data versions: "<version>/<path>" plus a "current" pointer object.
			DATA: bindings.r2({ name: DATA_BUCKET }),
			// Static assets; /data/* falls back here (local dev, or before the first publish).
			ASSETS: bindings.assets(),
		},
		// BMA sensors update every 5 minutes.
		triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
	},
});

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	// MapLibre starts its worker with { type: "module" }.
	worker: { format: "es" },
});

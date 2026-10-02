import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
	plugins: [cloudflare()],
	// public/ only holds the data symlink: dev serves it at /data/*, builds leave it out (production
	// reads data from the data domain, never from the app's assets).
	publicDir: command === "serve" ? "public" : false,
	// MapLibre starts its worker with { type: "module" }.
	worker: { format: "es" },
}));

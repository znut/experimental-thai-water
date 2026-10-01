// Writes public/data/BUILD.json (in the thai-water-way-data repo): which app commit and steps
// produced the current data, so every data commit traces back to the code that built it.
// Runs at the end of `bun run data:rebuild`; publish copies it to R2 like any other file.
// Run: bun scripts/record-build.mjs
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";

const appRoot = new URL("..", import.meta.url).pathname;
const dataDir = new URL("../public/data/", import.meta.url);
const git = (...a) => {
	try {
		return execFileSync("git", ["-C", appRoot, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
};
const J = async (f) => JSON.parse(await readFile(new URL(f, dataDir), "utf8").catch(() => "null"));

async function files(dir, prefix = "") {
	const out = {};
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".") || e.name === "BUILD.json") continue;
		if (e.isDirectory()) Object.assign(out, await files(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`));
		else out[`${prefix}${e.name}`] = (await stat(new URL(e.name, dir))).size;
	}
	return out;
}

const pkg = JSON.parse(await readFile(new URL("package.json", `file://${appRoot}`), "utf8"));
const [network, terrain, infra, ponding, hotspots] = await Promise.all(["network.geojson", "terrain.json", "infra.json", "ponding.json", "hotspots.json"].map(J));
const now = new Date();

const build = {
	built_at: now.toISOString(),
	built_at_bangkok: now.toLocaleString("en-GB", { timeZone: "Asia/Bangkok" }),
	app: {
		commit: git("rev-parse", "HEAD"),
		// Uncommitted app changes mean this data can't be rebuilt exactly from the commit above.
		dirty: (git("status", "--porcelain") ?? "") !== "",
		branch: git("rev-parse", "--abbrev-ref", "HEAD"),
	},
	steps: pkg.scripts["data:rebuild"],
	runtime: { bun: process.versions.bun ?? null, node: process.versions.node },
	network_build: network?.build ?? null,
	terrain: terrain ? { source: terrain.label, calibration: terrain.calibration ?? null } : null,
	counts: {
		edges: network?.features?.length ?? null,
		pumps: infra?.pumps?.length ?? null,
		tunnels: infra?.tunnels?.length ?? null,
		gravity_outlets: infra?.gravity?.length ?? null,
		ponding_spots: ponding ? Object.keys(ponding.params).length : null,
		report_hotspots: hotspots ? Object.keys(hotspots.params).length : null,
	},
	files: await files(dataDir),
};

await writeFile(new URL("BUILD.json", dataDir), JSON.stringify(build, null, "\t") + "\n");
console.log(`BUILD.json: app ${build.app.commit?.slice(0, 12) ?? "(no commit)"}${build.app.dirty ? " (dirty)" : ""}, network ${build.network_build}, ${Object.keys(build.files).length} files`);

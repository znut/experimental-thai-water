// Publishes the data repo (public/data -> ../thai-water-way-data/public) to R2 as a new version,
// then points "current" at it. The version is the data repo's commit, so what is live always
// matches a commit. Files go to "<version>/<path>"; the Worker serves /data/<path> from the
// current version, so a half-finished upload is never visible. Old versions stay in R2 (roll
// back by rewriting "current").
//
// Run: bun scripts/publish-data.mjs [--dry-run] [--allow-dirty]
//   --dry-run      list what would be uploaded
//   --allow-dirty  publish uncommitted data (version gets a "-dirty" suffix)
// Needs `cf` logged in to your Cloudflare account (bunx cf auth login). Local dev needs no
// publish: the Worker falls back to the symlinked files when R2 has nothing.
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { DATA_BUCKET } from "../shared/deploy.ts";

const DRY = process.argv.includes("--dry-run");
const ALLOW_DIRTY = process.argv.includes("--allow-dirty");
const root = new URL("../public/data/", import.meta.url);

const TYPES = { ".json": "application/json", ".geojson": "application/geo+json", ".bin": "application/octet-stream" };

async function walk(dir, prefix = "") {
	const out = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".")) continue;
		if (e.isDirectory()) out.push(...(await walk(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`)));
		else out.push(`${prefix}${e.name}`);
	}
	return out;
}

function cf(args) {
	return new Promise((resolve, reject) => {
		const p = spawn("bunx", ["cf", ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cf ${args.slice(0, 4).join(" ")} failed: ${err.trim().slice(-400)}`))));
	});
}

const net = JSON.parse(await readFile(new URL("network.geojson", root), "utf8"));
// Version = data repo commit (+ "-dirty" if it has uncommitted changes and --allow-dirty).
// public/data is a symlink into the data repo; resolve it before taking the parent directory.
const repo = dirname(realpathSync(root.pathname));
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let sha;
try {
	sha = git("rev-parse", "--short=12", "HEAD");
} catch {
	if (!DRY) throw new Error(`no commit in ${repo} yet: commit the data first`);
	sha = "uncommitted";
}
const dirty = git("status", "--porcelain", "--", "public") !== "";
if (dirty && !ALLOW_DIRTY && !DRY) throw new Error("data repo has uncommitted changes under public/: commit them, or pass --allow-dirty");
const version = `${sha}${dirty ? "-dirty" : ""}`;
// git prints "fatal: Needed a single revision" before the first commit; that is expected there.
console.log(`network build ${net.build}`);
const files = await walk(root);
let bytes = 0;
for (const f of files) bytes += (await stat(new URL(f, root))).size;
console.log(`version ${version}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB → r2://${DATA_BUCKET}`);
if (DRY) {
	for (const f of files) console.log(`  ${version}/${f}`);
	process.exit(0);
}

let done = 0;
const queue = [...files];
await Promise.all(
	Array.from({ length: 4 }, async () => {
		for (let f; (f = queue.shift()); ) {
			const ext = f.slice(f.lastIndexOf("."));
			await cf(["r2", "objects", "put", `${version}/${f}`, "--bucket-name", DATA_BUCKET, "--file", new URL(f, root).pathname, "--content-type", TYPES[ext] ?? "application/octet-stream"]);
			console.log(`  ${++done}/${files.length} ${f}`);
		}
	}),
);
// Switch over only after every file is in place.
await cf(["r2", "objects", "put", "current", "--bucket-name", DATA_BUCKET, "--body", version, "--content-type", "text/plain"]);
console.log(`current → ${version}`);

// Publishes the data repo (public/data -> ../thai-water-way-data/public) to R2 as a new version,
// then points current.json at it. The version is the data repo's commit, so what is live always
// matches a commit. Files go to "v/<version>/<path>" (immutable, cached for a year on the data
// domain); clients read current.json first, so a half-finished upload is never visible. Old
// versions stay in R2 (roll back by rewriting current.json).
//
// Run: bun scripts/publish-data.mjs [--dry-run] [--allow-dirty]
//   --dry-run      list what would be uploaded
//   --allow-dirty  publish uncommitted data (version gets a "-dirty" suffix)
// Uploads go through the Worker's API (scripts/lib/api.mjs); a version's files are write-once, so
// an interrupted publish just re-runs (files already there are skipped). Local dev needs no
// publish: the dev client reads the symlinked files directly.
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { KEY } from "../shared/data-layout.ts";
import { ORIGIN, put } from "./lib/api.mjs";

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
console.log(`version ${version}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB → ${ORIGIN}`);
if (DRY) {
	for (const f of files) console.log(`  ${KEY.built(version, f)}`);
	process.exit(0);
}

let done = 0;
const queue = [...files];
await Promise.all(
	Array.from({ length: 4 }, async () => {
		for (let f; (f = queue.shift()); ) {
			const ext = f.slice(f.lastIndexOf("."));
			const r = await put(KEY.built(version, f), await readFile(new URL(f, root)), TYPES[ext] ?? "application/octet-stream");
			console.log(`  ${++done}/${files.length} ${f}${r ? "" : " (already there)"}`);
		}
	}),
);
// Switch over only after every file is in place (the Worker checks again).
const current = { version, published_at: new Date().toISOString(), network_build: net.build ?? null, files };
await put(KEY.current, JSON.stringify(current), "application/json");
console.log(`${KEY.current} → ${version}`);

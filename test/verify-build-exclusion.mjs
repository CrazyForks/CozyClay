/**
 * I2 proof by module graph (plan 6.1): the default dist/ carries zero ingest
 * bytes, proven from a fresh build's manifest AND module ids.
 *
 * WHY this test exists: the isolation claim is about the shipped artifact, and
 * a string scan of dist/ cannot prove it -- chunk names are hashed and minified
 * code rewrites strings. The manifest of a fresh default build plus every
 * module id of the same build are the only honest evidence. The negative
 * control is a deliberately violating config that imports src/ingest/state.js
 * from the app entry; BOTH checks must report it, or a check is blind and
 * proves nothing.
 *
 * What would be circular or wrong: checking a build configured to exclude
 * ingest (both runs use the default vite.config.js); reusing a stale dist/
 * (every run builds fresh); the negative control using a static import (it is
 * inlined into the entry chunk and invisible to the manifest -- exactly why the
 * module-graph check exists -- so the control imports dynamically, making a
 * separate chunk with its own manifest record and module id); or asserting the
 * clean state without first proving the checks can fail.
 *
 * Canonical RED (plan 13): I2 "negative control: injected src/ingest module
 * not reported".
 *
 * Note on the plan's "tmp config": the negative control is an in-process config
 * object (plugins + manifest flag) instead of a scratch file -- identical
 * mechanism, no temp-file cleanup to leak.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = join(REPO_ROOT, "dist", ".vite", "manifest.json");
const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

function buildApp(plugins) {
	return build({
		root: REPO_ROOT,
		configFile: join(REPO_ROOT, "vite.config.js"),
		logLevel: "silent",
		plugins,
		build: { manifest: true },
	});
}

// the test-local graph plugin: generateBundle walks every fully resolved
// module id, which is exactly the plan's "writes every module id"
const graphPlugin = (collect) => ({
	name: "verify-build-exclusion-graph",
	generateBundle() {
		for (const id of this.getModuleIds()) collect.push(id);
	},
});

// no manifest key, src field, or emitted chunk/asset may resolve under
// src/ingest/ -- keys and src are repo-relative source paths, emitted paths
// are dist-relative, and both keep the src/ingest directory only when the
// feature actually entered the build
function manifestIngestPaths(manifest) {
	const found = [];
	for (const [key, rec] of Object.entries(manifest)) {
		for (const s of [key, rec.src]) {
			if (typeof s === "string" && (s === "src/ingest" || s.startsWith("src/ingest/"))) {
				found.push(`source path ${s}`);
			}
		}
		for (const f of [
			rec.file,
			...(rec.imports || []),
			...(rec.dynamicImports || []),
			...(rec.css || []),
			...(rec.assets || []),
		]) {
			if (typeof f === "string" && (f === "src/ingest" || f.startsWith("src/ingest/"))) {
				found.push(`emitted path ${f}`);
			}
		}
	}
	return found;
}
// the negative control: a deliberately violating config that imports the
// surface module from the app entry. A static import would be inlined into the
// entry chunk and become invisible to the manifest -- exactly why the
// module-graph check exists -- so the control imports dynamically, producing a
// separate chunk with its own manifest record AND module id, and both checks
// must report it.
const injectIngestPlugin = {
	name: "verify-build-exclusion-inject",
	transform(code, id) {
		if (id.endsWith("/src/main.jsx")) return `${code}\nimport("./ingest/state.js");\n`;
		return null;
	},
};
// the plan's wording covers an entry, a chunk, or a src field: the injection
// proves the source-path branches, and an html input's emitted path proves the
// chunk branch (dist/src/ingest/index.html keeps the source directory)
ok(
	"manifest check reports an ingest html entry and its emitted chunk path",
	manifestIngestPaths({
		"src/ingest/index.html": { file: "src/ingest/index.html", src: "src/ingest/index.html", isEntry: true },
	}).length >= 2,
);

// --- negative control first: both checks must report the injection ----------
// The deliberately violating config imports the surface module from the app
// entry (src/main.jsx); a blind guard reports nothing and fails here.
let negIds = [];
await buildApp([injectIngestPlugin, graphPlugin(negIds)]);
const negManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const manifestReported = manifestIngestPaths(negManifest).length > 0;
const graphReported = negIds.some((id) => id.includes("/src/ingest/"));
ok(
	"negative control: injected src/ingest module not reported",
	manifestReported && graphReported,
	`manifest=${manifestReported} graph=${graphReported}`,
);

// --- the default build must be clean in the manifest ------------------------
await buildApp([]);
const cleanManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const cleanManifestHits = manifestIngestPaths(cleanManifest);
ok("dist manifest contains zero src/ingest paths", cleanManifestHits.length === 0, cleanManifestHits.join(" | "));

// --- and clean in the module graph -------------------------------------------
let cleanIds = [];
await buildApp([graphPlugin(cleanIds)]);
const cleanGraphHits = cleanIds.filter((id) => id.includes("/src/ingest/"));
ok("module graph contains zero /src/ingest/ ids", cleanGraphHits.length === 0, cleanGraphHits.join(" | "));

// --- leave dist/ in the canonical state ---------------------------------------
// the test's builds empty dist and write no fonts; a final default build
// restores exactly what a plain `npm run build` produces
const restore = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, encoding: "utf8" });
const restoreLines = (restore.stdout + restore.stderr || "")
	.split("\n")
	.filter((l) => !/^\(node:|^\(Use `node --trace-warnings/.test(l));
ok("default npm run build is unchanged", restore.status === 0, restoreLines.slice(-4).join("\n"));

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

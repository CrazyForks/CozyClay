/**
 * I2 proof by module graph (plan 6.1): the default dist/ carries zero ingest
 * bytes, proven from a fresh build's manifest, its EMITTED chunk module lists,
 * and every module id.
 *
 * WHY this test exists: the isolation claim is about the shipped artifact, and
 * a string scan of dist/ cannot prove it -- chunk names are hashed and minified
 * code rewrites strings. The manifest of a fresh default build, the module
 * lists of every chunk that build actually emits, and every module id of the
 * same build are the only honest evidence. The negative controls are
 * deliberately violating configs: one that imports src/ingest/state.js from
 * the app entry, and one whose index.html carries an HTML <script
 * type="module"> reference to src/ingest/state.js -- an ENTRY ROUTE, not an
 * import edge (I-ISO-02). BOTH controls must be reported, or a check is blind
 * and proves nothing.
 *
 * What would be circular or wrong: checking a build configured to exclude
 * ingest (both runs use the default vite.config.js); reusing a stale dist/
 * (every run builds fresh); the JS negative control using a static import (it
 * is inlined into the entry chunk and invisible to the manifest -- exactly why
 * the module-graph check exists -- so the control imports dynamically, making
 * a separate chunk with its own manifest record and module id); asserting the
 * clean state without first proving the checks can fail; or trusting the
 * manifest alone for entry routes -- Vite inlines an HTML-referenced module
 * into the html entry chunk, so the manifest keeps no key, src field, or
 * emitted path under src/ingest/ and the emitted chunk's own module list is
 * the one record of the feature's presence that survives inlining.
 *
 * Canonical REDs (plan 13): I2 "negative control: injected src/ingest module
 * not reported"; I-ISO-02 "negative control: HTML module-script reference to
 * src/ingest not reported".
 *
 * Note on the plan's "tmp config": the negative controls are in-process config
 * objects (plugins + manifest flag) instead of scratch files -- identical
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

// buildApp returns the EMITTED bundle (result.output): the emitted-bundle scan
// is a check on what the build actually ships, not on the import graph
async function buildApp(plugins) {
	const result = await build({
		root: REPO_ROOT,
		configFile: join(REPO_ROOT, "vite.config.js"),
		logLevel: "silent",
		plugins,
		build: { manifest: true },
	});
	return result.output;
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
// the emitted-bundle scan: every chunk the build actually emits carries the
// module ids it was built from (chunk.modules), so the feature's presence is
// checked against the OUTPUT, not reasoned over the import graph. This is the
// I-ISO-02 fix: an HTML <script type="module"> reference is an ENTRY ROUTE,
// not an import edge -- Vite inlines the referenced module into the html
// entry chunk, so the manifest keeps no key, src field, or emitted path under
// src/ingest/ (proven by the html negative control below), and the emitted
// chunk's own module list is the one record of what actually shipped.
function emittedIngestModules(output) {
	const found = [];
	for (const out of output) {
		if (out.type !== "chunk") continue;
		for (const id of Object.keys(out.modules)) {
			if (id.includes("/src/ingest/")) found.push(`${out.fileName}: ${id}`);
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
// the I-ISO-02 negative control: an HTML module-script reference to the
// surface, injected through the transform hook into the ROOT entry. The
// reference is an entry route -- no JS import edge exists anywhere -- so a
// manifest-only or import-edge-only gate reports nothing and fails here.
// The red-team attack referenced /src/ingest/main.jsx (which USES state.js,
// so both modules carry emitted content); a direct reference to state.js
// alone is fully tree-shaken today and leaves no emitted trace, which is why
// the module-graph check exists alongside the emitted scan.
const htmlInjectPlugin = (src) => ({
	name: "verify-build-exclusion-html-inject",
	transform(code, id) {
		// the root entry only; src/ingest/index.html is the feature's own
		// entry and must stay untouched
		if (!id.endsWith("/index.html") || id.includes("/src/")) return null;
		return `${code}\n<script type="module" src="${src}"></script>\n`;
	},
});
// the plan's wording covers an entry, a chunk, or a src field: the injection
// proves the source-path branches, and an html input's emitted path proves the
// chunk branch (dist/src/ingest/index.html keeps the source directory)
ok(
	"manifest check reports an ingest html entry and its emitted chunk path",
	manifestIngestPaths({
		"src/ingest/index.html": { file: "src/ingest/index.html", src: "src/ingest/index.html", isEntry: true },
	}).length >= 2,
);

// --- negative controls first: every check must report the injections --------
// The JS control imports the surface module from the app entry (src/main.jsx)
// dynamically, producing a separate chunk with its own manifest record AND
// module id; a blind guard reports nothing and fails here.
let negIds = [];
const negOutput = await buildApp([injectIngestPlugin, graphPlugin(negIds)]);
const negManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const manifestReported = manifestIngestPaths(negManifest).length > 0;
const graphReported = negIds.some((id) => id.includes("/src/ingest/"));
const emittedReported = emittedIngestModules(negOutput).length > 0;
ok(
	"negative control: injected src/ingest module not reported",
	manifestReported && graphReported && emittedReported,
	`manifest=${manifestReported} graph=${graphReported} emitted=${emittedReported}`,
);

// --- I-ISO-02 negative control: the HTML entry route ------------------------
// The html control's modules are INLINED into the html entry chunk, so the
// manifest is blind to them by construction -- the detail below shows the
// manifest staying blind while the emitted scan and the module graph report
// the same modules. The emitted scan is the check that closes the route the
// manifest check never covered.
let htmlIds = [];
const htmlOutput = await buildApp([htmlInjectPlugin("/src/ingest/main.jsx"), graphPlugin(htmlIds)]);
const htmlEmitted = emittedIngestModules(htmlOutput);
const htmlGraphHits = htmlIds.filter((id) => id.includes("/src/ingest/"));
const htmlManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
ok(
	"negative control: HTML module-script reference to src/ingest not reported",
	htmlEmitted.length > 0 && htmlGraphHits.length > 0,
	`emitted=${htmlEmitted.join(" | ") || "NONE"} graph=${htmlGraphHits.join(" | ") || "NONE"} manifestBlind=${manifestIngestPaths(htmlManifest).length === 0}`,
);
// a DIRECT reference to src/ingest/state.js -- no importer, no usage -- is
// fully tree-shaken: no emitted chunk carries it and the manifest stays blind,
// so the emitted scan cannot prove a module the bundler eliminated. The
// module-graph check is what reports this variant.
let stateIds = [];
await buildApp([htmlInjectPlugin("/src/ingest/state.js"), graphPlugin(stateIds)]);
ok(
	"negative control: direct HTML reference to src/ingest/state.js is reported",
	stateIds.some((id) => id.includes("/src/ingest/state.js")),
	`graph=${stateIds.filter((id) => id.includes("/src/ingest/")).join(" | ") || "NONE"}`,
);

// --- the default build must be clean in the manifest ------------------------
await buildApp([]);
const cleanManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const cleanManifestHits = manifestIngestPaths(cleanManifest);
ok("dist manifest contains zero src/ingest paths", cleanManifestHits.length === 0, cleanManifestHits.join(" | "));

// --- and clean in the emitted bundle -----------------------------------------
let cleanIds = [];
const cleanOutput = await buildApp([graphPlugin(cleanIds)]);
const cleanEmittedHits = emittedIngestModules(cleanOutput);
ok("emitted bundle contains zero ingest-derived modules", cleanEmittedHits.length === 0, cleanEmittedHits.join(" | "));

// --- and clean in the module graph -------------------------------------------
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

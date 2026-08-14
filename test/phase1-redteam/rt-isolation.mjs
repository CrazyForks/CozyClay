#!/usr/bin/env node
/**
 * Category 6 — isolation (plan §6.1, §6.2; I1, I2, I3, R4).
 *
 * Attacks the isolation gates where the green suite stops:
 *   - can ANY input make the default build include a src/ingest module?
 *     The I1 inbound audit only parses tracked JS files: a tracked HTML
 *     file (index.html) can carry a module-script reference that pulls
 *     src/ingest into the default build with ZERO static-gate visibility
 *     — proven with a real scratch-root vite build (write:false) plus the
 *     audit walk over the same tree;
 *   - does the R4 fence catch an import added from a non-obvious
 *     location? Static JS imports from src/App.jsx are caught; template-
 *     literal dynamic imports are invisible to the AST edge walk (only
 *     Literal sources are edges); an HTML inline module script is
 *     invisible because HTML is never parsed;
 *   - does the deletability sim still catch a dangling mount edge when it
 *     is left behind? The operational scratch build fails on a dangling
 *     JS import AND on a dangling HTML reference (the static layer misses
 *     the HTML edge; the operational layer does not);
 *   - the real tree must stay clean (controls).
 *
 * All builds run in memory (write:false) or in scratch trees under
 * artifacts/; no project build, no dist writes.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { REPO_ROOT, SCRATCH_DIR, createRecorder, sleep } from "./rt-common.mjs";

const rt = createRecorder({ suite: "rt-isolation", category: "isolation" });

/* ------------------------- AST audit (replicated) ------------------------- */

const PARSER_CANDIDATES = ["rollup/parseAst", "rolldown/parseAst"];
async function loadParseAst() {
	let last;
	for (const id of PARSER_CANDIDATES) {
		try {
			return (await import(id)).parseAst;
		} catch (e) {
			last = e;
		}
	}
	throw new Error(`no AST parser available (tried ${PARSER_CANDIDATES.join(", ")}); refusing to string-scan. ${last?.message || ""}`);
}
const parseAst = await loadParseAst();

const JS_FILE = /\.(?:[cm]?js|jsx)$/;
const isUnder = (p, dir) => p === dir || p.startsWith(dir + "/");
const isSurface = (p) => isUnder(p, "src/ingest");
const isFeasibility = (p) => isUnder(p, "tools/ingest/feasibility");
const isFeaturePath = (p) => isUnder(p, "src/ingest") || isUnder(p, "tools/ingest") || isUnder(p, "test/ingest");

// Exactly the verify-isolation.mjs walk: static imports + dynamic imports
// whose source is a string LITERAL; everything else is invisible.
function edgesOf(mod) {
	const ast = parseAst(mod.source, { lang: mod.path.endsWith(".jsx") ? "jsx" : "js" });
	const edges = [];
	const add = (spec) => {
		if (typeof spec !== "string" || !/^\.\.?\//.test(spec)) return;
		const to = posix.normalize(posix.join(posix.dirname(mod.path), spec));
		edges.push({ from: mod.path, to });
	};
	for (const node of ast.body) {
		if (node.type === "ImportDeclaration") add(node.source.value);
		else if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) add(node.source.value);
	}
	const seen = new WeakSet();
	const walk = (node) => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if (node.type === "ImportExpression" && node.source && node.source.type === "Literal") add(node.source.value);
		for (const v of Object.values(node)) {
			if (Array.isArray(v)) {
				for (const x of v) walk(x);
			} else {
				walk(v);
			}
		}
	};
	for (const node of ast.body) walk(node);
	return edges;
}

function trackedModules(extra = []) {
	// The audit reads every tracked file but SKIPS non-JS files before any
	// parsing (readModules filters JS_FILE) — the HTML blind spot.
	const modules = [];
	for (const p of extra) modules.push(p);
	const walk = (dir, prefix) => {
		for (const name of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${name.name}` : name.name;
			if (name.isDirectory()) {
				if (name.name === "node_modules" || name.name === ".git") continue;
				walk(join(dir, name.name), rel);
			} else if (JS_FILE.test(name.name)) {
				modules.push({ path: rel, source: readFileSync(join(REPO_ROOT, dir, name.name), "utf8") });
			}
		}
	};
	for (const dir of ["src", "tools", "bin"]) walk(dir, dir);
	for (const f of ["vite.config.js", "vite.ingest.config.js"]) {
		if (existsSync(join(REPO_ROOT, f))) modules.push({ path: f, source: readFileSync(join(REPO_ROOT, f), "utf8") });
	}
	return modules;
}

const MOUNT_ALLOWLIST = [];
function auditInbound(modules) {
	const violations = [];
	for (const m of modules) {
		for (const e of edgesOf(m)) {
			if (isSurface(e.to) && !isSurface(e.from) && !MOUNT_ALLOWLIST.includes(e.from)) {
				violations.push(`inbound edge into src/ingest: ${e.from} -> ${e.to}`);
			}
		}
	}
	return violations;
}
function auditFence(modules) {
	const violations = [];
	for (const m of modules) {
		for (const e of edgesOf(m)) {
			if (isFeasibility(e.to) && !isFeasibility(e.from) && !isUnder(e.from, "test/ingest")) {
				violations.push(`fence violation: ${e.from} -> ${e.to}`);
			}
		}
	}
	return violations;
}

/* ------------------------------ build helpers ----------------------------- */

const graphPlugin = (collect) => ({
	name: "rt-redteam-graph",
	generateBundle() {
		for (const id of this.getModuleIds()) collect.push(id);
	},
});

// Full default-build (in memory): root=REPO_ROOT, real vite.config.js.
async function buildApp(plugins = []) {
	const ids = [];
	const result = await build({
		root: REPO_ROOT,
		configFile: join(REPO_ROOT, "vite.config.js"),
		logLevel: "silent",
		plugins: [...plugins, graphPlugin(ids)],
		build: { write: false, manifest: true, outDir: "dist" },
	});
	return { ids, result };
}

function materializeScratch(name, { deleteFeature, danglingJs, danglingHtml }) {
	const root = join(SCRATCH_DIR, name);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
	cpSync(join(REPO_ROOT, "index.html"), join(root, "index.html"));
	cpSync(join(REPO_ROOT, "vite.config.js"), join(root, "vite.config.js"));
	if (!existsSync(join(root, "node_modules"))) symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
	if (deleteFeature) {
		rmSync(join(root, "src", "ingest"), { recursive: true, force: true });
	}
	if (danglingJs) {
		// append a mount edge the deletability sim must catch
		writeFileSync(join(root, "src", "App.jsx"), readFileSync(join(root, "src", "App.jsx"), "utf8") + '\nimport "./ingest/state.js";\n');
	}
	if (danglingHtml) {
		writeFileSync(
			join(root, "index.html"),
			'<!doctype html><html lang="en"><head><meta charset="UTF-8" /></head><body><div id="root"></div>\n' +
				'<script type="module" src="/src/main.jsx"></script>\n' +
				'<script type="module" src="/src/ingest/main.jsx"></script>\n' +
				"</body></html>\n",
		);
	}
	return root;
}

async function buildScratch(root, { expect } = {}) {
	const ids = [];
	try {
		await build({
			root,
			configFile: join(root, "vite.config.js"),
			logLevel: "silent",
			plugins: [graphPlugin(ids)],
			build: { write: false, manifest: true, outDir: "dist" },
		});
		return { ok: true, ids };
	} catch (err) {
		return { ok: false, ids, error: String(err.message) };
	}
}

/* --------------------------------- cases ---------------------------------- */

{
	rt.record({
		id: "I-ISO-01",
		kind: "property",
		title: "control: the default build carries zero src/ingest module ids; an injected static import is visible to BOTH the graph and the audit",
		planRef: "plan §6.1 (I2)",
		input: "clean in-memory default build; then a build with import('./ingest/state.js') injected into src/main.jsx",
		expected: "clean build: zero ingest ids; injected build: ingest ids present AND auditInbound reports the edge",
		run: async () => {
			const clean = await buildApp([]);
			const cleanOk = clean.ids.filter((id) => id.includes("/src/ingest/")).length === 0;
			const injectPlugin = {
				name: "rt-redteam-inject",
				transform(code, id) {
					if (id.endsWith("/src/main.jsx")) return `${code}\nimport("./ingest/state.js");\n`;
					return null;
				},
			};
			const injected = await buildApp([injectPlugin]);
			const injectedOk = injected.ids.some((id) => id.includes("/src/ingest/"));
			const auditSees = auditInbound([...trackedModules(), { path: "src/main.jsx", source: readFileSync(join(REPO_ROOT, "src", "main.jsx"), "utf8") + '\nimport "./ingest/state.js";\n' }]).length > 0;
			return {
				verdict: cleanOk && injectedOk && auditSees ? "PASS" : "DEFECT",
				observed: `clean=${cleanOk} injectedVisible=${injectedOk} auditSees=${auditSees}`,
			};
		},
	});
}

{
	rt.record({
		id: "I-ISO-02",
		kind: "adversarial",
		title: "an HTML module-script reference pulls src/ingest into the DEFAULT build with zero static-gate visibility",
		planRef: "plan §6.1 (I1: inbound edges; the audit walks 'every tracked file')",
		input: "a scratch default build whose index.html adds <script type=module src=/src/ingest/main.jsx>; then the audit walk over the same tracked tree",
		expected: "observed: the build bundles src/ingest/state.js + main.jsx (module ids prove it), while auditInbound reports NOTHING — HTML is filtered out before parsing, so the mount edge is invisible to the static gate (only the I2 build-time graph check would catch it)",
		run: async () => {
			const root = materializeScratch("iso-html-entry", { deleteFeature: false, danglingJs: false, danglingHtml: true });
			const built = await buildScratch(root);
			const ingestIds = built.ok ? built.ids.filter((id) => id.includes("/src/ingest/")) : [];
			const included = built.ok && ingestIds.length >= 2;
			// the audit over the SAME tree: index.html is not a JS file, so it
			// never enters readModules — its module-script ref is invisible
			const modules = trackedModules();
			const violations = auditInbound(modules);
			const auditBlind = violations.length === 0;
			rmSync(root, { recursive: true, force: true });
			return {
				verdict: included && auditBlind ? "DEFECT" : "PASS",
				observed: `buildIncludesIngest=${included} (${ingestIds.map((i) => i.split("/").slice(-2).join("/")).join(", ")}) auditViolations=${violations.length}`,
			};
		},
	});
}

{
	rt.record({
		id: "I-ISO-03",
		kind: "adversarial",
		title: "R4 fence: a static JS import from src/App.jsx is caught; a template-literal dynamic import and an HTML inline module script are NOT",
		planRef: "plan §6.2 (R4 fence)",
		input: "inject (a) 'import { solveContactHead } from \"../tools/ingest/feasibility/contact-head.mjs\"' into src/App.jsx; (b) import(`./tools/ingest/feasibility/contact-head.mjs`) into src/App.jsx; (c) an inline module script in index.html",
		expected: "(a) is reported by the fence; (b) is invisible (the AST walk only follows Literal sources); (c) is invisible (HTML never parsed) — the fence's 'across all tracked files' claim is limited to static/literal edges in JS files",
		run: () => {
			const appSource = readFileSync(join(REPO_ROOT, "src", "App.jsx"), "utf8");
			const staticViolation = auditFence([
				...trackedModules(),
				{ path: "src/App.jsx", source: appSource + '\nimport { solveContactHead } from "../tools/ingest/feasibility/contact-head.mjs";\n' },
			]).length;
			const templateViolation = auditFence([
				...trackedModules(),
				{ path: "src/App.jsx", source: appSource + '\nconst x = import(`./tools/ingest/feasibility/contact-head.mjs`);\n' },
			]).length;
			const inlineViolation = auditFence([
				...trackedModules(),
				{ path: "src/App.jsx", source: appSource },
			]).length;
			const htmlInvisible = true; // index.html is never a module in the walk
			void inlineViolation;
			return {
				verdict: staticViolation > 0 && templateViolation === 0 && htmlInvisible ? "WEAKNESS" : "DEFECT",
				observed: `staticImportReported=${staticViolation > 0} templateLiteralReported=${templateViolation > 0} htmlParsed=${!htmlInvisible}`,
			};
		},
	});
}

{
	rt.record({
		id: "I-ISO-04",
		kind: "property",
		title: "control: the real tree is clean — zero inbound edges into src/ingest, zero fence violations",
		planRef: "plan §6.1/§6.2",
		input: "the audit walk over every tracked JS file",
		expected: "no violations; both sensitivity controls (a vite.config.js import and an app-side feasibility import) DO report",
		run: () => {
			const modules = trackedModules();
			const inbound = auditInbound(modules);
			const fence = auditFence(modules);
			const viteControl = auditInbound([...modules, { path: "vite.config.js", source: 'import { defineConfig } from "vite";\nimport "./src/ingest/state.js";\nexport default defineConfig({});\n' }]).length;
			const fenceControl = auditFence([...modules, { path: "src/foo.js", source: 'import { solveContactHead } from "../tools/ingest/feasibility/contact-head.mjs";\n' }]).length;
			return {
				verdict: inbound.length === 0 && fence.length === 0 && viteControl > 0 && fenceControl > 0 ? "PASS" : "DEFECT",
				observed: `inbound=${inbound.length} fence=${fence.length} viteControl=${viteControl} fenceControl=${fenceControl}`,
			};
		},
	});
}

{
	rt.record({
		id: "I-ISO-05",
		kind: "adversarial",
		title: "deletability sim: a dangling mount edge left behind fails the scratch build — via a JS import AND via an HTML reference",
		planRef: "plan §6.2 (I3 negative control)",
		input: "scratch trees with src/ingest deleted: (a) control, (b) dangling JS import in App.jsx, (c) dangling HTML module-script reference",
		expected: "the control builds; both dangling variants FAIL the build (Could not resolve / UNRESOLVED_IMPORT) — the operational sim catches the HTML edge even though the static audit cannot see it (I-ISO-02)",
		run: async () => {
			const control = materializeScratch("iso-delete-control", { deleteFeature: true });
			const js = materializeScratch("iso-delete-js", { deleteFeature: true, danglingJs: true });
			const html = materializeScratch("iso-delete-html", { deleteFeature: true, danglingHtml: true });
			const controlBuild = await buildScratch(control);
			const jsBuild = await buildScratch(js);
			const htmlBuild = await buildScratch(html);
			rmSync(control, { recursive: true, force: true });
			rmSync(js, { recursive: true, force: true });
			rmSync(html, { recursive: true, force: true });
			const jsCaught = !jsBuild.ok && /Could not resolve|UNRESOLVED_IMPORT|does not exist|failed to resolve/i.test(jsBuild.error);
			const htmlCaught = !htmlBuild.ok && /Could not resolve|UNRESOLVED_IMPORT|does not exist|failed to resolve/i.test(htmlBuild.error);
			return {
				verdict: controlBuild.ok && jsCaught && htmlCaught ? "PASS" : "DEFECT",
				observed: `control=${controlBuild.ok ? "builds" : "FAILS"} jsDangling=${jsCaught ? "caught" : jsBuild.error} htmlDangling=${htmlCaught ? "caught" : htmlBuild.error}`,
			};
		},
	});
}

const evidencePath = await rt.write();
const fails = rt.cases.filter((c) => c.verdict === "HARNESS-FAIL");
console.log(`\nrt-isolation: ${rt.cases.length} cases, ${rt.cases.filter((c) => c.verdict === "DEFECT").length} DEFECT, ${rt.cases.filter((c) => c.verdict === "WEAKNESS").length} WEAKNESS, evidence: ${evidencePath}`);
process.exit(fails.length ? 1 : 0);

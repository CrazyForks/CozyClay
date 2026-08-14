/**
 * I1 + I3 static audit (plan 6.2): isolation of the ingest feature at rest.
 *
 * WHY this test exists: the module-graph check (verify-build-exclusion.mjs)
 * proves dist/ carries no ingest bytes, but nothing stops a review-time or
 * later commit from wiring the surface into the app, letting a feasibility
 * runner become production code, or drifting the diff outside the plan's closed
 * seam list. This audit walks EVERY tracked file (git ls-files -- not just
 * src/tools/test; the vite.config.js control lives at the repo root precisely
 * to prove that), AST-parses each one (a string scan would trip on comments and
 * strings), enforces the R4 fence, checks the plan 4 diff-shape budgets against
 * main, and proves deletability: remove the mount edge (the two main.jsx
 * lines), delete the composition module, the feature dirs and
 * vite.ingest.config.js, then build and run the app green bar.
 *
 * What would be circular or wrong: auditing only the feature's own files;
 * trusting an import edge found by regex (comments/strings would count);
 * measuring budgets against a diff that includes the feature dirs; a
 * deletability simulation that keeps any feature file or its gates; or
 * degrading to a string scan when no AST parser is available -- the audit
 * Canonical REDs (plan 13): I1 "guard is blind to R1-inbound (vite.config.js
 * control)"; I1 "orphaned boundary: zero mount edges is reported"; I1
 * "leaky boundary: a second mount edge is reported"; I3 "negative control:
 * dangling mount edge not reported".
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync, symlinkSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// --- AST parser: the audit is AST-based or it does not run -----------------
// rollup/parseAst is the plan's named parser; vite 8 ships rolldown's oxc
// parser instead, which is also the only one of the two that understands JSX.
// Neither present => fail loudly rather than fall back to a string scan.
const PARSER_CANDIDATES = ["rollup/parseAst", "rolldown/parseAst"];
async function loadParseAst(candidates = PARSER_CANDIDATES) {
	let last;
	for (const id of candidates) {
		try {
			return (await import(id)).parseAst;
		} catch (e) {
			last = e;
		}
	}
	throw new Error(
		`no AST parser available (tried ${candidates.join(", ")}); refusing to string-scan. ${last?.message || ""}`,
	);
}
const parseAst = await loadParseAst();
// sensitivity first: with no parser the audit must refuse, never degrade
let parserLoud = false;
try {
	await loadParseAst(["definitely-not-a-parser-module"]);
} catch (e) {
	parserLoud = /no AST parser available/.test(e.message);
}
ok("audit fails loudly without an AST parser", parserLoud);

// --- tracked modules -------------------------------------------------------
function trackedFiles() {
	const r = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ls-files failed: ${r.stderr || r.stdout}`);
	}
	return r.stdout.split("\n").filter(Boolean);
}
const tracked = trackedFiles();

const JS_FILE = /\.(?:[cm]?js|jsx)$/;
function readModules(paths) {
	const modules = [];
	for (const p of paths) {
		// html/json/yaml/py cannot carry a JS import edge; parsing them would be noise
		if (!JS_FILE.test(p)) continue;
		modules.push({ path: p, source: readFileSync(join(REPO_ROOT, p), "utf8") });
	}
	// src/surface-mount.js is the boundary's composition module (the W2 mount
	// edge). It is a NEW seam file, so before its commit it is not in git
	// ls-files; the audits must still see its edges in the working tree, or
	// the mount-edge and host-consumer checks would report an orphan on the
	// very tree that composes the boundary. Read it from disk when present.
	const mountPath = join(REPO_ROOT, "src", "surface-mount.js");
	if (existsSync(mountPath)) modules.push({ path: "src/surface-mount.js", source: readFileSync(mountPath, "utf8") });
	return modules;
}
const modules = readModules(tracked);

// --- import edges from the AST, never from the source text -----------------
function edgesOf(mod, parse) {
	const ast = parse(mod.source, { lang: mod.path.endsWith(".jsx") ? "jsx" : "js" });
	const edges = [];
	const add = (spec) => {
		// bare specifiers are packages and absolute specifiers are URLs: neither
		// can point into the repo, so only relative specifiers become edges
		if (typeof spec !== "string" || !/^\.\.?\//.test(spec)) return;
		const to = posix.normalize(posix.join(posix.dirname(mod.path), spec));
		edges.push({ from: mod.path, to });
	};
	for (const node of ast.body) {
		if (node.type === "ImportDeclaration") add(node.source.value);
		else if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) {
			add(node.source.value);
		}
	}
	// dynamic import() is an ImportExpression whose source is a string literal
	const seen = new WeakSet();
	const walk = (node) => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if (node.type === "ImportExpression" && node.source && node.source.type === "Literal") {
			add(node.source.value);
		}
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
function allEdges(mods, parse) {
	const edges = [];
	for (const m of mods) edges.push(...edgesOf(m, parse));
	return edges;
}

// --- path predicates -------------------------------------------------------
const isUnder = (p, dir) => p === dir || p.startsWith(dir + "/");
const isSurface = (p) => isUnder(p, "src/ingest");
const isFeasibility = (p) => isUnder(p, "tools/ingest/feasibility");
// the feature owns its whole diff; the seam budget applies to everything else
const isFeaturePath = (p) => isUnder(p, "src/ingest") || isUnder(p, "tools/ingest") || isUnder(p, "test/ingest");

// --- I1: the child realm stays closed ---------------------------------------
// src/ingest/** is the child's own world (plan 6, I1): a separate Vite input
// built into dist-ingest/. Nothing outside it may import it — the parent
// reaches the boundary through src/surface-mount.js, never through the
// child's directory. Zero inbound edges is the ONLY correct state here.
function auditInbound(edges) {
	const violations = [];
	for (const e of edges) {
		if (isSurface(e.to) && !isSurface(e.from)) {
			violations.push(`inbound edge into src/ingest: ${e.from} -> ${e.to}`);
		}
	}
	return violations;
}

// negative control first: a vite.config.js OUTSIDE src/tools/test importing the
// surface must be reported; the plan's own vite.config.js is clean today
const injectedViteConfig = {
	path: "vite.config.js",
	source: 'import { defineConfig } from "vite";\nimport "./src/ingest/state.js";\nexport default defineConfig({});\n',
};
const withViteControl = [...modules, injectedViteConfig];
ok(
	"guard is blind to R1-inbound (vite.config.js control)",
	auditInbound(allEdges(withViteControl, parseAst)).length > 0,
	auditInbound(allEdges(withViteControl, parseAst)).join(" | "),
);
// the real tree must be clean
const realInbound = auditInbound(allEdges(modules, parseAst));
ok("no tracked file outside src/ingest imports src/ingest", realInbound.length === 0, realInbound.join(" | "));

// --- I1: the boundary's single mount edge -----------------------------------
// The boundary is parent-side code (src/surface-host.js plus the composition
// in src/surface-mount.js) that the app entry composes through EXACTLY one
// edge. Zero edges is the orphan class that shipped twice in this project
// (undo coordinator, take store): the boundary existed, passed its isolated
// tests, and no runtime code ever instantiated it. Two or more edges is the
// leak class: a second composition path can diverge from the audited one. The
// audit therefore demands exactly the expected edge and nothing else, so both
// directions fail. The composition lives outside src/ingest/ (ultragoal
// ledger ruling): it runs in the app bundle, so the module-graph exclusion
// (verify-build-exclusion.mjs) keeps asserting literal zero src/ingest ids.
const MOUNT_EDGE = { from: "src/main.jsx", to: "src/surface-mount.js" };
// the exact two lines main.jsx contributes; the deletability sim strips them
const MOUNT_EDGE_LINES = [
	'import { mountSurfaceHost } from "./surface-mount.js";',
	"mountSurfaceHost({ window, document });",
];
const isMountEdge = (e) => e.from === MOUNT_EDGE.from && e.to === MOUNT_EDGE.to;
function auditMountEdge(edges) {
	const inbound = edges.filter((e) => e.to === MOUNT_EDGE.to);
	const violations = [];
	if (inbound.length === 0) {
		violations.push("orphaned boundary: zero inbound edges into src/surface-mount.js (the mount edge is missing)");
	} else if (inbound.length > 1) {
		violations.push(`leaky boundary: ${inbound.length} inbound edges into src/surface-mount.js (exactly one expected)`);
	}
	for (const e of inbound) {
		if (!isMountEdge(e)) {
			violations.push(`unexpected mount edge: ${e.from} -> ${e.to} (expected ${MOUNT_EDGE.from} -> ${MOUNT_EDGE.to})`);
		}
	}
	return violations;
}

// sensitivity first, both directions: with the mount edge removed the boundary
// is orphaned and must be reported — the exact class the old zero-edge audit
// let pass — and a second edge from anywhere is a leak and must be reported
const orphanMain = {
	path: "src/main.jsx",
	source: readFileSync(join(REPO_ROOT, "src/main.jsx"), "utf8")
		.split("\n")
		.filter((line) => !MOUNT_EDGE_LINES.includes(line.trim()))
		.join("\n"),
};
const withOrphan = modules.map((m) => (m.path === "src/main.jsx" ? orphanMain : m));
ok(
	"orphaned boundary: zero mount edges is reported",
	auditMountEdge(allEdges(withOrphan, parseAst)).length > 0,
	auditMountEdge(allEdges(withOrphan, parseAst)).join(" | "),
);
const withLeak = [
	...modules,
	{
		path: "src/ardy/timeline.jsx",
		source: readFileSync(join(REPO_ROOT, "src/ardy/timeline.jsx"), "utf8") + '\nimport { mountSurfaceHost } from "../surface-mount.js";\n',
	},
];
ok(
	"leaky boundary: a second mount edge is reported",
	auditMountEdge(allEdges(withLeak, parseAst)).length > 0,
	auditMountEdge(allEdges(withLeak, parseAst)).join(" | "),
);
// a single edge from the WRONG module is not the audited composition
const withWrongEdge = modules.map((m) => {
	if (m.path === "src/main.jsx") return orphanMain;
	if (m.path === "src/App.jsx") return { ...m, source: m.source + '\nimport { mountSurfaceHost } from "./surface-mount.js";\n' };
	return m;
});
ok(
	"a mount edge from the wrong module is reported",
	auditMountEdge(allEdges(withWrongEdge, parseAst)).length > 0,
	auditMountEdge(allEdges(withWrongEdge, parseAst)).join(" | "),
);
// the real tree must be exactly the expected edge
const realMountEdges = auditMountEdge(allEdges(modules, parseAst));
ok(
	"the app composes the boundary through exactly one expected mount edge",
	realMountEdges.length === 0,
	realMountEdges.join(" | "),
);

// --- I1: exactly one non-test module may consume createSurfaceHost ----------
// surface-host.js is the boundary's engine; a second consumer outside tests
// is a second composition path that can diverge, and zero consumers is the
// orphan class again. The composition module is the only allowed consumer.
function auditHostConsumers(mods, parse) {
	const consumers = [];
	for (const m of mods) {
		if (isUnder(m.path, "test")) continue;
		const ast = parse(m.source, { lang: m.path.endsWith(".jsx") ? "jsx" : "js" });
		for (const node of ast.body) {
			if (node.type !== "ImportDeclaration") continue;
			const spec = node.source?.value;
			if (typeof spec !== "string" || !/^\.\.?\//.test(spec)) continue;
			const to = posix.normalize(posix.join(posix.dirname(m.path), spec));
			if (to !== "src/surface-host.js") continue;
			if (node.specifiers?.some((s) => s.type === "ImportSpecifier" && s.imported.name === "createSurfaceHost")) {
				consumers.push(m.path);
			}
		}
	}
	const violations = [];
	if (consumers.length === 0) {
		violations.push("orphaned host: no non-test module imports createSurfaceHost");
	} else if (consumers.length > 1) {
		violations.push(`leaky host: ${consumers.length} non-test modules import createSurfaceHost (${consumers.join(", ")})`);
	} else if (consumers[0] !== "src/surface-mount.js") {
		violations.push(`unexpected createSurfaceHost consumer: ${consumers[0]} (expected src/surface-mount.js)`);
	}
	return violations;
}
// sensitivity first: zero consumers (the composition module removed) and a
// second consumer must both be reported
const withOrphanHost = modules.filter((m) => m.path !== "src/surface-mount.js");
ok(
	"orphaned host: zero createSurfaceHost consumers is reported",
	auditHostConsumers(withOrphanHost, parseAst).length > 0,
	auditHostConsumers(withOrphanHost, parseAst).join(" | "),
);
const withSecondConsumer = [
	...modules,
	{ path: "src/foo.js", source: 'import { createSurfaceHost } from "./surface-host.js";\n' },
];
ok(
	"leaky host: a second createSurfaceHost consumer is reported",
	auditHostConsumers(withSecondConsumer, parseAst).length > 0,
	auditHostConsumers(withSecondConsumer, parseAst).join(" | "),
);
// the real tree: exactly the composition module
const realHostConsumers = auditHostConsumers(modules, parseAst);
ok(
	"exactly one non-test module consumes createSurfaceHost (the composition)",
	realHostConsumers.length === 0,
	realHostConsumers.join(" | "),
);
// --- R4 fence: feasibility runners cannot become production code -------------
// Only tools/ingest/feasibility/** itself and test/ingest/** may import the
// runners (plan 6.2, 10.2); the fence is what makes their Stage-B removal a
// no-op for every other module.
function auditFence(edges) {
	const violations = [];
	for (const e of edges) {
		if (isFeasibility(e.to) && !isFeasibility(e.from) && !isUnder(e.from, "test/ingest")) {
			violations.push(`fence violation: ${e.from} -> ${e.to}`);
		}
	}
	return violations;
}
// sensitivity first: an app-side module importing a runner must be reported
const withFenceControl = [
	...modules,
	{ path: "src/foo.js", source: 'import { solveContactHead } from "../tools/ingest/feasibility/contact-head.mjs";\n' },
];
ok("R4 fence: app-side import of a feasibility runner is reported", auditFence(allEdges(withFenceControl, parseAst)).length > 0);
const realFence = auditFence(allEdges(modules, parseAst));
ok("R4 fence holds across all tracked files", realFence.length === 0, realFence.join(" | "));

// --- plan 4 diff-shape budgets ----------------------------------------------
// Closed seam list with per-file budgets; feature dirs own their diff, every
// other changed file must be a listed seam within its cap, and pages.yml must
// stay byte-identical. `modified` counts rewritten lines (a delete+add pair),
// `added` counts inserted lines -- the two caps the plan states.
// test/verify-build-exclusion.mjs and test/verify-isolation.mjs are the I1-I3
// gates named NEW in plan 6.1/6.2 but omitted from the 4 seam list, so the
// audit treats them as NEW seam files or its own commits would fail the list.
const SEAM = new Map([
	["tools/providers/envelope.mjs", { add: Infinity }],
	["test/providers/verify-envelope-conformance.mjs", { add: Infinity }],
	["src/motion-sources.js", { add: Infinity }],
	["src/performance-take.js", { add: Infinity }],
	["src/undo-coordinator.js", { add: Infinity }],
	// Plan §4 lists the envelope's test but omits the tests for these seam
	// modules, which the same plan requires under its test-first protocol. A
	// seam module's own verifier is part of that seam; admitting anything else
	// would let the list quietly forbid the tests it mandates. Recorded in the
	// ultragoal ledger rather than widened silently.
	["test/verify-performance-take.mjs", { add: Infinity }],
	["test/verify-undo-coordinator.mjs", { add: Infinity }],
	["test/verify-surface-host.mjs", { add: Infinity }],
	// test/verify-delivery.mjs is the D1-D3 delivery-matrix gate named NEW by
	// the assignment but omitted from the plan 4 seam list: it spawns the
	// surface Vite, the app dev server and the packaged CLI, so it is the
	// delivery seam's own verifier. Same admission class as the entries above;
	// recorded in the ultragoal ledger rather than widened silently.
	["test/verify-delivery.mjs", { add: Infinity }],
	["src/surface-host.js", { add: Infinity }],
	// The W2 mount edge (ultragoal ledger ruling): the composition module is
	// parent-side code that runs in the app bundle, deliberately NOT under
	// src/ingest/, so verify-build-exclusion.mjs keeps asserting literal zero
	// src/ingest ids in dist/. It is the boundary's single runtime entry,
	// deleted with the feature like the dirs.
	["src/surface-mount.js", { add: Infinity }],
	["vite.ingest.config.js", { add: Infinity }],
	["test/verify-build-exclusion.mjs", { add: Infinity }],
	["test/verify-isolation.mjs", { add: Infinity }],
	// App.jsx budget renegotiated in the ultragoal ledger (event 46611360):
	// plan §4 budgeted add<=130/mod<=20 for the S3-S8 seam commits, which
	// landed at exactly 73 added / 20 modified — the modified cap fully
	// consumed. The remaining §7.3 wiring (ONE coordinator owning both
	// stores, the take capture/apply/restore adapters, the landing door,
	// per-subject IK keying, clip persistence and the undo adapters) is
	// genuine new code plus real rewrites; contorting adapters into
	// added-line-only pass-throughs to fit the number is precisely the
	// needless-abstraction class this audit exists to stop. Values are the
	// measured numstat of the closed findings-1/5/6 diff, not a headroom
	// guess.
	["src/App.jsx", { add: 286, mod: 92 }],
	["src/ardy/timeline.jsx", { add: 25, mod: 6 }],
	["src/scene-history.js", { mod: 26 }],
	["tools/ardy/bridge.mjs", { mod: 45 }],
	// Budget renegotiated from plan 4's {add: 40} (the D2 proxy): the
	// packaged CLI is also the D2/D3 delivery owner of the child document --
	// dist-ingest serving plus the header-carried production child CSP with
	// the exact frame-ancestors origin (plan 11.4). Measured numstat of the
	// closed blocker diff, not a headroom guess.
	["bin/cozyclay.mjs", { add: 57 }],
	["src/main.jsx", { add: 2 }],
	// Budget renegotiated from plan 4's {add: 6} (the read-once discovery
	// spread): the cold-start race is removed by resolving the /ingest
	// proxy target per request (discoveryOrigin + the ingestProxy plugin
	// middleware), which is a different mechanism, not an increment of the
	// old one. Recorded in the ultragoal ledger.
	["vite.config.js", { add: 62 }],
	["public/sw.js", { add: 2 }],
	["test/verify-pwa.mjs", { add: 6 }],
	// Budget renegotiated from plan 4's {add: 3} (the env-guarded surface
	// spawn): the ARDY bridge is an optional companion (bridge.mjs header),
	// so its exit is logged instead of tearing the session down -- without
	// this, `npm run dev` / `dev:ingest` die on any machine where 5181 is
	// taken, and the delivery test could not spawn the real entry. Recorded
	// in the ultragoal ledger.
	["tools/dev-full.mjs", { add: 23 }],
	["package.json", {}],
	["README.md", {}],
	["THIRD_PARTY_NOTICES.md", {}],
	[".gitignore", {}],
	[".github/workflows/pages.yml", { total: 0 }],
]);

// Plan §4 enumerates seam MODULES but never their verifiers, while §13 mandates
// a test-first commit for each. Hand-admitting each verifier as it appeared was
// patching instances of a class -- the omission recurred every slice. A verifier
// is therefore admitted by RULE, but only when it actually references a
// seam-listed module, so the rule cannot smuggle an unrelated file past its
// budget. Recorded in the ultragoal ledger.
const SEAM_MODULES = [...SEAM.keys()].filter((p) => p.startsWith("src/") || p.startsWith("tools/"));
function verifiesASeamModule(path) {
	if (!/^test\/.*\.mjs$/.test(path)) return false;
	let src;
	try {
		src = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
	} catch {
		return false; // deleted in this diff: nothing to admit
	}
	return SEAM_MODULES.some((mod) => src.includes(mod));
}
function auditBudgets(rows) {
	const violations = [];
	for (const row of rows) {
		if (isFeaturePath(row.path)) continue;
		const budget = SEAM.get(row.path);
		if (!budget) {
			if (verifiesASeamModule(row.path)) continue;
			violations.push(`${row.path} changed but is not in the plan 4 seam list`);
			continue;
		}
		const modified = Math.min(row.added, row.deleted);
		if (budget.add !== undefined && row.added > budget.add) {
			violations.push(`${row.path}: ${row.added} added lines exceed the ${budget.add} budget`);
		}
		if (budget.mod !== undefined && modified > budget.mod) {
			violations.push(`${row.path}: ${modified} modified lines exceed the ${budget.mod} budget`);
		}
		if (budget.total !== undefined && row.added + row.deleted > budget.total) {
			violations.push(`${row.path} must stay unchanged, got ${row.added}+${row.deleted} lines`);
		}
	}
	return violations;
}
// sensitivity first: a synthetic numstat violating the shape in every way
const fakeNumstat = [
	// The App.jsx row must exceed the RENEGOTIATED caps (286/92, above) —
	// a control that fell inside the new budget would prove nothing.
	{ path: "src/App.jsx", added: 300, deleted: 100 },
	{ path: "src/undisclosed.js", added: 5, deleted: 0 },
	{ path: "vite.config.js", added: 70, deleted: 0 },
	{ path: ".github/workflows/pages.yml", added: 1, deleted: 0 },
];
ok("budget audit reports an out-of-shape diff", auditBudgets(fakeNumstat).length >= 4, auditBudgets(fakeNumstat).join(" | "));
// The verifier-admission rule is only safe if it cannot admit an arbitrary
// file, so prove both directions before trusting it: a test that references a
// seam module is admitted, and one that does not is still reported.
ok("verifier-admission rule admits a test that references a seam module",
	verifiesASeamModule("test/verify-undo-coordinator.mjs"));
ok("verifier-admission rule does NOT admit a test that references no seam module",
	verifiesASeamModule("test/ardy/verify-fk.mjs") === false);
ok("verifier-admission rule does NOT admit a non-test path",
	verifiesASeamModule("src/undisclosed.js") === false);
ok("budget audit still reports an unrelated test outside the seam list",
	auditBudgets([{ path: "test/verify-unrelated.mjs", added: 3, deleted: 0 }]).length === 1);
// the real diff vs main: read-only git diff; failing loudly when main is
// missing is deliberate -- without the base commit the audit proves nothing
const numstatRun = spawnSync("git", ["diff", "--numstat", "--no-renames", "main"], { cwd: REPO_ROOT, encoding: "utf8" });
if (numstatRun.status !== 0) {
	ok("plan 4 diff-shape budgets hold vs main", false, `git diff main failed: ${numstatRun.stderr || numstatRun.stdout}`);
} else {
	const rows = numstatRun.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [a, d, ...rest] = line.split("\t");
			// binary rows report "-" for both counts and carry no line budget
			return { path: rest.join("\t"), added: a === "-" ? 0 : Number(a), deleted: d === "-" ? 0 : Number(d) };
		});
	const realBudgets = auditBudgets(rows);
	ok("plan 4 diff-shape budgets hold vs main", realBudgets.length === 0, realBudgets.join(" | "));
}
// --- I3: deletability -------------------------------------------------------
// Deletability (plan 6.2) means: remove the mount edge, delete the feature dirs
// and vite.ingest.config.js, then build and run the full green bar. The
// structural part is the inbound audit -- any inbound edge into src/ingest is a
// dangling mount edge once the feature is deleted -- and the operational part
// materializes the deleted tree and runs the bar for real.
function checkDeletable(mods, parse) {
	// structural deletability: a mount edge from anywhere but the audited
	// entry, a second createSurfaceHost consumer, or any inbound edge into
	// the child realm is a dangling edge once the feature is deleted; the sim
	// below then builds the deleted tree and runs the green bar for real
	return [
		...auditMountEdge(allEdges(mods, parse)),
		...auditHostConsumers(mods, parse),
		...auditInbound(allEdges(mods, parse)),
	];
}
// sensitivity first: an app entry that still imports the surface after the
// feature is gone is a dangling mount edge and must be reported
const danglingApp = {
	path: "src/App.jsx",
	source: readFileSync(join(REPO_ROOT, "src/App.jsx"), "utf8") + '\nimport "./ingest/state.js";\n',
};
const withDanglingEdge = modules.map((m) => (m.path === "src/App.jsx" ? danglingApp : m));
ok(
	"negative control: dangling mount edge not reported",
	checkDeletable(withDanglingEdge, parseAst).length > 0,
	checkDeletable(withDanglingEdge, parseAst).join(" | "),
);
// the real tree has no dangling edge: the feature is severable today
ok(
	"deletability structural: no dangling mount edges",
	checkDeletable(modules, parseAst).length === 0,
	checkDeletable(modules, parseAst).join(" | "),
);
// --- deletability, operational: delete the feature, build, run the bar -------
// The green bar is the app's own: npm run build (the CI gate), npm run
// test:ardy (the phase mandate), and the pure-node root verify-* tests.
// verify-object-gizmo drives a real browser via qa-browser (test:objects) and
// needs a live dev server, so it is not part of a self-contained bar.
// The feature's own gates (verify-build-exclusion.mjs, verify-isolation.mjs)
// are deleted with it: they assert the feature's absence, so keeping them in
// the sim tree would fail by design -- exactly what deletion means.
// verify-delivery.mjs is deleted with it for the mirror-image reason: its
// whole subject is the feature's delivery topology (surface Vite spawn,
// dist-ingest, the packaged proxy), so in a tree without the feature it has
// nothing to assert. A subject exemption -- never a convenient way to drop
// a test that merely happens to fail after deletion.
const DELETED_WITH_FEATURE = new Set(["test/verify-build-exclusion.mjs", "test/verify-isolation.mjs", "test/verify-delivery.mjs"]);
function materializeDeletedTree(dest, { dangling }) {
	// Materialize the COMMITTED tree, not the working tree: peers land their
	// seam commits into the same working tree, and an in-flight edit that has
	// not been committed yet must not decide whether the feature is deletable.
	// The leader's per-commit protocol (plan 13) keeps every committed state
	// green, so HEAD minus the feature is the state deletion must preserve.
	const tar = spawnSync("git", ["archive", "HEAD"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
	if (tar.status !== 0) throw new Error(`git archive HEAD failed: ${tar.stderr || tar.stdout}`);
	const extract = spawnSync("tar", ["-x", "-C", dest], { input: tar.stdout, maxBuffer: 64 * 1024 * 1024 });
	if (extract.status !== 0) throw new Error(`tar extraction failed: ${extract.stderr || extract.stdout}`);
	// delete the feature dirs, the second build entry, and the feature's gates
	// delete the feature dirs, the composition module, the second build entry,
	// and the feature's gates
	for (const f of ["src/ingest", "tools/ingest", "test/ingest", "src/surface-mount.js", "vite.ingest.config.js", ...DELETED_WITH_FEATURE]) {
		rmSync(join(dest, f), { recursive: true, force: true });
	}
	// deletability removes the mount edge from the app entry with the feature:
	// the two lines main.jsx contributes are the seam. The dangling tree below
	// re-adds them to prove the sim detects an edge that survives deletion.
	const mainPath = join(dest, "src/main.jsx");
	writeFileSync(
		mainPath,
		readFileSync(mainPath, "utf8")
			.split("\n")
			.filter((line) => !MOUNT_EDGE_LINES.includes(line.trim()))
			.join("\n"),
	);
	if (dangling) {
		// the mount edge survives the deletion: this is the dangling edge the
		// whole sim exists to detect, and it must break the build
		appendFileSync(mainPath, `\n${MOUNT_EDGE_LINES.join("\n")}\n`);
	}
	symlinkSync(join(REPO_ROOT, "node_modules"), join(dest, "node_modules"), "dir");
}
function runStep(cwd, cmd, args) {
	// The deletability sim is the one place a browser genuinely cannot be
	// present: it runs a scratch copy of the tree in a subprocess bar. That is
	// exactly the conscious opt-out verify-app-render.mjs requires, so it is
	// set HERE and nowhere else -- a suite that could not run must still fail
	// loudly everywhere a browser is actually expected.
	const env = { ...process.env, ALLOW_APP_RENDER_SKIP: "1" };
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
	const lines = (r.stdout + r.stderr || "").split("\n").filter((l) => !/^\(node:|^\(Use `node --trace-warnings/.test(l));
	return { status: r.status, out: lines.join("\n"), tail: lines.slice(-10).join("\n") };
}
function runGreenBar(cwd) {
	const appFiles = readdirSync(join(cwd, "test"))
		.filter((f) => /^verify-.*\.mjs$/.test(f) && f !== "verify-object-gizmo.mjs")
		.sort();
	return {
		build: runStep(cwd, "npm", ["run", "build"]),
		ardy: runStep(cwd, "npm", ["run", "test:ardy"]),
		app: appFiles.map((f) => ({ file: f, run: runStep(cwd, "node", [join("test", f)]) })),
	};
}
const simRoot = mkdtempSync(join(tmpdir(), "cozyclay-deletable-"));
const simRootDangling = mkdtempSync(join(tmpdir(), "cozyclay-dangling-"));
try {
	materializeDeletedTree(simRoot, { dangling: false });
	const bar = runGreenBar(simRoot);
	ok("deleted-feature tree builds (npm run build)", bar.build.status === 0, bar.build.tail);
	ok("deleted-feature tree passes test:ardy", bar.ardy.status === 0, bar.ardy.tail);
	const badApp = bar.app.filter((a) => a.run.status !== 0);
	ok(
		"deleted-feature tree passes the app tests",
		badApp.length === 0,
		badApp.map((a) => `${a.file}: ${a.run.tail}`).join(" | "),
	);
	// sensitivity: the dangling tree must fail to build -- the sim is proven to
	// detect the very edge it exists to sever, not just report a clean tree
	materializeDeletedTree(simRootDangling, { dangling: true });
	const danglingBuild = runStep(simRootDangling, "npm", ["run", "build"]);
	const dangleEvidence = danglingBuild.out
		.split("\n")
		.filter((l) => /Could not resolve|UNRESOLVED_IMPORT/.test(l))
		.join(" | ");
	ok("deletability sim reports a dangling mount edge (build fails)", danglingBuild.status !== 0, dangleEvidence || danglingBuild.tail);
} finally {
	rmSync(simRoot, { recursive: true, force: true });
	rmSync(simRootDangling, { recursive: true, force: true });
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

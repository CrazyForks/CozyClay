#!/usr/bin/env node
/**
 * W1 — the service worker must BYPASS the ingest bridge (plan §11, §13).
 *
 * Canonical RED: `/ingest/artifacts/x was cached`.
 *
 * This runs the real `public/sw.js` fetch handler inside a minimal
 * ServiceWorkerGlobalScope shim and dispatches real FetchEvents, rather than
 * grepping the source for a path fragment. The difference matters: a string
 * check passes as soon as "/ingest/" appears anywhere in the file, including
 * inside a comment or a branch that never runs, and this gate exists precisely
 * because a bypass that is present but unreachable is the failure mode.
 *
 * Two reasons the bypass is load-bearing, both about correctness rather than
 * performance:
 *   - an artifact is regenerated on re-extract, so a cached copy serves a stale
 *     take that silently disagrees with what the host holds;
 *   - a staged upload has a TTL, which is a promise about how long the user's
 *     footage exists. A cache entry outliving that TTL quietly breaks it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = [];
function ok(label, cond, detail = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
}

const source = readFileSync(join(REPO, "public/sw.js"), "utf8");
const ORIGIN = "http://127.0.0.1:5180";

/** Load sw.js in a shim and return its registered fetch handler. */
function loadWorker() {
	const listeners = new Map();
	const caches = {
		open: async () => ({ match: async () => undefined, put: async () => undefined, addAll: async () => undefined }),
		match: async () => undefined,
		keys: async () => [],
		delete: async () => true,
	};
	const scope = {
		self: null,
		caches,
		fetch: async () => new Response("net", { status: 200 }),
		Response,
		Request,
		URL,
		console: { log() {}, warn() {}, error() {} },
		location: new URL(`${ORIGIN}/sw.js`),
		clients: { claim: async () => undefined },
		skipWaiting: async () => undefined,
	};
	scope.self = {
		addEventListener: (type, fn) => listeners.set(type, fn),
		location: scope.location,
		clients: scope.clients,
		skipWaiting: scope.skipWaiting,
		caches,
		registration: { waiting: null },
	};
	vm.createContext(scope);
	// The worker's top level registers listeners; anything it does beyond that
	// (constants, cache names) is inert here.
	vm.runInContext(source, scope, { filename: "public/sw.js" });
	const fetchListener = listeners.get("fetch");
	if (typeof fetchListener !== "function") throw new Error("sw.js registered no fetch listener");
	return fetchListener;
}

/** Dispatch one synthetic FetchEvent; report whether the worker claimed it. */
function dispatch(fetchListener, url, { method = "GET", headers = {} } = {}) {
	let claimed = false;
	const event = {
		request: new Request(url, { method, headers }),
		respondWith(promise) {
			claimed = true;
			// Swallow rejections: whether the worker's own handling succeeds is
			// not this gate's question. Whether it CLAIMED the request is.
			Promise.resolve(promise).catch(() => {});
		},
		waitUntil() {},
	};
	fetchListener(event);
	return claimed;
}

const worker = loadWorker();
ok("public/sw.js registers a fetch listener", typeof worker === "function");

// ---------------------------------------------------------------------------
// the bypass
// ---------------------------------------------------------------------------
for (const path of [
	"/ingest/artifacts/0123456789abcdef0123456789abcdef",
	"/ingest/stage/0123456789abcdef0123456789abcdef",
	"/ingest/health",
	"/ingest/surface-origin",
]) {
	ok(`the worker does NOT claim ${path}`, dispatch(worker, ORIGIN + path) === false);
}

ok("the worker does NOT claim /ardy/ either (the pre-existing bridge bypass still holds)",
	dispatch(worker, `${ORIGIN}/ardy/motions/abc`) === false);

// ---------------------------------------------------------------------------
// the control: ordinary app assets are still cached, or the bypass proves
// nothing. A worker that claims nothing at all would pass every assertion above.
// ---------------------------------------------------------------------------
for (const path of ["/", "/index.html", "/assets/app.js", "/models/y-bot-tpose.fbx"]) {
	ok(`the worker DOES claim the app asset ${path}`, dispatch(worker, ORIGIN + path) === true);
}

// Cross-origin and non-GET are out of scope by design; asserting them keeps the
// bypass condition from being widened accidentally.
ok("a cross-origin request is not claimed", dispatch(worker, "https://example.com/x.js") === false);
ok("a POST to an app path is not claimed", dispatch(worker, `${ORIGIN}/index.html`, { method: "POST" }) === false);

// ---------------------------------------------------------------------------
// sensitivity: without the /ingest/ clause the artifact request IS claimed
// ---------------------------------------------------------------------------
{
	const withoutBypass = source.replace(/\s*\|\|\s*url\.pathname\.includes\("\/ingest\/"\)/, "");
	ok("the /ingest/ clause is actually present in the bypass condition", withoutBypass !== source);

	const listeners = new Map();
	const scope = {
		self: null,
		caches: { open: async () => ({ match: async () => undefined, put: async () => undefined }), match: async () => undefined, keys: async () => [], delete: async () => true },
		fetch: async () => new Response("net"),
		Response,
		Request,
		URL,
		console: { log() {}, warn() {}, error() {} },
		location: new URL(`${ORIGIN}/sw.js`),
		clients: { claim: async () => undefined },
		skipWaiting: async () => undefined,
	};
	scope.self = { addEventListener: (t, f) => listeners.set(t, f), location: scope.location, clients: scope.clients, skipWaiting: scope.skipWaiting, caches: scope.caches, registration: {} };
	vm.createContext(scope);
	vm.runInContext(withoutBypass, scope, { filename: "sw-without-bypass.js" });
	const claimedWithout = dispatch(listeners.get("fetch"), `${ORIGIN}/ingest/artifacts/x`);
	ok("REMOVING the /ingest/ clause makes the artifact request cached (the RED)",
		claimedWithout === true, "/ingest/artifacts/x was cached");
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

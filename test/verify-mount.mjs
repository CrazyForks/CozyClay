#!/usr/bin/env node
/**
 * The parent-side composition (plan 7/11/12): mountSurfaceHost turns the
 * unit-tested boundary pieces — discovery, createSurfaceHost, the landing
 * door and the unavailable panel — into ONE runtime call the app entry
 * makes. The browser suite (verify-surface-host.mjs S4) observes the same
 * composition in a real Chrome; this suite drives it in node against fake
 * window/document/fetch so every branch is deterministic.
 *
 * WHY this test exists: createSurfaceHost was unit-tested for a long time
 * without any runtime code instantiating it — the orphan class that shipped
 * twice in this project. This suite pins the composition's CONTRACT: the
 * discovered origin and url reach the host EXACTLY (a drift would break the
 * §12.1 origin comparison), a non-loopback or non-JSON discovery is
 * "feature absent" with no iframe and no affordance (§11.6), the landing
 * door is read through the neutral registry at land time (§7.2/12.2), the
 * parent-owned unavailable panel appears with a working retry (§11.6), and
 * a re-mount replaces the previous composition instead of stacking a second
 * iframe (HMR/StrictMode idempotence).
 *
 * What would be circular or wrong: testing the composition through the
 * real createSurfaceHost (its iframe/DOM side is the host suite's subject;
 * here the hostFactory is injected so the composition's own decisions are
 * what is asserted); reading the landing door ONCE at mount time (the app
 * re-exposes its door on every render, so a captured door can go stale);
 * or a panel that appears but whose retry does not reach the host.
 *
 * Canonical RED (plan 13): before the mount edge existed, this suite could
 * not even import the module: `Cannot find module '../src/surface-mount.js'`.
 */
import { mountSurfaceHost, INSTANCE_KEY } from "../src/surface-mount.js";
import { landingDoor } from "../src/motion-sources.js";

const ORIGIN = "http://127.0.0.1:5199";
const URL = ORIGIN + "/";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

/* ------------------------- fake browser harness ------------------------- */

function fakeElement(tag) {
	return {
		tag,
		className: "",
		textContent: "",
		type: undefined,
		parentNode: null,
		children: [],
		listeners: {},
		setAttribute(name, value) {
			this[name] = String(value);
		},
		getAttribute(name) {
			return this[name] ?? null;
		},
		addEventListener(type, fn) {
			(this.listeners[type] ??= []).push(fn);
		},
		append(...nodes) {
			this.children.push(...nodes);
			for (const n of nodes) n.parentNode = this;
		},
		appendChild(node) {
			this.append(node);
			return node;
		},
		removeChild(node) {
			const i = this.children.indexOf(node);
			if (i >= 0) this.children.splice(i, 1);
			node.parentNode = null;
			return node;
		},
		click() {
			for (const fn of this.listeners.click ?? []) fn();
		},
	};
}

function makeFakeDom() {
	const body = fakeElement("body");
	return {
		window: {},
		document: {
			body,
			createElement: (tag) => fakeElement(tag),
		},
	};
}

function fakeHost() {
	return {
		state: () => "ready",
		retried: 0,
		destroyed: 0,
		retry() {
			this.retried += 1;
		},
		destroy() {
			this.destroyed += 1;
		},
	};
}

// The discovery record the delivery layer publishes (§11.2): the app's own
// server answers GET /ingest/surface-origin with the child's exact origin
// and entry URL. Each response is a REAL node Response so the composition
// exercises its actual res.json() path.
const discoveryResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeEnv({ record, landing = () => null, timeoutMs = 8000 } = {}) {
	const dom = makeFakeDom();
	const host = fakeHost();
	let hostOpts = null;
	const controller = mountSurfaceHost({
		window: dom.window,
		document: dom.document,
		fetchImpl: async () => (record === null ? new Response("<!doctype html><title>app</title>", { status: 200 }) : discoveryResponse(record)),
		timeoutMs,
		hostFactory: (opts) => {
			hostOpts = opts;
			return host;
		},
		landing,
	});
	return { dom, host, controller, hostOpts: () => hostOpts };
}

/* ------------------- absent discovery: no iframe, no affordance ---------- */

// The dev SPA fallback answers index.html (200) for an unproxied /ingest
// path; the packaged server 404s. Both are "feature absent" (§11.6): the
// composition must mount NOTHING — no host, no iframe, no panel.
for (const [label, record] of [
	["the dev SPA fallback (html body)", null],
	["a 404 body", { status: 404, body: "not found" }],
]) {
	const dom = makeFakeDom();
	const host = fakeHost();
	let composed = false;
	const controller = mountSurfaceHost({
		window: dom.window,
		document: dom.document,
		fetchImpl: async () => (record === null ? new Response("<!doctype html>", { status: 200 }) : new Response(record.body, { status: record.status })),
		hostFactory: () => {
			composed = true;
			return host;
		},
	});
	const settled = await controller.settled;
	ok(`absent discovery (${label}) composes nothing`, settled === false && composed === false && controller.host() === null && controller.state() === "absent", `settled=${settled} composed=${composed}`);
	ok(`absent discovery (${label}) leaves the DOM untouched`, dom.document.body.children.length === 0, `children=${dom.document.body.children.length}`);
}

// An off-loopback origin must be refused by the composition itself, not
// left to the parent CSP: the frame-src policy is the last line, not the
// first (§11.4).
{
	const dom = makeFakeDom();
	const host = fakeHost();
	let composed = false;
	const controller = mountSurfaceHost({
		window: dom.window,
		document: dom.document,
		fetchImpl: async () => discoveryResponse({ origin: "https://evil.example", url: "https://evil.example/" }),
		hostFactory: () => {
			composed = true;
			return host;
		},
	});
	await controller.settled;
	ok("a non-loopback discovery origin is refused", composed === false && controller.state() === "absent", `composed=${composed}`);
}

// A discovery whose url does not live on the discovered origin is refused:
// the host compares event.origin to surfaceOrigin exactly (§12.1), so a url
// that drifts off-origin would make every child message foreign.
{
	const dom = makeFakeDom();
	const host = fakeHost();
	let composed = false;
	const controller = mountSurfaceHost({
		window: dom.window,
		document: dom.document,
		fetchImpl: async () => discoveryResponse({ origin: ORIGIN, url: "http://127.0.0.1:5999/other" }),
		hostFactory: () => {
			composed = true;
			return host;
		},
	});
	await controller.settled;
	ok("a discovery url off the discovered origin is refused", composed === false && controller.state() === "absent", `composed=${composed}`);
}

/* ------------------- valid discovery: the exact origin reaches the host -- */

{
	const env = makeEnv({ record: { origin: ORIGIN, url: URL }, landing: () => null });
	await env.controller.settled;
	ok("a valid discovery composes the host", env.controller.host() === env.host && env.controller.state() === "ready", `state=${env.controller.state()}`);
	const opts = env.hostOpts();
	ok(
		"the host receives the exact discovered origin and url",
		opts.surfaceOrigin === ORIGIN && opts.surfaceUrl === URL,
		`origin=${opts.surfaceOrigin} url=${opts.surfaceUrl}`,
	);
	ok(
		"the host receives the real window, document and timeout",
		opts.window === env.dom.window && opts.document === env.dom.document && opts.timeoutMs === 8000,
		`timeout=${opts.timeoutMs}`,
	);
	ok("the composed host is reachable through the window key", env.dom.window[INSTANCE_KEY] === env.controller, "key mismatch");
}

/* ------------------- the landing door is read at land time ---------------- */

// §7.2/12.2: the app re-exposes its door on every render, so the composition
// reads the CURRENT door when a land arrives. A land without a door is a
// typed rejection the child sees in its ack — never a silent drop.
{
	const landed = [];
	const env = makeEnv({
		record: { origin: ORIGIN, url: URL },
		landing: () => (payload) => {
			landed.push(payload);
			return "ack";
		},
	});
	await env.controller.settled;
	const payload = { requestId: "mount-1" };
	const result = env.hostOpts().onLand(payload);
	ok("onLand routes the payload through the registry door", landed.length === 1 && landed[0] === payload && result === "ack", `landed=${landed.length}`);
}

{
	const env = makeEnv({ record: { origin: ORIGIN, url: URL }, landing: () => null });
	await env.controller.settled;
	let threw = null;
	try {
		env.hostOpts().onLand({ requestId: "mount-2" });
	} catch (err) {
		threw = err.message;
	}
	ok("a land with no door is a typed rejection", threw === "landing-door-unavailable", `threw=${threw}`);
}

/* ------------------- the parent-owned unavailable panel ------------------- */

// §11.6: the child cannot render its own failure; the composition owns the
// panel. It appears on onUnavailable with a Retry that remounts, and a
// ready after retry removes any stale panel.
{
	const env = makeEnv({ record: { origin: ORIGIN, url: URL } });
	await env.controller.settled;
	env.hostOpts().onUnavailable("timeout");
	const panel = env.controller.panel();
	ok("unavailable renders the parent-owned panel", panel !== null && panel.getAttribute("role") === "alert" && panel.className === "cozyclay-surface-unavailable", `role=${panel?.getAttribute("role")}`);
	ok("the panel lives in the document", panel !== null && panel.parentNode === env.dom.document.body, `parent=${panel?.parentNode?.tag}`);
	const button = panel.children.find((c) => c.tag === "button");
	ok("the panel carries a Retry button", button !== null && button.textContent === "Retry", `button=${button?.textContent}`);
	button.click();
	ok("Retry reaches the host and hides the panel", env.host.retried === 1 && env.controller.panel() === null, `retried=${env.host.retried}`);
	env.hostOpts().onUnavailable("load-error");
	ok("a second failure re-renders the panel", env.controller.panel() !== null && env.controller.panel() !== panel, "same panel object reused");
	env.hostOpts().onReady();
	ok("a ready after retry removes the panel", env.controller.panel() === null, "panel still present");
}

/* ------------------- re-mount replaces, destroy tears down ----------------- */

// HMR re-executes the module; the composition must replace the previous one
// on the same window instead of stacking a second iframe and listener.
{
	const dom = makeFakeDom();
	const first = fakeHost();
	const second = fakeHost();
	const c1 = mountSurfaceHost({
		window: dom.window,
		document: dom.document,
		fetchImpl: async () => discoveryResponse({ origin: ORIGIN, url: URL }),
		hostFactory: () => first,
	});
	await c1.settled;
	const c2 = mountSurfaceHost({
		window: dom.window,
		document: dom.document,
		fetchImpl: async () => discoveryResponse({ origin: ORIGIN, url: URL }),
		hostFactory: () => second,
	});
	await c2.settled;
	ok("a re-mount destroys the previous composition", first.destroyed === 1, `destroyed=${first.destroyed}`);
	ok("the re-mount installs the fresh composition", dom.window[INSTANCE_KEY] === c2 && c2.host() === second, "key/host mismatch");
	c2.destroy();
	ok("destroy tears the host down", second.destroyed === 1, `destroyed=${second.destroyed}`);
}

/* ------------------- the registry accessor (neutral seam) ----------------- */

// The app publishes its real landTake on the QA hook without naming the
// feature (App.jsx:1629-1630); the registry is the ONLY seam the feature
// may use to reach it.
{
	const door = () => "landed";
	const saved = globalThis.window;
	const restore = () => {
		if (saved === undefined) delete globalThis.window;
		else globalThis.window = saved;
	};
	try {
		globalThis.window = { __cozyclay: { landTake: door } };
		ok("landingDoor returns the app's live landTake", landingDoor() === door, "not the door");
		globalThis.window = { __cozyclay: {} };
		ok("landingDoor is null when the hook has no door", landingDoor() === null, "non-null");
		globalThis.window = {};
		ok("landingDoor is null when the hook is absent", landingDoor() === null, "non-null");
	} finally {
		restore();
	}
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

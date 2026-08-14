#!/usr/bin/env node
/**
 * The cross-origin embedder and publish door (plan §11.5, §11.6, §12):
 * src/surface-host.js frames the ingest surface under a restrictive
 * sandbox and rejects any message that is not from the exact origin, the
 * exact contentWindow and protocol version cclay v1 — a foreign message
 * is refused, never merely ignored. Landings are exactly-once per surface
 * session: the request-id table is session-scoped and refuses at its
 * ceiling rather than evict, because eviction is exactly what lets a
 * delayed retry land twice. Landing success is acknowledged only after
 * the app's async landing callback fulfils; a rejection is reported and
 * leaves the id retryable, and a retry that arrives while a landing is
 * still applying joins it. The child cannot render its own failure, so
 * the host owns the load timeout, the ready handshake and the
 * parent-rendered unavailable panel. S2 is the publish door: every §5
 * TakePayload clause rejects by name.
 *
 * Node-first, against a fake window/document/postMessage harness; S4 drives
 * the SHIPPED composition (src/surface-mount.js, mounted by src/main.jsx)
 * in a real Chrome over CDP, where the sandbox activated-navigation clause
 * and the unavailable panel are observed for real — the fake DOM would
 * happily report both `loading="lazy"` and `hidden` set while Chrome never
 * loads such a frame at all (measured on the QA browser; see the S1 lazy
 * assertion).
 */
import { createSurfaceHost, validateTakePayload } from "../src/surface-host.js";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

const ORIGIN = "http://127.0.0.1:5183";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

/* ------------------------- fake browser harness ------------------------ */

// A deterministic clock: the host's 8 s window is driven by injected
// timers, so the never-loads case is testable without waiting.
function makeFakeTimers() {
	let now = 0;
	let nextId = 1;
	const pending = new Map();
	return {
		setTimeout(fn, ms) {
			const id = nextId;
			nextId += 1;
			pending.set(id, { fn, at: now + ms });
			return id;
		},
		clearTimeout(id) {
			pending.delete(id);
		},
		advance(ms) {
			now += ms;
			for (const [id, job] of [...pending]) {
				if (job.at <= now) {
					pending.delete(id);
					job.fn();
				}
			}
		},
	};
}

function makeFakeDom() {
	const posted = [];
	const iframes = [];
	const window = {
		listeners: {},
		addEventListener(type, fn) {
			(this.listeners[type] ??= []).push(fn);
		},
		removeEventListener(type, fn) {
			this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
		},
	};
	const document = {
		body: {
			appendChild(el) {
				el.appended = true;
			},
		},
		createElement(tag) {
			const el = {
				tag,
				attrs: new Map(),
				src: null,
				loading: null,
				hidden: true,
				appended: false,
				removed: false,
				events: {},
				contentWindow: {
					postMessage(message, targetOrigin) {
						posted.push({ message, targetOrigin });
					},
				},
				setAttribute(name, value) {
					this.attrs.set(name, String(value));
				},
				getAttribute(name) {
					return this.attrs.get(name) ?? null;
				},
				addEventListener(type, fn) {
					(this.events[type] ??= []).push(fn);
				},
				remove() {
					this.removed = true;
				},
			};
			iframes.push(el);
			return el;
		},
	};
	return { window, document, posted, iframes, timers: makeFakeTimers() };
}

function makeHost(overrides = {}) {
	const dom = makeFakeDom();
	const spies = { ready: 0, unavailable: [], land: [] };
	const host = createSurfaceHost({
		window: dom.window,
		document: dom.document,
		surfaceOrigin: ORIGIN,
		surfaceUrl: ORIGIN + "/",
		timers: dom.timers,
		onReady() {
			spies.ready += 1;
		},
		onUnavailable(reason) {
			spies.unavailable.push(reason);
		},
		onLand(payload) {
			spies.land.push(payload);
		},
		...overrides,
	});
	return { dom, spies, host };
}

const readyData = () => ({ cclay: 1, v: 1, id: "m-ready", type: "ready" });
const landData = (requestId, payload = makePayload(requestId)) => ({
	cclay: 1, v: 1, id: "m-" + requestId, requestId, type: "land", payload,
});

function message(host, { origin = ORIGIN, source = host.iframe().contentWindow, data }) {
	return { origin, source, data };
}

function dispatch(host, event) {
	try {
		return { threw: null, code: host.handleMessage(event) ?? null };
	} catch (err) {
		return { threw: err, code: null };
	}
}

function fire(iframe, type) {
	for (const fn of iframe?.events[type] ?? []) fn();
}

function ackFor(posted, requestId) {
	return posted.find((p) => p.message.type === "ack" && p.message.requestId === requestId);
}

// A valid §5 TakePayload: both clips upright at 0°, 20 fps, equal frame
// counts, complete provenance, artifact fields as paths on the app origin.
function makePayload(requestId) {
	const clip = (track) => ({
		rotationDeg: 0,
		fps: 20,
		frames: 60,
		artifactPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/track-${track}`,
		provenance: {
			command: "cozyclay ingest",
			sourceUrl: "file:///raw/take.mov",
			licence: "operator-owned",
			sourceSha256: "a".repeat(64),
			trimStartS: 0,
			trimEndS: 3,
			gvhmrCommit: "b".repeat(40),
			weightsSha256: "c".repeat(64),
			annotationPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-${track}`,
		},
	});
	return { requestId, a: clip("a"), b: clip("b") };
}

// Bring a host to ready: the handshake, then the (normally later) load.
function ready(env) {
	const out = dispatch(env.host, message(env.host, { data: readyData() }));
	fire(env.host.iframe(), "load");
	return out;
}

/* ------------------- S1: the boundary rejects, it never ignores --------- */

const env = makeHost();

const foreign = dispatch(env.host, message(env.host, { origin: "http://evil.example", data: readyData() }));
ok("accepted a message from a foreign origin", foreign.threw === null && foreign.code === "foreign-origin", `code=${foreign.code ?? (foreign.threw && foreign.threw.message)}`);
ok("the host listens on the parent window", (env.dom.window.listeners.message ?? []).length === 1, `listeners=${env.dom.window.listeners.message?.length}`);
ok("the foreign message changed nothing", env.host.state() === "loading" && env.spies.ready === 0 && env.spies.land.length === 0 && env.dom.posted.length === 0, `state=${env.host.state()} posted=${env.dom.posted.length}`);

// the event checks precede the data checks: hostile bytes are never read
const foreignBytes = dispatch(env.host, message(env.host, { origin: "http://evil.example", data: new ArrayBuffer(8) }));
ok("a foreign origin is rejected before its data is read", foreignBytes.code === "foreign-origin", `code=${foreignBytes.code}`);

const foreignLand = dispatch(env.host, message(env.host, { origin: "http://evil.example", data: landData("evil-1") }));
ok("a foreign landing is rejected and applied nothing", foreignLand.code === "foreign-origin" && env.spies.land.length === 0, `code=${foreignLand.code} land=${env.spies.land.length}`);

const wrongSource = dispatch(env.host, message(env.host, { source: { postMessage() {} }, data: readyData() }));
ok("a message from a different source object is rejected", wrongSource.threw === null && wrongSource.code === "foreign-source", `code=${wrongSource.code ?? (wrongSource.threw && wrongSource.threw.message)}`);
ok("the foreign-source message changed nothing", env.host.state() === "loading" && env.spies.ready === 0 && env.dom.posted.length === 0, `state=${env.host.state()} posted=${env.dom.posted.length}`);

const badVersion = dispatch(env.host, message(env.host, { data: { cclay: 1, v: 2, id: "m-2", type: "ready" } }));
ok("bad protocol version rejected", badVersion.code === "protocol-version", `code=${badVersion.code}`);
const badCclay = dispatch(env.host, message(env.host, { data: { cclay: 2, v: 1, id: "m-2", type: "ready" } }));
ok("bad cclay marker rejected", badCclay.code === "protocol-cclay", `code=${badCclay.code}`);
ok("the rejected handshakes did not open the surface", env.host.state() === "loading" && env.spies.ready === 0, `state=${env.host.state()}`);

const sandbox = env.host.iframe().getAttribute("sandbox");
ok("the sandbox attribute is the restrictive token set", sandbox === "allow-scripts allow-same-origin allow-forms", `sandbox=${sandbox}`);
ok('allow="" empties the Permissions Policy, not the sandbox', env.host.iframe().getAttribute("allow") === "" && env.host.iframe().getAttribute("referrerpolicy") === "no-referrer", `allow=${env.host.iframe().getAttribute("allow")}`);
ok("top-navigation, popups, downloads, modals, pointer lock, presentation and orientation lock are absent", !/allow-(?:top-navigation|top-navigation-by-user-activation|popups|downloads|modals|pointer-lock|presentation|orientation-lock)/.test(sandbox), `sandbox=${sandbox}`);
// NOT loading="lazy": Chrome never loads a display:none iframe with
// loading=lazy, so the hidden-until-ready handshake could never complete
// and every real composition would time out into the unavailable panel.
// Proven on the QA browser (S4 below: the composed host reaches "ready"
// against a real cross-origin child); the fake DOM here would happily
// report both tokens set, which is exactly why the browser section exists.
ok("the frame is NOT loading lazily (lazy+hidden never loads in Chrome)", env.host.iframe().loading !== "lazy" && env.host.iframe().src === ORIGIN + "/" && env.host.iframe().hidden === true, `src=${env.host.iframe().src} hidden=${env.host.iframe().hidden} loading=${env.host.iframe().loading}`);

const handshake = dispatch(env.host, message(env.host, { data: readyData() }));
ok("the ready handshake reveals the iframe", handshake.threw === null && handshake.code === null && env.host.state() === "ready" && env.spies.ready === 1 && env.host.iframe().hidden === false, `state=${env.host.state()} ready=${env.spies.ready}`);

const dupReady = dispatch(env.host, message(env.host, { data: readyData() }));
ok("a duplicate ready is a no-op", dupReady.code === null && env.spies.ready === 1 && env.host.state() === "ready", `ready=${env.spies.ready}`);

// the initial load event after the handshake is not a reload
fire(env.host.iframe(), "load");
ok("the initial load after ready does not reset the session", env.host.state() === "ready" && env.host.iframe().hidden === false, `state=${env.host.state()}`);

// the timer is gone: a healthy surface never sees the panel
env.dom.timers.advance(60000);
ok("the ready handshake cleared the load timer", env.spies.unavailable.length === 0 && env.host.state() === "ready", `unavailable=${env.spies.unavailable.join(",")}`);

/* ------------------- S1: the parent owns the unavailable UI ------------- */

const dead = makeHost();
dead.dom.timers.advance(8000);
ok("a child that never loads produces the parent's unavailable panel", dead.spies.unavailable.length === 1 && dead.spies.unavailable[0] === "timeout" && dead.host.state() === "unavailable", `unavailable=${dead.spies.unavailable.join(",")} state=${dead.host.state()}`);
ok("the dead frame is unmounted", dead.host.iframe() === null && dead.dom.iframes[0].removed === true, `iframe=${dead.host.iframe()}`);
const zombie = dispatch(dead.host, { origin: ORIGIN, source: dead.dom.iframes[0].contentWindow, data: readyData() });
ok("a zombie child cannot be processed after unmount", zombie.code === "foreign-source", `code=${zombie.code}`);

const noHandshake = makeHost();
fire(noHandshake.host.iframe(), "load");
// The no-handshake verdict is deferred a short window: the parent can
// process the iframe's load event ahead of the child's queued ready
// message (measured on the QA browser, S4), so the verdict only lands
// when the handshake is still absent afterwards.
noHandshake.dom.timers.advance(100);
ok("a load without the handshake is detected and failed", noHandshake.spies.unavailable.length === 1 && noHandshake.spies.unavailable[0] === "no-handshake" && noHandshake.host.state() === "unavailable", `unavailable=${noHandshake.spies.unavailable.join(",")}`);

const loadError = makeHost();
fire(loadError.host.iframe(), "error");
ok("an iframe error fails fast into the panel", loadError.spies.unavailable.length === 1 && loadError.spies.unavailable[0] === "load-error" && loadError.host.state() === "unavailable", `unavailable=${loadError.spies.unavailable.join(",")}`);

const recovery = makeHost();
ready(recovery);
dispatch(recovery.host, message(recovery.host, { data: landData("rec-1") }));
fire(recovery.host.iframe(), "error"); // the host dies mid-session
ok("a mid-session failure shows the panel", recovery.spies.unavailable.length === 1 && recovery.spies.unavailable[0] === "load-error" && recovery.host.state() === "unavailable", `unavailable=${recovery.spies.unavailable.join(",")}`);
recovery.host.retry();
ok("retry remounts a hidden fresh frame", recovery.host.state() === "loading" && recovery.host.iframe() !== null && recovery.host.iframe() !== recovery.dom.iframes[0] && recovery.host.iframe().hidden === true, `state=${recovery.host.state()}`);
const reborn = dispatch(recovery.host, message(recovery.host, { data: readyData() }));
ok("the retried surface handshakes again", reborn.code === null && recovery.host.state() === "ready" && recovery.host.iframe().hidden === false && recovery.spies.ready === 2, `state=${recovery.host.state()} ready=${recovery.spies.ready}`);
// a fresh mount is a fresh session: the pre-crash id lands again
dispatch(recovery.host, message(recovery.host, { data: landData("rec-1") }));
ok("the retried session re-lands the old id exactly once", recovery.spies.land.length === 2, `land=${recovery.spies.land.length}`);

const impatient = makeHost();
const early = dispatch(impatient.host, message(impatient.host, { data: landData("early-1") }));
ok("a landing before the handshake is refused", early.code === "not-ready" && impatient.spies.land.length === 0, `code=${early.code}`);

/* ------------------- S1: plain data, byte cap, exactly-once ------------- */

const gates = makeHost();
ready(gates);
const arrayBuffer = dispatch(gates.host, message(gates.host, { data: new ArrayBuffer(8) }));
ok("an ArrayBuffer payload is rejected before field access", arrayBuffer.code === "payload-not-plain-data" && gates.spies.land.length === 0, `code=${arrayBuffer.code}`);
const cyclic = { cclay: 1, v: 1, id: "m-cyc", type: "land", requestId: "cyc-1", payload: { self: null } };
cyclic.payload.self = cyclic;
const cycle = dispatch(gates.host, message(gates.host, { data: cyclic }));
ok("a cyclic payload is rejected", cycle.code === "payload-not-plain-data", `code=${cycle.code}`);
const nan = dispatch(gates.host, message(gates.host, { data: { cclay: NaN, v: 1, id: "m-nan", type: "ready" } }));
ok("a non-finite number is rejected before the envelope is read", nan.code === "payload-not-plain-data", `code=${nan.code}`);
const deep = { cclay: 1, v: 1, id: "m-deep", type: "land", requestId: "deep-1", payload: {} };
let level = deep.payload;
for (let i = 0; i < 9; i += 1) level = level["k" + i] = {};
const tooDeep = dispatch(gates.host, message(gates.host, { data: deep }));
ok("a payload past depth 8 is rejected", tooDeep.code === "payload-too-deep", `code=${tooDeep.code}`);
const manyNodes = { cclay: 1, v: 1, id: "m-many", type: "land", requestId: "many-1", payload: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => ["k" + i, {}])) };
const tooMany = dispatch(gates.host, message(gates.host, { data: manyNodes }));
ok("a payload past 2000 nodes is rejected", tooMany.code === "payload-too-many-nodes", `code=${tooMany.code}`);
const big = makePayload("big-1");
big.a.provenance.sourceUrl = "x".repeat(70000);
const oversized = dispatch(gates.host, message(gates.host, { data: landData("big-1", big) }));
ok("a message over the 64 KiB cap is rejected and nothing is read", oversized.code === "payload-too-large" && gates.spies.land.length === 0, `code=${oversized.code} land=${gates.spies.land.length}`);
const chunky = makePayload("chunky-1");
chunky.b.provenance.sourceUrl = "x".repeat(60000);
const underCap = dispatch(gates.host, message(gates.host, { data: landData("chunky-1", chunky) }));
ok("a message under the cap lands", underCap.code === null && gates.spies.land.length === 1, `code=${underCap.code} land=${gates.spies.land.length}`);

const once = makeHost();
ready(once);
const first = dispatch(once.host, message(once.host, { data: landData("req-1") }));
const firstAck = ackFor(once.dom.posted, "req-1").message;
ok("a landing applies exactly once", first.threw === null && first.code === null && once.spies.land.length === 1 && once.spies.land[0].requestId === "req-1", `code=${first.code} land=${once.spies.land.length}`);
ok("the ack echoes the envelope and targets the exact origin", firstAck.type === "ack" && firstAck.payload.status === "ok" && firstAck.requestId === "req-1" && firstAck.id === "m-req-1" && once.dom.posted.every((p) => p.targetOrigin === ORIGIN), `target=${[...new Set(once.dom.posted.map((p) => p.targetOrigin))].join(",")}`);
const duplicate = dispatch(once.host, message(once.host, { data: landData("req-1") }));
ok("a duplicate send applies nothing and returns the cached ack", duplicate.code === null && once.spies.land.length === 1 && once.dom.posted[once.dom.posted.length - 1].message === firstAck, `land=${once.spies.land.length}`);

const late = makeHost();
ready(late);
dispatch(late.host, message(late.host, { data: landData("req-1") }));
const lateFirstAck = ackFor(late.dom.posted, "req-1").message;
for (let i = 2; i <= 41; i += 1) {
	dispatch(late.host, message(late.host, { data: landData("req-" + i) }));
}
ok("40 intervening requests all land", late.spies.land.length === 41, `land=${late.spies.land.length}`);
const retry = dispatch(late.host, message(late.host, { data: landData("req-1") }));
ok("a late retry after 40 intervening requests lands nothing more", retry.code === null && late.spies.land.length === 41, `land=${late.spies.land.length}`);
ok("the late retry is served the original cached ack", late.dom.posted[late.dom.posted.length - 1].message === lateFirstAck, "reference equality");

const conflict = makeHost();
ready(conflict);
dispatch(conflict.host, message(conflict.host, { data: landData("req-1") }));
const conflicted = makePayload("req-1");
conflicted.a.fps = 24;
const clash = dispatch(conflict.host, message(conflict.host, { data: landData("req-1", conflicted) }));
ok("a same-id different-payload retry is a conflicting reuse", clash.code === "conflicting-reuse" && conflict.spies.land.length === 1, `code=${clash.code} land=${conflict.spies.land.length}`);
ok("the conflict ack names the refusal", conflict.dom.posted[conflict.dom.posted.length - 1].message.payload.status === "conflicting-reuse", `status=${conflict.dom.posted[conflict.dom.posted.length - 1].message.payload.status}`);
const clashAgain = dispatch(conflict.host, message(conflict.host, { data: landData("req-1") }));
ok("a reuse after the conflict stays refused", clashAgain.code === "conflicting-reuse" && conflict.spies.land.length === 1, `code=${clashAgain.code} land=${conflict.spies.land.length}`);

const reload = makeHost();
ready(reload);
dispatch(reload.host, message(reload.host, { data: landData("req-1") }));
fire(reload.host.iframe(), "load"); // second load: the child reloaded
ok("a surface reload starts a new session", reload.host.state() === "loading" && reload.host.iframe().hidden === true, `state=${reload.host.state()}`);
const early2 = dispatch(reload.host, message(reload.host, { data: landData("req-1") }));
ok("a landing is refused until the reloaded child handshakes", early2.code === "not-ready" && reload.spies.land.length === 1, `code=${early2.code} land=${reload.spies.land.length}`);
dispatch(reload.host, message(reload.host, { data: readyData() }));
dispatch(reload.host, message(reload.host, { data: landData("req-1") }));
ok("the old id lands again in the new session", reload.spies.land.length === 2, `land=${reload.spies.land.length}`);

const budget = makeHost();
ready(budget);
for (let i = 0; i < 10000; i += 1) {
	dispatch(budget.host, message(budget.host, { data: landData("budget-" + i) }));
}
ok("10 000 records fit the session budget", budget.spies.land.length === 10000, `land=${budget.spies.land.length}`);
const budgetAck = ackFor(budget.dom.posted, "budget-0").message;
const exhausted = dispatch(budget.host, message(budget.host, { data: landData("budget-overflow") }));
ok("the 10 001st request is refused with session-request-budget-exhausted", exhausted.code === "session-request-budget-exhausted" && budget.spies.land.length === 10000, `code=${exhausted.code} land=${budget.spies.land.length}`);
ok("the refusal instructs a surface reload", (() => {
	const last = budget.dom.posted[budget.dom.posted.length - 1].message;
	return last.payload.status === "session-request-budget-exhausted" && last.payload.reload === true;
})());
const replay = dispatch(budget.host, message(budget.host, { data: landData("budget-0") }));
ok("a replay still gets its cached ack at the budget ceiling", replay.code === null && budget.dom.posted[budget.dom.posted.length - 1].message === budgetAck, "reference equality");

/* --------------- S2: the publish door rejects every §5 clause ------------ */

const rotationMismatch = { ...makePayload("s2-red"), a: { ...makePayload("s2-red").a, rotationDeg: 5 } };
let s2Code = null;
try {
	validateTakePayload(rotationMismatch);
} catch (err) {
	s2Code = err.message;
}
ok("rejects a.rotationDeg !== b.rotationDeg: expected reject", s2Code === "rotation-deg-mismatch", `code=${s2Code}`);

const invalidTakes = [
	[null, "payload-not-object"],
	[{ ...makePayload("t0"), requestId: "" }, "request-id-missing"],
	[{ ...makePayload("t1"), a: { ...makePayload("t1").a, rotationDeg: 5 } }, "rotation-deg-mismatch"],
	[{ ...makePayload("t2"), b: { ...makePayload("t2").b, rotationDeg: -1 } }, "rotation-deg-mismatch"],
	[{ ...makePayload("t3"), a: { ...makePayload("t3").a, fps: 24 } }, "fps-not-20"],
	[{ ...makePayload("t4"), b: { ...makePayload("t4").b, fps: 0 } }, "fps-not-20"],
	[{ ...makePayload("t5"), b: { ...makePayload("t5").b, frames: 59 } }, "frame-count-mismatch"],
	[{ ...makePayload("t6"), a: { ...makePayload("t6").a, frames: 1.5 } }, "frame-count-mismatch"],
	[{ ...makePayload("t7"), a: { ...makePayload("t7").a, frames: 0 } }, "frame-count-mismatch"],
	[{ ...makePayload("t8"), a: { ...makePayload("t8").a, provenance: null } }, "provenance-incomplete"],
	[(() => {
		const p = makePayload("t9");
		const { weightsSha256, ...rest } = p.b.provenance;
		return { ...p, b: { ...p.b, provenance: rest } };
	})(), "provenance-incomplete"],
	[{ ...makePayload("t10"), a: { ...makePayload("t10").a, artifactPath: "http://127.0.0.1:5183/ingest/artifacts/0123456789abcdef0123456789abcdef/a" } }, "artifact-path-invalid"],
	[{ ...makePayload("t11"), b: { ...makePayload("t11").b, provenance: { ...makePayload("t11").b.provenance, annotationPath: "https://evil.example/x" } } }, "artifact-path-invalid"],
	[{ ...makePayload("t12"), a: { ...makePayload("t12").a, artifactPath: "/other/artifacts/0123456789abcdef0123456789abcdef/a" } }, "artifact-path-invalid"],
	[{ ...makePayload("t13"), b: { ...makePayload("t13").b, artifactPath: "/ingest/artifacts/not-hex/0123456789abcdef0123456789abcdef/b" } }, "artifact-path-invalid"],
];
for (const [badPayload, code] of invalidTakes) {
	let threw = null;
	try {
		validateTakePayload(badPayload);
	} catch (err) {
		threw = err.message;
	}
	ok(`invalid payload rejected with ${code}`, threw === code, `threw=${threw}`);
}

let mismatchCode = null;
try {
	validateTakePayload(makePayload("t14"), "envelope-other");
} catch (err) {
	mismatchCode = err.message;
}
ok("an envelope requestId that differs from the payload's is rejected", mismatchCode === "request-id-mismatch", `code=${mismatchCode}`);

const goodPayload = makePayload("good-1");
ok("a valid §5 payload passes the door unchanged", validateTakePayload(goodPayload) === goodPayload, "returned the same object");

const door = makeHost();
ready(door);
const badDoor = { ...makePayload("door-1"), a: { ...makePayload("door-1").a, fps: 24 } };
const doorReject = dispatch(door.host, message(door.host, { data: landData("door-1", badDoor) }));
ok("an invalid land is refused at the door by name", doorReject.code === "fps-not-20" && door.spies.land.length === 0, `code=${doorReject.code} land=${door.spies.land.length}`);
const rejectAck = door.dom.posted[door.dom.posted.length - 1].message;
ok("the refusal ack names the clause", rejectAck.payload.status === "rejected" && rejectAck.payload.code === "fps-not-20" && rejectAck.requestId === "door-1", `status=${rejectAck.payload.status} code=${rejectAck.payload.code}`);
const doorRetry = dispatch(door.host, message(door.host, { data: landData("door-1", badDoor) }));
ok("a retry of the refused land is served the same refusal", doorRetry.code === "fps-not-20" && door.spies.land.length === 0 && door.dom.posted[door.dom.posted.length - 1].message === rejectAck, `code=${doorRetry.code} land=${door.spies.land.length}`);
const doorGood = dispatch(door.host, message(door.host, { data: landData("door-2") }));
ok("a valid land crosses the door exactly once", doorGood.code === null && door.spies.land.length === 1 && door.spies.land[0].requestId === "door-2", `code=${doorGood.code} land=${door.spies.land.length}`);

/* ------------- S3: the landing is awaited, rejection is retryable ------ */

// The App's onLand callback is async (it decodes two npz artifacts before
// the store accepts the take), so these tests drive real promises, not a
// synchronous stub - a stub is exactly what hid the false-success defect.
// A deferred lets the test hold a landing open: the host must not ack
// before fulfilment, must report a typed failure and forget the id on
// rejection, and a duplicate arriving while the landing is still applying
// must join it rather than start a second landing (§12.2, across the async
// window).
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// The host's settle handlers run in the microtask queue, so this macrotask
// flush is the earliest an ack can be observable after a settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ackOf = (posted, requestId) => posted.filter((p) => p.message.type === "ack" && p.message.requestId === requestId);

const slowGate = deferred();
let slowLands = 0;
const slow = makeHost({
	onLand() {
		slowLands += 1;
		return slowGate.promise;
	},
});
ready(slow);
dispatch(slow.host, message(slow.host, { data: landData("as-slow-1") }));
ok("a slow landing posts no ack while it is still applying", slow.dom.posted.length === 0, `posted=${slow.dom.posted.length}`);
ok("a slow landing invoked the callback once", slowLands === 1, `land=${slowLands}`);
slowGate.resolve();
await flush();
const slowAcks = ackOf(slow.dom.posted, "as-slow-1");
ok("the ok ack appears only after the landing fulfils", slowAcks.length === 1 && slowAcks[0].message.payload.status === "ok", `acks=${slowAcks.length} status=${slowAcks[0]?.message.payload.status}`);
dispatch(slow.host, message(slow.host, { data: landData("as-slow-1") }));
ok("a duplicate after success is served the cached ack and lands nothing", slowLands === 1 && slow.dom.posted[slow.dom.posted.length - 1].message === slowAcks[0].message, `land=${slowLands}`);

const rejectGate = deferred();
const rej = makeHost({
	onLand() {
		return rejectGate.promise;
	},
});
ready(rej);
dispatch(rej.host, message(rej.host, { data: landData("as-rej-1") }));
ok("a failing landing posts no ack while it is still applying", rej.dom.posted.length === 0, `posted=${rej.dom.posted.length}`);
rejectGate.reject(new Error("artifact-decode-failed"));
await flush();
const rejAcks = ackOf(rej.dom.posted, "as-rej-1");
ok("a rejected landing posts a typed failure ack", rejAcks.length === 1 && rejAcks[0].message.payload.status === "rejected" && rejAcks[0].message.payload.code === "artifact-decode-failed", `acks=${rejAcks.length} status=${rejAcks[0]?.message.payload.status}`);
ok("no success was ever acknowledged for the failed landing", rejAcks.every((a) => a.message.payload.status === "rejected"), `statuses=${rejAcks.map((a) => a.message.payload.status).join(",")}`);

const joinGate = deferred();
let joinLands = 0;
const join = makeHost({
	onLand() {
		joinLands += 1;
		return joinGate.promise;
	},
});
ready(join);
dispatch(join.host, message(join.host, { data: landData("as-join-1") }));
dispatch(join.host, message(join.host, { data: landData("as-join-1") }));
ok("a duplicate mid-flight does not invoke the callback a second time", joinLands === 1, `land=${joinLands}`);
ok("the joined duplicate posts nothing until the landing settles", join.dom.posted.length === 0, `posted=${join.dom.posted.length}`);
joinGate.resolve();
await flush();
const joinAcks = ackOf(join.dom.posted, "as-join-1");
ok("the joined landing settles into exactly one ok ack", joinAcks.length === 1 && joinAcks[0].message.payload.status === "ok", `acks=${joinAcks.length} status=${joinAcks[0]?.message.payload.status}`);
ok("the joined pair landed exactly once", joinLands === 1, `land=${joinLands}`);

let retryCalls = 0;
const retryHost = makeHost({
	onLand() {
		retryCalls += 1;
		if (retryCalls === 1) return Promise.reject(new Error("store-rejected"));
		return Promise.resolve();
	},
});
ready(retryHost);
dispatch(retryHost.host, message(retryHost.host, { data: landData("as-retry-1") }));
await flush();
const retryFailAcks = ackOf(retryHost.dom.posted, "as-retry-1");
ok("a store rejection is reported as a typed failure", retryFailAcks.length === 1 && retryFailAcks[0].message.payload.status === "rejected" && retryFailAcks[0].message.payload.code === "store-rejected", `acks=${retryFailAcks.length} status=${retryFailAcks[0]?.message.payload.status}`);
dispatch(retryHost.host, message(retryHost.host, { data: landData("as-retry-1") }));
await flush();
ok("a retry after a rejection is allowed to land again", retryCalls === 2, `land=${retryCalls}`);
const retryOkAcks = ackOf(retryHost.dom.posted, "as-retry-1");
ok("the retried landing succeeds with an ok ack", retryOkAcks.length === 2 && retryOkAcks[1].message.payload.status === "ok", `acks=${retryOkAcks.length} statuses=${retryOkAcks.map((a) => a.message.payload.status).join(",")}`);

const okGate = deferred();
let okLands = 0;
const okdup = makeHost({
	onLand() {
		okLands += 1;
		return okGate.promise;
	},
});
ready(okdup);
dispatch(okdup.host, message(okdup.host, { data: landData("as-okdup-1") }));
ok("no ack precedes the fulfilment of a landing that will succeed", okdup.dom.posted.length === 0, `posted=${okdup.dom.posted.length}`);
okGate.resolve();
await flush();
const okdupAck = ackOf(okdup.dom.posted, "as-okdup-1")[0];
dispatch(okdup.host, message(okdup.host, { data: landData("as-okdup-1") }));
await flush();
ok("a duplicate after success lands nothing more", okLands === 1, `land=${okLands}`);
ok("the duplicate after success is served the cached ack", okdup.dom.posted[okdup.dom.posted.length - 1].message === okdupAck.message, "reference equality");

let mixedCalls = 0;
const mixed = makeHost({
	onLand() {
		mixedCalls += 1;
		if (mixedCalls === 1) return Promise.reject(new Error("decode-failed"));
		return Promise.resolve();
	},
});
ready(mixed);
dispatch(mixed.host, message(mixed.host, { data: landData("as-mixed-1") }));
await flush();
dispatch(mixed.host, message(mixed.host, { data: landData("as-mixed-1") }));
await flush();
dispatch(mixed.host, message(mixed.host, { data: landData("as-mixed-1") }));
await flush();
const mixedAcks = ackOf(mixed.dom.posted, "as-mixed-1");
ok("rejection then retry then duplicate: exactly two landings", mixedCalls === 2, `land=${mixedCalls}`);
ok("rejection then retry then duplicate: failure, then ok, then cached ok", mixedAcks.length === 3 && mixedAcks.map((a) => a.message.payload.status).join(",") === "rejected,ok,ok", `acks=${mixedAcks.map((a) => a.message.payload.status).join(",")}`);

const clashGate = deferred();
let clashLands = 0;
const clashHost = makeHost({
	onLand() {
		clashLands += 1;
		return clashGate.promise;
	},
});
ready(clashHost);
dispatch(clashHost.host, message(clashHost.host, { data: landData("as-clash-1") }));
const clashPayload = makePayload("as-clash-1");
clashPayload.a.fps = 24;
const clashSend = dispatch(clashHost.host, message(clashHost.host, { data: landData("as-clash-1", clashPayload) }));
ok("a same-id different-bytes send mid-flight is refused", clashSend.code === "conflicting-reuse" && clashLands === 1, `code=${clashSend.code} land=${clashLands}`);
clashGate.resolve();
await flush();
const clashAcks = ackOf(clashHost.dom.posted, "as-clash-1");
ok("the refusal does not disturb the in-flight landing", clashAcks.length === 2 && clashAcks.map((a) => a.message.payload.status).join(",") === "conflicting-reuse,ok", `acks=${clashAcks.map((a) => a.message.payload.status).join(",")}`);

const dyingGate = deferred();
const dying = makeHost({
	onLand() {
		return dyingGate.promise;
	},
});
ready(dying);
dispatch(dying.host, message(dying.host, { data: landData("as-dying-1") }));
fire(dying.host.iframe(), "error"); // the host dies while the landing applies
dyingGate.resolve();
await flush();
ok("a landing that settles after the session died acks nothing", dying.dom.posted.length === 0 && dying.host.state() === "unavailable", `posted=${dying.dom.posted.length} state=${dying.host.state()}`);

/* ---------- S4 (browser): sandbox, hostile origin and panel in Chrome ---- */
// §11.5/§11.6 and the phase-1 boundary clause: the sandbox attribute string
// on a fake DOM object is not the clause. This section drives a REAL
// cross-origin sandboxed iframe under user activation and asserts top
// navigation is blocked, a hostile-origin message is rejected by the real
// composed host, and the parent-owned unavailable panel appears with a
// working retry when the child never loads. The composition under test is
// the SHIPPED one (src/surface-mount.js, mounted by src/main.jsx), so a
// reintroduced `loading="lazy"` fails here: the child document would never
// load and the ready handshake would never fire. Follows the
// verify-app-render.mjs discipline: not-run is a FAILURE unless
// ALLOW_APP_RENDER_SKIP=1 makes the skip a recorded decision (the
// deletability sim sets it).
const cdpPort = Number(process.env.CDP_PORT || 9222);
const qaUrl = process.env.QA_URL || "http://127.0.0.1:5180/";
const appOrigin = new URL(qaUrl).origin;
const skipAllowed = process.env.ALLOW_APP_RENDER_SKIP === "1";

let cdpPage = null;
try {
	const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(1500) })).json();
	cdpPage = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
} catch {
	cdpPage = null;
}

if (cdpPage === null) {
	if (skipAllowed) {
		console.log("SKIP S4 browser section (ALLOW_APP_RENDER_SKIP=1): no CDP browser");
	} else {
		ok(
			"S4 browser section ran (a CDP browser on the QA page is required)",
			false,
			`no CDP browser on port ${cdpPort} — run \`node tools/qa-browser.mjs -- node test/verify-surface-host.mjs\` (or set CDP_PORT/QA_URL/ALLOW_APP_RENDER_SKIP)`,
		);
	}
} else {
	const ws = new WebSocket(cdpPage.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});

	let nextId = 1;
	const pending = new Map();
	const pageErrors = [];
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		// Uncaught script errors from the APP context only: the fixtures on
		// the test origins are allowed to be noisy.
		if (message.method === "Runtime.exceptionThrown") {
			const url = message.params.exceptionDetails?.url ?? "";
			if (url === "" || url.startsWith(appOrigin)) {
				pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
			}
			return;
		}
		if (!message.id || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
	};
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
		return result.result.value;
	};
	const evaluateSafely = async (expression) => {
		try {
			return await evaluate(expression);
		} catch {
			return undefined;
		}
	};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (expression, { timeoutMs = 8000, intervalMs = 150 } = {}) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await evaluateSafely(expression)) return true;
			await sleep(intervalMs);
		}
		return false;
	};
	const mouse = (type, x, y) =>
		send("Input.dispatchMouseEvent", {
			type,
			x: Math.round(x),
			y: Math.round(y),
			button: "left",
			clickCount: 1,
			buttons: type === "mouseReleased" ? 0 : 1,
		});
	const clickAt = async (x, y) => {
		await mouse("mousePressed", x, y);
		await sleep(30);
		await mouse("mouseReleased", x, y);
	};
	const pageTargetIds = async () =>
		(await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json())
			.filter((t) => t.type === "page")
			.map((t) => t.id);
	const bootApp = async () => {
		await send("Page.navigate", { url: qaUrl });
		for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
		for (let i = 0; i < 100 && !(await evaluateSafely("!!window.__cozyclay && typeof window.__takeHistory === 'function'")); i += 1) await sleep(200);
		await sleep(800);
	};
	// The composition under test is mounted with an injected discovery
	// record; the app's own mount (main.jsx) keeps running alongside.
	const mountExpr = (origin, timeoutMs) =>
		`(async () => {
			const m = await import("/src/surface-mount.js");
			window.__mountTest = m.mountSurfaceHost({
				window,
				document,
				timeoutMs: ${timeoutMs},
				fetchImpl: async () =>
					new Response(JSON.stringify({ origin: ${JSON.stringify(origin)}, url: ${JSON.stringify(origin + "/")} }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			});
			return true;
		})()`;

	await send("Runtime.enable");
	await bootApp();

	// The rendered app composes the boundary: the mount controller is live
	// on the window key, so the mount edge in main.jsx ran. On this server
	// /ingest/surface-origin has no record, so the app's own composition
	// settles "absent" — no iframe, no affordance (§11.6) — but the exact
	// state is environment-dependent (a live ingest host changes it), so
	// only the settled composition is asserted.
	const appComposed = await evaluateSafely(
		`(async () => {
			const c = window[Symbol.for("cozyclay.surfaceMount.v1")];
			if (!c || typeof c.settled?.then !== "function" || typeof c.state !== "function") return false;
			await c.settled;
			return true;
		})()`,
	);
	ok("the rendered app composes the surface boundary (mount edge live)", appComposed === true, String(appComposed));

	// A black-hole origin: accepts TCP, never answers, so the child never
	// loads and the 600 ms handshake window expires into the panel.
	const blackHole = createNetServer(() => {});
	await new Promise((done) => blackHole.listen(0, "127.0.0.1", done));
	const deadOrigin = `http://127.0.0.1:${blackHole.address().port}`;

	await evaluate(mountExpr(deadOrigin, 600));
	const deadSettled = await evaluate("window.__mountTest.settled.then(() => true)");
	ok("a discovery pointing at a dead child still composes a host", deadSettled === true, String(deadSettled));
	const panelAppeared = await waitFor("window.__mountTest.panel() !== null", { timeoutMs: 5000 });
	ok("a child that never loads produces the parent-owned panel", panelAppeared === true, "panel never appeared");
	const panelInfo = await evaluate(
		`(() => { const p = window.__mountTest.panel(); return { role: p.getAttribute("role"), cls: p.className, button: p.querySelector("button")?.textContent ?? null }; })()`,
	);
	ok(
		"the panel is the alert with a Retry button",
		panelInfo.role === "alert" && panelInfo.cls === "cozyclay-surface-unavailable" && panelInfo.button === "Retry",
		JSON.stringify(panelInfo),
	);
	ok("the composition reports unavailable", (await evaluate("window.__mountTest.state()")) === "unavailable", "state");
	// Retry with a REAL click (CDP mouse), not el.click().
	const buttonRect = await evaluate(
		`(() => { const b = window.__mountTest.panel().querySelector("button"); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
	);
	await clickAt(buttonRect.x, buttonRect.y);
	const retried = await evaluateSafely(
		`(() => { const c = window.__mountTest; return c.panel() === null && c.state() === "loading" && c.host() !== null && c.host().iframe() !== null && c.host().iframe().hidden === true; })()`,
	);
	ok("Retry remounts a hidden fresh frame and hides the panel", retried === true, String(retried));
	const panelAgain = await waitFor("window.__mountTest.panel() !== null", { timeoutMs: 5000 });
	ok("the retried dead child fails into the panel again", panelAgain === true, "panel never reappeared");
	await evaluate("window.__mountTest.destroy(); true");
	ok("destroy removes the test panel", (await evaluateSafely("window.__mountTest.panel() === null")) === true, "panel still present");

	// Two fixture origins: the CHILD handshakes like the real surface; the
	// HOSTILE one talks like a child AND attempts activated top navigation.
	// Both are real cross-origin documents (different loopback ports), so
	// event.origin is set by the browser, never by the fixture.
	const childServer = createHttpServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<!doctype html><meta charset="utf-8"><script>
			parent.postMessage({ cclay: 1, v: 1, id: "s4b-child", type: "ready" }, "*");
		</script>`);
	});
	const hostileServer = createHttpServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<!doctype html><meta charset="utf-8"><script>
			// A foreign origin that talks like a child: the land carries a
			// VALID §5 payload, so only the origin check can stop it, and a
			// click handler attempts activated top navigation.
			const take = ${JSON.stringify(makePayload("s4b-hostile-land"))};
			parent.postMessage({ cclay: 1, v: 1, id: "s4b-hostile-ready", type: "ready" }, "*");
			parent.postMessage({ cclay: 1, v: 1, id: "s4b-hostile-land", type: "land", requestId: take.requestId, payload: take }, "*");
			document.addEventListener("click", () => {
				try { top.location.href = ${JSON.stringify(appOrigin + "/__s4c-nav-marker")}; } catch (e) {}
				try { window.open(${JSON.stringify(appOrigin + "/__s4c-popup")}); } catch (e) {}
			});
		</script><button id="go" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent">GO</button>`);
	});
	await new Promise((done) => childServer.listen(0, "127.0.0.1", done));
	await new Promise((done) => hostileServer.listen(0, "127.0.0.1", done));
	const childOrigin = `http://127.0.0.1:${childServer.address().port}`;
	const hostileOrigin = `http://127.0.0.1:${hostileServer.address().port}`;

	await evaluate(mountExpr(childOrigin, 4000));
	const childReady = await waitFor(`window.__mountTest.state() === "ready"`, { timeoutMs: 8000 });
	ok("the real cross-origin child loads and handshakes the composed host", childReady === true, `ready=${childReady}`);
	const iframeInfo = await evaluate(
		`(() => { const f = window.__mountTest.host().iframe(); return { src: f.src, hidden: f.hidden, sandbox: f.getAttribute("sandbox"), allow: f.getAttribute("allow"), referrer: f.getAttribute("referrerpolicy"), appOrigin: location.origin }; })()`,
	);
	ok("the composed iframe carries the restrictive sandbox token set", iframeInfo.sandbox === "allow-scripts allow-same-origin allow-forms", `sandbox=${iframeInfo.sandbox}`);
	ok('allow="" and no-referrer ride along', iframeInfo.allow === "" && iframeInfo.referrer === "no-referrer", `allow=${iframeInfo.allow} referrer=${iframeInfo.referrer}`);
	ok("the frame targets the discovered child entry and is revealed", iframeInfo.src === childOrigin + "/" && iframeInfo.hidden === false, `src=${iframeInfo.src} hidden=${iframeInfo.hidden}`);
	ok("the parent really is a different origin", iframeInfo.appOrigin !== childOrigin, `app=${iframeInfo.appOrigin} child=${childOrigin}`);

	// The hostile fixture, framed with the PRODUCTION token set on a real
	// cross-origin document. The page-level listener records delivered
	// message origins; the composed host must reject all of them.
	await evaluate(`window.__s4bSeen = []; window.addEventListener("message", (e) => window.__s4bSeen.push(e.origin)); true`);
	await evaluate(
		`(() => { const f = document.createElement("iframe"); f.id = "s4b-hostile"; f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms"); f.setAttribute("allow", ""); f.setAttribute("referrerpolicy", "no-referrer"); f.style.cssText = "position:fixed;top:12px;left:12px;width:320px;height:180px;border:0;z-index:2147483647;background:#fff"; f.src = ${JSON.stringify(hostileOrigin + "/")}; document.body.appendChild(f); return true; })()`,
	);
	const hostileDelivered = await waitFor(`window.__s4bSeen.includes(${JSON.stringify(hostileOrigin)})`, { timeoutMs: 8000 });
	ok("the hostile fixture really posted from its own origin", hostileDelivered === true, `seen=${JSON.stringify(await evaluateSafely("window.__s4bSeen"))}`);
	const takePastBefore = await evaluate("window.__takeHistory().past");
	await sleep(600); // any land that could land, would have landed by now
	const takePastAfter = await evaluate("window.__takeHistory().past");
	ok("a hostile-origin land from a real cross-origin frame lands nothing", takePastAfter === takePastBefore, `past=${takePastBefore}->${takePastAfter}`);
	ok("the composed host ignores the hostile ready", (await evaluate("window.__mountTest.state()")) === "ready", "state");
	const directCode = await evaluate(
		`(() => { const c = window.__mountTest; const f = document.querySelector("#s4b-hostile"); return c.host().handleMessage({ origin: ${JSON.stringify(hostileOrigin)}, source: f.contentWindow, data: { cclay: 1, v: 1, id: "s4b-direct", type: "land", requestId: "s4b-direct", payload: ${JSON.stringify(makePayload("s4b-direct"))} } }); })()`,
	);
	ok("the real host names the foreign-origin rejection", directCode === "foreign-origin", `code=${directCode}`);
	// §11.5: with user activation (a REAL CDP click), the sandboxed hostile
	// frame must not be able to navigate top or open a popup. The fixture
	// frames sit above the app UI, or the CDP click would hit the app and
	// the "blocked" assertion would pass without any attempt being made.
	const idsBefore = await pageTargetIds();
	const hrefBefore = await evaluate("location.href");
	const hostileRect = await evaluate(
		`(() => { const r = document.querySelector("#s4b-hostile").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
	);
	await clickAt(hostileRect.x, hostileRect.y);
	await sleep(700);
	const hrefAfter = await evaluate("location.href");
	const newTargets = (await pageTargetIds()).filter((id) => !idsBefore.includes(id));
	ok("activated top navigation from the sandboxed cross-origin frame is blocked", hrefAfter === hrefBefore, `href=${hrefAfter}`);
	ok("no popup opened from the sandboxed frame", newTargets.length === 0, `newTargets=${newTargets.length}`);

	// Negative control: the SAME fixture in an UNSANDBOXED cross-origin
	// frame CAN navigate top under activation — proving the block above is
	// the sandbox token set, not some unrelated browser rule.
	await evaluate(
		`(() => { const f = document.createElement("iframe"); f.id = "s4c-nosandbox"; f.style.cssText = "position:fixed;top:12px;left:12px;width:320px;height:180px;border:0;z-index:2147483647;background:#fff"; f.src = ${JSON.stringify(hostileOrigin + "/")}; document.body.appendChild(f); return true; })()`,
	);
	const unsandboxedDelivered = await waitFor(`window.__s4bSeen.filter((o) => o === ${JSON.stringify(hostileOrigin)}).length >= 3`, { timeoutMs: 8000 });
	ok("the unsandboxed fixture loaded and posted", unsandboxedDelivered === true, `delivered=${unsandboxedDelivered}`);
	await sleep(300);
	const unsandboxedRect = await evaluate(
		`(() => { const r = document.querySelector("#s4c-nosandbox").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
	);
	await clickAt(unsandboxedRect.x, unsandboxedRect.y);
	const navHref = await waitFor(`location.href.startsWith(${JSON.stringify(appOrigin + "/__s4c-nav-marker")})`, { timeoutMs: 4000 });
	ok("the unsandboxed control frame DID navigate top (the sandbox is the blocker)", navHref === true, `navigated=${navHref}`);
	await bootApp();
	const recomposed = await evaluateSafely(`!!window[Symbol.for("cozyclay.surfaceMount.v1")]`);
	ok("a reload re-composes the boundary", recomposed === true, "mount controller missing after reload");
	ok("no uncaught app errors during the browser section", pageErrors.length === 0, pageErrors.join(" | "));

	blackHole.close();
	childServer.close();
	hostileServer.close();
	ws.close();
}
console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

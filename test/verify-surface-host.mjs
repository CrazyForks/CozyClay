#!/usr/bin/env node
/**
 * The cross-origin embedder and publish door (plan §11.5, §11.6, §12):
 * src/surface-host.js frames the ingest surface under a restrictive
 * sandbox and rejects any message that is not from the exact origin, the
 * exact contentWindow and protocol version cclay v1 — a foreign message
 * is refused, never merely ignored. Landings are exactly-once per surface
 * session: the request-id table is session-scoped and refuses at its
 * ceiling rather than evict, because eviction is exactly what lets a
 * delayed retry land twice. The child cannot render its own failure, so
 * the host owns the load timeout, the ready handshake and the
 * parent-rendered unavailable panel. S2 is the publish door: every §5
 * TakePayload clause rejects by name.
 *
 * Node-only, against a fake window/document/postMessage harness; the
 * browser suite is U4 in Phase 4.
 */
import { createSurfaceHost, validateTakePayload } from "../src/surface-host.js";

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
ok("the frame loads lazily from the surface URL and starts hidden", env.host.iframe().loading === "lazy" && env.host.iframe().src === ORIGIN + "/" && env.host.iframe().hidden === true, `src=${env.host.iframe().src} hidden=${env.host.iframe().hidden}`);

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

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

#!/usr/bin/env node
/**
 * The atomic take store (plan §7.2/§7.3): landTake validates the §5
 * TakePayload contract, applies in one batch, and pushes exactly one
 * history entry; every accepted requestId is retained in a bounded
 * table that REFUSES at its ceiling rather than evicting, so a replay
 * — immediate or delayed behind any number of intervening requests —
 * returns the cached ack and mints nothing; undo restores the
 * pre-landing field snapshot and redo re-applies the take.
 *
 * The landing path is covered where it actually runs: the surface host
 * (src/surface-host.js, §12) wired to a real take store, delayed retry
 * after 40 intervening requests. What would be circular: asserting the
 * store's private history object or the adapter's table internals —
 * depths()/value(), the wiring spies and the mint counter are the
 * observable surface, and the idempotency key travels in the payload.
 */
import { createUndoCoordinator } from "../src/undo-coordinator.js";
import { createSceneHistoryStore } from "../src/scene-history.js";
import { createPerformanceTakeStore } from "../src/performance-take.js";
import { createSurfaceHost } from "../src/surface-host.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// Fake App fields the take store writes, with counting spies so "applied
// exactly once per landing" and "restored on undo" are assertable.
function makeTakeWiring() {
	const fields = { take: null, clipA: null, clipB: null, dragging: true };
	const calls = { capture: 0, apply: 0, restore: 0 };
	const wiring = {
		capture() {
			calls.capture += 1;
			return { ...fields };
		},
		apply(value) {
			calls.apply += 1;
			fields.take = value;
		},
		restore(snapshot) {
			calls.restore += 1;
			Object.assign(fields, snapshot);
		},
	};
	return { fields, calls, wiring };
}

// A valid §5 TakePayload: both clips upright at 0°, 20 fps, equal frame
// counts, complete provenance. The artifact fields also pass the host's
// §12.3 path regex, so one builder serves the store tests and the
// real-landing-path composition below.
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

/* ---------------- exactly one entry per landing (§7.2) --------------- */

const coordinator = createUndoCoordinator();
const takeEnv = makeTakeWiring();
const take = createPerformanceTakeStore(takeEnv.wiring, { coordinator });
const payload = makePayload("req-1");
const ack = take.landTake(payload);
ok("landing pushes exactly one entry: expected 1, got 0", take.depths().past === 1 && take.depths().future === 0, `past=${take.depths().past} future=${take.depths().future}`);
ok("the landing minted exactly one sequence", coordinator.sequence() === 1, `sequence()=${coordinator.sequence()}`);
ok("the take store holds the one landed value", take.value() === payload && ack.requestId === "req-1" && ack.value === payload);
ok("landing applies in one batch", takeEnv.calls.capture === 1 && takeEnv.calls.apply === 1 && takeEnv.calls.restore === 0, `capture=${takeEnv.calls.capture} apply=${takeEnv.calls.apply} restore=${takeEnv.calls.restore}`);
ok("the take fields carry the landed value", takeEnv.fields.take === payload);

/* ------------------ a replayed requestId mints nothing --------------- */

const replay = take.landTake(payload);
ok("a replayed landTake with the same requestId mints nothing", replay === ack && take.depths().past === 1 && take.depths().future === 0 && coordinator.sequence() === 1, `past=${take.depths().past} sequence()=${coordinator.sequence()}`);
ok("the replay applied nothing", takeEnv.calls.capture === 1 && takeEnv.calls.apply === 1, `capture=${takeEnv.calls.capture} apply=${takeEnv.calls.apply}`);

/* --------- a delayed re-landing after intervening requests ----------- */
/* The defect this closes: idempotency used to remember only the last
 * accepted requestId, so req-1, req-2, then a delayed req-1 applied and
 * minted req-1 a second time. The table retains every accepted id. */

const coordinator5 = createUndoCoordinator();
const env5 = makeTakeWiring();
const take5 = createPerformanceTakeStore(env5.wiring, { coordinator: coordinator5 });
const firstAck5 = take5.landTake(makePayload("req-1")); // seq 1
take5.landTake(makePayload("req-2")); // seq 2
const delayed5 = take5.landTake(makePayload("req-1"));
ok("a delayed re-landing after one intervening request is refused, not re-applied", delayed5 === firstAck5 && take5.depths().past === 2 && take5.depths().future === 0 && coordinator5.sequence() === 2 && env5.calls.apply === 2, `same-ack=${delayed5 === firstAck5} past=${take5.depths().past} sequence()=${coordinator5.sequence()} apply=${env5.calls.apply}`);

/* --------------------- validation rejects, applies nothing ----------- */

const invalid = [
	[null, "payload-not-object"],
	[{ ...makePayload("bad-0"), requestId: "" }, "request-id-missing"],
	[{ ...makePayload("bad-1"), a: { ...makePayload("bad-1").a, rotationDeg: 5 } }, "rotation-deg-mismatch"],
	[{ ...makePayload("bad-2"), a: { ...makePayload("bad-2").a, fps: 24 } }, "fps-not-20"],
	[{ ...makePayload("bad-3"), b: { ...makePayload("bad-3").b, frames: 59 } }, "frame-count-mismatch"],
	[
		(() => {
			const payload = makePayload("bad-4");
			const { weightsSha256, ...provenance } = payload.b.provenance;
			return { ...payload, b: { ...payload.b, provenance } };
		})(),
		"provenance-incomplete",
	],
];
const badEnv = makeTakeWiring();
const badTake = createPerformanceTakeStore(badEnv.wiring, { coordinator });
for (const [badPayload, code] of invalid) {
	let threw = null;
	try {
		badTake.landTake(badPayload);
	} catch (err) {
		threw = err.message;
	}
	ok(`invalid payload rejected with ${code}`, threw === code, `threw=${threw}`);
	ok(`the rejected ${code} applied nothing`, badTake.depths().past === 0 && badTake.depths().future === 0 && coordinator.sequence() === 1 && badEnv.fields.take === null && badEnv.calls.apply === 0, `past=${badTake.depths().past} sequence()=${coordinator.sequence()} apply=${badEnv.calls.apply}`);
}

/* ----------------------- undo restores, redo re-applies -------------- */

const coordinator2 = createUndoCoordinator();
const env2 = makeTakeWiring();
const take2 = createPerformanceTakeStore(env2.wiring, { coordinator: coordinator2 });
const payload2 = makePayload("req-2");
take2.landTake(payload2);
const undone = take2.undo();
ok("undo restores the pre-landing field snapshot", undone !== null && env2.fields.take === null && take2.value() === null && env2.calls.restore === 1, `restore=${env2.calls.restore}`);
ok("the take's seq moved to its redo stack", take2.canRedo() === true && take2.topRedoSeq() === 1 && take2.depths().past === 0 && take2.depths().future === 1, `topRedoSeq()=${take2.topRedoSeq()}`);
ok("redo re-applies the landed take", take2.redo() !== null && env2.fields.take === payload2 && take2.value() === payload2 && take2.canRedo() === false && take2.topSeq() === 1, `topSeq()=${take2.topSeq()}`);
ok("undo with nothing landed is null", (() => {
	const env0 = makeTakeWiring();
	const t0 = createPerformanceTakeStore(env0.wiring, { coordinator: coordinator2 });
	return t0.undo() === null && t0.redo() === null && env0.calls.restore === 0;
})());

/* ------------------- the take store inside the coordinator ----------- */

const coordinator3 = createUndoCoordinator();
const scene3 = createSceneHistoryStore(["base"], { coordinator: coordinator3, onObjects() {} });
const env3 = makeTakeWiring();
const take3 = createPerformanceTakeStore(env3.wiring, { coordinator: coordinator3 });
scene3.applyAtomic((objects) => ["base", "s1"]); // seq 1
take3.landTake(makePayload("req-3")); // seq 2
ok("coordinator.undo() picks the take (2 > 1)", (() => {
	coordinator3.undo();
	return take3.value() === null && env3.fields.take === null && scene3.objects[1] === "s1";
})());
ok("coordinator.redo() re-applies the take", (() => {
	coordinator3.redo();
	return take3.value() !== null && take3.value().requestId === "req-3" && env3.fields.take !== null;
})());

// a scene edit after the take was undone kills the take's redo branch
const coordinator4 = createUndoCoordinator();
const scene4 = createSceneHistoryStore(["base"], { coordinator: coordinator4, onObjects() {} });
const env4 = makeTakeWiring();
const take4 = createPerformanceTakeStore(env4.wiring, { coordinator: coordinator4 });
take4.landTake(makePayload("req-4")); // seq 1
coordinator4.undo(); // take undone, canRedo true
scene4.applyAtomic((objects) => ["base", "s1"]); // mints 2 — invalidates take
ok("a new scene edit invalidates the take's redo", take4.canRedo() === false && take4.topRedoSeq() === undefined && take4.depths().future === 0, `canRedo()=${take4.canRedo()}`);
ok("coordinator.redo() is null after the invalidation", coordinator4.redo() === null);

/* ----------------------- fake browser harness -------------------------- */
/* Only what the host touches: a window that records message listeners, a
 * document whose created iframes remember their listeners and post their
 * acks into a posted log, and real timers (the ready handshake clears the
 * load timer, so nothing keeps the process alive). */

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
				setAttribute() {},
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
	return { window, document, posted, iframes };
}

/* ----------- the real landing path: host door -> take store ----------- */
/* The adapter (src/surface-host.js, §12.2) is the session authority and
 * the store's only entrance in the app; this composes them for real:
 * req-1, 40 intervening distinct ids, then a delayed req-1. The door
 * must serve the original cached ack, the store must hold exactly 41
 * entries, and the mint counter must not move. */

const LAND_ORIGIN = "http://127.0.0.1:5183";
const landDom = makeFakeDom();
const landCo = createUndoCoordinator();
const landEnv = makeTakeWiring();
const landStore = createPerformanceTakeStore(landEnv.wiring, { coordinator: landCo });
const landHost = createSurfaceHost({
	window: landDom.window,
	document: landDom.document,
	surfaceOrigin: LAND_ORIGIN,
	surfaceUrl: LAND_ORIGIN + "/",
	onLand(payload) {
		landStore.landTake(payload); // the app wiring: door -> store
	},
});
const landMessage = (data) => ({ origin: LAND_ORIGIN, source: landHost.iframe().contentWindow, data });
const landCode = (requestId) => landHost.handleMessage(landMessage({ cclay: 1, v: 1, id: "m-" + requestId, requestId, type: "land", payload: makePayload(requestId) })) ?? null;
landHost.handleMessage(landMessage({ cclay: 1, v: 1, id: "m-ready", type: "ready" }));
landCode("req-1");
const landFirstAck = landDom.posted.find((p) => p.message.requestId === "req-1").message;
for (let i = 2; i <= 41; i += 1) landCode("req-" + i);
ok("40 intervening landings each apply exactly once at the real path", landEnv.calls.apply === 41 && landStore.depths().past === 41 && landCo.sequence() === 41, `apply=${landEnv.calls.apply} past=${landStore.depths().past} sequence()=${landCo.sequence()}`);
const landRetry = landCode("req-1");
ok("a delayed retry after 40 intervening requests lands nothing at the real path", landRetry === null && landEnv.calls.apply === 41 && landStore.depths().past === 41 && landCo.sequence() === 41, `code=${landRetry} apply=${landEnv.calls.apply} past=${landStore.depths().past} sequence()=${landCo.sequence()}`);
ok("the delayed retry is served the original cached ack", landDom.posted[landDom.posted.length - 1].message === landFirstAck, "reference equality");
ok("the delayed retry mints no second sequence and re-lands nothing", landStore.value() !== null && landStore.value().requestId === "req-41", `value.requestId=${landStore.value()?.requestId}`);

/* ----------- the idempotency table refuses at its ceiling -------------- */
/* The table is bounded and refuses rather than evicts: eviction is
 * exactly the defect that lets a delayed retry land twice (§12.2). */

const ceilingCo = createUndoCoordinator();
const ceilingEnv = makeTakeWiring();
const ceilingStore = createPerformanceTakeStore(ceilingEnv.wiring, { coordinator: ceilingCo });
const ceilingFirst = ceilingStore.landTake(makePayload("ceiling-0"));
for (let i = 1; i < 10000; i += 1) {
	ceilingStore.landTake(makePayload("ceiling-" + i));
}
ok("10 000 accepted request ids fit the take table", ceilingCo.sequence() === 10000 && ceilingEnv.calls.apply === 10000, `sequence()=${ceilingCo.sequence()} apply=${ceilingEnv.calls.apply}`);
let ceilingCode = null;
try {
	ceilingStore.landTake(makePayload("ceiling-overflow"));
} catch (err) {
	ceilingCode = err.message;
}
ok("the 10 001st accepted id is refused by name and nothing applied", ceilingCode === "request-table-exhausted" && ceilingEnv.calls.apply === 10000 && ceilingCo.sequence() === 10000, `code=${ceilingCode} apply=${ceilingEnv.calls.apply} sequence()=${ceilingCo.sequence()}`);
const ceilingReplay = ceilingStore.landTake(makePayload("ceiling-0"));
ok("a replay at the ceiling is still served the cached ack", ceilingReplay === ceilingFirst && ceilingEnv.calls.apply === 10000 && ceilingCo.sequence() === 10000, `same-ack=${ceilingReplay === ceilingFirst} apply=${ceilingEnv.calls.apply}`);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

#!/usr/bin/env node
/**
 * The atomic take store (plan §7.2/§7.3): landTake validates the §5
 * TakePayload contract, applies in one batch, and pushes exactly one
 * history entry; a replayed requestId returns the cached ack and mints
 * nothing; undo restores the pre-landing field snapshot and redo
 * re-applies the take.
 *
 * What would be circular: asserting the store's private history object
 * or the adapter's requestId table (U3) — depths()/value() and the
 * wiring spies are the observable surface, and the idempotency key
 * travels in the payload.
 */
import { createUndoCoordinator } from "../src/undo-coordinator.js";
import { createSceneHistoryStore } from "../src/scene-history.js";
import { createPerformanceTakeStore } from "../src/performance-take.js";

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
// counts, complete provenance.
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
			annotationPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-${track}.json`,
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

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

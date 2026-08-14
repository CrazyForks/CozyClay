#!/usr/bin/env node
/**
 * Category 1 — undo coordinator sequence algebra (plan §7.3, S4).
 *
 * Attacks the coordinator's algebra where the green suite stops:
 * interleaving with a THIRD registered store, coalescing at every push
 * site, HISTORY_LIMIT trimming at and past the 51st push, undo/redo to
 * both extremes then a branch, three-store cross-store redo invalidation,
 * a store whose canUndo() lies, and re-entrant undo during a settle
 * (both through a custom prepare() and through a REAL scene store whose
 * cancel callback calls back into the coordinator — history.js's
 * teardown-only contract, attacked for its consequence).
 *
 * Every verdict is derived from the observed store/coordinator state;
 * a case that cannot be observed is a HARNESS-FAIL, never a pass.
 */
import { createUndoCoordinator } from "../../src/undo-coordinator.js";
import { createSceneHistoryStore } from "../../src/scene-history.js";
import { createPerformanceTakeStore } from "../../src/performance-take.js";
import { createRecorder } from "./rt-common.mjs";

const rt = createRecorder({ suite: "rt-undo", category: "undo-coordinator" });

// --- fixtures ---------------------------------------------------------------

function makeTakeWiring() {
	const fields = { take: null, clipA: null, clipB: null, dragging: true };
	const calls = { capture: 0, apply: 0, restore: 0 };
	return {
		fields,
		calls,
		wiring: {
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
		},
	};
}

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

// A minimal honest third store: its own seq mirror, real stacks, the
// seven-handler contract. The registry allows any number of stores.
function makeThirdStore(coordinator) {
	const past = [];
	const future = [];
	const store = {
		prepare() {},
		canUndo() {
			return past.length > 0;
		},
		canRedo() {
			return future.length > 0;
		},
		undo() {
			const id = past.pop();
			if (id !== undefined) future.unshift(id);
			return "third:" + id;
		},
		redo() {
			const id = future.shift();
			if (id !== undefined) past.push(id);
			return "third:" + id;
		},
		stamp(id) {
			past.push(id);
			future.length = 0;
		},
		invalidateRedo() {
			future.length = 0;
		},
		topSeq() {
			return past[past.length - 1];
		},
		topRedoSeq() {
			return future[0];
		},
		push() {
			coordinator.thirdStamp();
		},
	};
	coordinator.thirdStamp = (() => {
		const stamp = coordinator.register({ id: "third", store }).stamp;
		return () => stamp();
	})();
	return store;
}

// --- cases ------------------------------------------------------------------

rt.record({
	id: "U-UNDO-01",
	kind: "algorithm",
	title: "scene/take/scene/take interleave: undo walks 4,3,2,1; redo replays 1,2,3,4",
	planRef: "plan §7.3",
	input: "applyAtomic(s1) -> landTake(t1) -> applyAtomic(s2) -> landTake(t2); coordinator.undo() x4; coordinator.redo() x4",
	expected: "sequence mints 1,2,3,4 in order; each undo pops the greatest topSeq; each redo replays the smallest topRedoSeq; final state equals the post-4 state",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const env = makeTakeWiring();
		const take = createPerformanceTakeStore(env.wiring, { coordinator });
		scene.applyAtomic((o) => [...o, "s1"]); // 1
		take.landTake(makePayload("t1")); // 2
		scene.applyAtomic((o) => [...o, "s2"]); // 3
		take.landTake(makePayload("t2")); // 4
		const minted = coordinator.sequence() === 4 && scene.topSeq() === 3 && take.topSeq() === 4;
		const order = [];
		order.push(coordinator.undo()); // 4: take t2 undone
		order.push(coordinator.undo()); // 3: scene s2 undone
		order.push(coordinator.undo()); // 2: take t1 undone
		order.push(coordinator.undo()); // 1: scene s1 undone
		const undosOk = coordinator.sequence() === 4 && scene.topSeq() === undefined && take.topSeq() === undefined && scene.depths().past === 0 && take.depths().past === 0 && order[0]?.value?.requestId === "t2" && order[1]?.[1] === "s1" && order[2]?.value?.requestId === "t1" && order[3]?.[0] === "v0";
		const redone = [coordinator.redo(), coordinator.redo(), coordinator.redo(), coordinator.redo()];
		const redosOk = scene.topSeq() === 3 && take.topSeq() === 4 && redone[0]?.[1] === "s1" && redone[1]?.value?.requestId === "t1" && redone[2]?.[2] === "s2" && redone[3]?.value?.requestId === "t2" && scene.objects[1] === "s1" && scene.objects[2] === "s2" && env.fields.take?.requestId === "t2";
		return {
			verdict: minted && undosOk && redosOk ? "PASS" : "DEFECT",
			observed: `sequence=${coordinator.sequence()} undos=[${order.map((r) => (r?.value?.requestId ?? r?.[1] ?? null)).join(",")}] redos=[${redone.map((r) => (r?.value?.requestId ?? r?.[1] ?? null)).join(",")}]`,
		};
	},
});

rt.record({
	id: "U-UNDO-02",
	kind: "boundary",
	title: "coalesced no-ops mint nothing at any push site",
	planRef: "plan §7.3",
	input: "applyAtomic(same-ref); begin/applyIn/end(commit:true) with no change; begin/applyIn/settle with no change",
	expected: "no mint: sequence() unchanged, depths unchanged, topSeq unchanged",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const before = coordinator.sequence();
		scene.applyAtomic((o) => o); // same reference
		const t1 = scene.begin("noop1", () => {});
		scene.applyIn(t1, (o) => o);
		scene.end(t1, { commit: true });
		const t2 = scene.begin("noop2", () => {});
		scene.applyIn(t2, (o) => o);
		scene.settle();
		const stable = coordinator.sequence() === before && scene.topSeq() === undefined && scene.depths().past === 0 && scene.depths().future === 0 && scene.objects.length === 1;
		return {
			verdict: stable ? "PASS" : "DEFECT",
			observed: `sequence=${coordinator.sequence()} (before ${before}), past=${scene.depths().past}, future=${scene.depths().future}`,
		};
	},
});

rt.record({
	id: "U-UNDO-03",
	kind: "math",
	title: "HISTORY_LIMIT: the 51st and every later push trims past to 50; seq pairing survives 100 pushes",
	planRef: "plan §7.3 (HISTORY_LIMIT lockstep)",
	input: "100 sequential applyAtomic pushes; then undo to exhaustion",
	expected: "past.length === 50 at push 51..100; topSeq === 100; each undo pops the seq-paired present (present k-1 pairs seq k); exactly 50 undos exhaust; the 51 undos that would be needed are trimmed",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		for (let i = 1; i <= 100; i += 1) scene.applyAtomic(() => [`v${i}`]);
		const capped = scene.depths().past === 50 && coordinator.sequence() === 100 && scene.topSeq() === 100;
		let aligned = true;
		let undos = 0;
		while (scene.canUndo()) {
			const top = scene.topSeq();
			const present = scene.undo();
			undos += 1;
			if (present === null || present[0] !== `v${top - 1}`) aligned = false;
		}
		const exhausted = undos === 50 && scene.topSeq() === undefined && scene.depths().past === 0 && scene.depths().future === 50;
		return {
			verdict: capped && aligned && exhausted ? "PASS" : "DEFECT",
			observed: `capped=${capped} aligned=${aligned} undos=${undos} future=${scene.depths().future} sequence=${coordinator.sequence()}`,
		};
	},
});

rt.record({
	id: "U-UNDO-04",
	kind: "algorithm",
	title: "undo/redo to both extremes, then a branch kills every redo branch",
	planRef: "plan §7.3 (A3)",
	input: "5 interleaved ops; undo x5 (extreme past); redo x5 (extreme future); one new push",
	expected: "after the branch, coordinator.redo() === null; BOTH stores report canRedo() === false and empty futures",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const env = makeTakeWiring();
		const take = createPerformanceTakeStore(env.wiring, { coordinator });
		scene.applyAtomic((o) => [...o, "s1"]); // 1
		take.landTake(makePayload("t1")); // 2
		scene.applyAtomic((o) => [...o, "s2"]); // 3
		take.landTake(makePayload("t2")); // 4
		scene.applyAtomic((o) => [...o, "s3"]); // 5
		for (let i = 0; i < 5; i += 1) coordinator.undo();
		const atPast = scene.depths().past === 0 && take.depths().past === 0 && scene.topSeq() === undefined && take.topSeq() === undefined && scene.objects.length === 1 && env.fields.take === null;
		for (let i = 0; i < 5; i += 1) coordinator.redo();
		const atFuture = scene.depths().future === 0 && take.depths().future === 0 && scene.topSeq() === 5 && take.topSeq() === 4 && scene.objects.length === 4 && env.fields.take !== null;
		scene.applyAtomic((o) => [...o, "branch"]); // 6: the branch
		const branchKills = coordinator.redo() === null && scene.canRedo() === false && take.canRedo() === false && scene.topRedoSeq() === undefined && take.topRedoSeq() === undefined && scene.depths().future === 0 && take.depths().future === 0;
		return {
			verdict: atPast && atFuture && branchKills ? "PASS" : "DEFECT",
			observed: `atPast=${atPast} atFuture=${atFuture} branchKills=${branchKills} scene.future=${scene.depths().future} take.future=${take.depths().future}`,
		};
	},
});

rt.record({
	id: "U-UNDO-05",
	kind: "algorithm",
	title: "three registered stores: a push on any one invalidates the other two's redo branches atomically",
	planRef: "plan §7.3 (A3, registry allows N stores)",
	input: "scene(1) -> take(2) -> third(3); undo (third); undo (take); push on scene(4)",
	expected: "the push on scene invalidates take AND third redo; redo returns null; the invalidations happen before the mint is recorded (atomic)",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const env = makeTakeWiring();
		const take = createPerformanceTakeStore(env.wiring, { coordinator });
		const third = makeThirdStore(coordinator);
		scene.applyAtomic((o) => [...o, "s1"]); // 1
		take.landTake(makePayload("t1")); // 2
		third.push(); // 3
		const order1 = coordinator.undo() === "third:3" && coordinator.undo()?.value?.requestId === "t1";
		let invalidations = 0;
		const origInvalidate = take.invalidateRedo;
		take.invalidateRedo = () => {
			invalidations += 1;
			origInvalidate();
		};
		scene.applyAtomic((o) => [...o, "s2"]); // 4: branch
		take.invalidateRedo = origInvalidate;
		const allInvalidated = take.canRedo() === false && third.canRedo() === false && take.topRedoSeq() === undefined && third.topRedoSeq() === undefined && coordinator.redo() === null && scene.canRedo() === false;
		const atomicity = invalidations === 1 && coordinator.sequence() === 4;
		// the take's own redo (seq 2) must ALSO be dead: its id was undone and a branch happened
		return {
			verdict: order1 && allInvalidated && atomicity ? "PASS" : "DEFECT",
			observed: `order1=${order1} allInvalidated=${allInvalidated} invalidations=${invalidations} sequence=${coordinator.sequence()}`,
		};
	},
});

rt.record({
	id: "U-UNDO-06",
	kind: "adversarial",
	title: "a store whose canUndo() lies (true, empty stack, topSeq 999) is chosen and starves the honest undo",
	planRef: "plan §7.3 (seven-handler contract)",
	input: "register a ghost store reporting canUndo() === true and topSeq() === 999 with nothing to undo; one real scene entry exists",
	expected: "per the documented pick rule ('greatest topSeq among undoable') the ghost IS chosen; consequence: the honest entry is never undone while the liar is registered",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		let ghostUndoCalls = 0;
		const ghost = {
			prepare() {},
			stamp() {},
			invalidateRedo() {},
			canUndo() {
				return true; // lies
			},
			canRedo() {
				return false;
			},
			undo() {
				ghostUndoCalls += 1;
				return "ghost-undone";
			},
			redo() {
				throw new Error("ghost redo called");
			},
			topSeq() {
				return 999; // lies
			},
			topRedoSeq() {
				return undefined;
			},
		};
		coordinator.register({ id: "ghost", store: ghost });
		scene.applyAtomic((o) => [...o, "s1"]); // 1
		const result = coordinator.undo();
		const starved = scene.topSeq() === 1 && scene.canUndo() === true && scene.objects[1] === "s1";
		return {
			verdict: ghostUndoCalls === 1 && result === "ghost-undone" && starved ? "WEAKNESS" : "DEFECT",
			observed: `undo returned ${JSON.stringify(result)}, ghost undo calls=${ghostUndoCalls}, scene still undoable=${starved}`,
		};
	},
});

rt.record({
	id: "U-UNDO-07",
	kind: "adversarial",
	title: "re-entrant undo from a prepare() (guarded) double-undoes in one keystroke",
	planRef: "plan §7.3 (prepare phase; no re-entrancy guard)",
	input: "a store whose prepare() calls coordinator.undo() once; scene has 2 entries",
	expected: "a single coordinator.undo() should pop exactly one entry; observed behaviour is the risk surface",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		let reentered = false;
		const store = {
			prepare() {
				if (!reentered) {
					reentered = true;
					coordinator.undo();
				}
			},
			stamp() {},
			invalidateRedo() {},
			canUndo() {
				return false;
			},
			canRedo() {
				return false;
			},
			undo() {
				throw new Error("reentrant store undo called");
			},
			redo() {
				throw new Error("reentrant store redo called");
			},
			topSeq() {
				return 0;
			},
			topRedoSeq() {
				return undefined;
			},
		};
		coordinator.register({ id: "reentrant", store });
		scene.applyAtomic((o) => [...o, "s1"]); // 1
		scene.applyAtomic((o) => [...o, "s2"]); // 2
		const result = coordinator.undo();
		// inner undo popped s2 (seq 2); the outer pick then sees scene.canUndo() === true
		// (s1 remains) and pops s1 too — two entries undone by one call.
		const doubleUndo = scene.objects.length === 1 && scene.topSeq() === undefined && scene.depths().past === 0 && scene.depths().future === 2;
		return {
			verdict: doubleUndo && reentered ? "WEAKNESS" : "INFO",
			observed: `result=${JSON.stringify(result)} objects=${JSON.stringify(scene.objects)} past=${scene.depths().past} future=${scene.depths().future}`,
		};
	},
});

rt.record({
	id: "U-UNDO-08",
	kind: "adversarial",
	title: "REAL scene store: a cancel callback that calls coordinator.undo() silently discards the open drag's travel",
	planRef: "plan §7.3; history.js cancel teardown-only contract",
	input: "begin('drag', cancel) where cancel calls coordinator.undo() once; applyIn travel; one outer coordinator.undo()",
	expected: "the travel should become one entry (settle) and the undo pops exactly one entry; observed: the travel is neither minted nor preserved",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		let reentry = 0;
		scene.applyAtomic((o) => [...o, "v1"]); // 1
		const token = scene.begin("drag", () => {
			reentry += 1;
			if (reentry === 1) coordinator.undo();
		});
		scene.applyIn(token, (o) => [...o, "travel"]);
		const result = coordinator.undo();
		const travelLost = scene.objects.length === 1 && scene.objects[0] === "v0" && !scene.objects.includes("travel") && scene.depths().past === 0 && scene.depths().future === 1 && coordinator.sequence() === 1;
		const travelMinted = scene.depths().future === 2;
		return {
			verdict: travelLost && !travelMinted ? "WEAKNESS" : travelMinted ? "PASS" : "DEFECT",
			observed: `result=${JSON.stringify(result)} objects=${JSON.stringify(scene.objects)} sequence=${coordinator.sequence()} past=${scene.depths().past} future=${scene.depths().future} reentry=${reentry}`,
		};
	},
});

rt.record({
	id: "U-UNDO-09",
	kind: "property",
	title: "coordinator.undo()/redo() return exactly what the picked store returned",
	planRef: "plan §7.3",
	input: "one scene push, one take push; undo and redo through the coordinator",
	expected: "returns are passed through unmodified (scene present array / take entry object)",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const env = makeTakeWiring();
		const take = createPerformanceTakeStore(env.wiring, { coordinator });
		scene.applyAtomic((o) => [...o, "s1"]); // 1
		take.landTake(makePayload("t1")); // 2
		const undone = coordinator.undo(); // take
		const undoneDirect = take.undo ? null : null;
		void undoneDirect;
		const sceneUndone = coordinator.undo(); // scene
		const redoneScene = coordinator.redo(); // scene first (seq 1 < 2)
		const redoneTake = coordinator.redo(); // take
		const pass =
			undone !== null && undone.value?.requestId === "t1" &&
			Array.isArray(sceneUndone) && sceneUndone[0] === "v0" &&
			Array.isArray(redoneScene) && redoneScene[1] === "s1" &&
			redoneTake !== null && redoneTake.value?.requestId === "t1";
		return { verdict: pass ? "PASS" : "DEFECT", observed: `undone=${undone?.value?.requestId} sceneUndone=${sceneUndone?.[0]} redoneScene=${redoneScene?.[1]} redoneTake=${redoneTake?.value?.requestId}` };
	},
});

rt.record({
	id: "U-UNDO-10",
	kind: "boundary",
	title: "redo after a branch returns null and never touches the futures",
	planRef: "plan §7.3 (A3)",
	input: "land take (1); undo; push scene (2); coordinator.redo()",
	expected: "null; the take's future stays empty; nothing re-applies",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const env = makeTakeWiring();
		const take = createPerformanceTakeStore(env.wiring, { coordinator });
		take.landTake(makePayload("t1")); // 1
		coordinator.undo();
		scene.applyAtomic((o) => [...o, "s1"]); // 2 branch
		const result = coordinator.redo();
		const clean = result === null && take.canRedo() === false && take.depths().future === 0 && env.fields.take === null && scene.topSeq() === 2;
		return { verdict: clean ? "PASS" : "DEFECT", observed: `redo=${JSON.stringify(result)} take.future=${take.depths().future} take.take=${env.fields.take}` };
	},
});

rt.record({
	id: "U-UNDO-11",
	kind: "property",
	title: "failed operations mint nothing: rejected landings and null undos leave sequence() untouched",
	planRef: "plan §7.3",
	input: "a landing the store rejects (bad fps), an undo on an empty history, a redo on an empty history",
	expected: "sequence() unchanged; depths unchanged",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const env = makeTakeWiring();
		const take = createPerformanceTakeStore(env.wiring, { coordinator });
		const bad = makePayload("bad");
		bad.a.fps = 24;
		let threw = null;
		try {
			take.landTake(bad);
		} catch (err) {
			threw = err.message;
		}
		const afterReject = coordinator.sequence() === 0;
		const nullUndo = coordinator.undo() === null && scene.depths().past === 0;
		const nullRedo = coordinator.redo() === null && scene.depths().future === 0;
		const stable = coordinator.sequence() === 0 && scene.topSeq() === undefined && take.topSeq() === undefined;
		return {
			verdict: threw === "fps-not-20" && afterReject && nullUndo && nullRedo && stable ? "PASS" : "DEFECT",
			observed: `threw=${threw} sequence=${coordinator.sequence()}`,
		};
	},
});

rt.record({
	id: "U-UNDO-12",
	kind: "property",
	title: "an interleaved take undo restores the exact captured before-snapshot",
	planRef: "plan §7.2/§7.3",
	input: "land a take; mutate the fields behind the wiring; coordinator.undo()",
	expected: "restore() receives the snapshot captured at land time and the fields return to it exactly",
	run: () => {
		const coordinator = createUndoCoordinator();
		const scene = createSceneHistoryStore(["v0"], { coordinator, onObjects() {} });
		const env = makeTakeWiring();
		const take = createPerformanceTakeStore(env.wiring, { coordinator });
		take.landTake(makePayload("snap"));
		env.fields.clipA = "tampered";
		env.fields.dragging = false;
		coordinator.undo();
		const restored = env.fields.take === null && env.fields.clipA === null && env.fields.dragging === true && env.calls.restore === 1;
		return {
			verdict: restored ? "PASS" : "DEFECT",
			observed: `fields=${JSON.stringify(env.fields)} restoreCalls=${env.calls.restore}`,
		};
	},
});

const evidencePath = await rt.write();
const fails = rt.cases.filter((c) => c.verdict === "HARNESS-FAIL");
console.log(`\nrt-undo: ${rt.cases.length} cases, ${rt.cases.filter((c) => c.verdict === "DEFECT").length} DEFECT, ${rt.cases.filter((c) => c.verdict === "WEAKNESS").length} WEAKNESS, evidence: ${evidencePath}`);
process.exit(fails.length ? 1 : 0);

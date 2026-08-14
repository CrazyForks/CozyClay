#!/usr/bin/env node
/**
 * Category 2 — exactly-once landing (plan §7.2, §12.2; S5).
 *
 * Attacks the atomic take store's idempotency where the green suite
 * stops: concurrent same-id landings, a landing that rejects mid-apply,
 * a clear racing a landing (both directions), the request table at its
 * 10 000 ceiling, a replay after the ceiling refused a NEW id, a replay
 * after undo, and requestId edge types.
 *
 * Every verdict is derived from observed store state; a case that cannot
 * be observed is a HARNESS-FAIL, never a pass.
 */
import { createUndoCoordinator } from "../../src/undo-coordinator.js";
import { createPerformanceTakeStore } from "../../src/performance-take.js";
import { createRecorder } from "./rt-common.mjs";

const rt = createRecorder({ suite: "rt-take", category: "exactly-once-landing" });

// --- fixtures ---------------------------------------------------------------

function makeTakeWiring({ applyImpl } = {}) {
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
				if (applyImpl) {
					applyImpl(value, fields);
				} else {
					fields.take = value;
				}
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

function makeStore(applyImpl) {
	const coordinator = createUndoCoordinator();
	const env = makeTakeWiring({ applyImpl });
	const take = createPerformanceTakeStore(env.wiring, { coordinator });
	return { coordinator, take, env };
}

// --- cases ------------------------------------------------------------------

rt.record({
	id: "T-ONCE-01",
	kind: "property",
	title: "concurrent same-requestId landings apply exactly once",
	planRef: "plan §12.2",
	input: "Promise.all([landTake(p), landTake(p)]) with the identical payload object",
	expected: "one apply, one entry, one sequence mint; the second caller gets the cached ack",
	run: () => {
		const { coordinator, take, env } = makeStore();
		const payload = makePayload("conc-1");
		// Two same-tick call sites (the store is synchronous; the App door
		// shares one in-flight task per requestId, so this is the store-level
		// equivalent of two concurrent sends).
		const ack1 = take.landTake(payload);
		const ack2 = take.landTake(payload);
		const appliedOnce = env.calls.apply === 1 && take.depths().past === 1 && coordinator.sequence() === 1;
		const sameAck = ack1 === ack2;
		return {
			verdict: appliedOnce && sameAck ? "PASS" : "DEFECT",
			observed: `applyCalls=${env.calls.apply} past=${take.depths().past} sequence=${coordinator.sequence()} ack1===ack2=${ack1 === ack2}`,
		};
	},
});

rt.record({
	id: "T-ONCE-02",
	kind: "property",
	title: "concurrent DISTINCT requestIds all land exactly once each",
	planRef: "plan §12.2",
	input: "Promise.all of 50 landings with distinct ids",
	expected: "50 entries, 50 mints, apply called 50 times, every ack returned",
	run: () => {
		const { coordinator, take, env } = makeStore();
		const acks = [];
		for (let i = 0; i < 50; i += 1) acks.push(take.landTake(makePayload("dist-" + i)));
		const ok = env.calls.apply === 50 && take.depths().past === 50 && coordinator.sequence() === 50 && acks.every((a, i) => a.requestId === "dist-" + i);
		return { verdict: ok ? "PASS" : "DEFECT", observed: `apply=${env.calls.apply} past=${take.depths().past} seq=${coordinator.sequence()}` };
	},
});

rt.record({
	id: "T-ONCE-03",
	kind: "adversarial",
	title: "a landing that rejects mid-apply: no entry, no table record, no rollback — the retry re-applies",
	planRef: "plan §7.2 (one entry per landing), §12.2",
	input: "apply() throws after capture (simulating a partial external write); then retry the same requestId",
	expected: "the rejection must not corrupt idempotency: observed — the failed attempt is unrecorded, the `before` snapshot is abandoned, and the retry re-applies (apply count 2) and mints one entry whose undo restores to the half-mutated state",
	run: () => {
		const payload = makePayload("mid-apply");
		const coordinator2 = createUndoCoordinator();
		const env2 = makeTakeWiring();
		let applyCount = 0;
		const take2 = createPerformanceTakeStore(
			{
				capture() {
					env2.calls.capture += 1;
					return { ...env2.fields };
				},
				apply(value) {
					applyCount += 1;
					env2.calls.apply += 1;
					env2.fields.clipA = "half-written";
					if (applyCount === 1) throw new Error("mid-apply failure");
					env2.fields.take = value; // the retry succeeds
				},
				restore(snapshot) {
					env2.calls.restore += 1;
					Object.assign(env2.fields, snapshot);
				},
			},
			{ coordinator: coordinator2 },
		);
		let threw = null;
		try {
			take2.landTake(payload);
		} catch (err) {
			threw = err.message;
		}
		const afterFail = { past: take2.depths().past, seq: coordinator2.sequence(), clipA: env2.fields.clipA };
		const replay = take2.landTake(payload); // retry: applies again
		const replayObserved = { applyCount, past: take2.depths().past, seq: coordinator2.sequence() };
		const unrecorded = afterFail.past === 0 && afterFail.seq === 0 && env2.fields.clipA === "half-written";
		const retried = replayObserved.applyCount === 2 && replayObserved.past === 1 && replayObserved.seq === 1 && replay.requestId === "mid-apply" && env2.fields.take?.requestId === "mid-apply";
		// undo restores to the snapshot captured by the SUCCESSFUL attempt — which
		// already contains the first attempt's half-write
		coordinator2.undo();
		const undoState = { ...env2.fields };
		return {
			verdict: threw === "mid-apply failure" && unrecorded && retried ? "WEAKNESS" : "DEFECT",
			observed: `threw=${threw} afterFail=${JSON.stringify(afterFail)} retryApply=${replayObserved.applyCount} undoFields=${JSON.stringify(undoState)}`,
		};
	},
});

rt.record({
	id: "T-ONCE-04",
	kind: "algorithm",
	title: "a clear racing a landing: clear never consults or fills the replay table",
	planRef: "plan §7.4 (Finding 5)",
	input: "land('x') -> clear('x') -> land('x') again; then undo x2",
	expected: "the third call returns the cached LANDING ack and applies nothing; the clear stays one entry; undo 1 restores the cleared take, undo 2 undoes the landing",
	run: () => {
		const { coordinator, take, env } = makeStore();
		const payload = makePayload("x");
		take.landTake(payload); // 1
		const clearPayload = { ...makePayload("x"), clear: true, timeline: {} };
		take.clear(clearPayload); // 2
		const writesBefore = env.calls.apply;
		const ack = take.landTake(payload); // replay of the LANDING id
		const replayInert = env.calls.apply === writesBefore && take.depths().past === 2 && ack.value?.requestId === "x";
		coordinator.undo(); // clear undone -> take restored
		const afterClearUndo = env.fields.take?.requestId === "x";
		coordinator.undo(); // landing undone
		const afterLandUndo = env.fields.take === null && take.depths().past === 0 && take.depths().future === 2;
		return {
			verdict: replayInert && afterClearUndo && afterLandUndo ? "PASS" : "DEFECT",
			observed: `replayInert=${replayInert} afterClearUndo=${afterClearUndo} afterLandUndo=${afterLandUndo} past=${take.depths().past}`,
		};
	},
});

rt.record({
	id: "T-ONCE-05",
	kind: "algorithm",
	title: "a landing after a clear with the same id is a fresh landing, never shadowed",
	planRef: "plan §7.4 (Finding 5)",
	input: "clear('x') -> land('x')",
	expected: "the landing applies (the clear never entered the table); undo order: landing then clear",
	run: () => {
		const { coordinator, take, env } = makeStore();
		const clearPayload = { ...makePayload("x"), clear: true, timeline: {} };
		take.clear(clearPayload); // 1
		const ack = take.landTake(makePayload("x")); // 2: fresh
		const landed = ack.value?.requestId === "x" && env.fields.take?.requestId === "x" && take.depths().past === 2;
		coordinator.undo();
		// undo 1 pops the LANDING; the harness wiring (not the real adapter)
		// stores the clear marker verbatim, so the restored pre-landing state
		// carries the clear marker payload
		const landingUndone = env.fields.take?.clear === true;
		coordinator.undo();
		const clearUndone = env.fields.take === null && take.depths().past === 0;
		return {
			verdict: landed && landingUndone && clearUndone ? "PASS" : "DEFECT",
			observed: `landed=${landed} landingUndone=${landingUndone} clearUndone=${clearUndone}`,
		};
	},
});

rt.record({
	id: "T-ONCE-06",
	kind: "boundary",
	title: "the request table at its 10 000 ceiling: NEW ids refused by name, replays still served",
	planRef: "plan §12.2 (store-level guard)",
	input: "10 000 distinct landings, then a NEW id, then a replay of the first id",
	expected: "the 10 001st NEW id throws request-table-exhausted and mints nothing; the replay returns the cached ack; the refused id is never recorded (a retry is refused again, still minting nothing)",
	run: () => {
		const { coordinator, take } = makeStore();
		for (let i = 0; i < 10000; i += 1) take.landTake(makePayload("fill-" + i));
		const atCeiling = take.depths().past === 50 && coordinator.sequence() === 10000; // history trimmed; mints still count
		let refused = null;
		try {
			take.landTake(makePayload("overflow"));
		} catch (err) {
			refused = err.message;
		}
		const afterRefuse = coordinator.sequence() === 10000 && take.depths().past === 50;
		const replay = take.landTake(makePayload("fill-0"));
		const replayOk = replay.requestId === "fill-0" && coordinator.sequence() === 10000;
		let refusedAgain = null;
		try {
			take.landTake(makePayload("overflow"));
		} catch (err) {
			refusedAgain = err.message;
		}
		const neverRecorded = refusedAgain === "request-table-exhausted" && coordinator.sequence() === 10000;
		return {
			verdict: atCeiling && refused === "request-table-exhausted" && afterRefuse && replayOk && neverRecorded ? "PASS" : "DEFECT",
			observed: `ceiling=${atCeiling} refused=${refused} replay=${replayOk} neverRecorded=${neverRecorded} seq=${coordinator.sequence()}`,
		};
	},
});

rt.record({
	id: "T-ONCE-07",
	kind: "boundary",
	title: "a replay after the ceiling refused a NEW id stays refused forever (never enters the table)",
	planRef: "plan §12.2",
	input: "at the ceiling, land 'new-1' (refused); replay 'new-1'; land 'fill-0' (accepted id)",
	expected: "the refused id is refused every time and mints nothing; accepted replays keep working at the ceiling",
	run: () => {
		const { coordinator, take } = makeStore();
		for (let i = 0; i < 10000; i += 1) take.landTake(makePayload("f-" + i));
		const seqBefore = coordinator.sequence();
		const results = [];
		for (let i = 0; i < 3; i += 1) {
			try {
				take.landTake(makePayload("new-1"));
				results.push("landed");
			} catch (err) {
				results.push(err.message);
			}
		}
		const replay = take.landTake(makePayload("f-0"));
		const stable = coordinator.sequence() === seqBefore && results.every((r) => r === "request-table-exhausted") && replay.requestId === "f-0";
		return { verdict: stable ? "PASS" : "DEFECT", observed: `results=${results.join(",")} replay=${replay.requestId} seq=${coordinator.sequence()}` };
	},
});

rt.record({
	id: "T-ONCE-08",
	kind: "adversarial",
	title: "a replay after undo: cached ack returned, nothing applied — the take stays undone",
	planRef: "plan §12.2 (ids retained for the store's lifetime)",
	input: "land('u1'); undo; land('u1') again",
	expected: "the store's documented lifetime retention serves the cached ack and applies nothing; the client got an ok ack while the lanes stay empty",
	run: () => {
		const { coordinator, take, env } = makeStore();
		take.landTake(makePayload("u1"));
		coordinator.undo();
		const undone = env.fields.take === null;
		const ack = take.landTake(makePayload("u1"));
		const inert = env.fields.take === null && take.depths().past === 0 && take.depths().future === 1 && coordinator.sequence() === 1;
		return {
			verdict: undone && inert && ack.value?.requestId === "u1" ? "WEAKNESS" : "DEFECT",
			observed: `undone=${undone} replayInert=${inert} ack=${ack.value?.requestId} past=${take.depths().past} future=${take.depths().future}`,
		};
	},
});

rt.record({
	id: "T-ONCE-09",
	kind: "property",
	title: "a replay after undo+redo returns the cached ack with the take present",
	planRef: "plan §12.2",
	input: "land('u2'); undo; redo; land('u2')",
	expected: "cached ack; nothing re-applied; the take remains loaded",
	run: () => {
		const { coordinator, take, env } = makeStore();
		take.landTake(makePayload("u2"));
		coordinator.undo();
		coordinator.redo();
		const loaded = env.fields.take?.requestId === "u2";
		const applies = env.calls.apply;
		const ack = take.landTake(makePayload("u2"));
		const stable = env.calls.apply === applies && take.depths().past === 1 && ack.value?.requestId === "u2";
		return { verdict: loaded && stable ? "PASS" : "DEFECT", observed: `loaded=${loaded} stable=${stable} applyCalls=${env.calls.apply}` };
	},
});

rt.record({
	id: "T-ONCE-10",
	kind: "math",
	title: "51 landings + a clear: HISTORY_LIMIT trimming keeps the undo pairing through the clear",
	planRef: "plan §7.3/§7.4",
	input: "51 landings then one clear; undo to exhaustion",
	expected: "past stays 50; the clear is the top entry; every undo pops the seq-paired present; exactly 50 undos exhaust with the clear first",
	run: () => {
		const { coordinator, take, env } = makeStore();
		for (let i = 1; i <= 51; i += 1) take.landTake(makePayload("l" + i));
		take.clear({ ...makePayload("clear"), clear: true, timeline: {} });
		const capped = take.depths().past === 50 && coordinator.sequence() === 52;
		let aligned = true;
		let undos = 0;
		while (take.canUndo()) {
			const top = take.topSeq();
			const entry = take.undo();
			undos += 1;
			if (entry === null || (top === 52 && entry.value?.clear !== true) || (top < 52 && entry.value?.requestId !== "l" + top)) aligned = false;
		}
		// 50 pops: the clear (52) then landings 51..3; the final present is the
		// state after landing l2 (the oldest entry surviving the trim)
		const exhausted = undos === 50 && take.depths().past === 0 && env.fields.take?.requestId === "l2";
		return { verdict: capped && aligned && exhausted ? "PASS" : "DEFECT", observed: `capped=${capped} aligned=${aligned} undos=${undos} seq=${coordinator.sequence()}` };
	},
});

rt.record({
	id: "T-ONCE-11",
	kind: "boundary",
	title: "clear marker edge types: clear:false is refused; a LANDING of a clear-marker payload applies the clear effect but records a landing",
	planRef: "plan §7.4 (distinct ops)",
	input: "take.clear(payload with clear:false); take.landTake(clearTakePayload(...))",
	expected: "clear with clear:false throws clear-marker-required; a landing of a clear-marker payload behaves as a landing (table record + ack) whose adapter applies the clear effect — the store cannot tell them apart by design",
	run: () => {
		const { coordinator, take, env } = makeStore();
		const marker = { ...makePayload("m1"), clear: true, timeline: {} };
		let threw = null;
		try {
			take.clear({ ...marker, clear: false });
		} catch (err) {
			threw = err.message;
		}
		const clearRefused = threw === "clear-marker-required" && take.depths().past === 0;
		take.landTake(marker); // a LANDING carrying the marker
		const landedClear = env.fields.clipA === null && take.depths().past === 1 && coordinator.sequence() === 1;
		const replay = take.landTake(marker);
		const replayInert = env.calls.apply === 1 && take.depths().past === 1;
		return {
			verdict: clearRefused && landedClear && replayInert ? "PASS" : "DEFECT",
			observed: `clearRefused=${clearRefused} landedClear=${landedClear} replayInert=${replayInert} replayAck=${replay.requestId}`,
		};
	},
});

rt.record({
	id: "T-ONCE-12",
	kind: "boundary",
	title: "requestId edge types: whitespace, '0', emoji, 1000 chars land; numbers, '', null are refused",
	planRef: "plan §5 (non-empty string)",
	input: "land with requestId ' ', '0', '🚀', 1000-char, 123, '', null",
	expected: "any non-empty string lands (including whitespace); non-strings throw request-id-missing",
	run: () => {
		const { coordinator, take, env } = makeStore();
		const results = [];
		const seqs = [];
		for (const rid of [" ", "0", "🚀", "x".repeat(1000)]) {
			try {
				const ack = take.landTake(makePayload(rid));
				results.push("landed");
				seqs.push(ack.requestId.length);
			} catch (err) {
				results.push(err.message);
			}
		}
		for (const rid of [123, "", null]) {
			try {
				take.landTake(makePayload(rid));
				results.push("landed");
			} catch (err) {
				results.push(err.message);
			}
		}
		const stringOk = results.slice(0, 4).every((r) => r === "landed") && seqs.join(",") === "1,1,2,1000";
		const refused = results.slice(4).every((r) => r === "request-id-missing");
		const minted = coordinator.sequence() === 4;
		return { verdict: stringOk && refused && minted ? "PASS" : "DEFECT", observed: `results=${results.join(",")} seq=${coordinator.sequence()}` };
	},
});

rt.record({
	id: "T-ONCE-13",
	kind: "adversarial",
	title: "a restore that throws during undo: history already stepped, fields stale, exception propagates",
	planRef: "plan §7.2 (undo restores the before snapshot)",
	input: "land a take; make restore() throw; coordinator.undo()",
	expected: "observed: the store steps its history BEFORE restore, so a throwing restore leaves the history advanced and the fields stale; the exception propagates to the undo caller — no defensive try/catch anywhere in the undo path",
	run: () => {
		const coordinator = createUndoCoordinator();
		const fields = { take: null };
		const calls = { apply: 0 };
		const take = createPerformanceTakeStore(
			{
				capture() {
					return { ...fields };
				},
				apply(value) {
					calls.apply += 1;
					fields.take = value;
				},
				restore() {
					throw new Error("restore-boom");
				},
			},
			{ coordinator },
		);
		take.landTake(makePayload("boom"));
		let threw = null;
		try {
			coordinator.undo();
		} catch (err) {
			threw = err.message;
		}
		const historyStepped = take.depths().past === 0 && take.depths().future === 1 && take.canRedo() === true;
		const fieldsStale = fields.take !== null;
		// redo still works (re-applies) — the store is not wedged
		const redone = coordinator.redo() !== null && fields.take !== null;
		return {
			verdict: threw === "restore-boom" && historyStepped && fieldsStale && redone ? "WEAKNESS" : "DEFECT",
			observed: `threw=${threw} stepped=${historyStepped} fieldsStale=${fieldsStale} redone=${redone}`,
		};
	},
});

const evidencePath = await rt.write();
const fails = rt.cases.filter((c) => c.verdict === "HARNESS-FAIL");
console.log(`\nrt-take: ${rt.cases.length} cases, ${rt.cases.filter((c) => c.verdict === "DEFECT").length} DEFECT, ${rt.cases.filter((c) => c.verdict === "WEAKNESS").length} WEAKNESS, evidence: ${evidencePath}`);
process.exit(fails.length ? 1 : 0);

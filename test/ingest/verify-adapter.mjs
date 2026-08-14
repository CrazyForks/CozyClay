/**
 * U3: the child half of the §12 protocol (plan §13 commit U3) —
 * src/ingest/adapter.js.
 *
 * Why this test exists: the parent side (src/surface-host.js) is the
 * embedder's exactly-once landing table; the child side must satisfy the
 * SAME contract from inside the frame: receive parent commands
 * ({cclay:1, v:1, id, requestId, type:"command"} + payload), apply each
 * exactly once per surface session, and ack. The plan's canonical RED is
 * "late retry after 40 intervening requests produced 2 undo entries,
 * expected 1": an LRU-32 memory evicts request #1 while 40 later requests
 * stream through, so the delayed retry is treated as new and applies a
 * second time. The session memory here is therefore session-scoped, never
 * evicted by recency, and refuses at its 10 000-record ceiling rather than
 * forget — eviction is precisely the defect.
 *
 * The adapter mirrors the parent's failure vocabulary (foreign-origin,
 * payload-not-plain-data, protocol-cclay, conflicting-reuse,
 * session-request-budget-exhausted, ...) so both sides of the boundary
 * name the same refusals, and it validates outgoing lands through the §5
 * door (contracts.js, the child mirror of the parent's door) before any
 * bytes leave the child.
 *
 * What would be circular or wrong: re-implementing the parent's dedup in
 * the test; testing with an LRU-shaped memory and calling it session-scoped;
 * or asserting "exactly once" with no 40-request eviction-pressure replay.
 */
import { createCommandAdapter } from "../../src/ingest/adapter.js";

const PARENT_ORIGIN = "http://127.0.0.1:5180";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

/* ------------------------- fake browser harness ------------------------ */

// A deterministic clock: the ack-timeout retry is driven by injected
// timers, so the never-acks case is testable without waiting.
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

function makeFakeWindow() {
	const posted = [];
	const parent = {
		postMessage(message, targetOrigin) {
			posted.push({ message, targetOrigin });
		},
	};
	const win = {
		parent,
		listeners: {},
		addEventListener(type, fn) {
			(this.listeners[type] ??= []).push(fn);
		},
		removeEventListener(type, fn) {
			this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
		},
	};
	return { win, posted, timers: makeFakeTimers() };
}

// An adapter that threw at construction (the RED run) must still fail the
// assertions with a visible reason instead of crashing the suite.
function makeAdapter(overrides = {}) {
	const harness = makeFakeWindow();
	const spies = { applies: [] };
	let adapter = null;
	let threw = null;
	try {
		adapter = createCommandAdapter({
			window: harness.win,
			parentOrigin: PARENT_ORIGIN,
			timers: harness.timers,
			onCommand(payload) {
				spies.applies.push(payload);
			},
			...overrides,
		});
	} catch (err) {
		threw = err;
	}
	if (threw !== null) {
		adapter = {
			handleMessage() {
				throw threw;
			},
			sendLand() {
				return Promise.reject(threw);
			},
		};
	}
	return { harness, spies, adapter, threw };
}

const commandData = (requestId, payload) => ({ cclay: 1, v: 1, id: "p-" + requestId, requestId, type: "command", payload });
const commandMessage = (env, data) => ({ origin: PARENT_ORIGIN, source: env.harness.win.parent, data });

function dispatch(env, event) {
	try {
		return { threw: null, code: env.adapter.handleMessage(event) ?? null };
	} catch (err) {
		return { threw: err, code: null };
	}
}
const note = (env) => (env.threw !== null ? ` [${env.threw.message}]` : "");
const ackOf = (posted, requestId) => posted.filter((p) => p.message.type === "ack" && p.message.requestId === requestId);
const landOf = (posted, requestId) => posted.filter((p) => p.message.type === "land" && p.message.requestId === requestId);
const ackData = (requestId, payload) => ({ cclay: 1, v: 1, id: "p-" + requestId, requestId, type: "ack", payload });

// A valid §5 TakePayload: both clips upright at 0°, 20 fps, equal frame
// counts, complete provenance, artifact fields as paths on the app origin.
function makeTakePayload(requestId) {
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

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// Swallow the unhandled-rejection path: a deferred that the RED run's
	// broken adapter never consumes must not crash the suite when the test
	// rejects it — consumers still observe the rejection through their own
	// handlers.
	promise.catch(() => {});
	return { promise, resolve, reject };
}

// The adapter's settle handlers run in the microtask queue, so this
// macrotask flush is the earliest ack can be observable after a settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 1. The plan's RED: late retry after 40 intervening requests lands once
// ---------------------------------------------------------------------------
// "late retry after 40 intervening requests produced 2 undo entries,
// expected 1" — an LRU-32 memory evicts request #1 under the pressure of
// 40 later requests, so the delayed retry re-applies and creates a second
// undo entry. The session-scoped memory must serve the cached ack and
// apply nothing. Each applied command is one undo entry.
const red = makeAdapter();
const firstPosted = red.harness.posted[0];
ok(
	"the adapter posts the ready handshake on construction",
	firstPosted?.message.type === "ready" && firstPosted?.message.cclay === 1 && firstPosted?.message.v === 1 && typeof firstPosted?.message.id === "string" && firstPosted?.message.requestId === undefined,
	JSON.stringify(firstPosted?.message) + note(red)
);
ok("the handshake targets the exact parent origin", red.harness.posted.every((p) => p.targetOrigin === PARENT_ORIGIN), `targets=${[...new Set(red.harness.posted.map((p) => p.targetOrigin))].join(",")}`);
ok("the adapter listens on its own window", (red.harness.win.listeners.message ?? []).length === 1, `listeners=${red.harness.win.listeners.message?.length}`);

const redCmd1 = { requestId: "req-1", command: "land-take", take: "T1" };
dispatch(red, commandMessage(red, commandData("req-1", redCmd1)));
for (let i = 2; i <= 41; i += 1) {
	dispatch(red, commandMessage(red, commandData("req-" + i, { requestId: "req-" + i, command: "op-" + i })));
}
const redRetry = dispatch(red, commandMessage(red, commandData("req-1", redCmd1)));
ok(
	"a late retry after 40 intervening requests produced exactly 1 undo entry",
	red.spies.applies.filter((p) => p.requestId === "req-1").length === 1,
	`req-1 applies=${red.spies.applies.filter((p) => p.requestId === "req-1").length}${note(red)}`
);
ok("the 40 intervening requests all applied", red.spies.applies.length === 41, `applies=${red.spies.applies.length}`);
ok("the late retry applied nothing", redRetry.threw === null && redRetry.code === null, `code=${redRetry.code ?? (redRetry.threw && redRetry.threw.message)}`);
const redAcks = ackOf(red.harness.posted, "req-1");
ok("the late retry is served the original cached ack", redAcks.length === 2 && redAcks[0].message === redAcks[1].message, `acks=${redAcks.length} same=${redAcks[0]?.message === redAcks[1]?.message}`);

// ---------------------------------------------------------------------------
// 2. Duplicates and conflicting reuse
// ---------------------------------------------------------------------------
const dup = makeAdapter();
dispatch(dup, commandMessage(dup, commandData("dup-1", { requestId: "dup-1", command: "op" })));
dispatch(dup, commandMessage(dup, commandData("dup-1", { requestId: "dup-1", command: "op" })));
const dupAcks = ackOf(dup.harness.posted, "dup-1");
ok("a duplicate send applies nothing", dup.spies.applies.filter((p) => p.requestId === "dup-1").length === 1, `applies=${dup.spies.applies.filter((p) => p.requestId === "dup-1").length}${note(dup)}`);
ok("the duplicate is served the cached ack", dupAcks.length === 2 && dupAcks[0].message === dupAcks[1].message, `same=${dupAcks[0]?.message === dupAcks[1]?.message}`);

const conflict = makeAdapter();
dispatch(conflict, commandMessage(conflict, commandData("cf-1", { requestId: "cf-1", command: "op-a" })));
const clash = dispatch(conflict, commandMessage(conflict, commandData("cf-1", { requestId: "cf-1", command: "op-b" })));
ok("a same-id different-payload retry is a conflicting reuse", clash.threw === null && clash.code === "conflicting-reuse" && conflict.spies.applies.filter((p) => p.requestId === "cf-1").length === 1, `code=${clash.code ?? (clash.threw && clash.threw.message)}${note(conflict)}`);
ok("the conflict ack names the refusal", ackOf(conflict.harness.posted, "cf-1").at(-1)?.message.payload.status === "conflicting-reuse", `status=${ackOf(conflict.harness.posted, "cf-1").at(-1)?.message.payload.status}`);
const clashAgain = dispatch(conflict, commandMessage(conflict, commandData("cf-1", { requestId: "cf-1", command: "op-a" })));
ok("a reuse after the conflict stays refused", clashAgain.code === "conflicting-reuse" && conflict.spies.applies.filter((p) => p.requestId === "cf-1").length === 1, `code=${clashAgain.code}`);

// ---------------------------------------------------------------------------
// 3. Rejection classes: deterministic refusals are cached, transient ones
//    leave the id retryable
// ---------------------------------------------------------------------------
// A malformed command is a DOOR refusal: deterministic, so it is cached
// like a success and every retry is served the same ack (§12.2). A
// throwing or rejecting onCommand is the parent's "landing rejection"
// class: transient, so the id is forgotten and a retry may succeed.
const door = makeAdapter();
const badPayload = { requestId: "cd-1" }; // no command name
const doorReject = dispatch(door, commandMessage(door, commandData("cd-1", badPayload)));
ok("a command without a name is rejected by name", doorReject.threw === null && doorReject.code === "command-invalid" && door.spies.applies.length === 0, `code=${doorReject.code ?? (doorReject.threw && doorReject.threw.message)}${note(door)}`);
const doorAck = ackOf(door.harness.posted, "cd-1")[0]?.message;
const doorRetry = dispatch(door, commandMessage(door, commandData("cd-1", badPayload)));
ok("a retry of the refused command is served the same refusal", doorRetry.code === "command-invalid" && door.spies.applies.length === 0 && ackOf(door.harness.posted, "cd-1")[1].message === doorAck, `code=${doorRetry.code} same=${ackOf(door.harness.posted, "cd-1")[1]?.message === doorAck}`);

let retryCalls = 0;
const retryable = makeAdapter({
	onCommand() {
		retryCalls += 1;
		if (retryCalls === 1) throw new Error("store-busy");
	},
});
dispatch(retryable, commandMessage(retryable, commandData("rt-1", { requestId: "rt-1", command: "op" })));
const retryFailAck = ackOf(retryable.harness.posted, "rt-1")[0]?.message;
ok("a throwing apply is reported as a typed rejection", retryFailAck?.payload.status === "rejected" && retryFailAck?.payload.code === "store-busy", JSON.stringify(retryFailAck) + note(retryable));
dispatch(retryable, commandMessage(retryable, commandData("rt-1", { requestId: "rt-1", command: "op" })));
ok("a retry after the rejection is allowed to apply and succeed", retryCalls === 2 && ackOf(retryable.harness.posted, "rt-1").at(-1)?.message.payload.status === "ok", `calls=${retryCalls} status=${ackOf(retryable.harness.posted, "rt-1").at(-1)?.message.payload.status}`);

// The promise-rejection variant of the same transient class.
const rejGate = deferred();
let rejCalls = 0;
const asyncRetry = makeAdapter({
	onCommand() {
		rejCalls += 1;
		if (rejCalls === 1) return rejGate.promise;
	},
});
dispatch(asyncRetry, commandMessage(asyncRetry, commandData("ar-1", { requestId: "ar-1", command: "op" })));
rejGate.reject(new Error("decode-failed"));
await flush();
const rejAcks = ackOf(asyncRetry.harness.posted, "ar-1");
ok("a rejected apply promise is reported as a typed failure", rejAcks.length === 1 && rejAcks[0].message.payload.status === "rejected" && rejAcks[0].message.payload.code === "decode-failed", `acks=${rejAcks.length} status=${rejAcks[0]?.message?.payload?.status}${note(asyncRetry)}`);
dispatch(asyncRetry, commandMessage(asyncRetry, commandData("ar-1", { requestId: "ar-1", command: "op" })));
await flush();
ok("a retry after the rejected promise is allowed to apply and succeed", rejCalls === 2 && ackOf(asyncRetry.harness.posted, "ar-1").at(-1)?.message.payload.status === "ok", `calls=${rejCalls}`);

// ---------------------------------------------------------------------------
// 4. Concurrent duplicates join one in-flight operation
// ---------------------------------------------------------------------------
// A duplicate arriving while the first apply is still pending joins it:
// exactly one apply and exactly one ack when the operation settles (§12.2,
// across the async window).
const joinGate = deferred();
let joinCalls = 0;
const join = makeAdapter({
	onCommand() {
		joinCalls += 1;
		return joinGate.promise;
	},
});
dispatch(join, commandMessage(join, commandData("jn-1", { requestId: "jn-1", command: "op" })));
dispatch(join, commandMessage(join, commandData("jn-1", { requestId: "jn-1", command: "op" })));
ok("a duplicate mid-flight does not apply a second time", joinCalls === 1, `calls=${joinCalls}${note(join)}`);
ok("the joined duplicate posts nothing until the apply settles", ackOf(join.harness.posted, "jn-1").length === 0, `acks=${ackOf(join.harness.posted, "jn-1").length}`);
joinGate.resolve();
await flush();
const joinAcks = ackOf(join.harness.posted, "jn-1");
ok("the joined pair settles into exactly one ok ack", joinAcks.length === 1 && joinAcks[0].message.payload.status === "ok" && joinCalls === 1, `acks=${joinAcks.length} status=${joinAcks[0]?.message.payload.status} calls=${joinCalls}`);

// ---------------------------------------------------------------------------
// 5. The envelope is validated by name, never silently ignored
// ---------------------------------------------------------------------------
const gates = makeAdapter();
const cyclic = { cclay: 1, v: 1, id: "p-cyc", type: "command", requestId: "cyc-1", payload: { requestId: "cyc-1", command: "op", self: null } };
cyclic.payload.self = cyclic;
const deep = { cclay: 1, v: 1, id: "p-deep", type: "command", requestId: "deep-1", payload: { requestId: "deep-1", command: "op" } };
let level = deep.payload;
for (let i = 0; i < 9; i += 1) level = level["k" + i] = {};
const manyNodes = { cclay: 1, v: 1, id: "p-many", type: "command", requestId: "many-1", payload: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => ["k" + i, {}])) };
const big = commandData("big-1", { requestId: "big-1", command: "op", data: "x".repeat(70000) });
const cases = [
	["a foreign origin is rejected before its data is read", { origin: "http://evil.example", source: gates.harness.win.parent, data: commandData("g-0", { requestId: "g-0", command: "op" }) }, "foreign-origin"],
	["a message from a different source object is rejected", { origin: PARENT_ORIGIN, source: { postMessage() {} }, data: commandData("g-0", { requestId: "g-0", command: "op" }) }, "foreign-source"],
	["an ArrayBuffer payload is rejected before field access", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: new ArrayBuffer(8) }, "payload-not-plain-data"],
	["a non-finite number is rejected before the envelope is read", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: { cclay: NaN, v: 1, id: "p-nan", type: "command" } }, "payload-not-plain-data"],
	["a cyclic payload is rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: cyclic }, "payload-not-plain-data"],
	["a payload past depth 8 is rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: deep }, "payload-too-deep"],
	["a payload past 2000 nodes is rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: manyNodes }, "payload-too-many-nodes"],
	["a message over the 64 KiB cap is rejected and nothing is read", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: big }, "payload-too-large"],
	["bad cclay marker rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: { cclay: 2, v: 1, id: "p-c", type: "command" } }, "protocol-cclay"],
	["bad protocol version rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: { cclay: 1, v: 2, id: "p-v", type: "command" } }, "protocol-version"],
	["a missing id is rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: { cclay: 1, v: 1, id: "", type: "command" } }, "protocol-id"],
	["a missing type is rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: { cclay: 1, v: 1, id: "p-t", type: "" } }, "protocol-type"],
	["an unknown message type is refused by name", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: { cclay: 1, v: 1, id: "p-f", type: "frobnicate" } }, "unknown-type"],
	["a command without a requestId is rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: commandData("", { requestId: "g-x", command: "op" }) }, "request-id-missing"],
	["a command with a non-object payload is rejected", { origin: PARENT_ORIGIN, source: gates.harness.win.parent, data: commandData("g-null", null) }, "payload-not-object"],
];
for (const [label, event, code] of cases) {
	const out = dispatch(gates, event);
	ok(label, out.threw === null && out.code === code, `code=${out.code ?? (out.threw && out.threw.message)}${note(gates)}`);
}
ok("the rejected messages applied nothing", gates.spies.applies.length === 0, `applies=${gates.spies.applies.length}`);

// A requestId that differs between envelope and payload is a door clause:
// the id the session caches under must never diverge from the command the
// surface applies.
const mismatch = makeAdapter();
const mismatched = dispatch(
	mismatch,
	commandMessage(mismatch, { cclay: 1, v: 1, id: "p-mm-1", requestId: "mm-1", type: "command", payload: { requestId: "mm-OTHER", command: "op" } })
);
ok("an envelope requestId differing from the payload's is rejected by name", mismatched.threw === null && mismatched.code === "request-id-mismatch" && mismatch.spies.applies.length === 0, `code=${mismatched.code ?? (mismatched.threw && mismatched.threw.message)}${note(mismatch)}`);
const mismatchAck = ackOf(mismatch.harness.posted, "mm-1")[0]?.message;
dispatch(
	mismatch,
	commandMessage(mismatch, { cclay: 1, v: 1, id: "p-mm-1", requestId: "mm-1", type: "command", payload: { requestId: "mm-OTHER", command: "op" } })
);
ok("a retry of the mismatched command is served the same refusal", ackOf(mismatch.harness.posted, "mm-1").length === 2 && ackOf(mismatch.harness.posted, "mm-1")[1].message === mismatchAck && mismatch.spies.applies.length === 0, `same=${ackOf(mismatch.harness.posted, "mm-1")[1]?.message === mismatchAck}`);

// ---------------------------------------------------------------------------
// 6. The session budget: refuses rather than evicts
// ---------------------------------------------------------------------------
const budget = makeAdapter();
for (let i = 0; i < 10000; i += 1) {
	dispatch(budget, commandMessage(budget, commandData("budget-" + i, { requestId: "budget-" + i, command: "op-" + i })));
}
ok("10 000 records fit the session budget", budget.spies.applies.length === 10000, `applies=${budget.spies.applies.length}${note(budget)}`);
const budgetAck = ackOf(budget.harness.posted, "budget-0")[0]?.message;
const exhausted = dispatch(budget, commandMessage(budget, commandData("budget-overflow", { requestId: "budget-overflow", command: "op" })));
ok("the 10 001st request is refused with session-request-budget-exhausted", exhausted.threw === null && exhausted.code === "session-request-budget-exhausted" && budget.spies.applies.length === 10000, `code=${exhausted.code ?? (exhausted.threw && exhausted.threw.message)}`);
ok("the refusal instructs a surface reload", (() => {
	const last = budget.harness.posted.at(-1)?.message;
	return last?.payload?.status === "session-request-budget-exhausted" && last?.payload?.reload === true;
})());
const budgetReplay = dispatch(budget, commandMessage(budget, commandData("budget-0", { requestId: "budget-0", command: "op-0" })));
ok("a replay at the ceiling still gets its cached ack", budgetReplay.threw === null && budgetReplay.code === null && budget.harness.posted.at(-1)?.message === budgetAck && budget.spies.applies.length === 10000, `applies=${budget.spies.applies.length} same=${budget.harness.posted.at(-1)?.message === budgetAck}`);

// ---------------------------------------------------------------------------
// 7. Outgoing lands: the §5 door before any bytes, then the ack dance
// ---------------------------------------------------------------------------
const land = makeAdapter();
const take1 = makeTakePayload("land-1");
const landPromise = land.adapter.sendLand(take1);
const landEnvelope = landOf(land.harness.posted, "land-1")[0]?.message;
ok(
	"sendLand posts a land envelope with the payload's requestId",
	landEnvelope?.type === "land" && landEnvelope?.requestId === "land-1" && landEnvelope?.payload === take1 && landEnvelope?.cclay === 1 && landEnvelope?.v === 1 && typeof landEnvelope?.id === "string",
	JSON.stringify(landEnvelope) + note(land)
);
dispatch(land, { origin: PARENT_ORIGIN, source: land.harness.win.parent, data: ackData("land-1", { status: "ok" }) });
ok("an ok ack resolves the land", (await landPromise.then(() => true, () => false)) === true, "resolved=false");

let doorThrew = null;
const landDoor = makeAdapter();
try {
	landDoor.adapter.sendLand({ requestId: "bad-land" }); // missing clips
} catch (err) {
	doorThrew = err;
}
ok("a door-invalid land is rejected before any bytes leave", doorThrew?.message === "clips-missing" && landOf(landDoor.harness.posted, "bad-land").length === 0, `threw=${doorThrew?.message} posted=${landOf(landDoor.harness.posted, "bad-land").length}${note(landDoor)}`);

const rejLand = makeAdapter();
const rejLandPromise = rejLand.adapter.sendLand(makeTakePayload("rej-land-1"));
dispatch(rejLand, { origin: PARENT_ORIGIN, source: rejLand.harness.win.parent, data: ackData("rej-land-1", { status: "rejected", code: "artifact-decode-failed" }) });
ok("a rejected ack rejects the land promise with the code", (await rejLandPromise.catch((e) => e)).message === "artifact-decode-failed", `err=${(await rejLandPromise.catch((e) => e)).message}`);

const clashLand = makeAdapter();
clashLand.adapter.sendLand(makeTakePayload("cl-land-1"));
let conflictThrew = null;
try {
	clashLand.adapter.sendLand({ ...makeTakePayload("cl-land-1"), command: "different" });
} catch (err) {
	conflictThrew = err;
}
ok("a same-requestId different-payload land is refused", conflictThrew?.message === "land-request-id-conflict" && landOf(clashLand.harness.posted, "cl-land-1").length === 1, `threw=${conflictThrew?.message} posted=${landOf(clashLand.harness.posted, "cl-land-1").length}`);

const joinLand = makeAdapter();
const joinLandA = joinLand.adapter.sendLand(makeTakePayload("join-land-1"));
const joinLandB = joinLand.adapter.sendLand(makeTakePayload("join-land-1"));
ok("a duplicate sendLand joins the in-flight land", joinLandA === joinLandB && landOf(joinLand.harness.posted, "join-land-1").length === 1, `same=${joinLandA === joinLandB} posted=${landOf(joinLand.harness.posted, "join-land-1").length}`);
dispatch(joinLand, { origin: PARENT_ORIGIN, source: joinLand.harness.win.parent, data: ackData("join-land-1", { status: "ok" }) });
ok("the joined land pair settles into one ok", (await joinLandA.then(() => true, () => false)) === true && (await joinLandB.then(() => true, () => false)) === true, "");

// §12.2: the child retries after the ack timeout, at most 3 times, same
// requestId — then gives up with a named failure.
const slow = makeAdapter();
const slowPromise = slow.adapter.sendLand(makeTakePayload("slow-1"), { timeoutMs: 1000, attempts: 3 });
slow.harness.timers.advance(1000);
ok("a timed-out land re-posts the same requestId", landOf(slow.harness.posted, "slow-1").length === 2 && landOf(slow.harness.posted, "slow-1").every((p) => p.message.requestId === "slow-1"), `posted=${landOf(slow.harness.posted, "slow-1").length}${note(slow)}`);
slow.harness.timers.advance(1000);
ok("the second timeout re-posts again", landOf(slow.harness.posted, "slow-1").length === 3, `posted=${landOf(slow.harness.posted, "slow-1").length}`);
slow.harness.timers.advance(1000);
const slowErr = await slowPromise.catch((e) => e);
ok("the land gives up after the last attempt with ack-timeout", slowErr.message === "ack-timeout" && landOf(slow.harness.posted, "slow-1").length === 3, `err=${slowErr.message} posted=${landOf(slow.harness.posted, "slow-1").length}`);

const gone = makeAdapter();
if (typeof gone.adapter.destroy === "function") gone.adapter.destroy();
ok("destroy removes the message listener", (gone.harness.win.listeners.message ?? []).length === 0, `listeners=${gone.harness.win.listeners.message?.length}`);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

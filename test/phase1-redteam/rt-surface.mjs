#!/usr/bin/env node
/**
 * Category 3 — publish door / surface host (plan §11.5, §11.6, §12; S1, S2).
 *
 * Attacks the host's message gate and the §5/§12.3 door where the green
 * suite stops: forged event.source variants, protocol-version edges, the
 * §12.3 regex boundary (URLs, dots, traversal, charset, length), rotation
 * and fps edges, frame-count edges (including an unbounded upper end),
 * provenance key deletion, envelope/payload requestId divergence, the
 * 64 KiB byte cap AT and just OVER the boundary, whitespace/long
 * requestIds, the session budget shared with REJECTED ids, a child whose
 * postMessage throws mid-ack, reload/destroy mid-flight, and envelope
 * type edges.
 *
 * Node-only against the same fake window/document/postMessage harness the
 * green suite uses; every verdict is derived from observed dispatches.
 */
import { createSurfaceHost, validateTakePayload, assertPlainData } from "../../src/surface-host.js";
import { createRecorder } from "./rt-common.mjs";

const rt = createRecorder({ suite: "rt-surface", category: "publish-door-surface-host" });

const ORIGIN = "http://127.0.0.1:5183";

/* ------------------------- fake browser harness ------------------------- */

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
		body: { appendChild(el) { el.appended = true; } },
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

const readyData = () => ({ cclay: 1, v: 1, id: "m-ready", type: "ready" });
const landData = (requestId, payload = makePayload(requestId), extra = {}) => ({ cclay: 1, v: 1, id: "m-" + requestId, requestId, type: "land", payload, ...extra });

function message(host, { origin = ORIGIN, source, data }) {
	return { origin, source: source === undefined ? host.iframe().contentWindow : source, data };
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
function ready(env) {
	const out = dispatch(env.host, message(env.host, { data: readyData() }));
	fire(env.host.iframe(), "load");
	return out;
}
const ackFor = (posted, requestId) => posted.find((p) => p.message.type === "ack" && p.message.requestId === requestId);

/* ------------------------------- cases ---------------------------------- */

rt.record({
	id: "P-DOOR-01",
	kind: "adversarial",
	title: "right origin, forged event.source: plain object, null, and another host's contentWindow are all refused",
	planRef: "plan §12.1",
	input: "three messages with origin === ORIGIN but source = {postMessage(){}} / null / a second host's iframe.contentWindow",
	expected: "foreign-source in every case; state unchanged; nothing posted; data never read",
	run: () => {
		const env = makeHost();
		const other = makeHost();
		const cases = [
			["plain object", { postMessage() {} }],
			["null", null],
			["another host's contentWindow", other.host.iframe().contentWindow],
		];
		const results = [];
		for (const [label, source] of cases) {
			const out = dispatch(env.host, message(env.host, { source, data: readyData() }));
			results.push(`${label}:${out.code ?? (out.threw && out.threw.message)}`);
		}
		const allRefused = results.every((r) => r.endsWith(":foreign-source"));
		const unchanged = env.host.state() === "loading" && env.spies.ready === 0 && env.dom.posted.length === 0;
		return { verdict: allRefused && unchanged ? "PASS" : "DEFECT", observed: results.join(" | ") };
	},
});

rt.record({
	id: "P-DOOR-02",
	kind: "boundary",
	title: "valid envelope shape with protocol-version edges: v 2, v '1', v null, cclay 2, cclay '1', missing v",
	planRef: "plan §12 (cclay v1)",
	input: "ready envelopes with each edge value",
	expected: "protocol-version / protocol-cclay by name; the surface never opens",
	run: () => {
		const env = makeHost();
		const variants = [
			[{ cclay: 1, v: 2, id: "m-1", type: "ready" }, "protocol-version"],
			[{ cclay: 1, v: "1", id: "m-2", type: "ready" }, "protocol-version"],
			[{ cclay: 1, v: null, id: "m-3", type: "ready" }, "protocol-version"],
			[{ cclay: 1, id: "m-4", type: "ready" }, "protocol-version"],
			[{ cclay: 2, v: 1, id: "m-5", type: "ready" }, "protocol-cclay"],
			[{ cclay: "1", v: 1, id: "m-6", type: "ready" }, "protocol-cclay"],
			[{ cclay: 0, v: 1, id: "m-7", type: "ready" }, "protocol-cclay"],
		];
		const results = [];
		for (const [data, code] of variants) {
			const out = dispatch(env.host, message(env.host, { data }));
			results.push(`${out.code ?? (out.threw && out.threw.message)}`);
		}
		const allNamed = results.every((r, i) => r === variants[i][1]);
		const closed = env.host.state() === "loading" && env.spies.ready === 0;
		return { verdict: allNamed && closed ? "PASS" : "DEFECT", observed: results.join(",") };
	},
});

rt.record({
	id: "P-DOOR-03",
	kind: "boundary",
	title: "§12.3 artifact-path regex boundary: URLs, dots, traversal, percent-encoding, charset, length edges",
	planRef: "plan §12.3",
	input: "artifactPath and annotationPath variants: https URL, http URL, ../, '..', %2e, '.txt', 33-char and 32-char file names, 1-char name, uppercase hex dir, 31-char hex, 32-char hex, absolute path outside /ingest/artifacts/, non-string",
	expected: "every variant except the in-regex boundaries is artifact-path-invalid; 32-char hex + 1..32-char [a-z0-9_-] name passes; uppercase hex and 31-char hex fail",
	run: () => {
		const HEX = "0123456789abcdef0123456789abcdef";
		const variants = [
			[`https://evil.example/x`, false],
			[`http://127.0.0.1:5183/ingest/artifacts/${HEX}/a`, false],
			[`/ingest/artifacts/${HEX}/../a`, false],
			[`/ingest/artifacts/${HEX}/a..`, false],
			[`/ingest/artifacts/${HEX}/a%2e%2e`, false],
			[`/ingest/artifacts/${HEX}/a.txt`, false],
			[`/ingest/artifacts/${HEX}/` + "a".repeat(33), false],
			[`/ingest/artifacts/${HEX}/` + "a".repeat(32), true],
			[`/ingest/artifacts/${HEX}/a`, true],
			[`/ingest/artifacts/${HEX}/-_.`, false],
			[`/ingest/artifacts/${HEX}/a-1_b`, true],
			[`/ingest/artifacts/${HEX.toUpperCase()}/a`, false],
			[`/ingest/artifacts/${HEX.slice(0, 31)}/a`, false],
			[`/other/artifacts/${HEX}/a`, false],
			[`/ingest/artifacts/${HEX}/a?x=1`, false],
			[`/ingest/artifacts/${HEX}/a#frag`, false],
		];
		const results = [];
		let allCorrect = true;
		for (const [path, shouldPass] of variants) {
			const payload = makePayload("p3-" + results.length);
			payload.a.artifactPath = path;
			let code = null;
			try {
				validateTakePayload(payload);
			} catch (err) {
				code = err.message;
			}
			const passed = code === null;
			const ok2 = passed === shouldPass;
			if (!ok2) allCorrect = false;
			results.push(`${passed ? "accept" : "reject"}(${path.slice(0, 46)})`);
		}
		// annotationPath is checked by the same regex; probe one traversal there
		const payload = makePayload("p3-ann");
		payload.b.provenance.annotationPath = `/ingest/artifacts/${HEX}/../ann`;
		let annCode = null;
		try {
			validateTakePayload(payload);
		} catch (err) {
			annCode = err.message;
		}
		const annOk = annCode === "artifact-path-invalid";
		// non-string artifactPath
		const payload2 = makePayload("p3-num");
		payload2.a.artifactPath = 42;
		let numCode = null;
		try {
			validateTakePayload(payload2);
		} catch (err) {
			numCode = err.message;
		}
		const numOk = numCode === "artifact-path-invalid";
		return {
			verdict: allCorrect && annOk && numOk ? "PASS" : "DEFECT",
			observed: `paths=${results.join(" | ")} annTraversal=${annOk} nonString=${numOk}`,
		};
	},
});

rt.record({
	id: "P-DOOR-04",
	kind: "boundary",
	title: "rotationDeg and fps edges: both-zero required; -0 and 20.0 pass, any nonzero or non-number fails",
	planRef: "plan §5",
	input: "a.rotationDeg 5 / both 5 / -0 / '0'; a.fps 24 / both 24 / 20.0 / '20'",
	expected: "rotation-deg-mismatch for any nonzero value, fps-not-20 for any non-20 value; -0 and 20.0 are === 0 / === 20 so they pass",
	run: () => {
		const variants = [
			[{ a: { rotationDeg: 5 } }, "rotation-deg-mismatch"],
			[{ a: { rotationDeg: 0 }, b: { rotationDeg: 5 } }, "rotation-deg-mismatch"],
			[{ a: { rotationDeg: 0.5 } }, "rotation-deg-mismatch"],
			[{ a: { rotationDeg: "0" } }, "rotation-deg-mismatch"],
			[{ a: { fps: 24 } }, "fps-not-20"],
			[{ a: { fps: 20 }, b: { fps: 24 } }, "fps-not-20"],
			[{ a: { fps: 0 } }, "fps-not-20"],
			[{ a: { fps: "20" } }, "fps-not-20"],
		];
		const results = [];
		let allNamed = true;
		for (const [mut, code] of variants) {
			const payload = makePayload("p4-" + results.length);
			for (const [k, v] of Object.entries(mut.a ?? {})) payload.a[k] = v;
			if (mut.b) {
				for (const [k, v] of Object.entries(mut.b)) payload.b[k] = v;
			}
			let got = null;
			try {
				validateTakePayload(payload);
			} catch (err) {
				got = err.message;
			}
			if (got !== code) allNamed = false;
			results.push(`${got ?? "accept"}`);
		}
		// boundary passes
		const p1 = makePayload("p4-negzero");
		p1.a.rotationDeg = -0;
		const negZeroPass = validateTakePayload(p1) === p1;
		const p2 = makePayload("p4-fpsfloat");
		p2.a.fps = 20.0;
		p2.b.fps = 20.0;
		const fpsFloatPass = validateTakePayload(p2) === p2;
		return {
			verdict: allNamed && negZeroPass && fpsFloatPass ? "PASS" : "DEFECT",
			observed: `rejects=${results.join(",")} negZero=${negZeroPass} fps20.0=${fpsFloatPass}`,
		};
	},
});

rt.record({
	id: "P-DOOR-05",
	kind: "boundary",
	title: "frame-count edges: unequal counts, non-integers, and the unbounded upper end (2^53-1 passes)",
	planRef: "plan §5",
	input: "a 60/b 61; a 60.0/b 60; a NaN; a 2^53-1 / b 2^53-1; a 1 / b 1",
	expected: "frame-count-mismatch for unequal or non-integer; equal positive integers pass with NO upper bound — 2^53-1 passes the door (boundary observation: the door never sees the decoded clip, so a payload claiming 2^53-1 frames lands if the artifacts decode)",
	run: () => {
		const variants = [
			[{ a: { frames: 60 }, b: { frames: 61 } }, "frame-count-mismatch"],
			[{ a: { frames: 1.5 } }, "frame-count-mismatch"],
			[{ a: { frames: NaN } }, "frame-count-mismatch"],
			[{ a: { frames: 0 } }, "frame-count-mismatch"],
			[{ a: { frames: -3 } }, "frame-count-mismatch"],
		];
		const results = [];
		let allNamed = true;
		for (const [mut, code] of variants) {
			const payload = makePayload("p5-" + results.length);
			if (mut.a) {
				for (const [k, v] of Object.entries(mut.a)) payload.a[k] = v;
			}
			if (mut.b) {
				for (const [k, v] of Object.entries(mut.b)) payload.b[k] = v;
			}
			let got = null;
			try {
				validateTakePayload(payload);
			} catch (err) {
				got = err.message;
			}
			if (got !== code) allNamed = false;
			results.push(got ?? "accept");
		}
		const big = makePayload("p5-big");
		big.a.frames = Number.MAX_SAFE_INTEGER;
		big.b.frames = Number.MAX_SAFE_INTEGER;
		const bigPass = validateTakePayload(big) === big;
		const one = makePayload("p5-one");
		one.a.frames = 1;
		one.b.frames = 1;
		const onePass = validateTakePayload(one) === one;
		return {
			verdict: allNamed && bigPass && onePass ? "WEAKNESS" : "DEFECT",
			observed: `rejects=${results.join(",")} maxSafe=${bigPass} frames1=${onePass}`,
		};
	},
});

rt.record({
	id: "P-DOOR-06",
	kind: "property",
	title: "each of the nine provenance keys deleted individually is provenance-incomplete; extras tolerated",
	planRef: "plan §5/§10.2",
	input: "delete each of the 9 keys one at a time; add an unknown key",
	expected: "provenance-incomplete for every deletion; the unknown key passes",
	run: () => {
		const KEYS = ["command", "sourceUrl", "licence", "sourceSha256", "trimStartS", "trimEndS", "gvhmrCommit", "weightsSha256", "annotationPath"];
		const results = [];
		let allNamed = true;
		for (const key of KEYS) {
			const payload = makePayload("p6-" + key);
			delete payload.a.provenance[key];
			let got = null;
			try {
				validateTakePayload(payload);
			} catch (err) {
				got = err.message;
			}
			if (got !== "provenance-incomplete") allNamed = false;
			results.push(`${key}:${got ?? "accept"}`);
		}
		const extra = makePayload("p6-extra");
		extra.b.provenance.operatorNote = "anything";
		const extraPass = validateTakePayload(extra) === extra;
		const empty = makePayload("p6-empty");
		empty.a.provenance = {};
		let emptyCode = null;
		try {
			validateTakePayload(empty);
		} catch (err) {
			emptyCode = err.message;
		}
		return {
			verdict: allNamed && extraPass && emptyCode === "provenance-incomplete" ? "PASS" : "DEFECT",
			observed: `${results.join(" | ")} extra=${extraPass} empty=${emptyCode}`,
		};
	},
});

rt.record({
	id: "P-DOOR-07",
	kind: "adversarial",
	title: "envelope requestId diverging from the payload's is refused before any read of the payload",
	planRef: "plan §12.2",
	input: "data.requestId 'env-1' with payload.requestId 'payload-1'; then the matching pair; then a whitespace requestId ' ' in both",
	expected: "request-id-mismatch named; the matching pair lands; whitespace ' ' is a non-empty string so it lands (boundary)",
	run: () => {
		const env = makeHost();
		ready(env);
		const diverge = dispatch(env.host, message(env.host, { data: landData("env-1", makePayload("payload-1")) }));
		const ack1 = ackFor(env.dom.posted, "env-1");
		const named = diverge.code === "request-id-mismatch" && ack1?.message.payload.status === "rejected" && ack1?.message.payload.code === "request-id-mismatch";
		const match = dispatch(env.host, message(env.host, { data: landData("same-1", makePayload("same-1")) }));
		const matched = match.code === null && env.spies.land.length === 1;
		const ws = dispatch(env.host, message(env.host, { data: landData(" ", makePayload(" ")) }));
		const whitespace = ws.code === null && env.spies.land.length === 2;
		return {
			verdict: named && matched && whitespace ? "PASS" : "DEFECT",
			observed: `diverge=${diverge.code} status=${ack1?.message.payload.status} matched=${matched} whitespace=${ws.code} land=${env.spies.land.length}`,
		};
	},
});

rt.record({
	id: "P-DOOR-08",
	kind: "math",
	title: "the 64 KiB cap at the boundary: an exactly-65536-byte message lands, 65537 is payload-too-large",
	planRef: "plan §12.1",
	input: "binary-search a provenance.sourceUrl padding so the full envelope JSON is exactly 65536 bytes; then 65537",
	expected: "the at-cap message is not '> MAX_MESSAGE_BYTES' so it lands; one byte over is refused and nothing is read",
	run: () => {
		const env = makeHost();
		ready(env);
		const build = (pad) => {
			const payload = makePayload("cap-" + pad);
			payload.a.provenance.sourceUrl = "x".repeat(pad);
			return landData("cap-" + pad, payload);
		};
		// binary search the pad for exactly 65536 bytes of the whole envelope
		let lo = 0;
		let hi = 65536;
		while (lo < hi) {
			const mid = Math.floor((lo + hi) / 2);
			const size = new TextEncoder().encode(JSON.stringify(build(mid))).byteLength;
			if (size < 65536) lo = mid + 1;
			else hi = mid;
		}
		const atCap = build(lo);
		const atCapSize = new TextEncoder().encode(JSON.stringify(atCap)).byteLength;
		const atOut = dispatch(env.host, message(env.host, { data: atCap }));
		const atOk = atCapSize === 65536 && atOut.code === null && env.spies.land.length === 1;
		const over = build(lo + 1);
		const overSize = new TextEncoder().encode(JSON.stringify(over)).byteLength;
		const overOut = dispatch(env.host, message(env.host, { data: over }));
		const overOk = overSize === 65537 && overOut.code === "payload-too-large" && env.spies.land.length === 1;
		return {
			verdict: atOk && overOk ? "PASS" : "DEFECT",
			observed: `atCap=${atCapSize} -> ${atOut.code ?? "land"} ; over=${overSize} -> ${overOut.code}`,
		};
	},
});

rt.record({
	id: "P-DOOR-09",
	kind: "boundary",
	title: "requestId length and shape at the host: 5000-char ids land (bounded only by the message cap)",
	planRef: "plan §12.2",
	input: "a landing whose requestId is 5000 chars; a landing with requestId 0 (number)",
	expected: "the 5000-char id lands (the 64 KiB cap is the only bound); the numeric id is request-id-missing before the payload is read",
	run: () => {
		const env = makeHost();
		ready(env);
		const long = "r".repeat(5000);
		const longOut = dispatch(env.host, message(env.host, { data: landData(long, makePayload(long)) }));
		const longOk = longOut.code === null && env.spies.land.length === 1;
		const numOut = dispatch(env.host, message(env.host, { data: { cclay: 1, v: 1, id: "m-n", requestId: 0, type: "land", payload: makePayload("n") } }));
		const numOk = numOut.code === "request-id-missing" && env.spies.land.length === 1;
		return { verdict: longOk && numOk ? "PASS" : "DEFECT", observed: `long=${longOk} numeric=${numOut.code} land=${env.spies.land.length}` };
	},
});

rt.record({
	id: "P-DOOR-10",
	kind: "adversarial",
	title: "the session budget is shared with REJECTED ids: 10 000 rejected landings starve legitimate landings",
	planRef: "plan §12.2 (refuse rather than forget)",
	input: "dispatch 10 000 landings whose payloads fail validation (fps 24), then one valid landing",
	expected: "observed: rejected landings ARE recorded in the session table (their refusal is cached), so at the ceiling a valid NEW id is refused with session-request-budget-exhausted — a buggy or hostile child can exhaust the session with garbage",
	run: () => {
		const env = makeHost();
		ready(env);
		for (let i = 0; i < 10000; i += 1) {
			const payload = makePayload("junk-" + i);
			payload.a.fps = 24;
			dispatch(env.host, message(env.host, { data: landData("junk-" + i, payload) }));
		}
		const valid = dispatch(env.host, message(env.host, { data: landData("legit-1") }));
		const starved = valid.code === "session-request-budget-exhausted" && env.spies.land.length === 0;
		// the replay of a rejected id is still served its cached refusal
		const junkPayload = makePayload("junk-0");
		junkPayload.a.fps = 24;
		const replay = dispatch(env.host, message(env.host, { data: landData("junk-0", junkPayload) }));
		const replayServed = replay.code === "fps-not-20" && env.spies.land.length === 0;
		return {
			verdict: starved && replayServed ? "WEAKNESS" : "DEFECT",
			observed: `valid landing -> ${valid.code} (land=${env.spies.land.length}); rejected replay -> ${replay.code}`,
		};
	},
});

rt.record({
	id: "P-DOOR-11",
	kind: "adversarial",
	title: "a child whose postMessage throws mid-ack: the landing already applied, the ack is lost, the retry throws but never double-applies",
	planRef: "plan §12.2 (exactly-once)",
	input: "make contentWindow.postMessage throw after onLand; land once, retry once",
	expected: "observed: onLand ran and the session record exists before the ack post, so the throw propagates out of handleMessage (the ack is lost), and the retry — served from the cache — throws again without re-applying; exactly-once holds, ack delivery is the casualty",
	run: () => {
		const dom = makeFakeDom();
		const spies = { land: 0 };
		const host = createSurfaceHost({
			window: dom.window,
			document: dom.document,
			surfaceOrigin: ORIGIN,
			surfaceUrl: ORIGIN + "/",
			timers: dom.timers,
			onLand() {
				spies.land += 1;
			},
		});
		dom.iframes[0].contentWindow.postMessage = () => {
			throw new Error("post-boom");
		};
		const first = dispatch(host, message(host, { data: readyData() }));
		const firstLand = dispatch(host, message(host, { data: landData("pb-1") }));
		const retry = dispatch(host, message(host, { data: landData("pb-1") }));
		const landedOnce = spies.land === 1;
		const throws = first.threw === null && firstLand.threw?.message === "post-boom" && retry.threw?.message === "post-boom";
		const neverDouble = spies.land === 1;
		host.destroy();
		return {
			verdict: landedOnce && throws && neverDouble ? "WEAKNESS" : "DEFECT",
			observed: `ready=${first.threw?.message ?? "ok"} first=${firstLand.threw?.message ?? "ok"} retry=${retry.threw?.message ?? "ok"} land=${spies.land}`,
		};
	},
});

rt.record({
	id: "P-DOOR-12",
	kind: "adversarial",
	title: "reload mid-flight and destroy: the old session dies with the frame; the listener is removed",
	planRef: "plan §12.2, §11.6",
	input: "ready; land ok; fire the iframe load (reload) and re-land the old id; then destroy and dispatch",
	expected: "a reload clears the session so the old id lands again once; after destroy the listener is gone and a dispatch reaches nobody",
	run: () => {
		const env = makeHost();
		ready(env);
		dispatch(env.host, message(env.host, { data: landData("rl-1") }));
		fire(env.host.iframe(), "load"); // reload: new session
		dispatch(env.host, message(env.host, { data: readyData() }));
		dispatch(env.host, message(env.host, { data: landData("rl-1") }));
		const reloaded = env.spies.land.length === 2;
		env.host.destroy();
		const removed = (env.dom.window.listeners.message ?? []).length === 0 && env.host.iframe() === null;
		// after destroy the iframe is null; dispatch with an explicit forged source
		const zombie = dispatch(env.host, { origin: ORIGIN, source: { postMessage() {} }, data: landData("rl-1") });
		const zombieSafe = zombie.code === "foreign-source";
		return {
			verdict: reloaded && removed && zombieSafe ? "PASS" : "DEFECT",
			observed: `land=${env.spies.land.length} listeners=${env.dom.window.listeners.message?.length} zombie=${zombie.code}`,
		};
	},
});

rt.record({
	id: "P-DOOR-13",
	kind: "boundary",
	title: "envelope type edges: unknown type refused by name; a ready after unavailable is inert; a duplicate ready is a no-op",
	planRef: "plan §12",
	input: "type 'pong' on a ready host; a second ready; a ready delivered to an unavailable host",
	expected: "unknown-type; duplicate ready no-op; a late ready after fail(timeout) is ignored without throwing",
	run: () => {
		const env = makeHost();
		ready(env);
		const unknown = dispatch(env.host, message(env.host, { data: { cclay: 1, v: 1, id: "m-u", type: "pong" } }));
		const dup = dispatch(env.host, message(env.host, { data: readyData() }));
		const unknownOk = unknown.code === "unknown-type" && env.spies.ready === 1;
		const dupOk = dup.code === null && env.spies.ready === 1;
		const dead = makeHost();
		dead.dom.timers.advance(8000);
		const late = dispatch(dead.host, { origin: ORIGIN, source: dead.dom.iframes[0].contentWindow, data: readyData() });
		const lateOk = late.code === "foreign-source" && dead.host.state() === "unavailable";
		return { verdict: unknownOk && dupOk && lateOk ? "PASS" : "DEFECT", observed: `unknown=${unknown.code} dup=${dup.code} late=${late.code} state=${dead.host.state()}` };
	},
});

rt.record({
	id: "P-DOOR-14",
	kind: "property",
	title: "assertPlainData boundaries: -0, 1e308, bigint, Date, RegExp, sparse arrays, undefined values, arrays as roots",
	planRef: "plan §12.1",
	input: "each hostile value as the message payload",
	expected: "numbers that are finite (including -0 and 1e308) pass; non-plain objects (Date, RegExp, Map) and undefined values are rejected by name; a sparse array's holes are undefined values by any other name — but Object.keys skips holes, so the gate accepts them and JSON.stringify silently coerces them to null (a claim mismatch: 'undefined values are rejected')",
	run: () => {
		const cases = [
			["-0", -0, true],
			["1e308", 1e308, true],
			["1e309 (inf)", 1e309, false],
			["NaN", NaN, false],
			["Infinity", Infinity, false],
			["bigint", 10n, false],
			["Date", new Date(), false],
			["RegExp", /x/, false],
			["Map", new Map(), false],
			["undefined value", { k: undefined }, false],
			["array root", [1, 2], true],
		];
		const results = [];
		let allOk = true;
		for (const [label, value, shouldPass] of cases) {
			let passed = true;
			try {
				assertPlainData(value);
			} catch {
				passed = false;
			}
			if (passed !== shouldPass) allOk = false;
			results.push(`${label}:${passed ? "pass" : "reject"}`);
		}
		const sparse = new Array(3);
		let sparsePassed = true;
		try {
			assertPlainData(sparse);
		} catch {
			sparsePassed = false;
		}
		const sparseJson = JSON.stringify(sparse);
		results.push(`sparse:${sparsePassed ? "pass (coerced to " + sparseJson + ")" : "reject"}`);
		// the gate accepts sparse holes (they never reach the undefined check);
		// JSON.stringify normalizes them to null. Claim mismatch -> WEAKNESS.
		return { verdict: allOk && sparsePassed ? "WEAKNESS" : "DEFECT", observed: results.join(" | ") };
	},
});

rt.record({
	id: "P-DOOR-15",
	kind: "property",
	title: "a valid §5 payload crosses the host door exactly once and the ack echoes the envelope id",
	planRef: "plan §12.2",
	input: "one valid land on a ready host; inspect the ack",
	expected: "onLand once; ack type/requestId/id echo the envelope; target origin exact; nothing else posted",
	run: () => {
		const env = makeHost();
		ready(env);
		const out = dispatch(env.host, message(env.host, { data: landData("good-1") }));
		const ack = ackFor(env.dom.posted, "good-1");
		const ok2 =
			out.code === null && env.spies.land.length === 1 && env.spies.land[0].requestId === "good-1" &&
			ack?.message.type === "ack" && ack.message.requestId === "good-1" && ack.message.id === "m-good-1" &&
			ack.message.payload.status === "ok" && env.dom.posted.every((p) => p.targetOrigin === ORIGIN);
		return { verdict: ok2 ? "PASS" : "DEFECT", observed: `code=${out.code} land=${env.spies.land.length} ack=${ack?.message.id} target=${[...new Set(env.dom.posted.map((p) => p.targetOrigin))].join(",")}` };
	},
});

const evidencePath = await rt.write();
const fails = rt.cases.filter((c) => c.verdict === "HARNESS-FAIL");
console.log(`\nrt-surface: ${rt.cases.length} cases, ${rt.cases.filter((c) => c.verdict === "DEFECT").length} DEFECT, ${rt.cases.filter((c) => c.verdict === "WEAKNESS").length} WEAKNESS, evidence: ${evidencePath}`);
process.exit(fails.length ? 1 : 0);

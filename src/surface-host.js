// surface-host.js - the parent-side embedder of the ingest surface.
//
// The surface is a separate Vite entry on its own loopback origin, framed
// cross-origin under a restrictive sandbox (plan §11.5). This module owns
// the versioned postMessage boundary (§12): a message is rejected unless
// it comes from the exact origin AND the exact contentWindow AND speaks
// cclay v1, and a command lands at most once per surface session (§12.2) -
// the session table refuses at its ceiling rather than evict, because
// eviction is exactly what lets a delayed retry land twice. Landing
// success is acknowledged only after the app's async landing callback
// fulfils - a rejection is reported and leaves the id retryable, and a
// retry that arrives while a landing is still applying joins it. The child
// cannot render its own failure, so the host also owns the load timeout,
// the ready handshake and the parent-rendered unavailable panel with
// retry (§11.6). No React, no imports: node-importable against a fake
// window/postMessage harness (the browser suite is U4 in Phase 4).

const PROTOCOL_CClay = 1;
const PROTOCOL_V = 1;
const MAX_MESSAGE_BYTES = 64 * 1024; // §12.1: over cap => payload-too-large, nothing read
const SESSION_BUDGET = 10000; // §12.2: refuse rather than forget
// §12.3: artifact fields are paths on the app's own origin, never URLs
const ARTIFACT_PATH = /^\/ingest\/artifacts\/[0-9a-f]{32}\/[a-z0-9_-]{1,32}$/;
// §5/§10.2: the provenance block a complete take must carry. Mirrors
// src/performance-take.js; both derive from the same closed contract.
const PROVENANCE_KEYS = ["command", "sourceUrl", "licence", "sourceSha256", "trimStartS", "trimEndS", "gvhmrCommit", "weightsSha256", "annotationPath"];

// §12.1: JSON-representable plain data only, asserted before ANY field is
// read - structured clone is not JSON. Depth and node budgets bound the
// walk; cycles, undefined values and non-finite numbers are rejected like
// every other non-plain value.
export function assertPlainData(value, { maxDepth = 8, maxNodes = 2000 } = {}) {
	let nodes = 0;
	const ancestors = new Set();
	const walk = (v, depth) => {
		if (v === null || typeof v === "boolean" || typeof v === "string") return;
		if (typeof v === "number") {
			if (!Number.isFinite(v)) throw new Error("payload-not-plain-data");
			return;
		}
		const plain = Array.isArray(v) || (typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
		if (!plain || ancestors.has(v)) throw new Error("payload-not-plain-data");
		nodes += 1;
		if (nodes > maxNodes) throw new Error("payload-too-many-nodes");
		if (depth > maxDepth) throw new Error("payload-too-deep");
		ancestors.add(v);
		for (const key of Object.keys(v)) {
			if (v[key] === undefined) throw new Error("payload-not-plain-data");
			walk(v[key], depth + 1);
		}
		ancestors.delete(v);
	};
	walk(value, 0);
}

// The §5 publish door: each clause is a named rejection, nothing is read
// past the failing clause, and a valid payload returns unchanged.
// envelopeRequestId, when given, must equal payload.requestId so the id
// the session table caches under can never diverge from the take the app
// lands.
export function validateTakePayload(payload, envelopeRequestId) {
	if (payload === null || typeof payload !== "object") throw new Error("payload-not-object");
	if (typeof payload.requestId !== "string" || payload.requestId.length === 0) throw new Error("request-id-missing");
	if (envelopeRequestId !== undefined && payload.requestId !== envelopeRequestId) throw new Error("request-id-mismatch");
	const a = payload.a;
	const b = payload.b;
	if (a === null || typeof a !== "object" || b === null || typeof b !== "object") throw new Error("clips-missing");
	if (a.rotationDeg !== 0 || b.rotationDeg !== 0) throw new Error("rotation-deg-mismatch");
	if (a.fps !== 20 || b.fps !== 20) throw new Error("fps-not-20");
	if (!Number.isInteger(a.frames) || a.frames <= 0 || a.frames !== b.frames) throw new Error("frame-count-mismatch");
	for (const clip of [a, b]) {
		if (clip.provenance === null || typeof clip.provenance !== "object") throw new Error("provenance-incomplete");
		for (const key of PROVENANCE_KEYS) {
			if (clip.provenance[key] === undefined) throw new Error("provenance-incomplete");
		}
		if (typeof clip.artifactPath !== "string" || !ARTIFACT_PATH.test(clip.artifactPath)) throw new Error("artifact-path-invalid");
		if (typeof clip.provenance.annotationPath !== "string" || !ARTIFACT_PATH.test(clip.provenance.annotationPath)) throw new Error("artifact-path-invalid");
	}
	return payload;
}

export function createSurfaceHost({
	window: win,
	document: doc,
	surfaceOrigin,
	surfaceUrl,
	timeoutMs = 8000, // §11.6: the handshake must arrive inside this window
	timers = { setTimeout, clearTimeout },
	onReady = () => {},
	onUnavailable = () => {},
	onLand = () => {},
}) {
	let state = "loading"; // loading | ready | unavailable
	let session = new Map(); // requestId -> { hash, status, ack }, per surface session
	let iframe = null;
	// The injected timers keep the 8 s window deterministic in tests, but
	// the browser's global setTimeout is receiver-sensitive: called as an
	// object method it throws "Illegal invocation" (measured on the QA
	// browser, S4 in verify-surface-host.mjs). Destructure and call bare —
	// never as methods — so the default timers work in Chrome while the
	// fake timers keep working in node.
	let loadCount = 0;
	let readySeen = false;
	let timerId = null;
	const { setTimeout: schedule, clearTimeout: cancel } = timers;

	const clearTimer = () => {
		if (timerId !== null) cancel(timerId);
		timerId = null;
	};
	const startTimer = () => {
		clearTimer();
		timerId = schedule(() => fail("timeout"), timeoutMs);
	};
	const post = (ack) => iframe.contentWindow.postMessage(ack, surfaceOrigin);
	const makeAck = (request, payload) => ({ cclay: PROTOCOL_CClay, v: PROTOCOL_V, id: request.id, requestId: request.requestId, type: "ack", payload });

	function fail(reason) {
		if (state === "unavailable") return;
		clearTimer();
		session.clear(); // the unmount ends the session (§12.2)
		state = "unavailable";
		if (iframe !== null) {
			iframe.remove(); // unmounted when hidden (§11.5)
			iframe = null;
		}
		onUnavailable(reason);
	}

	function createIframe() {
		const el = doc.createElement("iframe");
		// §11.5: the restrictive token set; everything else - top-navigation,
		// popups, downloads, modals, pointer lock, presentation, orientation
		// lock - stays denied. allow="" empties the Permissions Policy; it is
		// NOT sandboxing.
		el.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
		el.setAttribute("allow", "");
		el.setAttribute("referrerpolicy", "no-referrer");
		// NOT loading="lazy": Chrome never loads a display:none iframe with
		// loading=lazy, so the hidden-until-ready handshake could never
		// complete and every real composition would time out into the
		// unavailable panel. Proven on the QA browser (S4 in
		// verify-surface-host.mjs); the resource claim lives in the
		// unmount-on-hide below instead.
		el.hidden = true; // revealed only after the ready handshake (§11.6)
		el.addEventListener("load", onLoad);
		el.addEventListener("error", () => fail("load-error"));
		el.src = surfaceUrl;
		doc.body.appendChild(el);
		return el;
	}

	function onLoad() {
		loadCount += 1;
		if (loadCount > 1) {
			// A reload begins a new session: the child mints fresh ids on
			// reload, so the old records must not survive (§12.2).
			session.clear();
			readySeen = false;
			state = "loading";
			iframe.hidden = true;
			startTimer();
			return;
		}
		// Initial load without the handshake yet: the child posts ready
		// from its script, which runs BEFORE the document finishes loading,
		// but the parent can process the iframe's load event a task (or an
		// IPC hop) ahead of the queued message — measured on the QA browser,
		// S4 in verify-surface-host.mjs. Deferring the verdict a short
		// window keeps the fail-fast for a genuinely silent child while a
		// healthy one gets its handshake processed; the load timer remains
		// the backstop either way.
		if (!readySeen) {
			schedule(() => {
				if (!readySeen && state === "loading" && timerId !== null) fail("no-handshake");
			}, 100);
		}
	}

	// FNV-1a 32-bit over the JSON text. Retries resend the identical
	// serialization, so byte-equal payloads hash equal - nothing stronger is
	// claimed, because the child is our own origin-validated surface.
	// JSON.stringify is total here: the plain-data gate ran before any field
	// was read, so undefined is the only non-serializable input left.
	function hashOf(value) {
		const text = JSON.stringify(value);
		if (text === undefined) return "undefined";
		let hash = 0x811c9dc5;
		for (let i = 0; i < text.length; i += 1) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(16);
	}

	function handleLand(data) {
		if (state !== "ready") return "not-ready";
		if (typeof data.requestId !== "string" || data.requestId.length === 0) return "request-id-missing";
		const record = session.get(data.requestId);
		const hash = hashOf(data.payload);
		if (record !== undefined) {
			if (record.hash === hash) {
				if (record.status === "in-flight") {
					// The first landing is still applying: the retry joins
					// it - the single settle handler below posts one ack
					// when the landing completes, so exactly-once holds
					// across the async window, not merely after it (§12.2).
					return undefined;
				}
				// A retry of the identical command: return the cached ack,
				// apply nothing (§12.2).
				post(record.ack);
				return record.status === "ok" ? undefined : (record.ack.payload.code ?? record.status);
			}
			if (record.status === "in-flight") {
				// Different bytes for an id whose landing is still
				// applying: refuse the clash, apply nothing, and leave the
				// in-flight record untouched so its settle still owns the
				// slot (§12.2).
				const ack = makeAck(data, { status: "conflicting-reuse" });
				post(ack);
				return "conflicting-reuse";
			}
			// The id was already consumed with different bytes: refuse,
			// apply nothing (§12.2).
			record.status = "conflicting-reuse";
			record.ack = makeAck(data, { status: "conflicting-reuse" });
			post(record.ack);
			return "conflicting-reuse";
		}
		if (session.size >= SESSION_BUDGET) {
			// Refuse rather than forget: eviction is exactly the defect the
			// session table exists to avoid (§12.2).
			const ack = makeAck(data, { status: "session-request-budget-exhausted", reload: true });
			post(ack);
			return "session-request-budget-exhausted";
		}
		// The §5 door is deterministic: the same bytes fail the same clause
		// every time, so a door refusal is cached like a success and every
		// retry is served the same ack (§12.2).
		try {
			validateTakePayload(data.payload, data.requestId);
		} catch (err) {
			const ack = makeAck(data, { status: "rejected", code: err.message });
			session.set(data.requestId, { hash, status: "rejected", ack });
			post(ack);
			return err.message;
		}
		// The App's landing callback is async (it decodes both npz
		// artifacts before the store accepts the take), so success is
		// posted and cached only once the landing promise fulfils. A
		// rejection - a decode failure, a store refusal - is transient,
		// unlike a door clause, so it is reported to the child and the id
		// is forgotten, leaving a retry free to land (§12.2).
		const failureCode = (err) => (err instanceof Error ? err.message : String(err ?? "landing-rejected"));
		let outcome;
		try {
			outcome = onLand(data.payload);
		} catch (err) {
			// A synchronous throw from the callback is the same transient
			// class as a promise rejection.
			post(makeAck(data, { status: "rejected", code: failureCode(err) }));
			return failureCode(err);
		}
		if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") {
			const pending = { hash, status: "in-flight", ack: null };
			session.set(data.requestId, pending);
			outcome.then(
				() => {
					// The session may have ended (unmount, reload) while
					// the landing was applying: nothing is acked and the
					// record must not resurrect into the new session.
					if (session.get(data.requestId) !== pending) return;
					pending.status = "ok";
					pending.ack = makeAck(data, { status: "ok" });
					post(pending.ack);
				},
				(err) => {
					if (session.get(data.requestId) !== pending) return;
					session.delete(data.requestId); // leave the id retryable
					post(makeAck(data, { status: "rejected", code: failureCode(err) }));
				},
			);
			return undefined;
		}
		// A synchronous callback fulfilled: the same contract, settled now.
		const ack = makeAck(data, { status: "ok" });
		session.set(data.requestId, { hash, status: "ok", ack });
		post(ack);
		return undefined;
	}

	function handleMessage(event) {
		// §12.1: the event checks come first - a message from a foreign
		// origin or a different source object is rejected, not merely
		// ignored, and its data is never read.
		if (event.origin !== surfaceOrigin) return "foreign-origin";
		if (iframe === null || event.source !== iframe.contentWindow) return "foreign-source";
		const data = event.data;
		try {
			assertPlainData(data);
		} catch (err) {
			return err.message;
		}
		if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_MESSAGE_BYTES) return "payload-too-large";
		if (data.cclay !== PROTOCOL_CClay) return "protocol-cclay";
		if (data.v !== PROTOCOL_V) return "protocol-version";
		if (typeof data.id !== "string" || data.id.length === 0) return "protocol-id";
		if (typeof data.type !== "string" || data.type.length === 0) return "protocol-type";
		if (data.type === "ready") {
			if (state !== "loading") return undefined;
			readySeen = true;
			state = "ready";
			clearTimer();
			iframe.hidden = false;
			onReady();
			return undefined;
		}
		if (data.type === "land") return handleLand(data);
		return "unknown-type";
	}

	function retry() {
		if (state !== "unavailable") return;
		// A fresh mount is a fresh session: the old records died with the
		// old frame, and the new child mints new ids (§12.2).
		session.clear();
		loadCount = 0;
		readySeen = false;
		state = "loading";
		iframe = createIframe();
		startTimer();
	}

	function destroy() {
		clearTimer();
		session.clear();
		if (win.removeEventListener) win.removeEventListener("message", handleMessage);
		if (iframe !== null) {
			iframe.remove();
			iframe = null;
		}
	}

	iframe = createIframe();
	startTimer();
	win.addEventListener("message", handleMessage);

	return { state: () => state, iframe: () => iframe, handleMessage, retry, destroy };
}

// adapter.js - U3: the child half of the §12 protocol (plan §12, §13 U3).
//
// The parent side (src/surface-host.js) owns the embedder boundary; this
// module owns the child side of the SAME contract from inside the frame:
// post the ready handshake, receive parent commands
// ({cclay:1, v:1, id, requestId, type:"command"} + payload), apply each
// command exactly once per surface session, and ack. The session memory is
// session-scoped - request ids are retained for the whole surface session
// and never evicted by recency, so a delayed retry can never land twice;
// at the 10 000-record ceiling the adapter refuses new commands with
// session-request-budget-exhausted rather than forget, because eviction is
// precisely the defect (plan §12.2: "refusing preserves the guarantee;
// evicting is precisely the defect").
//
// The failure vocabulary mirrors the parent's so both sides of the
// boundary name the same refusals (foreign-origin, payload-not-plain-data,
// protocol-cclay, conflicting-reuse, ...). Deterministic refusals - a
// malformed envelope, a door clause, a requestId mismatch between envelope
// and payload - are cached like successes, so every retry is served the
// same ack; a throwing or rejecting onCommand is a TRANSIENT failure like
// the parent's landing rejection, so the id is forgotten and a retry may
// succeed. A duplicate arriving while an apply is still in flight joins
// it: the single settle handler posts one ack, exactly-once across the
// async window.
//
// Outgoing lands go through the §5 door (validateTakePayload from
// contracts.js, the child-side mirror of the parent's door) before any
// bytes leave, then retry on ack timeout (10 s, at most 3 attempts, same
// requestId - plan §12.2). The surface always runs framed, so the source
// check is exact: a message whose source is not window.parent is refused.

import { assertPlainData } from "../surface-host.js";
import { validateTakePayload } from "./contracts.js";

const PROTOCOL_CClay = 1;
const PROTOCOL_V = 1;
const MAX_MESSAGE_BYTES = 64 * 1024; // §12.1: over cap => payload-too-large, nothing read
const SESSION_BUDGET = 10000; // §12.2: refuse rather than forget
const ACK_TIMEOUT_MS = 10000; // §12.2: the child retries after the ack timeout
const MAX_ACK_ATTEMPTS = 3; // §12.2: at most 3 times, same requestId

// Per-instance message id: unique within a page, deterministic in tests.
let instanceSeq = 0;

export function createCommandAdapter({
	window: win,
	parentOrigin,
	timers = { setTimeout, clearTimeout },
	onCommand = () => {},
	ackTimeoutMs = ACK_TIMEOUT_MS,
	maxAckAttempts = MAX_ACK_ATTEMPTS,
	sessionBudget = SESSION_BUDGET,
	id = null,
}) {
	if (win === null || typeof win !== "object") throw new Error("adapter-window");
	if (typeof parentOrigin !== "string" || parentOrigin.length === 0) throw new Error("adapter-parent-origin");
	const instanceId = id ?? `surface-${++instanceSeq}`;
	const parentWindow = win.parent;
	// The injected timers keep the ack timeout deterministic in tests, but
	// the browser's global setTimeout is receiver-sensitive: called as an
	// object method it throws "Illegal invocation" (measured on the QA
	// browser, S4 in verify-surface-host.mjs). Destructure and call bare —
	// never as methods — so the default timers work in Chrome while the
	// fake timers keep working in node.
	const { setTimeout: schedule, clearTimeout: cancel } = timers;
	// Session-scoped command memory: requestId -> {hash, status, ack},
	// retained for the whole surface session and never evicted by recency.
	// Eviction is exactly the defect this table exists to prevent (§12.2).
	const session = new Map();
	// Outgoing lands awaiting their ack: requestId -> {hash, timer, promise}.
	const pendingLands = new Map();

	const post = (message) => parentWindow.postMessage(message, parentOrigin);

	const makeEnvelope = (type, requestId, payload) => {
		const envelope = { cclay: PROTOCOL_CClay, v: PROTOCOL_V, id: instanceId, type };
		if (requestId !== undefined) envelope.requestId = requestId;
		if (payload !== undefined) envelope.payload = payload;
		return envelope;
	};
	// The ack echoes the incoming envelope's id, exactly like the parent's
	// makeAck, so both sides of the boundary build the same shape.
	const makeAck = (request, payload) => ({ cclay: PROTOCOL_CClay, v: PROTOCOL_V, id: request.id, requestId: request.requestId, type: "ack", payload });

	// FNV-1a 32-bit over the JSON text, mirroring the parent's hashOf so
	// byte-identical payloads hash equal on both sides of the boundary.
	// JSON.stringify is total here: the plain-data gate ran before any
	// field was read, so undefined is the only non-serializable input left.
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

	// The command door: the child-side shape contract for a parent command,
	// mirroring the parent's validateTakePayload clause order so the id the
	// session caches under can never diverge from the command the surface
	// applies.
	function validateCommandPayload(payload, envelopeRequestId) {
		if (payload === null || typeof payload !== "object") throw new Error("payload-not-object");
		if (typeof payload.requestId !== "string" || payload.requestId.length === 0) throw new Error("request-id-missing");
		if (envelopeRequestId !== undefined && payload.requestId !== envelopeRequestId) throw new Error("request-id-mismatch");
		if (typeof payload.command !== "string" || payload.command.length === 0) throw new Error("command-invalid");
		return payload;
	}

	function handleCommand(data) {
		if (typeof data.requestId !== "string" || data.requestId.length === 0) return "request-id-missing";
		const record = session.get(data.requestId);
		const hash = hashOf(data.payload);
		if (record !== undefined) {
			if (record.hash === hash) {
				if (record.status === "in-flight") {
					// The first apply is still running: the retry joins it —
					// the single settle handler below posts one ack when the
					// apply completes, so exactly-once holds across the
					// async window, not merely after it (§12.2).
					return undefined;
				}
				// A retry of the identical command: return the cached ack,
				// apply nothing (§12.2).
				post(record.ack);
				return record.status === "ok" ? undefined : (record.ack.payload.code ?? record.status);
			}
			if (record.status === "in-flight") {
				// Different bytes for an id whose apply is still running:
				// refuse the clash, apply nothing, and leave the in-flight
				// record untouched so its settle still owns the slot.
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
		if (session.size >= sessionBudget) {
			// Refuse rather than forget: eviction is exactly the defect the
			// session table exists to avoid (§12.2).
			const ack = makeAck(data, { status: "session-request-budget-exhausted", reload: true });
			post(ack);
			return "session-request-budget-exhausted";
		}
		// The command door is deterministic: the same bytes fail the same
		// clause every time, so a door refusal is cached like a success and
		// every retry is served the same ack (§12.2).
		try {
			validateCommandPayload(data.payload, data.requestId);
		} catch (err) {
			const ack = makeAck(data, { status: "rejected", code: err.message });
			session.set(data.requestId, { hash, status: "rejected", ack });
			post(ack);
			return err.message;
		}
		const failureCode = (err) => (err instanceof Error ? err.message : String(err ?? "command-rejected"));
		let outcome;
		try {
			outcome = onCommand(data.payload);
		} catch (err) {
			// A synchronous throw from the apply is the same transient
			// class as a promise rejection: reported, id left retryable.
			post(makeAck(data, { status: "rejected", code: failureCode(err) }));
			return failureCode(err);
		}
		if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") {
			const pending = { hash, status: "in-flight", ack: null };
			session.set(data.requestId, pending);
			outcome.then(
				() => {
					// The session may have ended (destroy) while the apply
					// was running: nothing is acked and the record must not
					// resurrect into a new session.
					if (session.get(data.requestId) !== pending) return;
					pending.status = "ok";
					pending.ack = makeAck(data, { status: "ok" });
					post(pending.ack);
				},
				(err) => {
					if (session.get(data.requestId) !== pending) return;
					session.delete(data.requestId); // transient: leave the id retryable
					post(makeAck(data, { status: "rejected", code: failureCode(err) }));
				},
			);
			return undefined;
		}
		// A synchronous apply fulfilled: the same contract, settled now.
		const ack = makeAck(data, { status: "ok" });
		session.set(data.requestId, { hash, status: "ok", ack });
		post(ack);
		return undefined;
	}

	function handleAck(data) {
		const pending = pendingLands.get(data.requestId);
		if (pending === undefined) return undefined; // an ack for a land we already gave up on
		if (data.payload === null || typeof data.payload !== "object" || typeof data.payload.status !== "string") return undefined;
		cancel(pending.timer);
		pendingLands.delete(data.requestId);
		if (data.payload.status === "ok") {
			pending.resolve(data.payload);
		} else if (data.payload.status === "rejected") {
			pending.reject(new Error(data.payload.code ?? "landing-rejected"));
		} else {
			// conflicting-reuse, session-request-budget-exhausted, ...
			pending.reject(new Error(data.payload.status));
		}
		return undefined;
	}

	function handleMessage(event) {
		// §12.1: the event checks come first — a message from a foreign
		// origin or a different source object is rejected, not merely
		// ignored, and its data is never read.
		if (event.origin !== parentOrigin) return "foreign-origin";
		// The surface always runs framed, so the only legitimate sender is
		// the embedding window; when win.parent is absent (never in a real
		// frame) the comparison fails closed.
		if (event.source !== parentWindow) return "foreign-source";
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
		if (data.type === "command") return handleCommand(data);
		if (data.type === "ack") return handleAck(data);
		return "unknown-type";
	}

	function sendLand(payload, { timeoutMs = ackTimeoutMs, attempts = maxAckAttempts } = {}) {
		// The §5 door before any bytes leave: the child must not send a
		// land the parent's own door would reject. A synchronous throw is
		// a caller error (the take is not publishable), not an async event.
		validateTakePayload(payload);
		const requestId = payload.requestId;
		const existing = pendingLands.get(requestId);
		if (existing !== undefined) {
			if (existing.hash !== hashOf(payload)) throw new Error("land-request-id-conflict");
			return existing.promise; // join the in-flight land (§12.2)
		}
		const envelope = makeEnvelope("land", requestId, payload);
		const pending = { hash: hashOf(payload), timer: null, promise: null, resolve: null, reject: null };
		pending.promise = new Promise((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
			// §12.2: retry after the ack timeout, at most `attempts` times,
			// always with the same requestId — the parent's session table
			// dedupes by that id, so a retry can never land twice.
			const attempt = (left) => {
				post(envelope);
				pending.timer = schedule(() => {
					if (left <= 1) {
						pendingLands.delete(requestId);
						reject(new Error("ack-timeout"));
						return;
					}
					attempt(left - 1);
				}, timeoutMs);
			};
			attempt(attempts);
		});
		pendingLands.set(requestId, pending);
		return pending.promise;
	}

	// The ready handshake (§11.6): posted from the child's script, before
	// the document finishes loading, inside the parent's 8 s window.
	post(makeEnvelope("ready"));
	win.addEventListener("message", handleMessage);

	return {
		id: instanceId,
		handleMessage,
		sendLand,
		destroy() {
			if (win.removeEventListener) win.removeEventListener("message", handleMessage);
			for (const pending of pendingLands.values()) cancel(pending.timer);
			pendingLands.clear();
			session.clear();
		},
	};
}

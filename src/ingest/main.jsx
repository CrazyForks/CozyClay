// main.jsx — the ingest surface entry (plan §13 commit U2).
//
// This module owns the singletons the UI drives: the state machine and the
// cross-origin command adapter (which posts the ready handshake and
// attaches the message listener at construction). Creating them ONCE at
// module scope is what makes the surface StrictMode-idempotent: React 19
// dev StrictMode double-invokes render and effects, but it never re-runs
// this module, so a double mount cannot stack a second message listener, a
// second ready handshake or a second landing path.
//
// The parent origin: the embedding iframe carries referrerpolicy
// "no-referrer", so document.referrer is empty in production; Chrome's
// location.ancestorOrigins names the embedding app origin exactly, and
// that is the targetOrigin every postMessage goes to. Standalone dev
// (opening the surface URL directly) degrades to "*" — the parent host
// validates the sender's origin and source object regardless, so a
// wildcard target origin cannot weaken the boundary.
//
// The surface never renders its own unavailable state (§11.6): the parent
// owns the panel, because an unreachable child cannot draw its own error.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createIngestMachine } from "./state.js";
import { createCommandAdapter } from "./adapter.js";
import { Surface } from "./surface.jsx";
import "./surface.css";

function deriveParentOrigin() {
	try {
		const ancestors = location.ancestorOrigins;
		if (ancestors && ancestors.length > 0) return ancestors[0];
	} catch {
		/* opaque or sandboxed: fall through */
	}
	try {
		const referrer = document.referrer;
		if (referrer) return new URL(referrer).origin;
	} catch {
		/* malformed referrer: fall through */
	}
	return "*";
}

const machine = createIngestMachine();

// The child-side protocol (§12): construction posts the ready handshake and
// registers the message listener exactly once; onCommand is the seam the
// machine wiring uses for parent-initiated commands (the host does not
// send any today).
const adapter = createCommandAdapter({
	window,
	parentOrigin: deriveParentOrigin(),
	onCommand: () => {},
});

// The session store: what the operator flow has staged, measured and
// produced so far. The UI subscribes; the measurement seams (and the QA
// hook the browser suite drives) write through set(). Nothing here is a
// secret or a path the policy has not seen — the machine's gates stay the
// authority for what may advance.
const session = {
	value: {
		filename: null,
		stageId: null,
		signals: null, // §10.4 signal set for the preflight policy
		calibration: null, // { level, reasons }
		frames: null,
		artifactPaths: { a: null, b: null, annotation: null },
		provenance: {
			sourceUrl: null,
			licence: null,
			sourceSha256: null,
			trimStartS: 0,
			trimEndS: 0,
			gvhmrCommit: null,
			weightsSha256: null,
		},
	},
	listeners: new Set(),
	set(patch) {
		this.value = { ...this.value, ...patch };
		for (const listener of [...this.listeners]) listener(this.value);
	},
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	},
};

// The QA hook (the app's own __cozyclay pattern): the browser suite drives
// the shipped surface through this handle — the machine, the adapter and
// the session store are the real singletons, not fakes.
window.__cozyclaySurface = {
	machine: {
		state: () => machine.state(),
		report: () => machine.report(),
		warnings: () => machine.warnings(),
		dispatch: (event, payload) => machine.dispatch(event, payload),
	},
	adapter: {
		sendLand: (payload) => adapter.sendLand(payload),
		id: adapter.id,
	},
	session: { get: () => session.value, set: (patch) => session.set(patch) },
	origin: location.origin,
};

createRoot(document.getElementById("root")).render(
	<StrictMode>
		<Surface machine={machine} adapter={adapter} session={session} />
	</StrictMode>,
);

// surface-mount.js - the parent-side composition of the ingest boundary
// (plan 7, 11, 12): one runtime call from the app entry turns the tested
// pieces into the shipped feature. This module owns the wiring - discovery
// of the child origin (plan 11.2), the exact-origin comparison and the
// restrictive sandbox (plan 11.5, both enforced inside createSurfaceHost),
// the onLand route into the app's landing door (plan 7.2/12.2, through the
// neutral motion registry) and the parent-owned unavailable panel with
// retry (plan 11.6). Nothing else in the app imports createSurfaceHost
// (audited in test/verify-isolation.mjs), so deleting the feature is
// removing the two mount lines from main.jsx plus this module, the surface
// dir and the second build entry.
//
// Deliberately NOT under src/ingest/: this is parent-side code that runs in
// the app bundle, so the module-graph exclusion (plan 6.1) keeps asserting
// a literal zero src/ingest ids in dist/ - the composition lives beside
// surface-host.js instead (ultragoal ledger ruling).

import { createSurfaceHost } from "./surface-host.js";
import { landingDoor } from "./motion-sources.js";

// Plan 11.4: the parent CSP admits only loopback frame sources; a discovery
// record pointing anywhere else is refused here too, so the mount never
// relies on the CSP alone.
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;
// The composition is keyed on its window so a re-import (vite HMR
// re-execution, a double import) replaces the previous composition instead
// of stacking a second hidden iframe and message listener. Symbol.for makes
// the key shared across module instances; exported for the verifier.
export const INSTANCE_KEY = Symbol.for("cozyclay.surfaceMount.v1");

export function mountSurfaceHost({
	window: win,
	document: doc,
	fetchImpl = (url, init) => win.fetch(url, init),
	timeoutMs = 8000, // §11.6: the handshake must arrive inside this window
	hostFactory = createSurfaceHost,
	landing = landingDoor,
} = {}) {
	const previous = win[INSTANCE_KEY];
	if (previous !== undefined) previous.destroy();
	const controller = composeSurfaceMount({ window: win, document: doc, fetchImpl, timeoutMs, hostFactory, landing });
	win[INSTANCE_KEY] = controller;
	return controller;
}

function composeSurfaceMount({ window: win, document: doc, fetchImpl, timeoutMs, hostFactory, landing }) {
	let host = null;
	let panel = null;
	let disposed = false;
	let resolveSettled;
	// resolves false when discovery found no usable record (feature absent:
	// no iframe, no affordance, §11.6), true once a host is composed
	const settled = new Promise((resolve) => {
		resolveSettled = resolve;
	});

	const removePanel = () => {
		if (panel !== null && panel.parentNode !== null) panel.parentNode.removeChild(panel);
		panel = null;
	};

	const showPanel = (reason) => {
		if (panel !== null) return;
		panel = doc.createElement("div");
		panel.className = "cozyclay-surface-unavailable";
		panel.setAttribute("role", "alert");
		// The panel is a parent-owned overlay: it must sit above the app UI
		// (a covered Retry would make the feature unreachable) yet stay out
		// of the way of the stage itself.
		panel.style = "position:fixed;right:16px;bottom:16px;max-width:380px;display:flex;gap:12px;align-items:center;padding:12px 16px;background:#2b2b2b;color:#ececec;border:1px solid #555;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.45);font:14px/1.45 system-ui,sans-serif;z-index:1000";
		const message = doc.createElement("span");
		message.textContent = `Footage surface unavailable (${reason})`;
		const retry = doc.createElement("button");
		retry.type = "button";
		retry.textContent = "Retry";
		retry.style = "padding:6px 14px;border:1px solid #888;border-radius:6px;background:#444;color:#fff;cursor:pointer;font:inherit";
		retry.addEventListener("click", () => {
			// A fresh mount is a fresh session: the panel hides, the host
			// remounts a hidden frame, and only the ready handshake reveals it.
			removePanel();
			host.retry();
		});
		panel.append(message, retry);
		doc.body.appendChild(panel);
	};

	// §11.6: the child cannot render its own failure, so the panel is
	// parent-owned; a ready after retry removes any stale panel.
	const onReady = () => removePanel();

	const onLand = (payload) => {
		// §7.2/12.2: the app owns the landing door. The registry hands us the
		// CURRENT door at landing time - a land can never hit a stale closure,
		// and before the app has exposed it the child gets a typed rejection
		// in its ack, never a silent drop.
		const door = landing();
		if (typeof door !== "function") throw new Error("landing-door-unavailable");
		return door(payload);
	};

	async function discover() {
		let response;
		try {
			response = await fetchImpl("/ingest/surface-origin");
		} catch {
			return null; // offline or no proxy: feature absent, no affordance
		}
		let record;
		try {
			record = await response.json();
		} catch {
			return null; // a 404 body or the dev SPA fallback is not a record
		}
		if (record === null || typeof record !== "object") return null;
		const { origin, url } = record;
		if (typeof origin !== "string" || typeof url !== "string") return null;
		if (!LOOPBACK_ORIGIN.test(origin)) return null;
		// the child's entry must live on the discovered origin: the host
		// compares event.origin to surfaceOrigin exactly (§12.1), so an
		// off-origin url would make every child message foreign
		if (!url.startsWith(origin + "/")) return null;
		return { origin, url };
	}

	void (async () => {
		const record = await discover();
		if (disposed || record === null) {
			resolveSettled(false);
			return;
		}
		host = hostFactory({
			window: win,
			document: doc,
			surfaceOrigin: record.origin,
			surfaceUrl: record.url,
			timeoutMs,
			onReady,
			onUnavailable: showPanel,
			onLand,
		});
		resolveSettled(true);
	})();

	return {
		// the composed host once discovery lands, null when feature absent
		host: () => host,
		state: () => (host === null ? "absent" : host.state()),
		panel: () => panel,
		settled,
		destroy: () => {
			disposed = true;
			if (host !== null) host.destroy();
			removePanel();
		},
	};
}

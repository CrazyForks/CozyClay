#!/usr/bin/env node
/**
 * U4: the browser containment suite (plan §14.1 phase 4, §11.5/§11.6, §12.2).
 *
 * Six phase-4 items, each asserted against REAL cross-origin frames in a
 * REAL browser over CDP: the hostile fixture (a page pretending to be the
 * surface), activated top-navigation blocked from the sandboxed frame,
 * offline startup, the host-killed parent fallback, StrictMode idempotence,
 * and exactly-once landing under the 40-request late-retry test. A fake DOM
 * cannot prove any of these — sandbox enforcement, user activation,
 * network emulation and the SW cache are browser behaviours — so the suite
 * drives the SHIPPED composition (src/surface-mount.js mounted by
 * src/main.jsx) and the SHIPPED surface (src/ingest/*, live in the framed
 * document), with suite-owned fixture servers for the hostile and
 * dying-host scenarios.
 *
 * The one that matters most: sandbox without
 * allow-top-navigation-by-user-activation must stop a USER-ACTIVATED
 * top.location change — only a real browser can prove it. The hostile
 * fixture is mounted with the suite's SURFACE_SANDBOX constant; the
 * unsandboxed control frame proves the block is the sandbox token set, not
 * some unrelated browser rule. The shipped iframe's own token set is
 * asserted separately, so a regression in surface-host.js fails the suite
 * even if this constant stays correct.
 *
 * Follows the verify-app-render.mjs discipline: not-run is a FAILURE unless
 * ALLOW_APP_RENDER_SKIP=1 makes the skip a recorded decision (the
 * deletability sim sets it).
 *
 * Canonical RED: U4 "activated top-navigation succeeded from the sandboxed
 * frame".
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { spawnOwned, terminateOwned, waitForExit } from "../tools/process-supervisor.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const cdpPort = Number(process.env.CDP_PORT || 9222);
const qaUrl = process.env.QA_URL || "http://127.0.0.1:5180/";
const appOrigin = new URL(qaUrl).origin;
const skipAllowed = process.env.ALLOW_APP_RENDER_SKIP === "1";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// A suite that exits 0 when it could not run hands the gate a green receipt
// for an unrun check — the same false-evidence class the Phase-0 red-team
// orchestrator was fixed for twice. Not-run is therefore a FAILURE by
// default; ALLOW_APP_RENDER_SKIP=1 makes the skip a recorded decision.
const notRun = (why) => {
	if (skipAllowed) {
		console.log(`SKIP surface browser suite (ALLOW_APP_RENDER_SKIP=1): ${why}`);
		process.exit(0);
	}
	console.error(`FAIL surface browser suite could not run: ${why}`);
	process.exit(1);
};

/* ---------- synthetic motion npz (the app's landing door decodes it) ------ */
// decodeMotionNpz (src/ardy/npz.js) demands four members with CRC-32, a
// proper-rotation check on every 3x3 and fps 1..240; identity matrices and
// zeroed positions pass all of it. The same writer verify-app-render.mjs
// uses, so the app's real fetch+decode path lands real clips.
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();
const crc32 = (bytes) => {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const concatBytes = (parts) => {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};
function npyBytes(descr, shape, payload) {
	const tuple = shape.length === 0 ? "()" : `(${shape.join(", ")}${shape.length === 1 ? "," : ""})`;
	const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${tuple}, }`;
	const header = dict + " ".repeat((16 - ((dict.length + 1) % 16)) % 16) + "\n";
	const prefix = new Uint8Array(10);
	prefix[0] = 0x93;
	prefix.set([0x4e, 0x55, 0x4d, 0x50, 0x59], 1);
	prefix[6] = 1;
	prefix[8] = header.length & 0xff;
	prefix[9] = (header.length >> 8) & 0xff;
	const out = new Uint8Array(10 + header.length + payload.length);
	out.set(prefix, 0);
	out.set(new TextEncoder().encode(header), 10);
	out.set(payload, 10 + header.length);
	return out;
}
function zipStored(members) {
	const localParts = [];
	const centralEntries = [];
	let offset = 0;
	for (const { name, bytes } of members) {
		const nameBytes = new TextEncoder().encode(name);
		const crc = crc32(bytes);
		const local = new Uint8Array(30);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(8, 0, true); // method: STORED
		lv.setUint32(14, crc, true);
		lv.setUint32(18, bytes.length, true);
		lv.setUint32(22, bytes.length, true);
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true);
		localParts.push(local, nameBytes, bytes);
		centralEntries.push({ nameBytes, crc, size: bytes.length, offset });
		offset += 30 + nameBytes.length + bytes.length;
	}
	const cdStart = offset;
	const cdParts = [];
	let cdSize = 0;
	for (const entry of centralEntries) {
		const c = new Uint8Array(46);
		const cv = new DataView(c.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(10, 0, true); // method: STORED
		cv.setUint32(16, entry.crc, true);
		cv.setUint32(20, entry.size, true);
		cv.setUint32(24, entry.size, true);
		cv.setUint16(28, entry.nameBytes.length, true);
		cv.setUint32(42, entry.offset, true);
		cdParts.push(c, entry.nameBytes);
		cdSize += 46 + entry.nameBytes.length;
	}
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, members.length, true);
	ev.setUint16(10, members.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, cdStart, true);
	return concatBytes([...localParts, ...cdParts, eocd]);
}
const f32Bytes = (values) => {
	const floats = Float32Array.from(values);
	return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
};
const int32Bytes = (value) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setInt32(0, value, true);
	return bytes;
};
const FRAMES = 60;
const JOINT_COUNT = 27;
const identityRotMats = new Float32Array(FRAMES * JOINT_COUNT * 9);
for (let m = 0; m < FRAMES * JOINT_COUNT; m += 1) {
	identityRotMats[m * 9] = 1;
	identityRotMats[m * 9 + 4] = 1;
	identityRotMats[m * 9 + 8] = 1;
}
const npzBytes = zipStored([
	{ name: "local_rot_mats.npy", bytes: npyBytes("<f4", [FRAMES, JOINT_COUNT, 3, 3], f32Bytes(identityRotMats)) },
	{ name: "root_positions.npy", bytes: npyBytes("<f4", [FRAMES, 3], f32Bytes(new Float32Array(FRAMES * 3))) },
	{ name: "fps.npy", bytes: npyBytes("<i4", [], int32Bytes(20)) },
	{ name: "posed_joints.npy", bytes: npyBytes("<f4", [FRAMES, JOINT_COUNT, 3], f32Bytes(new Float32Array(FRAMES * JOINT_COUNT * 3))) },
]);
const NPZ_BASE64 = Buffer.from(npzBytes).toString("base64");

// A structurally complete §5 TakePayload (the parent door and the store
// demand all of this): rotationDeg 0, fps 20, equal frame counts, and the
// nine provenance keys; artifact fields are PATHS (§12.3), never URLs.
const PROVENANCE = {
	command: "cozyclay ingest",
	sourceUrl: "file:///raw/u4-take.mov",
	licence: "operator-owned",
	sourceSha256: "a".repeat(64),
	trimStartS: 0,
	trimEndS: 3,
	gvhmrCommit: "b".repeat(40),
	weightsSha256: "c".repeat(64),
	annotationPath: "/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-a",
};
const makeTakePayload = (requestId, tag = "track-a") => ({
	requestId,
	a: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/${tag}`, provenance: PROVENANCE },
	b: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath: `/ingest/artifacts/0123456789abcdef0123456789abcdef/${tag}-b`, provenance: PROVENANCE },
});

/* -------------------------------------------------------------------------- */
/* CDP plumbing                                                                */
/* -------------------------------------------------------------------------- */
let targets;
try {
	targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(1500) })).json();
} catch {
	notRun(`no CDP browser on port ${cdpPort} — run \`node tools/qa-browser.mjs -- node test/verify-surface-browser.mjs\` with \`npm run dev:ingest\` (or set CDP_PORT/QA_URL/ALLOW_APP_RENDER_SKIP)`);
}
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) notRun("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
const contextsByOrigin = new Map();
let downloadsStarted = 0;
let countedOrigins = new Set([appOrigin]);

ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		const url = message.params.exceptionDetails?.url ?? "";
		if (url === "" || countedOrigins.has(url) || [...countedOrigins].some((origin) => url.startsWith(origin))) {
			pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		}
		return;
	}
	if (message.method === "Runtime.executionContextCreated") {
		const context = message.params.context;
		if (typeof context?.origin === "string" && context.origin.length > 0) contextsByOrigin.set(context.origin, context);
		return;
	}
	if (message.method === "Runtime.executionContextDestroyed") {
		for (const [origin, context] of contextsByOrigin) {
			if (context.id === message.params.executionContextId) contextsByOrigin.delete(origin);
		}
		return;
	}
	if (message.method === "Page.downloadWillBegin") {
		downloadsStarted += 1;
		return;
	}
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const evaluateSafely = async (expression) => {
	try {
		return await evaluate(expression);
	} catch {
		return undefined;
	}
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, { timeoutMs = 8000, intervalMs = 150 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluateSafely(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};
// The child realm: the surface document's execution context, resolved by
// its exact origin. Contexts are tracked from Runtime.enable onward; a
// reload destroys and re-creates them, so lookups happen per use.
let surfaceOrigin = null;
const waitForChildContext = async (timeoutMs = 20000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const context = surfaceOrigin !== null ? contextsByOrigin.get(surfaceOrigin) : null;
		if (context !== undefined) return context;
		await sleep(150);
	}
	return null;
};
const evaluateInChild = async (expression, { attempts = 5 } = {}) => {
	// A reload destroys and re-creates the child's execution context; the
	// map can hand us an id that dies a moment later (the reload's teardown
	// races the next probe), so a vanished context is re-resolved, never
	// fatal.
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const context = await waitForChildContext();
		if (context === null) throw new Error(`no execution context for the surface origin ${surfaceOrigin}`);
		try {
			const result = await send("Runtime.evaluate", { expression, contextId: context.id, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "child evaluate failed");
			return result.result.value;
		} catch (err) {
			if (String(err.message).includes("Cannot find context") && attempt < attempts - 1) {
				await sleep(250);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`child evaluate failed after ${attempts} attempts: ${expression}`);
};
const evaluateInChildSafely = async (expression) => {
	try {
		return await evaluateInChild(expression);
	} catch {
		return undefined;
	}
};
const childWaitFor = async (expression, { timeoutMs = 8000, intervalMs = 150 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluateInChildSafely(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};
const childClick = (selector) =>
	evaluateInChild(
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("child click target not found: " + ${JSON.stringify(selector)}); el.click(); return true; })()`,
	);
const mouse = (type, x, y) =>
	send("Input.dispatchMouseEvent", {
		type,
		x: Math.round(x),
		y: Math.round(y),
		button: "left",
		clickCount: 1,
		buttons: type === "mouseReleased" ? 0 : 1,
	});
const clickAt = async (x, y) => {
	await mouse("mousePressed", x, y);
	await sleep(30);
	await mouse("mouseReleased", x, y);
};
const pageTargetIds = async () =>
	(await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json())
		.filter((t) => t.type === "page")
		.map((t) => t.id);

const bootApp = async () => {
	await send("Page.navigate", { url: qaUrl });
	for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
	for (let i = 0; i < 100 && !(await evaluateSafely("!!window.__cozyclay && typeof window.__takeHistory === 'function'")); i += 1) await sleep(200);
	await sleep(800);
	await evaluateSafely(
		"localStorage.removeItem('cozyclay.clips.v1'); localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine'); localStorage.setItem('cozyclay.locale', 'en'); true",
	);
};

// The suite-owned composition mount (the S4 pattern): discovery is injected
// so the mount does not depend on the app's own /ingest proxy.
const mountExpr = (origin, timeoutMs) =>
	`(async () => {
		const m = await import("/src/surface-mount.js");
		window.__mountTest = m.mountSurfaceHost({
			window,
			document,
			timeoutMs: ${timeoutMs},
			fetchImpl: async () =>
				new Response(JSON.stringify({ origin: ${JSON.stringify(origin)}, url: ${JSON.stringify(origin + "/")} }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		return true;
	})()`;

/* ========================================================================== */
/* S1 — boot, composition, the shipped sandbox token set                      */
/* ========================================================================== */
await send("Runtime.enable");
await send("Page.enable");
await bootApp();

const composedState = await evaluateSafely(
	`(async () => {
		const c = window[Symbol.for("cozyclay.surfaceMount.v1")];
		if (!c || typeof c.settled?.then !== "function") return "no-controller";
		await c.settled;
		return c.state();
	})()`,
);
ok(
	"the rendered app composes the surface boundary and reaches ready",
	composedState === "ready",
	`state=${composedState} (requires the ingest surface dev server: \`npm run dev:ingest\`, and the surface must handshake inside the 8 s window)`,
);

const iframeInfo = await evaluate(
	`(() => {
		const c = window[Symbol.for("cozyclay.surfaceMount.v1")];
		const f = c.host().iframe();
		return {
			src: f.src,
			hidden: f.hidden,
			sandbox: f.getAttribute("sandbox"),
			allow: f.getAttribute("allow"),
			referrer: f.getAttribute("referrerpolicy"),
			lazy: f.getAttribute("loading"),
			count: document.querySelectorAll("iframe").length,
		};
	})()`,
);
surfaceOrigin = new URL(iframeInfo.src).origin;
ok("the composed iframe carries the restrictive sandbox token set", iframeInfo.sandbox === "allow-scripts allow-same-origin allow-forms", `sandbox=${iframeInfo.sandbox}`);
ok('allow="" and no-referrer ride along', iframeInfo.allow === "" && iframeInfo.referrer === "no-referrer", `allow=${iframeInfo.allow} referrer=${iframeInfo.referrer}`);
// NOT loading="lazy": Chrome never loads a lazy+hidden iframe, so the
// handshake could never complete and every real composition would time out
// into the unavailable panel (measured on the QA browser, S4 in
// verify-surface-host.mjs). Reintroducing it must fail this suite.
ok("the frame is revealed and not lazy", iframeInfo.hidden === false && iframeInfo.lazy === null, `hidden=${iframeInfo.hidden} lazy=${iframeInfo.lazy}`);
ok("exactly one surface iframe in the app document", iframeInfo.count === 1, `count=${iframeInfo.count}`);
ok("the frame is really cross-origin", surfaceOrigin !== appOrigin, `app=${appOrigin} child=${surfaceOrigin}`);

// The app's landing door fetches the §5 artifact paths on the app origin;
// in this suite the paths are served by a fetch patch so landings decode
// real synthetic npz clips (the transport is the wiring's concern; the
// door, the host and the store all run their real code).
await evaluate(`(async () => {
	window.__u4RealFetch = window.fetch.bind(window);
	const bytes = atob(${JSON.stringify(NPZ_BASE64)});
	window.fetch = (url, init) => {
		const u = String(url);
		if (u.includes("/ingest/artifacts/")) {
			return Promise.resolve(new Response(Uint8Array.from(bytes, (c) => c.charCodeAt(0)), { status: 200, headers: { "content-type": "application/octet-stream" } }));
		}
		return window.__u4RealFetch(url, init);
	};
	return true;
})()`);

/* ========================================================================== */
/* S2 — StrictMode idempotence (the SHIPPED surface, live in its frame)       */
/* ========================================================================== */
const childContext = await waitForChildContext();
ok("the child's execution context is live", childContext !== null, surfaceOrigin);

const strictInfo = await evaluateInChild(
	`(() => {
		const h = window.__cozyclaySurface;
		return { hook: typeof h === "object" && h !== null, id: h?.adapter?.id ?? null, state: h?.machine?.state() ?? null };
	})()`,
);
ok("the surface exposes its QA hook", strictInfo.hook === true, JSON.stringify(strictInfo));
// The adapter is created once at module scope in main.jsx; React 19 dev
// StrictMode double-invokes render and effects but never re-runs the
// module, so exactly ONE construction survives — instance ids start at
// surface-1 and a double construction would yield surface-2 with two
// message listeners and two ready handshakes.
ok("StrictMode produced exactly one adapter instance (id surface-1)", strictInfo.id === "surface-1", `id=${strictInfo.id}`);
ok("the surface machine is live", typeof strictInfo.state === "string", `state=${strictInfo.state}`);

// Behavioral single-flight: one land through the shipped adapter + the
// real composed host + the app's landing door = exactly one take entry.
const probePayload = makeTakePayload("u4-strict-probe");
const probeAck = await evaluateInChild(
	`window.__cozyclaySurface.adapter.sendLand(${JSON.stringify(probePayload)}).then(() => "ok").catch((err) => "rejected:" + err.message)`,
);
ok("a single land through the shipped adapter acks ok", probeAck === "ok", probeAck);
await waitFor("window.__takeHistory().past === 1");
ok("the single land produced exactly one take entry", (await evaluate("window.__takeHistory().past")) === 1, "past=1");

// A reload re-composes everything: exactly one iframe, one fresh adapter,
// ready again — no leftovers from the previous document.
await send("Page.reload");
// The reload swap is not instantaneous: the canvas loop can pass on the
// dying document. Wait for the NEW document's mount controller and the
// app hooks instead, then for the child's fresh adapter.
const rebornMount = await waitFor(`window[Symbol.for("cozyclay.surfaceMount.v1")] !== undefined && window.__cozyclay && typeof window.__cozyclay.landTake === "function"`, { timeoutMs: 20000 });
// The dev client can reload twice in quick succession, so the controller
// key can vanish between polls: wait INSIDE the page for a live, settled
// controller instead of trusting one moment's snapshot.
const recomposed = await evaluateSafely(
	`(async () => {
		const deadline = Date.now() + 15000;
		let last = "no-controller";
		while (Date.now() < deadline) {
			const c = window[Symbol.for("cozyclay.surfaceMount.v1")];
			if (c && typeof c.settled?.then === "function") {
				await c.settled;
				last = c.state();
				if (last === "ready") return last;
			}
			await new Promise((r) => setTimeout(r, 150));
		}
		return last;
	})()`,
);
const childReborn = await childWaitFor(`window.__cozyclaySurface?.adapter?.id === "surface-1"`, { timeoutMs: 20000 });
const afterReloadId = await evaluateInChild(`window.__cozyclaySurface.adapter.id`);
const appIframeCount = await evaluate("document.querySelectorAll('iframe').length");
ok("a reload re-composes to ready with exactly one frame and one adapter", rebornMount === true && childReborn === true && recomposed === "ready" && afterReloadId === "surface-1" && appIframeCount === 1, `state=${recomposed} id=${afterReloadId} appIframes=${appIframeCount}`);
await waitForChildContext();
await evaluate(`(() => { window.__u4RealFetch = window.fetch.bind(window); const bytes = atob(${JSON.stringify(NPZ_BASE64)}); window.fetch = (url, init) => { const u = String(url); if (u.includes("/ingest/artifacts/")) return Promise.resolve(new Response(Uint8Array.from(bytes, (c) => c.charCodeAt(0)), { status: 200, headers: { "content-type": "application/octet-stream" } })); return window.__u4RealFetch(url, init); }; return true; })()`);

/* ========================================================================== */
/* S3 — the real surface walks the whole pipeline (incl. NDJSON progress)     */
/* ========================================================================== */
// The transport is stubbed in the child (stage/extract), everything else
// runs the shipped code: the real file input, the real fetch call sites,
// the real NDJSON stream consumer, the real machine, the real adapter, the
// real parent host, the real landing door.
await evaluateInChild(`(() => {
	window.__u4RealFetch = window.fetch.bind(window);
	const enc = new TextEncoder();
	window.fetch = (url, init) => {
		const u = String(url);
		if (u.includes("/ingest/stage")) {
			return Promise.resolve(new Response(JSON.stringify({ stageId: "u4stage0000000000000000000000000001" }), { status: 200, headers: { "content-type": "application/json" } }));
		}
		if (u.includes("/ingest/extract")) {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(enc.encode('{"type":"log","line":"preflight ok"}\\n'));
					setTimeout(() => controller.enqueue(enc.encode('{"type":"log","line":"track A: 60 frames"}\\n')), 300);
					setTimeout(() => controller.enqueue(enc.encode('{"type":"log","stream":"stderr","line":"warn: clinch contact high"}\\n')), 600);
					setTimeout(() => { controller.enqueue(enc.encode('{"type":"done","code":0}\\n')); controller.close(); }, 900);
				},
			});
			return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
		}
		return window.__u4RealFetch(url, init);
	};
	return true;
})()`);

// pick-footage: drive the real file input, then the real Stage button.
await evaluateInChild(`(() => {
	const input = document.querySelector('input[data-action="footage-file"]');
	const dt = new DataTransfer();
	dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], "u4-take.webm", { type: "video/webm" }));
	Object.defineProperty(input, "files", { value: dt.files, configurable: true });
	input.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
})()`);
await childClick('button[data-action="stage-footage"]');
await childWaitFor(`window.__cozyclaySurface.machine.state() === "preflight"`);
ok("pick-footage stages the take and advances the machine to preflight", true, "state=preflight");

// preflight: a §10.4 GO signal set through the measurement seam renders a
// go report; the machine's own gate must be the one that lets it through.
await evaluateInChild(`window.__cozyclaySurface.session.set({ signals: { cutsDetected: false, zoomDetected: false, panHandheld: false, vfrUncorrected: false, interlaceTelecine: false, subjectHeightFraction: 0.55, personCount: 2, durationS: 12.5, clinchIoUPeak: 0.2 } }); true`);
await childWaitFor(`document.querySelector('[data-action="continue-preflight"]') !== null`);
const verdictText = await evaluateInChild(`document.querySelector('.cclay-verdict')?.textContent ?? null`);
ok("the preflight report renders the go verdict", verdictText === "go", `verdict=${verdictText}`);
await childClick('button[data-action="continue-preflight"]');
await childWaitFor(`window.__cozyclaySurface.machine.state() === "select-take"`);
ok("a go report leaves preflight for select-take", true, "state=select-take");

await childClick('button[data-action="confirm-take"]');
await childWaitFor(`window.__cozyclaySurface.machine.state() === "calibrate"`);
ok("the operator confirms the take and reaches calibrate", true, "state=calibrate");

// calibrate: a warn verdict (carried into review) reaches extract.
await evaluateInChild(`window.__cozyclaySurface.session.set({ calibration: { level: "warn", reasons: ["clinch-iou-high"] } }); true`);
await childWaitFor(`document.querySelector('[data-action="complete-calibration"]') !== null`);
await childClick('button[data-action="complete-calibration"]');
await childWaitFor(`window.__cozyclaySurface.machine.state() === "extract"`);
ok("a warn calibration verdict reaches extract", true, "state=extract");

// extract metadata, then the real Begin button: the NDJSON stream renders
// as it arrives (line 1 visible while the stream is still open), and the
// done record advances the machine.
await evaluateInChild(`window.__cozyclaySurface.session.set({ frames: 60, artifactPaths: { a: "/ingest/artifacts/0123456789abcdef0123456789abcdef/track-a", b: "/ingest/artifacts/0123456789abcdef0123456789abcdef/track-b", annotation: "/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-a" }, provenance: { sourceUrl: "file:///raw/u4-take.mov", licence: "operator-owned", sourceSha256: ${JSON.stringify("a".repeat(64))}, trimStartS: 0, trimEndS: 3, gvhmrCommit: ${JSON.stringify("b".repeat(40))}, weightsSha256: ${JSON.stringify("c".repeat(64))} } }); true`);
await childWaitFor(`(document.querySelector('[data-action="begin-extraction"]')?.disabled ?? true) === false`);
await childClick('button[data-action="begin-extraction"]');
const progressed = await childWaitFor(`document.querySelector('[data-role="extract-log"] .cclay-log-line') !== null`, { timeoutMs: 4000 });
const midRun = await evaluateInChild(
	`(() => { const log = document.querySelector('[data-role="extract-log"]'); return { lines: log?.querySelectorAll(".cclay-log-line").length ?? 0, running: document.querySelector('button[data-action="begin-extraction"]')?.disabled ?? false }; })()`,
);
ok(
	"the surface renders the host's NDJSON progress while the stream is still open",
	progressed === true && midRun.running === true && midRun.lines >= 1,
	JSON.stringify(midRun),
);
await childWaitFor(`window.__cozyclaySurface.machine.state() === "review"`, { timeoutMs: 8000 });
const reviewInfo = await evaluateInChild(
	`(() => { const s = document.querySelector('.cclay-summary')?.textContent ?? ""; return { summary: s, state: window.__cozyclaySurface.machine.state() }; })()`,
);
ok(
	"the done record advances to review with all NDJSON lines rendered",
	reviewInfo.state === "review" && reviewInfo.summary.includes("extract lines: 3") && reviewInfo.summary.includes("60"),
	reviewInfo.summary,
);

// review: the calibration warning is carried for the operator to see.
const warnShown = await evaluateInChild(`document.querySelector('.cclay-summary')?.textContent.includes("clinch-iou-high") ?? false`);
ok("review surfaces the calibration warning telemetry", warnShown === true);

// publish: the real Land button lands through the real composed host.
const pastBeforeWalk = await evaluate("window.__takeHistory().past");
await childClick('button[data-action="land-take"]');
await waitFor(`window.__takeHistory().past === ${pastBeforeWalk + 1}`);
await childWaitFor(`window.__cozyclaySurface.machine.state() === "published"`, { timeoutMs: 8000 });
const landedAck = await evaluateInChild(`document.querySelector('[data-role="land-ack"]')?.textContent ?? null`);
ok("the take lands through the real host and the UI shows the ok ack", (landedAck ?? "").includes("Landed"), landedAck);

/* ========================================================================== */
/* S4 — the hostile fixture and activated top-navigation                      */
/* ========================================================================== */
// U4's RED was the permissive token set here — granting
// allow-top-navigation-by-user-activation let the user-activated
// top.location change SUCCEED from the sandboxed frame ("activated
// top-navigation succeeded from the sandboxed frame"). The fix restores
// the production token set (plan §11.5, identical to what surface-host.js
// puts on the real frame): the hostile click must be blocked, and the
// unsandboxed control frame proves the block is the sandbox, not a
// browser rule.
const SURFACE_SANDBOX = "allow-scripts allow-same-origin allow-forms";

const hostileServer = createHttpServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end(`<!doctype html><meta charset="utf-8"><script>
		const take = ${JSON.stringify(makeTakePayload("u4-hostile-land"))};
		parent.postMessage({ cclay: 1, v: 1, id: "u4-hostile-ready", type: "ready" }, "*");
		parent.postMessage({ cclay: 1, v: 1, id: "u4-hostile-land", requestId: take.requestId, type: "land", payload: take }, "*");
		document.addEventListener("click", () => {
			try { top.location.href = ${JSON.stringify(appOrigin + "/__u4-nav-marker")}; } catch (e) {}
			try { window.open(${JSON.stringify(appOrigin + "/__u4-popup")}); } catch (e) {}
			try { document.querySelector("a").click(); } catch (e) {}
		});
	</script>
	<a download href="data:text/plain,u4-download" style="display:none">dl</a>
	<button id="go" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent">GO</button>`);
});
await new Promise((done) => hostileServer.listen(0, "127.0.0.1", done));
const hostileOrigin = `http://127.0.0.1:${hostileServer.address().port}`;

const mountHostileExpr = (id, sandbox) =>
	`(() => { const f = document.createElement("iframe"); f.id = ${JSON.stringify(id)}; ${sandbox ? `f.setAttribute("sandbox", ${JSON.stringify(sandbox)});` : ""} f.setAttribute("allow", ""); f.setAttribute("referrerpolicy", "no-referrer"); f.style.cssText = "position:fixed;top:12px;left:12px;width:320px;height:180px;border:0;z-index:2147483647;background:#fff"; f.src = ${JSON.stringify(hostileOrigin + "/")}; document.body.appendChild(f); return true; })()`;

await evaluate(`window.__u4Seen = []; window.addEventListener("message", (e) => window.__u4Seen.push(e.origin)); true`);
await evaluate(mountHostileExpr("u4-hostile", SURFACE_SANDBOX));
const hostileDelivered = await waitFor(`window.__u4Seen.includes(${JSON.stringify(hostileOrigin)})`, { timeoutMs: 8000 });
ok("the hostile fixture really posted from its own origin", hostileDelivered === true, `seen=${JSON.stringify(await evaluateSafely("window.__u4Seen"))}`);
const takePastBeforeHostile = await evaluate("window.__takeHistory().past");
await sleep(600); // any land that could land, would have landed by now
ok("a hostile-origin land lands nothing", (await evaluate("window.__takeHistory().past")) === takePastBeforeHostile, `past=${takePastBeforeHostile}`);
ok("the composed host ignores the hostile ready", (await evaluate(`window[Symbol.for("cozyclay.surfaceMount.v1")].state()`)) === "ready", "state");

// §11.5 with REAL user activation (a CDP mouse click, not el.click()): the
// sandboxed hostile frame must not navigate top, open a popup or start a
// download. The fixture frames sit above the app UI, or the click would
// hit the app and the "blocked" assertion would pass without any attempt.
const idsBefore = await pageTargetIds();
const hrefBefore = await evaluate("location.href");
const downloadsBefore = downloadsStarted;
const hostileRect = await evaluate(
	`(() => { const r = document.querySelector("#u4-hostile").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
);
await clickAt(hostileRect.x, hostileRect.y);
await sleep(700);
const hrefAfter = await evaluate("location.href");
const newTargets = (await pageTargetIds()).filter((id) => !idsBefore.includes(id));
ok(
	"activated top-navigation from the sandboxed cross-origin frame is blocked",
	hrefAfter === hrefBefore,
	`activated top-navigation succeeded from the sandboxed frame: ${hrefBefore} -> ${hrefAfter}`,
);
ok("no popup opened from the sandboxed frame", newTargets.length === 0, `newTargets=${newTargets.length}`);
ok("no download started from the sandboxed frame", downloadsStarted === downloadsBefore, `downloads=${downloadsStarted}`);

// Negative control: the SAME fixture in an UNSANDBOXED cross-origin frame
// CAN navigate top under activation — proving the block above is the
// sandbox token set, not some unrelated browser rule.
await evaluate(mountHostileExpr("u4-control", null));
const controlDelivered = await waitFor(`window.__u4Seen.filter((o) => o === ${JSON.stringify(hostileOrigin)}).length >= 3`, { timeoutMs: 8000 });
ok("the unsandboxed fixture loaded and posted", controlDelivered === true, `delivered=${controlDelivered}`);
await sleep(300);
const controlRect = await evaluate(
	`(() => { const r = document.querySelector("#u4-control").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
);
await clickAt(controlRect.x, controlRect.y);
const navHref = await waitFor(`location.href.startsWith(${JSON.stringify(appOrigin + "/__u4-nav-marker")})`, { timeoutMs: 4000 });
ok("the unsandboxed control frame DID navigate top (the sandbox is the blocker)", navHref === true, `navigated=${navHref}`);
await bootApp(); // the control navigated away; rebuild the app state
await waitForChildContext();
await evaluate(`(() => { window.__u4RealFetch = window.fetch.bind(window); const bytes = atob(${JSON.stringify(NPZ_BASE64)}); window.fetch = (url, init) => { const u = String(url); if (u.includes("/ingest/artifacts/")) return Promise.resolve(new Response(Uint8Array.from(bytes, (c) => c.charCodeAt(0)), { status: 200, headers: { "content-type": "application/octet-stream" } })); return window.__u4RealFetch(url, init); }; return true; })()`);

/* ========================================================================== */
/* S5 — exactly-once landing under the 40-request late-retry test             */
/* ========================================================================== */
// §12.2's eviction-pressure shape, against the REAL parent and the REAL
// child: 40 distinct requests (> 32, defeating any LRU-32), then retry
// request #1 — zero additional undo entries, and the ORIGINAL cached ack
// is returned. A same-id different-bytes reuse is refused by name.
const pastBeforeLate = await evaluate("window.__takeHistory().past");
const latePayloads = Array.from({ length: 40 }, (_, i) => makeTakePayload(`u4-late-${i}`, `track-${i}`));
const lateResults = await evaluateInChild(
	`(async () => {
		const h = window.__cozyclaySurface;
		const payloads = ${JSON.stringify(latePayloads)};
		const jobs = payloads.map((payload) =>
			h.adapter.sendLand(payload).then(() => ({ ok: true })).catch((err) => ({ ok: false, code: err.message })),
		);
		return Promise.all(jobs);
	})()`,
);
ok("all 40 distinct lands ack ok", lateResults.length === 40 && lateResults.every((r) => r.ok === true), JSON.stringify(lateResults.filter((r) => !r.ok)));
await waitFor(`window.__takeHistory().past === ${pastBeforeLate + 40}`);
ok("40 distinct requests produced exactly 40 take entries", (await evaluate("window.__takeHistory().past")) === pastBeforeLate + 40, `past=${pastBeforeLate}->${pastBeforeLate + 40}`);
const retryAck = await evaluateInChild(
	`window.__cozyclaySurface.adapter.sendLand(${JSON.stringify(latePayloads[0])}).then(() => "ok").catch((err) => "rejected:" + err.message)`,
);
ok("the late retry is served the cached ack", retryAck === "ok", retryAck);
await sleep(500);
ok(
	"the late retry applied nothing (40, not 41 entries)",
	(await evaluate("window.__takeHistory().past")) === pastBeforeLate + 40,
	`past=${await evaluate("window.__takeHistory().past")}`,
);
const conflict = makeTakePayload("u4-late-1", "track-conflict");
const conflictAck = await evaluateInChild(
	`window.__cozyclaySurface.adapter.sendLand(${JSON.stringify(conflict)}).then(() => "ok").catch((err) => "rejected:" + err.message)`,
);
ok("a same-id different-bytes reuse is refused by name", conflictAck === "rejected:conflicting-reuse", conflictAck);
ok("the conflicting reuse applied nothing", (await evaluate("window.__takeHistory().past")) === pastBeforeLate + 40, "past");

/* ========================================================================== */
/* S6 — offline startup (prod build + SW cache, no ingest affordance)         */
/* ========================================================================== */
// §11.6's "installed PWA, offline" row: the app boots from the SW cache
// and NO ingest affordance appears. The dev server never registers the SW
// (registerPwa is PROD-only), so the suite builds dist/, serves it with
// vite preview, lets the SW install and cache the shell, then goes offline
// and reloads.
await build({ root: REPO_ROOT, configFile: join(REPO_ROOT, "vite.config.js"), logLevel: "silent", build: { manifest: false } });
cpSync(join(REPO_ROOT, "public", "fonts"), join(REPO_ROOT, "dist", "fonts"), { recursive: true });

const previewProbe = createNetServer();
await new Promise((done) => previewProbe.listen(0, "127.0.0.1", done));
const previewPort = previewProbe.address().port;
await new Promise((done) => previewProbe.close(done));
const preview = spawnOwned(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"], { cwd: REPO_ROOT });
const previewUrl = `http://127.0.0.1:${previewPort}/`;
let previewReady = false;
for (let i = 0; i < 100; i += 1) {
	try {
		const res = await fetch(previewUrl, { signal: AbortSignal.timeout(1000) });
		if (res.ok) {
			previewReady = true;
			break;
		}
	} catch {
		/* still starting */
	}
	await sleep(150);
}
ok("the prod preview server serves dist/", previewReady === true, previewUrl);

await send("Page.navigate", { url: previewUrl });
for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
countedOrigins.add(`http://127.0.0.1:${previewPort}`);
const swActivated = await evaluateSafely(`(async () => { await navigator.serviceWorker.ready; return true; })()`);
ok("the SW installs and activates on the preview origin", swActivated === true);
await send("Page.reload");
for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
const controlled = await waitFor("navigator.serviceWorker.controller !== null", { timeoutMs: 15000 });
ok("the app is SW-controlled after a reload", controlled === true);

await send("Network.enable");
await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await send("Page.reload");
let offlineBooted = false;
for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) {
	await sleep(200);
}
offlineBooted = await evaluateSafely("!!document.querySelector('canvas')");
const offlineInfo = await evaluateSafely(
	`(async () => {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const c = window[Symbol.for("cozyclay.surfaceMount.v1")];
			if (c && typeof c.settled?.then === "function") {
				await c.settled;
				return { state: c.state(), panel: c.panel() !== null, iframes: document.querySelectorAll("iframe").length };
			}
			await new Promise((r) => setTimeout(r, 150));
		}
		return { state: "no-controller", panel: false, iframes: document.querySelectorAll("iframe").length };
	})()`,
);
await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
ok("offline startup boots the app from the SW cache", offlineBooted === true);
ok(
	"offline startup shows no ingest affordance (absent, no iframe, no panel)",
	offlineInfo?.state === "absent" && offlineInfo?.panel === false && offlineInfo?.iframes === 0,
	JSON.stringify(offlineInfo),
);

// Back to the dev app for the last section.
await bootApp();
await waitForChildContext();

/* ========================================================================== */
/* S7 — host-killed parent fallback                                           */
/* ========================================================================== */
// §11.6: the child's own host dies mid-session — the parent panel appears
// inside the 8 s window and every baseline snapshot value is unchanged.
// The child is a suite-owned server on a real loopback origin; killing it
// strands the already-loaded frame, and a forced reload into the dead
// origin fails into the parent-owned unavailable panel. Retry against a
// revived server on the SAME origin recovers to ready.
const childServer = createHttpServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end(`<!doctype html><meta charset="utf-8"><script>parent.postMessage({ cclay: 1, v: 1, id: "u4-kill-child", type: "ready" }, "*");</script>`);
});
await new Promise((done) => childServer.listen(0, "127.0.0.1", done));
const killPort = childServer.address().port;
const killOrigin = `http://127.0.0.1:${killPort}`;
await evaluate(mountExpr(killOrigin, 8000));
const killReady = await waitFor(`window.__mountTest.state() === "ready"`, { timeoutMs: 8000 });
ok("the suite-owned child handshakes the composed host", killReady === true, killOrigin);
const baseline = await evaluate(
	`(() => ({ href: location.href, takePast: window.__takeHistory().past, scenePast: window.__sceneHistory().past, canvases: document.querySelectorAll("canvas").length }))()`,
);
childServer.close();
await evaluate(
	`(() => { const f = window.__mountTest.host().iframe(); f.src = f.src + (f.src.includes("?") ? "&u4killed=1" : "?u4killed=1"); return true; })()`,
);
const panelUp = await waitFor(`window.__mountTest.panel() !== null`, { timeoutMs: 8500 });
ok("the parent panel appears inside the 8 s window after the host dies", panelUp === true);
const afterKill = await evaluate(
	`(() => { const t = window.__mountTest; return { state: t.state(), role: t.panel()?.getAttribute("role"), cls: t.panel()?.className, button: t.panel()?.querySelector("button")?.textContent ?? null }; })()`,
);
ok(
	"the composition reports unavailable with the parent-owned alert panel",
	afterKill.state === "unavailable" && afterKill.role === "alert" && afterKill.cls === "cozyclay-surface-unavailable" && afterKill.button === "Retry",
	JSON.stringify(afterKill),
);
const afterKillBaseline = await evaluate(
	`(() => ({ href: location.href, takePast: window.__takeHistory().past, scenePast: window.__sceneHistory().past, canvases: document.querySelectorAll("canvas").length }))()`,
);
ok("every baseline snapshot value is unchanged", JSON.stringify(afterKillBaseline) === JSON.stringify(baseline), JSON.stringify(afterKillBaseline));

// Revive the child on the SAME origin and drive the real Retry button.
const reborn = createHttpServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end(`<!doctype html><meta charset="utf-8"><script>parent.postMessage({ cclay: 1, v: 1, id: "u4-kill-child", type: "ready" }, "*");</script>`);
});
await new Promise((done) => reborn.listen(killPort, "127.0.0.1", done));
const retryRect = await evaluate(
	`(() => { const b = window.__mountTest.panel().querySelector("button"); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
);
await clickAt(retryRect.x, retryRect.y);
const recovered = await waitFor(`window.__mountTest.state() === "ready" && window.__mountTest.panel() === null`, { timeoutMs: 10000 });
ok("Retry against the revived child recovers to ready and hides the panel", recovered === true);
await evaluate("window.__mountTest.destroy(); true");
reborn.close();
hostileServer.close();

ok("no uncaught app errors during the run", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
await terminateOwned(preview);
await waitForExit(preview);
console.log(fail.length ? `\nfailures: ${fail.length}` : "\nall surface browser checks PASS");
process.exit(fail.length ? 1 : 0);

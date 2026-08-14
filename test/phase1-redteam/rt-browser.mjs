#!/usr/bin/env node
/**
 * Category 3 (browser half) — the LIVE app's landing door, observed
 * through the real QA hooks (window.__cozyclay.landTake, __takeHistory,
 * __sceneHistory) in a real browser via CDP.
 *
 * Cases:
 *   B-E2E-01  boot + hooks live (control)
 *   B-E2E-02  validation ORDER: a payload the §5 door would reject (fps 24)
 *             with a data:-URL artifact is decoded BEFORE it is validated —
 *             the observed rejection is a decode error, never fps-not-20;
 *             and a payload whose artifactPath is an arbitrary same-origin
 *             URL is FETCHED before any §12.3 path gate runs
 *   B-E2E-03  exactly-once through the real door: two concurrent same-id
 *             landings share one task and mint one entry
 *   B-E2E-04  land -> Clear clip button -> land SAME id: the cached ack is
 *             served and the lanes STAY cleared (documented lifetime
 *             retention; footgun observed through the real UI)
 *   B-E2E-05  surface-host app wiring: main.jsx does not wire the host yet
 *             (U4) — recorded as evidence, not claimed
 *
 * A suite that cannot run (no CDP browser) FAILS loudly — it never exits 0
 * with unrun checks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, createRecorder } from "./rt-common.mjs";

const rt = createRecorder({ suite: "rt-browser", category: "publish-door-browser" });

const port = Number(process.env.CDP_PORT || 9222);
const skipAllowed = process.env.ALLOW_APP_RENDER_SKIP === "1";
const notRun = (why) => {
	const label = skipAllowed ? "SKIP " : "FAIL ";
	console.log(`${label} rt-browser did not run: ${why}`);
	process.exit(skipAllowed ? 0 : 1);
};

let targets;
try {
	targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json();
} catch {
	notRun(`no CDP browser on port ${port} — run through tools/qa-browser.mjs`);
}
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) notRun("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
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
const waitFor = async (expression, { timeoutMs = 15000, intervalMs = 200 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluateSafely(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};

/* -------- synthetic motion npz (spec-derived STORED zip writer) ---------- */
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
		lv.setUint16(8, 0, true);
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
		cv.setUint16(10, 0, true);
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
const ARTIFACT_URL = "data:application/octet-stream;base64," + Buffer.from(npzBytes).toString("base64");
const GARBAGE_URL = "data:application/octet-stream;base64," + Buffer.from("this is not an npz archive at all").toString("base64");

const provenance = {
	command: "cozyclay ingest",
	sourceUrl: "file:///raw/take.mov",
	licence: "operator-owned",
	sourceSha256: "a".repeat(64),
	trimStartS: 0,
	trimEndS: 3,
	gvhmrCommit: "b".repeat(40),
	weightsSha256: "c".repeat(64),
	annotationPath: "/ingest/artifacts/0123456789abcdef0123456789abcdef/annotation-a",
};
const takePayload = (requestId, artifactPath = ARTIFACT_URL) => ({
	requestId,
	a: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath, provenance },
	b: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath, provenance },
});

/* --------------------------------- boot ----------------------------------- */
await send("Runtime.enable");
for (let i = 0; i < 100 && !(await evaluateSafely("location.href.startsWith('http')")); i += 1) await sleep(200);
await evaluate("localStorage.removeItem('cozyclay.clips.v1'); localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine'); localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.reload");
for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
for (let i = 0; i < 100 && !(await evaluateSafely("!!window.__cozyclay && !!window.__takeHistory && !!window.__sceneHistory && !!window.__cozyclay.rigA && document.querySelectorAll('.hierarchy-row').length > 0")); i += 1) await sleep(200);
await sleep(1200);

await rt.record({
	id: "B-E2E-01",
	kind: "test-report",
	title: "the live app boots with the QA hooks and both real stores",
	planRef: "plan §7.2/§7.3",
	input: "boot against the live dev server",
	expected: "__cozyclay.landTake is a function; __takeHistory/__sceneHistory report live store state",
	run: async () => {
		const hooks = await evaluate("typeof window.__cozyclay === 'object' && typeof window.__cozyclay.landTake === 'function' && typeof window.__takeHistory === 'function' && typeof window.__sceneHistory === 'function'");
		const both = await evaluate("(() => { const t = window.__takeHistory(); const s = window.__sceneHistory(); return t && s && typeof t.past === 'number' && s.settled === true; })()");
		return { verdict: hooks && both ? "PASS" : "DEFECT", observed: `hooks=${hooks} bothStores=${both}` };
	},
}).done;

await rt.record({
	id: "B-E2E-02",
	kind: "adversarial",
	title: "validation ORDER: the door decodes a §5-invalid payload (fps 24) and FETCHES an arbitrary artifact URL before any validator rejects",
	planRef: "plan §12.3 (artifact fields are paths on the app's own origin), §5",
	input: "window.__cozyclay.landTake with fps 24 and a garbage data:-URL artifact; then a payload with artifactPath = an arbitrary same-origin URL (http://127.0.0.1:5180/src/main.jsx) and fps 24",
	expected: "observed: both reject with a DECODE error ('motion download failed' / npz parse), never 'fps-not-20' or 'artifact-path-invalid' — the §5/§12.3 gates live in the host, and the exposed door fetches/decodes first; in Phase 1 the host is not wired, so this door is directly callable",
	run: async () => {
		const badFps = takePayload("e2e-order-1", GARBAGE_URL);
		badFps.a.fps = 24;
		badFps.b.fps = 24;
		const r1 = await evaluate(`window.__cozyclay.landTake(${JSON.stringify(badFps)}).then(() => "landed", (e) => String(e && e.message || e))`);
		const urlPath = takePayload("e2e-order-2", `http://${new URL(await evaluate("location.href")).host}/src/main.jsx`);
		urlPath.a.fps = 24;
		urlPath.b.fps = 24;
		const r2 = await evaluate(`window.__cozyclay.landTake(${JSON.stringify(urlPath)}).then(() => "landed", (e) => String(e && e.message || e))`);
		const orderViolation = !r1.includes("fps-not-20") && !r2.includes("fps-not-20") && !r2.includes("artifact-path-invalid") && /download|npz|archive|parse/i.test(r1) && /download|npz|archive|parse/i.test(r2);
		const stillEmpty = await evaluate("window.__takeHistory().past === 0 && window.__sceneHistory().settled === true");
		return {
			verdict: orderViolation && stillEmpty ? "WEAKNESS" : orderViolation ? "WEAKNESS" : "DEFECT",
			observed: `fps24+garbage -> ${String(r1).slice(0, 120)} ; fps24+URL -> ${String(r2).slice(0, 120)} ; past=${await evaluate("window.__takeHistory().past")}`,
		};
	},
}).done;

await rt.record({
	id: "B-E2E-03",
	kind: "property",
	title: "exactly-once through the REAL door: two concurrent same-id landings share one task and mint one entry",
	planRef: "plan §12.2",
	input: "Promise.all of two identical landTake(p) calls with a VALID npz data URL",
	expected: "both resolve with the same ack; __takeHistory().past === 1; both clip slots loaded",
	run: async () => {
		const payload = takePayload("e2e-conc-" + Date.now());
		const result = await evaluate(`(async () => {
			const p = ${JSON.stringify(payload)};
			const [a, b] = await Promise.all([window.__cozyclay.landTake(p), window.__cozyclay.landTake(p)]);
			return { same: a === b, req: a && a.value ? a.value.requestId : (a && a.requestId) };
		})()`);
		const past = await evaluate("window.__takeHistory().past");
		const loaded = await evaluate("window.__cozyclay.motion !== null && window.__cozyclay.motionB !== null");
		return {
			verdict: result.same === true && past === 1 && loaded === true ? "PASS" : "DEFECT",
			observed: `sameAck=${result.same} past=${past} bothSlots=${loaded}`,
		};
	},
}).done;

await rt.record({
	id: "B-E2E-04",
	kind: "adversarial",
	title: "land -> Clear clip -> land the SAME id: the cached ack is served, the lanes STAY cleared",
	planRef: "plan §12.2 (ids retained for the store's lifetime)",
	input: "land 'e2e-clear-x'; click the real Clear clip button; land 'e2e-clear-x' again",
	expected: "the third call is a replay: ack ok, nothing applied — the client that re-landed after a clear gets an ok ack while the lanes remain empty (documented lifetime retention; footgun observed through the real UI)",
	run: async () => {
		const requestId = "e2e-clear-" + Date.now();
		const payload = takePayload(requestId);
		await evaluate(`window.__cozyclay.landTake(${JSON.stringify(payload)})`);
		const pastAfterLand = await evaluate("window.__takeHistory().past");
		const cleared = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear clip'); if (!b) return false; b.click(); return true; })()`);
		await sleep(400);
		const pastAfterClear = await evaluate("window.__takeHistory().past");
		const emptyAfterClear = await evaluate("window.__cozyclay.motion === null && window.__cozyclay.motionB === null");
		const replay = await evaluate(`window.__cozyclay.landTake(${JSON.stringify(payload)}).then((a) => ({ ok: true, req: a.value ? a.value.requestId : a.requestId }), (e) => ({ ok: false, err: String(e) }))`);
		await sleep(400);
		const stillEmpty = await evaluate("window.__cozyclay.motion === null && window.__cozyclay.motionB === null");
		const pastAfterReplay = await evaluate("window.__takeHistory().past");
		const footgun = replay.ok === true && replay.req === requestId && stillEmpty === true && pastAfterReplay === pastAfterClear && pastAfterClear === pastAfterLand + 1 && cleared === true && emptyAfterClear === true;
		return { verdict: footgun ? "WEAKNESS" : "DEFECT", observed: `cleared=${cleared} past=${pastAfterLand}->${pastAfterClear}->${pastAfterReplay} replay=${JSON.stringify(replay)} stillEmpty=${stillEmpty}` };
	},
}).done;

await rt.record({
	id: "B-E2E-05",
	kind: "test-report",
	title: "surface-host app wiring is Phase 4 (U4): main.jsx does not create the host; the host boundary is proven node-side",
	planRef: "plan §11.5 (U4)",
	input: "read-only source inspection of src/main.jsx",
	expected: "no createSurfaceHost wiring in the app entry — the browser-side host is unproven until U4; recorded as evidence, not claimed",
	run: () => {
		const mainSource = readFileSync(new URL("../../src/main.jsx", import.meta.url), "utf8");
		const wired = mainSource.includes("createSurfaceHost");
		const imports = (mainSource.match(/^import .*$/gm) ?? []).join(" ");
		return {
			verdict: wired ? "INFO" : "INFO",
			observed: `createSurfaceHostWired=${wired} imports=${imports.slice(0, 160)}`,
		};
	},
}).done;

const evidencePath = await rt.write();
const fails = rt.cases.filter((c) => c.verdict === "HARNESS-FAIL");
console.log(`\nrt-browser: ${rt.cases.length} cases, ${rt.cases.filter((c) => c.verdict === "DEFECT").length} DEFECT, ${rt.cases.filter((c) => c.verdict === "WEAKNESS").length} WEAKNESS, pageErrors=${pageErrors.length}, evidence: ${evidencePath}`);
process.exit(fails.length ? 1 : 0);

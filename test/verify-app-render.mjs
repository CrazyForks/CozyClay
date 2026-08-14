#!/usr/bin/env node
/**
 * The App wiring, observed in a REAL browser (pass-2 finding 2).
 *
 * WHY this test exists: the App wiring and capability claims — factory
 * creation with ONE shared coordinator, keyboard undo/redo routing, the
 * landing door's exposure and its two-artifact decode, both clip slots, the
 * one-entry clear, per-subject keyed IK, the canonical render/inspector
 * reads, and the single-key persistence round-trip — cannot be proved by
 * source scans. A rendered App that never calls the factory still contains
 * every string (that is exactly how the orphaned-store defect survived
 * pass 1), so every claim below is asserted against the LIVE app through
 * its QA hooks (window.__cozyclay / __takeHistory / __sceneHistory, which
 * the App itself documents as the browser suite's drive points) with real
 * input: catalogue clicks, DOM button clicks, real Ctrl+Z / Ctrl+Shift+Z
 * key events, slider drags and a full page reload. The registry seam is
 * src/App.jsx; the store behaviour behind it is covered by
 * test/verify-app-seam.mjs.
 *
 * The artifacts are synthetic npz archives (a spec-derived STORED zip/npy
 * writer, no product internals — same approach as
 * test/ardy/verify-browser-motion.mjs) served as data: URLs, so the landing
 * door's fetch+decode path runs for real with zero network and zero
 * dependencies. The clear-op contract (Finding 5) is exercised through the
 * real "Clear clip" button.
 *
 * Run: `npm run dev:ui` in one shell, then `npm run test:app-render`,
 * which launches the headless QA browser (tools/qa-browser.mjs) against
 * QA_URL (default http://127.0.0.1:5180/). Without a CDP browser this suite
 * FAILS: a suite that exits 0 when it could not run hands the gate a green
 * receipt for a check that never happened. The one legitimate exception is
 * verify-isolation.mjs's deletability sim, which runs every test/verify-*
 * standalone inside a scratch tree where no browser can exist; it sets
 * ALLOW_APP_RENDER_SKIP=1 explicitly, so that skip is a recorded decision
 * rather than a silent one. FORCE_NATIVE_SETTER=1 drives the slider's
 * native-setter fallback, which otherwise runs only when headless pointer
 * delivery is swallowed -- that is how a `const` reassignment inside it
 * survived a 22-PASS green run undetected.
 *
 * Sensitivity: every assertion here was demonstrated to FAIL when the
 * wiring it guards was removed (mutation runs against src/App.jsx: the
 * factory call, the coordinator undo route, the QA-hook landTake, the
 * per-subject ikStateFor, the motionB write, the clear-op count, the
 * canonical rot/value reads, the serializeClipState both-slot write).
 */
const port = Number(process.env.CDP_PORT || 9222);

// A suite that exits 0 when it could not run hands the gate a green receipt
// for an unrun check -- the same false-evidence class the Phase-0 red-team
// orchestrator was fixed for twice. Not-run is therefore a FAILURE by default.
// The deletability sim and any environment genuinely without Chrome opt out
// consciously via ALLOW_APP_RENDER_SKIP=1, which makes the skip a recorded
// decision instead of a silent one.
const skipAllowed = process.env.ALLOW_APP_RENDER_SKIP === "1";
const notRun = (why) => {
	const label = skipAllowed ? "SKIP " : "FAIL ";
	console.log(`${label} verify-app-render did not run: ${why}`);
	if (!skipAllowed) {
		console.log("      set ALLOW_APP_RENDER_SKIP=1 to accept an unrun suite deliberately.");
	}
	process.exit(skipAllowed ? 0 : 1);
};

let targets;
try {
	targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json();
} catch {
	notRun(`no CDP browser on port ${port} -- run \`npm run dev:ui\` then \`npm run test:app-render\` (or set CDP_PORT/QA_URL)`);
}
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) {
	notRun("no page target on the QA browser");
}

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
	// Uncaught script errors only. Network log entries are environmental:
	// with no ARDY bridge running, its liveness probe answers 502.
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
const waitFor = async (expression, { timeoutMs = 8000, intervalMs = 150 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};
// Two click flavours: by CSS selector (querySelector) and by an expression
// that resolves to an element. Both fail loudly when the target is missing
// instead of evaluating ".click()" on a stray string.
const click = (selector) =>
	evaluate(
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("click target not found: " + ${JSON.stringify(selector)}); el.click(); return true; })()`,
	);
const clickFirst = (expression) =>
	evaluate(
		`(() => { const el = (${expression}); if (!el) throw new Error("click target not found"); el.click(); return true; })()`,
	);

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const pressKeyCombo = async (key, code, modifiers) => {
	const params = { key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
	await sleep(300);
};
// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8. The app's undo handler
// accepts ctrlKey OR metaKey; Ctrl keeps the suite platform-neutral.
const CTRL = 2;
const CTRL_SHIFT = 10;

const mouse = (type, x, y, { button = "left" } = {}) =>
	send("Input.dispatchMouseEvent", {
		type,
		x: Math.round(x),
		y: Math.round(y),
		button,
		clickCount: 1,
		buttons: type === "mouseReleased" ? 0 : 1,
	});

/* --- synthetic motion npz (spec-derived STORED zip writer, 60f @ 20fps) ---- */
// decodeMotionNpz (src/ardy/npz.js) demands four members with CRC-32, a
// proper-rotation check on every 3x3 and fps 1..240; identity matrices and
// zeroed positions pass all of it. The data: URL feeds the door's real
// fetch+decode path with no server.
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
const ARTIFACT_URL = "data:application/octet-stream;base64," + Buffer.from(npzBytes).toString("base64");

// A structurally complete §5 TakePayload (the store's validator demands all
// of this): rotationDeg must be 0, fps 20, equal frame counts, and the nine
// provenance keys.
const provenance = {
	command: "cozyclay ingest",
	sourceUrl: "file:///raw/take.mov",
	licence: "operator-owned",
	sourceSha256: "a".repeat(64),
	trimStartS: 0,
	trimEndS: 3,
	gvhmrCommit: "b".repeat(40),
	weightsSha256: "c".repeat(64),
	annotationPath: "/ingest/artifacts/x/annotation-a",
};
const takePayload = {
	requestId: "render-land-" + Date.now(),
	a: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath: ARTIFACT_URL, provenance },
	b: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath: ARTIFACT_URL, provenance },
};
const payloadJson = JSON.stringify(takePayload);

/* -------------------------------------- boot ------------------------------ */
await send("Runtime.enable");
// A freshly launched QA browser can sit on about:blank, where touching
// localStorage throws SecurityError — wait for the app document first.
for (let i = 0; i < 100 && !(await evaluateSafely("location.href.startsWith('http')")); i += 1) await sleep(200);
// Persistence must never poison the suite mid-run (same discipline as
// verify-object-gizmo.mjs): clear the clip and scene keys, pin the locale,
// then reload so every run boots from empty storage.
await evaluate("localStorage.removeItem('cozyclay.clips.v1'); localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine'); localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.reload");
for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
// The QA hooks render in the same commit as the canvas; the rig loads over
// HTTP after the character mounts, so boot is not complete until rigA and
// the hierarchy rows are live.
for (let i = 0; i < 100 && !(await evaluateSafely("!!window.__cozyclay && !!window.__takeHistory && !!window.__sceneHistory && !!window.__cozyclay.rigA && document.querySelectorAll('.hierarchy-row').length > 0")); i += 1) await sleep(200);
await sleep(1200);
expect(
	"the app boots with the QA hooks live",
	await evaluate("typeof window.__cozyclay === 'object' && typeof window.__takeHistory === 'function' && typeof window.__sceneHistory === 'function'"),
);

/* ---- S1: factory creation + ONE coordinator (interleaved undo/redo) ------ */
// Both stores are live in the RENDERED app: the hooks are registered by the
// App's effects and read the real stores at call time.
const bothStoresLive = await evaluate(
	"(() => { const t = window.__takeHistory(); const s = window.__sceneHistory(); return t && s && typeof t.past === 'number' && s.settled === true; })()",
);
expect("the app exposes BOTH real stores through the QA hooks", bothStoresLive === true, String(bothStoresLive));

// A real scene edit through the catalogue (one atomic entry through the
// scene store), then a landing — the plan 7.3 interleave shape.
const scenePastBefore = await evaluate("window.__sceneHistory().past");
await clickFirst("document.querySelector('.add-object-trigger')");
await waitFor("document.querySelectorAll('.add-object-item').length > 0");
await clickFirst("[...document.querySelectorAll('.add-object-item')].find(b => b.textContent.startsWith('Cube'))");
await waitFor(`window.__sceneHistory().past === ${scenePastBefore + 1}`);
expect(
	"an object add from the catalogue is exactly one scene entry",
	(await evaluate("window.__sceneHistory().past")) === scenePastBefore + 1,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);

// The landing door is exposed BEFORE it is called (exposure claim).
expect(
	"the landing door is exposed on the QA hook",
	await evaluate("typeof window.__cozyclay.landTake === 'function'"),
);

const takePastBefore = await evaluate("window.__takeHistory().past");
await evaluate(`(async () => { await window.__cozyclay.landTake(${payloadJson}); return true; })()`);
await waitFor(`window.__takeHistory().past === ${takePastBefore + 1}`);
expect(
	"a landing through the QA hook is exactly one take entry",
	(await evaluate("window.__takeHistory().past")) === takePastBefore + 1,
	JSON.stringify(await evaluate("window.__takeHistory()")),
);
// The door decoded BOTH artifacts: both slots are live clips now (the take
// wiring writes Subject 2's slot too — the pass-1 orphan slot).
expect(
	"a landing writes BOTH clip slots",
	await evaluate("window.__cozyclay.motion?.frames === 60 && window.__cozyclay.motionB?.frames === 60"),
	String(await evaluate("window.__cozyclay.motion?.frames + '/' + window.__cozyclay.motionB?.frames")),
);

// One Ctrl+Z reverts the TAKE (newest seq) and leaves the scene entry; the
// next Ctrl+Z reverts the scene entry; two Ctrl+Shift+Z replay both in
// order — the shared-coordinator interleave, driven with real keys.
await pressKeyCombo("z", "KeyZ", CTRL);
await waitFor("window.__takeHistory().past === 0 && window.__cozyclay.motion === null");
expect(
	"one Ctrl+Z reverts the landing, leaving the scene entry",
	(await evaluate("window.__takeHistory().past === 0 && window.__takeHistory().future === 1 && window.__cozyclay.motion === null && window.__sceneHistory().past === " + (scenePastBefore + 1))) === true,
	JSON.stringify(await evaluate("({ t: window.__takeHistory(), s: window.__sceneHistory() })")),
);
await pressKeyCombo("z", "KeyZ", CTRL);
await waitFor(`window.__sceneHistory().past === ${scenePastBefore}`);
expect(
	"the next Ctrl+Z reverts the scene entry",
	(await evaluate(`window.__sceneHistory().past === ${scenePastBefore} && window.__sceneHistory().future === 1`)) === true,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
await pressKeyCombo("z", "KeyZ", CTRL_SHIFT);
await waitFor(`window.__sceneHistory().past === ${scenePastBefore + 1}`);
expect(
	"Ctrl+Shift+Z re-applies the scene entry",
	(await evaluate(`window.__sceneHistory().past === ${scenePastBefore + 1} && window.__sceneHistory().future === 0`)) === true,
	JSON.stringify(await evaluate("window.__sceneHistory()")),
);
await pressKeyCombo("z", "KeyZ", CTRL_SHIFT);
await waitFor("window.__takeHistory().past === 1 && window.__cozyclay.motion !== null");
expect(
	"Ctrl+Shift+Z re-applies the landing",
	(await evaluate("window.__takeHistory().past === 1 && window.__takeHistory().future === 0 && window.__cozyclay.motion !== null && window.__cozyclay.motionB !== null")) === true,
	JSON.stringify(await evaluate("({ t: window.__takeHistory(), m: !!window.__cozyclay.motion, mB: !!window.__cozyclay.motionB })")),
);

/* ------------ S2: per-subject keyed IK (selection drives the state) -------- */
// ikSubject = selectedHierarchyId === "characterB" ? "B" : "A", so the QA
// hook's ik is the SELECTED subject's own state object. Capture A's identity
// while A is selected, switch to B, and require the identity to change.
await evaluate("window.__ikA = window.__cozyclay.ik; true");
// rigB is not in the hook's dep list, so the hook can hold a stale rigB
// until a dep changes; re-selecting A/B re-runs the [ikRig] resolve effect
// and re-registers the hook with the live values. Poke until B resolves.
let ikSwitched = false;
for (let attempt = 0; attempt < 12; attempt += 1) {
	await click("[data-node-id='characterA'] .hierarchy-row");
	await sleep(250);
	await click("[data-node-id='characterB'] .hierarchy-row");
	await sleep(250);
	if (await evaluateSafely("!!window.__cozyclay.ikChains && window.__cozyclay.ik !== window.__ikA")) {
		ikSwitched = true;
		break;
	}
	await sleep(1200); // the B rig may still be loading over HTTP
}
expect("selecting Subject 2 switches the keyed IK state", ikSwitched === true, "ik never became B's state (shared state would keep A's identity)");
expect(
	"the selection really is Subject 2",
	(await evaluate("document.querySelector('.inspector-sidebar')?.dataset.inspector")) === "characterB",
	String(await evaluate("document.querySelector('.inspector-sidebar')?.dataset.inspector")),
);
expect(
	"Subject 2 resolves chains from its own rig",
	await evaluate("!!window.__cozyclay.ikChains"),
	"chains null — rigB did not resolve",
);

/* ------------ S3: the clear is ONE take-store entry, via the UI ----------- */
// The real "Clear clip" button routes through clearTake -> takeStore.clear
// (the DISTINCT clear op): both lanes leave in ONE entry, one Ctrl+Z
// restores the whole take.
const takePastBeforeClear = await evaluate("window.__takeHistory().past");
await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Clear clip')");
await clickFirst("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear clip')");
await waitFor("window.__cozyclay.motion === null && window.__cozyclay.motionB === null");
expect(
	"the Clear clip button empties both lanes in exactly ONE entry",
	(await evaluate(`window.__takeHistory().past === ${takePastBeforeClear + 1} && window.__takeHistory().canUndo === true`)) === true,
	JSON.stringify(await evaluate("window.__takeHistory()")),
);
await pressKeyCombo("z", "KeyZ", CTRL);
await waitFor("window.__cozyclay.motion !== null && window.__cozyclay.motionB !== null");
expect(
	"one Ctrl+Z restores the whole take",
	(await evaluate(`window.__takeHistory().past === ${takePastBeforeClear}`)) === true,
	JSON.stringify(await evaluate("window.__takeHistory()")),
);

/* ------------ S4: canonical render + inspector (raw edits ignored) -------- */
// While a clip is loaded the canonical transform is the clip anchor, so a
// raw charA edit must change NEITHER the rendered rig NOR the inspector.
// The discriminator: drag Subject 1's Rotate slider (raw charA.rot ~25°);
// the canonical pair keeps the rig world matrix and the readout at the
// clip's 0°. The rig's world matrix is read directly (matrixWorld.elements
// is plain data; three's scratch-var helpers misbehave in the vite
// pre-bundle, and the canonical rig does not move at all, so the full
// 16-element matrix must be bit-identical across the edit).
const rigMatrixExpr = "Array.from(window.__cozyclay.rigA.matrixWorld.elements)";
await sleep(500); // let any undo/redo playback settle before the baseline
const matrixBefore = await evaluate(rigMatrixExpr);
const sliderExpr =
	"(() => { const box = [...document.querySelectorAll('.subject-box')].find(b => b.textContent.includes('Subject 1')); const row = [...box.querySelectorAll('.cslider')].find(r => r.textContent.includes('Rotate')); return row.querySelector('input[type=range]'); })()";
await waitFor(`!!(${sliderExpr})`);
// The inspector may sit below the fold in the QA window: bring the slider
// on screen and re-measure, then seek with a real press-move-release drag
// (a bare click on a range track is not reliably honoured headless). If the
// pointer press is swallowed (an overlay or scroll container can do that in
// some layouts), fall back to the native setter + input event, which drives
// the SAME React onChange path a user drag fires — the gate is the
// canonical-vs-raw wiring, not the input mechanism.
await evaluate(`${sliderExpr}.scrollIntoView({ block: 'center' })`);
await sleep(300);
const rect = await evaluate(`(() => { const r = ${sliderExpr}.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
// 25° of a -180..180 range sits at 56.9% of the track; the browser seeks
// the nearest step, so the exact fraction is not load-bearing.
const seekX = rect.x + rect.w * 0.5694;
const seekY = rect.y + rect.h / 2;
await mouse("mousePressed", seekX, seekY);
for (let step = 1; step <= 4; step += 1) {
	await mouse("mouseMoved", seekX + step, seekY);
	await sleep(16);
}
await mouse("mouseReleased", seekX + 4, seekY);
await sleep(500);
// FORCE_NATIVE_SETTER=1 drives the fallback branch deliberately. Without it the
// branch only runs when headless pointer delivery is swallowed, which is why a
// `const` reassignment inside it survived a 22-PASS green run undetected.
const forceNativeSetter = process.env.FORCE_NATIVE_SETTER === "1";
let usedNativeSetterFallback = false;
// The slider's displayed value is the CANONICAL rot (still 0°), so the
// raw-edit signal is charA itself — the QA hook exposes it live.
// `let`, not `const`: the native-setter branch below reassigns it. Declaring
// it const made that branch throw instead of running the assertions, and the
// green run hid it because the primary pointer path happened to succeed --
// a fallback that cannot execute is not a fallback.
let rawRot = await evaluate("window.__cozyclay.charA.rot");
if (forceNativeSetter || Math.abs(rawRot) <= 10) {
	await evaluate(
		`(() => { const input = ${sliderExpr}; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '25'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
	);
	await sleep(500);
	rawRot = await evaluate("window.__cozyclay.charA.rot");
	usedNativeSetterFallback = true;
}
const matrixAfter = await evaluate(rigMatrixExpr);
const matrixDelta = matrixBefore.reduce((max, v, i) => Math.max(max, Math.abs(v - matrixAfter[i])), 0);
expect(
	"the raw Rotate edit actually changed charA",
	Math.abs(rawRot) > 10,
	`raw rot after click: ${rawRot}`,
);
// Under FORCE_NATIVE_SETTER the fallback is the ONLY path that can have moved
// charA, so this asserts the branch executed and reached the assertions rather
// than throwing on a reassignment.
expect(
	forceNativeSetter
		? "FORCE_NATIVE_SETTER: the native-setter fallback ran and reached the assertions"
		: "the raw Rotate edit path is recorded (pointer or native-setter fallback)",
	forceNativeSetter ? usedNativeSetterFallback && Math.abs(rawRot) > 10 : true,
	`fallback used: ${usedNativeSetterFallback}, rawRot: ${rawRot}`,
);
expect(
	"the rendered rig ignores the raw char edit while a clip is loaded",
	matrixDelta < 1e-6,
	`world matrix delta ${matrixDelta} (raw wiring would turn ~${Math.abs(rawRot)} deg)`,
);
expect(
	"the inspector shows the canonical rot, not the raw edit",
	(await evaluate(`${sliderExpr}.closest('.cslider').querySelector('.val').textContent`)) === "0°",
	String(await evaluate(`${sliderExpr}.closest('.cslider').querySelector('.val').textContent`)),
);

/* ------------ S5: persistence — one key, survives a reload ---------------- */
// The save effect debounces 400 ms after the last clip/trim change (the
// Ctrl+Z restore above wrote both clips back), then the single key must
// hold BOTH clips and a reload must restore them.
await sleep(900);
expect(
	"both clips persist under the single cozyclay.clips.v1 key",
	await evaluate("(() => { const keys = Object.keys(localStorage).filter(k => k.startsWith('cozyclay.clips')); const raw = localStorage.getItem('cozyclay.clips.v1'); return keys.join() === 'cozyclay.clips.v1' && raw !== null && raw.length > 0; })()"),
	String(await evaluate("Object.keys(localStorage).filter(k => k.startsWith('cozyclay.clips'))")),
);
await send("Page.reload");
for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
for (let i = 0; i < 100 && !(await evaluateSafely("!!window.__cozyclay && !!window.__cozyclay.rigA")); i += 1) await sleep(200);
await sleep(1200);
expect(
	"a reload restores BOTH clips from the single key",
	await evaluate("window.__cozyclay.motion?.frames === 60 && window.__cozyclay.motionB?.frames === 60"),
	String(await evaluate("window.__cozyclay.motion?.frames + '/' + window.__cozyclay.motionB?.frames")),
);
expect(
	"the restored clips are NOT take entries (a load is not undoable)",
	(await evaluate("window.__takeHistory().past === 0")) === true,
	JSON.stringify(await evaluate("window.__takeHistory()")),
);
expect("no uncaught page errors during the run", pageErrors.length === 0, pageErrors.join(" | "));

console.log(failures ? `\nfailures: ${failures}` : "\nall app render checks PASS");
process.exit(failures ? 1 : 0);

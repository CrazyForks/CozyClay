#!/usr/bin/env node
/**
 * The ARDY regeneration REQUEST, observed in a REAL browser.
 *
 * HISTORY (pass-4 finding, now resolved): test/verify-layout.mjs USED TO gate
 * the regeneration wiring claims on src/App.jsx string presence — motion-edit
 * routing, duration inheritance, tracked-key serialization, verified-commit
 * clearing and failure preservation — while test/verify-app-seam.mjs USED TO
 * declare that same ground "unproven until U4". A rendered App that never
 * performs any of it still contains every string, so the scans passed either
 * way. Both files now credit this suite as the behavioural gate; none of them
 * still defers this ground to U4.
 *
 * This suite observes the five claims at the REAL boundary: the rendered
 * app's runArdy builds the real /ardy/generate request, the real
 * ardyGenerate client (src/ardy/client.js) POSTs it, and the request body
 * is captured at the network edge by a fetch wrapper installed before the
 * document loads. The wrapper also answers the bridge probes (/ardy/health,
 * /ardy/bases) and streams a scripted ndjson response per scenario, so the
 * app's own commit/verification logic runs on the reply exactly as it
 * would against the sidecar. The take is landed through the real QA-hook
 * door (window.__cozyclay.landTake) with a synthetic npz data: URL; IK keys
 * are authored into the LIVE state object the hook exposes (the same object
 * runArdy reads) and the real "Add key" button bumps the real ikTick.
 *
 * Scenarios:
 *   S1  prompt blocks only          -> one `segments` schedule, posePin false
 *       (claim 1, schedule routing; also: no per-block Generate button)
 *   S2  landing through the door    -> both clip slots live (fixture setup)
 *   S3  live IK keys authored       -> Subject 1's pending key state
 *   S4  clip + IK, no blocks        -> posePin true, `poses` sampled at the
 *       key frames, and duration = the CLIP's 3 s while the form shows 4 s
 *       (claim 1, pose routing; claim 2, duration inheritance)
 *   S5  blocks + IK edits, commit verified -> body.motionEdit with
 *       sourceMotion = the loaded clip url, every edit's tracks EXACTLY the
 *       live tracked joints per frame, then committedIkEdits grows and the
 *       pending IK clears (claims 1/3/4, motion-edit routing, tracked-key
 *       serialization, verified-commit clearing)
 *   S6  blocks + IK edits, commit NOT verified -> the same request shape is
 *       sent, the error surfaces, and the pending IK stays INTACT with
 *       committedIkEdits unchanged (claim 5, failure preservation)
 *
 * Sensitivity: every assertion below was demonstrated to FAIL when the
 * wiring it guards was removed (mutation runs against src/App.jsx, each
 * restored and hash-verified afterwards): the posePin flag, the segments
 * branch, the motionEdit block, the duration ternary, the tracks array,
 * the pending-IK clear, and the commit-verification gate.
 *
 * A suite that exits 0 when it could not run hands the gate a green receipt
 * for an unrun check -- the same false-evidence class the Phase-0 red-team
 * orchestrator was fixed for twice. Not-run is therefore a FAILURE by
 * default. The deletability sim (test/verify-isolation.mjs) and any
 * environment genuinely without Chrome opt out consciously via
 * ALLOW_APP_RENDER_SKIP=1, which makes the skip a recorded decision instead
 * of a silent one.
 *
 * Run: `npx vite --host 127.0.0.1 --port 5180` in one terminal, then
 * `npm run test:ardy-request` (or `node tools/qa-browser.mjs -- node
 * test/verify-ardy-request.mjs`) in another.
 */
const port = Number(process.env.CDP_PORT || 9222);

const skipAllowed = process.env.ALLOW_APP_RENDER_SKIP === "1";
const notRun = (why) => {
	const label = skipAllowed ? "SKIP " : "FAIL ";
	console.log(`${label} verify-ardy-request did not run: ${why}`);
	if (!skipAllowed) {
		console.log("      set ALLOW_APP_RENDER_SKIP=1 to accept an unrun suite deliberately.");
	}
	process.exit(skipAllowed ? 0 : 1);
};

let targets;
try {
	targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json();
} catch {
	notRun(`no CDP browser on port ${port} -- run \`npx vite --host 127.0.0.1 --port 5180\` then \`npm run test:ardy-request\` (or set CDP_PORT/QA_URL)`);
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
	// every /ardy/* request is stubbed by the wrapper installed at boot.
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
const waitFor = async (expression, { timeoutMs = 15000, intervalMs = 150 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};
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
	requestId: "ardy-request-land-" + Date.now(),
	a: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath: ARTIFACT_URL, provenance },
	b: { rotationDeg: 0, fps: 20, frames: FRAMES, artifactPath: ARTIFACT_URL, provenance },
};
const payloadJson = JSON.stringify(takePayload);

/* ------- the /ardy fetch stub (installed BEFORE the document loads) ------- */
// The app probes the sidecar once at mount (checkBridge -> /ardy/health) and
// lists bases (/ardy/bases); without a stub the ARDY form never renders and
// generation is disabled. runArdy POSTs /ardy/generate through the REAL
// client (src/ardy/client.js): the wrapper captures the parsed body at the
// network edge and streams the ndjson events the current responder script
// returns, so the app's own commit/verification logic decides what happens
// next. The responder and the capture list live on window so the suite can
// swap scenarios between generations.
const WRAPPER_SOURCE = `(() => {
	if (window.__ardyWrapped) return;
	window.__ardyWrapped = true;
	window.__ardyCapture = [];
	window.__ardyRespond = null;
	window.__ardyRespondError = null;
	const origFetch = window.fetch.bind(window);
	window.fetch = (input, init) => {
		const url = typeof input === "string" ? input : (input && input.url) || "";
		if (url.includes("/ardy/health")) {
			return Promise.resolve(new Response(JSON.stringify({ ok: true, host: "verify-ardy-request", encoder: "test", device: "test" }), { status: 200, headers: { "Content-Type": "application/json" } }));
		}
		if (url.includes("/ardy/bases")) {
			return Promise.resolve(new Response(JSON.stringify({ bases: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
		}
		if (url.includes("/ardy/generate")) {
			let body = null;
			try {
				body = JSON.parse((init && init.body) || "{}");
			} catch {
				body = { parseError: String((init && init.body) || "") };
			}
			window.__ardyCapture.push(body);
			let events = null;
			try {
				events = window.__ardyRespond ? window.__ardyRespond(body) : null;
			} catch (err) {
				window.__ardyRespondError = String(err && err.message);
				events = null;
			}
			const lines = Array.isArray(events) ? events.map((e) => JSON.stringify(e)).join("\\n") + "\\n" : "";
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(lines));
					controller.close();
				},
			});
			return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }));
		}
		return origFetch(input, init);
	};
})();`;

// A plain successful generation: status + done, no report and no returned
// motion (so the loaded take keeps driving the next scenario).
const responderPlain = `(body) => [ { event: "status", message: "verify-ardy-request" }, { event: "done", output: "ardy-request-test", bytes: 42 } ]`;
// A VERIFIED commit: the report acknowledges every motionEdit frame, and the
// done event returns the currently loaded clip's own (valid) npz url so the
// real loadMotion decode path succeeds before the commit block runs.
const responderVerified = `(body) => [ { event: "status", message: "verify-ardy-request" }, { event: "report", report: { commit_verified: true, committed_keys: body.motionEdit.edits.map((e) => e.frame) } }, { event: "done", output: "ardy-request-test", bytes: 42, motionUrl: window.__cozyclay.motion.url } ]`;
// An UNVERIFIED commit: the report refuses, the request is answered, and the
// app's own verification gate must refuse to commit.
const responderUnverified = `(body) => [ { event: "status", message: "verify-ardy-request" }, { event: "report", report: { commit_verified: false } }, { event: "done", output: "ardy-request-test", bytes: 42 } ]`;

/* -------------------------------------- boot ------------------------------ */
await send("Runtime.enable");
// Page.enable must precede addScriptToEvaluateOnNewDocument: without it the
// registration is accepted but never fires on the next navigation (observed
// as a boot where __ardyWrapped stays undefined and the bridge probe answers
// 502, leaving the ARDY form disabled). A freshly launched QA browser can
// sit on about:blank, where touching localStorage throws SecurityError —
// wait for the app document first.
await send("Page.enable");
for (let i = 0; i < 100 && !(await evaluateSafely("location.href.startsWith('http')")); i += 1) await sleep(200);
// Persistence must never poison the suite mid-run (same discipline as
// verify-object-gizmo.mjs): clear the clip and scene keys, pin the locale,
// then install the fetch stub and reload so the app boots against it.
await evaluate("localStorage.removeItem('cozyclay.clips.v1'); localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine'); localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.addScriptToEvaluateOnNewDocument", { source: WRAPPER_SOURCE });
await send("Page.reload");
for (let i = 0; i < 150 && !(await evaluateSafely("!!document.querySelector('canvas')")); i += 1) await sleep(200);
// The QA hooks render in the same commit as the canvas; the rig loads over
// HTTP after the character mounts, and the IK chains resolve from the rig —
// boot is not complete until all of them (and the fetch stub) are live.
for (let i = 0; i < 100 && !(await evaluateSafely("!!window.__cozyclay && !!window.__takeHistory && !!window.__sceneHistory && !!window.__cozyclay.rigA && !!window.__cozyclay.ikChains && !!window.__cozyclay.ik && window.__ardyWrapped === true && Array.isArray(window.__ardyCapture) && document.querySelectorAll('.hierarchy-row').length > 0")); i += 1) await sleep(200);
await sleep(1200);
const bootState = await evaluate("({ hooks: typeof window.__cozyclay === 'object', door: typeof window.__cozyclay?.landTake === 'function', chains: !!window.__cozyclay?.ikChains, wrapped: window.__ardyWrapped, capture: Array.isArray(window.__ardyCapture) })");
expect(
	"the app boots with the QA hooks, the IK chains and the fetch stub live",
	bootState.hooks && bootState.door && bootState.chains && bootState.wrapped === true && bootState.capture,
	JSON.stringify(bootState),
);
// The QA hook's ik IS Subject 1's state: the suite never selects Subject 2,
// so ikSubject stays "A" and runArdy's ikStateA is this same live object.
await evaluate("window.__ikA = window.__cozyclay.ik; true");

/* ------------- S1: unedited prompt blocks -> one segments schedule -------- */
// With two prompt blocks and NO IK edits, the request must NOT pin poses:
// posePin false and the whole rollout rides one `segments` schedule (the
// autoregressive chain). The rendered Motion tab must also expose no
// per-block "Generate selected block" action any more.
await clickFirst("[...document.querySelectorAll('.inspector-tabs button')].find(b => b.textContent.trim() === 'Motion')");
await waitFor("!!document.querySelector('.prompt-block-generate')");
await waitFor("!document.querySelector('.prompt-block-generate').disabled");
expect(
	"the rendered Motion tab has no individual block generation action",
	await evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Generate selected block')") === false,
	"a per-block Generate button is still rendered",
);
expect(
	"the session starts with no clip and no prompt blocks",
	await evaluate("window.__cozyclay.motion === null && [...document.querySelectorAll('.inspector-list button')].filter(b => b.textContent.includes('f')).length === 0"),
);
const addBlock = async (text) => {
	await clickFirst("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Add block at frame'))");
	await waitFor("!!document.querySelector('input[placeholder=\"describe this motion block\"]')");
	await evaluate(
		`(() => { const input = document.querySelector('input[placeholder="describe this motion block"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; })()`,
	);
	await sleep(200);
};
await addBlock("walk");
await addBlock("punch");
await waitFor("!document.querySelector('.prompt-block-generate').disabled");
await evaluate(`window.__ardyRespond = ${responderPlain}; true`);
await click(".prompt-block-generate");
await waitFor("window.__ardyCapture.length === 1", { timeoutMs: 20000 });
await waitFor("!document.querySelector('.prompt-block-generate').disabled");
const body1 = await evaluate("window.__ardyCapture[0]");
expect(
	"S1: unedited prompt blocks ship as ONE segments schedule, unpinned",
	body1 && body1.posePin === false &&
		Array.isArray(body1.segments) && body1.segments.length === 2 &&
		body1.segments[0].startFrame === 0 && body1.segments[0].endFrame === 40 && body1.segments[0].prompt === "walk" &&
		body1.segments[1].startFrame === 40 && body1.segments[1].endFrame === 80 && body1.segments[1].prompt === "punch" &&
		body1.motionEdit === undefined && body1.poses === undefined,
	JSON.stringify(body1).slice(0, 400),
);

/* --------------------------- S2: land the take ---------------------------- */
// The take lands through the REAL door: both clip slots become live 60-frame
// clips and the playhead returns to frame 0, the base every later scenario
// regenerates from.
const takePastBefore = await evaluate("window.__takeHistory().past");
await evaluate(`(async () => { await window.__cozyclay.landTake(${payloadJson}); return true; })()`);
await waitFor(`window.__takeHistory().past === ${takePastBefore + 1}`);
expect(
	"S2: the landing writes both clip slots",
	await evaluate("window.__cozyclay.motion?.frames === 60 && window.__cozyclay.motionB?.frames === 60 && window.__cozyclay.tlFrame === 0"),
	String(await evaluate("window.__cozyclay.motion?.frames + '/' + window.__cozyclay.motionB?.frames")),
);

/* ---- S3: author Subject 1's pending IK keys (live state + real bake) ----- */
// The pending keys are written into the LIVE state object the QA hook
// exposes (window.__cozyclay.ik — the same object runArdy reads as
// ikStateA), with real quaternion values cloned from the resolved chains so
// the app's own ikEvaluate can consume them. The real "Add key at frame N"
// button then bakes the tracked parts at the playhead (frame 0) and bumps
// the real ikTick, so ikFramesA re-derives — the authored state the request
// builder actually sees.
expect(
	"S3: Subject 1 is the selected subject (the hook's ik is A's state)",
	await evaluate("document.querySelector('.inspector-sidebar')?.dataset.inspector !== 'characterB' && window.__cozyclay.ik === window.__ikA"),
);
const injectKeys = async (spec) => {
	const result = await evaluate(`(() => {
		const st = window.__cozyclay.ik;
		const chains = window.__cozyclay.ikChains;
		if (!st || !chains) return "no-ik-state";
		const make = (id) => { const c = chains.get(id); return c ? { q: c.bones.map((b) => b.quaternion.clone()), p: null } : null; };
		${spec.map(([frame, ids]) => `st.keys.set(${frame}, new Map(${JSON.stringify(ids)}.map((id) => [id, make(id)])));`).join("\n\t\t")}
		${JSON.stringify([...new Set(spec.flatMap(([, ids]) => ids))])}.forEach((id) => st.tracked.add(id));
		return ${JSON.stringify(spec.map(([frame, ids]) => [frame, ids]))}.every(([frame, ids]) => ids.every((id) => !!st.keys.get(frame)?.get(id))) ? "ok" : "missing-chain";
	})()`);
	return result;
};
const liveKeys = () =>
	evaluate(`(() => { const st = window.__cozyclay.ik; const out = {}; for (const [frame, map] of st.keys) out[frame] = [...map.keys()]; return out; })()`);
expect("S3: pending IK keys land in the live state", (await injectKeys([[20, ["leftFoot", "rightFoot"]], [50, ["leftFoot"]]])) === "ok");
await clickFirst("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Add key at frame'))");
await waitFor("window.__cozyclay.ik.keys.size === 3");
const liveBefore = await liveKeys();
expect(
	"S3: the baked key state is frames 0, 20, 50 with the tracked joints",
	JSON.stringify(liveBefore) === JSON.stringify({ 0: ["leftFoot", "rightFoot"], 20: ["leftFoot", "rightFoot"], 50: ["leftFoot"] }),
	JSON.stringify(liveBefore),
);

/* ------ S4: no schedule -> posePin true, poses at the key frames, and ----- */
/* ------ the request inherits the CLIP's duration, not the form's ---------- */
// runArdy's duration branch must read motion.frames / motion.fps (60/20 = 3)
// while the duration form still shows the block-era value (4). The poses
// array must be sampled at the constraint set INCLUDING Subject 1's authored
// key frames 20 and 50.
const durationShown = await evaluate("document.querySelector('.foldout:not([hidden]) input[type=number]')?.value");
await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Generate motion')");
await evaluate(`window.__ardyRespond = ${responderPlain}; true`);
await clickFirst("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Generate motion')");
await waitFor("window.__ardyCapture.length === 2", { timeoutMs: 20000 });
await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Generate motion')");
const body2 = await evaluate("window.__ardyCapture[1]");
const poseFrames = Array.isArray(body2?.poses) ? body2.poses.map((p) => p.frame) : [];
expect(
	"S4: the duration form still shows 4 s (the discriminator)",
	durationShown === "4",
	`form shows ${durationShown}`,
);
expect(
	"S4: regeneration inherits the loaded clip's duration (3 s), not the form's 4 s",
	body2 && body2.duration === 3,
	`request duration ${body2?.duration}`,
);
expect(
	"S4: a loaded clip with pending IK pins the regeneration (posePin + poses at the key frames)",
	body2 && body2.posePin === true && Array.isArray(body2.poses) && poseFrames.includes(20) && poseFrames.includes(50),
	`posePin ${body2?.posePin}, pose frames [${poseFrames}]`,
);
expect(
	"S4: the no-schedule request carries neither segments nor motionEdit",
	body2 && body2.segments === undefined && body2.motionEdit === undefined,
	JSON.stringify(body2).slice(0, 300),
);

/* --------- S5: IK-edited blocks -> motionEdit with EXACT tracks, then ----- */
/* --------- the VERIFIED commit records the edits and clears pending IK ---- */
// With a schedule AND authored keys inside it, the request must switch to
// the motion-edit session: sourceMotion is the loaded clip's own url, the
// span covers the edited blocks, and every edit's tracks are EXACTLY the
// tracked joints in Subject 1's live key map for that frame — nothing more.
// The scripted report then VERIFIES the commit (commit_verified true,
// committed_keys covering every edit frame) and returns the clip's own npz
// url, so the app's real loadMotion + commit block must record the edits in
// committedIkEdits and clear the pending IK.
await waitFor("!document.querySelector('.prompt-block-generate').disabled");
// Snapshot the pending keys BEFORE the run: the verified commit clears them
// right after the response lands, so a post-run read would compare the
// request against an already-emptied state (a race, not a wiring change).
const live3 = await liveKeys();
await evaluate(`window.__ardyRespond = ${responderVerified}; true`);
await click(".prompt-block-generate");
await waitFor("window.__ardyCapture.length === 3", { timeoutMs: 20000 });
const body3 = await evaluate("window.__ardyCapture[2]");
const edits3 = body3?.motionEdit?.edits ?? [];
expect(
	"S5: IK-edited blocks ship a motionEdit session anchored at the loaded clip",
	body3 && body3.motionEdit && body3.motionEdit.sourceMotion === (await evaluate("window.__cozyclay.motion.url")) &&
		body3.motionEdit.startFrame === 0 && body3.motionEdit.endFrame === 60 &&
		body3.motionEdit.contextBefore === 40 && body3.motionEdit.contextAfter === 20 &&
		body3.poses === undefined && body3.segments === undefined && body3.posePin === true,
	JSON.stringify(body3?.motionEdit).slice(0, 300),
);
expect(
	"S5: the edit frames are exactly Subject 1's pending key frames",
	JSON.stringify(edits3.map((e) => e.frame)) === JSON.stringify(Object.keys(live3).map(Number).sort((a, b) => a - b)),
	`edits [${edits3.map((e) => e.frame)}] vs live [${Object.keys(live3)}]`,
);
expect(
	"S5: every edit carries exactly the tracked pending joints from the live key state",
	edits3.length === 3 &&
		edits3.every((e) => JSON.stringify(e.tracks) === JSON.stringify(live3[e.frame] ?? [])) &&
		edits3.every((e) => e.tracks.every((t) => t === "leftFoot" || t === "rightFoot")) &&
		edits3.every((e) => e.pose && typeof e.pose === "object"),
	JSON.stringify(edits3.map((e) => ({ frame: e.frame, tracks: e.tracks }))),
);
await waitFor("window.__cozyclay.committedIkEdits.length === 3", { timeoutMs: 20000 });
expect(
	"S5: a verified commit records the edits in committedIkEdits",
	JSON.stringify(await evaluate("window.__cozyclay.committedIkEdits")) ===
		JSON.stringify(edits3.map(({ frame, tracks }) => ({ frame, tracks }))),
	String(JSON.stringify(await evaluate("window.__cozyclay.committedIkEdits"))),
);
expect(
	"S5: pending IK clears only after the exact commit verification",
	await evaluate("window.__cozyclay.ik.keys.size === 0 && window.__cozyclay.ik.tracked.size === 0 && window.__cozyclay.motion?.frames === 60"),
	String(await evaluate("window.__cozyclay.ik.keys.size + '/' + window.__cozyclay.ik.tracked.size")),
);

/* --------- S6: an UNVERIFIED commit leaves the pending IK intact ---------- */
// Fresh keys on top of the cleared state, the same request shape, but the
// report now refuses verification: the app's gate must surface the exact
// error, must NOT grow committedIkEdits, and must leave every pending key
// (and the tracked set) exactly where it was.
expect("S6: fresh pending keys land in the live state", (await injectKeys([[25, ["leftFoot"]], [55, ["leftFoot"]]])) === "ok");
await clickFirst("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Add key at frame'))");
await waitFor("window.__cozyclay.ik.keys.size === 3");
const live6 = await liveKeys();
await waitFor("!document.querySelector('.prompt-block-generate').disabled");
await evaluate(`window.__ardyRespond = ${responderUnverified}; true`);
await click(".prompt-block-generate");
await waitFor("window.__ardyCapture.length === 4", { timeoutMs: 20000 });
const body4 = await evaluate("window.__ardyCapture[3]");
const edits4 = body4?.motionEdit?.edits ?? [];
expect(
	"S6: the unverified run still sends the exact tracked-key request",
	JSON.stringify(edits4.map((e) => e.frame)) === JSON.stringify(Object.keys(live6).map(Number).sort((a, b) => a - b)) &&
		edits4.every((e) => JSON.stringify(e.tracks) === JSON.stringify(live6[e.frame] ?? [])),
	JSON.stringify(edits4.map((e) => ({ frame: e.frame, tracks: e.tracks }))),
);
await waitFor("document.querySelector('.ardy-outcome.error')?.textContent.includes('ARDY returned motion without verified authored IK keys')");
expect(
	"S6: failed key verification surfaces the refusal",
	await evaluate("document.querySelector('.ardy-outcome.error')?.textContent.includes('ARDY returned motion without verified authored IK keys')") === true,
);
const state6 = await evaluate("(() => { const st = window.__cozyclay.ik; return { size: st.keys.size, tracked: st.tracked.size, frames: [...st.keys.keys()].sort((a, b) => a - b), committed: window.__cozyclay.committedIkEdits.length }; })()");
// The tracked set holds exactly the ids S6 re-injected (leftFoot): S5's
// VERIFIED commit cleared the previous set, so this count proves the
// unverified run neither cleared the pending keys nor the tracked set.
expect(
	"S6: failed key verification leaves the pending IK intact",
	state6.size === 3 && state6.tracked === 1 && state6.frames.includes(25) && state6.frames.includes(55) && state6.frames.includes(0) &&
		JSON.stringify(state6.frames) === JSON.stringify(Object.keys(live6).map(Number).sort((a, b) => a - b)),
	JSON.stringify(state6),
);
expect(
	"S6: a failed verification commits nothing",
	state6.committed === 3,
	`committedIkEdits.length = ${state6.committed}`,
);

expect("no uncaught page errors during the run", pageErrors.length === 0, pageErrors.join(" | "));

console.log(failures ? `\nfailures: ${failures}` : "\nall ARDY request observations PASS");
process.exit(failures ? 1 : 0);

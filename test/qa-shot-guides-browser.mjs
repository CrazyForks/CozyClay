#!/usr/bin/env node
// Browser QA for composition guides + burn-in, driven over CDP through the QA
// browser wrapper: cycle the guide button and read the real overlay DOM, then
// exercise the Canvas-2D stamp rasterizer inside the page. Evidence script;
// not part of the manifest.
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(120);
	}
	return false;
};
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

expect("app becomes ready", await waitFor("!!document.querySelector('.add-object-trigger')", 30000));

// --- guide cycle over the real DOM ----------------------------------------
const cycle = "document.querySelector('.vp-guide-cycle')";
const overlay = "document.querySelector('.vp-shot-preview .shot-guides')";
expect("the shot preview offers the guide button", await evaluate(`!!${cycle}`));
expect("guides start off (no overlay drawn)", await evaluate(`!${overlay}`));

await evaluate(`${cycle}.click()`);
expect("first click shows thirds", await waitFor(`${overlay}?.dataset.guideMode === "thirds"`, 8000));
expect("thirds draws four hairlines", await evaluate(`${overlay}?.querySelectorAll("line").length === 4`));

await evaluate(`${cycle}.click()`);
expect("second click shows golden", await waitFor(`${overlay}?.dataset.guideMode === "golden"`, 8000));

await evaluate(`${cycle}.click()`);
expect("third click shows center + diagonals", await waitFor(`${overlay}?.dataset.guideMode === "center"`, 8000));

await evaluate(`${cycle}.click()`);
expect("fourth click shows safe areas as two rects", await waitFor(`${overlay}?.dataset.guideMode === "safe" && ${overlay}?.querySelectorAll("rect").length === 2`, 8000));
expect("the preference is stored under its own key", await evaluate(`localStorage.getItem("cozyclay.shot-guides.v1") === "safe"`));

// The overlay never eats the pointer: the element under the frame centre is
// not the guides layer.
expect("guides are pointer-transparent", await evaluate(`(() => {
	const box = document.querySelector('.vp-shot-preview').getBoundingClientRect();
	const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
	return !hit?.closest?.('.shot-guides');
})()`));

// --- persistence across reload --------------------------------------------
await send("Page.enable");
await send("Page.reload", { ignoreCache: false });
await sleep(1000);
expect("app returns after reload", await waitFor(`!!${cycle}`, 30000));
expect("the guide mode survives the reload", await waitFor(`${overlay}?.dataset.guideMode === "safe"`, 8000));

// --- look-through carries the same overlay --------------------------------
await evaluate("document.querySelector('.vp-look-through').click()");
await sleep(400);
expect("look-through draws the letterbox-fitted overlay", await evaluate("!!document.querySelector('.shot-guides.lookthrough')"));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
expect("Esc leaves look-through and drops its overlay", await evaluate("!document.querySelector('.shot-guides.lookthrough')"));

// back to off for a clean slate
await evaluate(`${cycle}.click()`);
expect("fifth click wraps back to off", await waitFor(`!${overlay}`, 8000));

// --- burn-in rasterizer inside the real browser ---------------------------
const stampProbe = await evaluate(`(async () => {
	const m = await import("/src/burn-in.js");
	const bitmap = m.renderStampBitmap("MEDIUM SHOT 35MM · F 0042");
	let inked = 0;
	for (let index = 3; index < bitmap.data.length; index += 4) if (bitmap.data[index] > 0) inked += 1;
	// composite over an opaque black frame and count changed pixels
	const width = 320, height = 180;
	const frame = new Uint8Array(width * height * 4);
	for (let index = 3; index < frame.length; index += 4) frame[index] = 255;
	m.compositeStamp(frame, width, height, bitmap, { marginX: 8, marginY: 8 });
	let changed = 0;
	for (let index = 0; index < frame.length; index += 4) {
		if (frame[index] || frame[index + 1] || frame[index + 2]) changed += 1;
	}
	const wrapped = m.burnInCapture(() => {
		const raw = new Uint8Array(width * height * 4);
		for (let index = 3; index < raw.length; index += 4) raw[index] = 255;
		return raw;
	}, { width, height, slate: "Wide 24mm", frameCount: 360 });
	const stamped = wrapped(7);
	let stampedChanged = 0;
	for (let index = 0; index < stamped.length; index += 4) {
		if (stamped[index] || stamped[index + 1] || stamped[index + 2]) stampedChanged += 1;
	}
	return { width: bitmap.width, height: bitmap.height, inked, changed, stampedChanged };
})()`);
expect("the stamp bitmap has body", stampProbe.width > 100 && stampProbe.height >= 20, JSON.stringify(stampProbe));
expect("the rasterized text actually inked pixels", stampProbe.inked > stampProbe.width * stampProbe.height * 0.5, `inked=${stampProbe.inked}`);
expect("compositing lights up frame pixels", stampProbe.changed > 500, `changed=${stampProbe.changed}`);
expect("burnInCapture stamps a captured frame", stampProbe.stampedChanged > 500, `stamped=${stampProbe.stampedChanged}`);

// --- export wiring pin ----------------------------------------------------
const fs = await import("node:fs");
const appSource = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
expect("the exporter routes frames through the burn-in", appSource.includes("capture: burnInCapture(applyExportFrame"));

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-shot-guides-browser: all checks passed");
process.exit(0);

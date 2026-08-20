#!/usr/bin/env node
// Browser contract for the camera rail deletion affordance. The math and
// persistence model are covered by node tests; this proves the actual editor
// button is visible, removes the authored rail, and persists Follow mode.
import { writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

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
const waitFor = async (expression, timeoutMs = 10000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:5180/app/" });
await waitFor("location.href.startsWith('http')");
await evaluate(`(() => {
	const shot = {
		id: "rail-qa",
		name: "Rail QA",
		startFrame: 0,
		endFrame: 359,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 3 }, yaw: 0, pitch: -0.1, fovDeg: 45 } }],
		camera: {
			mode: "rail",
			followCam: { distance: 3, height: 1.6, response: 0.7, lead: 0.25, railStartMode: "head", maxDollySpeed: 4, pitchOffsetDeg: 0 },
			cameraRail: [{ x: -2, z: -1 }, { x: -2, z: 8 }],
			railFollow: { mode: "range", startFrame: 0, endFrame: 359 },
		},
	};
	const scene = {
		version: 4,
		activeSceneId: "scene-rail-qa",
		scenes: [{
			id: "scene-rail-qa",
			name: "RAIL QA",
			objects: [],
			shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.scenes.v4", JSON.stringify(scene));
})()`);
await send("Page.reload");
expect("studio renders", await waitFor("!!document.querySelector('canvas')"));
expect("timeline shot block renders", await waitFor("!!document.querySelector('.tl-shot-block')"));
await evaluate("document.querySelector('.tl-shot-block')?.click()");
expect("rail editor exposes delete action", await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Delete rail')"));
expect("follow distance is visible before deletion", await evaluate("[...document.querySelectorAll('.tl-camera-editor label')].some((label) => label.textContent.includes('Distance') && label.textContent.includes('3.00'))"));
if (process.env.QA_SCREENSHOT) {
	const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	writeFileSync(process.env.QA_SCREENSHOT, Buffer.from(capture.data, "base64"));
}
await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Delete rail')?.click()");
expect("delete action leaves Follow mode", await waitFor("document.querySelector('.tl-camera-slate')?.textContent.includes('Camera preview')"));
expect("rail delete toast is shown", await evaluate("document.body.textContent.includes('Camera rail deleted')"));
expect("live Follow camera holds the displayed 3 m distance", await waitFor(`(() => {
	const state = window.__cozyclay;
	if (!state?.shotCam || !state?.charA) return false;
	return Math.abs(Math.hypot(state.shotCam.position.x - state.charA.x, state.shotCam.position.z - state.charA.z) - 3) < 0.05;
})()`));
expect("rail deletion reaches the debounced Scene save", await waitFor(`(() => {
	const body = JSON.parse(localStorage.getItem("cozyclay.scenes.v4"));
	const camera = body.scenes[0].shotDocument.shots[0].camera;
	return camera.mode === "follow" && camera.cameraRail === null && camera.railFollow === null;
})()`));
const persisted = await evaluate(`(() => {
	const body = JSON.parse(localStorage.getItem("cozyclay.scenes.v4"));
	const camera = body.scenes[0].shotDocument.shots[0].camera;
	return { mode: camera.mode, cameraRail: camera.cameraRail, railFollow: camera.railFollow };
})()`);
expect("deleted rail persists as Follow without geometry", persisted.mode === "follow" && persisted.cameraRail === null && persisted.railFollow === null, JSON.stringify(persisted));
await send("Page.reload");
expect("studio returns after reload", await waitFor("!!document.querySelector('canvas')"));
expect("shot block returns after reload", await waitFor("!!document.querySelector('.tl-shot-block')"));
await evaluate("document.querySelector('.tl-shot-block')?.click()");
expect("Follow mode survives reload", await waitFor("document.querySelector('.tl-camera-slate')?.textContent.includes('Camera preview')"));
await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Inspector')?.click()");
await evaluate("[...document.querySelectorAll('.hierarchy-row')].find((row) => row.textContent.trim() === 'Camera')?.click()");
const followButtons = () => evaluate("[...document.querySelectorAll('button')].map((button) => ({ text: button.textContent.trim(), pressed: button.getAttribute('aria-pressed'), visible: !!(button.offsetWidth || button.offsetHeight) })).filter((button) => button.text.includes('Follow') || button.pressed !== null)");
expect(
	"Inspector shows Follow On explicitly",
	await waitFor(`[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === "Follow On" && button.getAttribute("aria-pressed") === "true")`),
	JSON.stringify(await followButtons()),
);
await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Follow On')?.click()");
expect("Follow Off is explicit after toggle", await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Follow Off' && button.getAttribute('aria-pressed') === 'false')"));
await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Follow Off')?.click()");
expect("Follow On restores after toggle", await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Follow On' && button.getAttribute('aria-pressed') === 'true')"));

ws.close();
if (failures) process.exit(1);
console.log("all camera rail browser checks PASS");

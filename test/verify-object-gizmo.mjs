#!/usr/bin/env node
/**
 * Scene objects, end to end in a real browser.
 *
 * Creation and direct manipulation cannot be proved by unit tests: the
 * transform maths lives in scene-objects.js (verify-scene-objects.mjs covers
 * it), but "can you actually grab the arrow" depends on the camera's
 * letterboxed sub-rect, the layer masks and the pointer-capture order — all of
 * which only exist in a running page. This drives Chrome over CDP with real
 * pointer input: add a cube from the catalogue, drag it with the move gizmo,
 * spin it with a rotate ring, select it by clicking it in the shot view, drive
 * the same record from the bird's-eye board, and remove it.
 *
 * Run: `npm run dev:ui` in one shell, then `npm run test:objects`, which
 * launches the headless QA browser against QA_URL (default 127.0.0.1:5180).
 */

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
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	// Uncaught script errors only. Network log entries are environmental here:
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const ALT = 1; // CDP modifier bits
// macOS turns Ctrl+left into a secondary click, which is why Unity's snap
// modifier is Cmd there; drive whichever one this platform actually delivers.
const SNAP_MODIFIER = process.platform === "darwin" ? 4 : 2;
const mouse = (type, x, y, { button = "left", modifiers = 0 } = {}) =>
	send("Input.dispatchMouseEvent", {
		type,
		x: Math.round(x),
		y: Math.round(y),
		button,
		clickCount: 1,
		buttons: type === "mouseReleased" ? 0 : BUTTON_MASK[button],
		modifiers,
	});
const drag = async (from, to, options = {}) => {
	const steps = options.steps ?? 14;
	await mouse("mousePressed", from.x, from.y, options);
	for (let i = 1; i <= steps; i++) {
		await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, options);
		await sleep(16);
	}
	await mouse("mouseReleased", to.x, to.y, options);
	await sleep(150);
};
const pressKey = async (key, code) => {
	const params = { key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
	await sleep(250);
};
/** the inspector's Transform rows, as { Position: [x,y,z], Rotation: [...], Scale: [...] } */
const transform = () =>
	evaluate(
		"Object.fromEntries([...document.querySelectorAll('.inspector-pane .vec3-row')].map(r => [r.querySelector('.vec3-label').textContent, [...r.querySelectorAll('input')].map(i => parseFloat(i.value))]))",
	);
const click = (selectorExpression) => evaluate(`${selectorExpression}.click()`);

await send("Runtime.enable");

for (let i = 0; i < 100 && !(await evaluate("!!document.querySelector('canvas')")); i++) await sleep(200);
expect("the studio renders a canvas", await evaluate("!!document.querySelector('canvas')"));
await sleep(1500);

/* ------------------------------------------------------- creation ---- */

expect("the hierarchy offers an Add object control", await evaluate("!!document.querySelector('.add-object-trigger')"));
await click("document.querySelector('.add-object-trigger')");
await sleep(150);
const catalogue = await evaluate("[...document.querySelectorAll('.add-object-item')].map(b => b.textContent)");
expect(
	"the catalogue lists primitives and set pieces",
	["Cube", "Sphere", "Capsule", "Cylinder", "Cone", "Plane", "Chair", "Car"].every((label) =>
		catalogue.some((entry) => entry.startsWith(label)),
	),
	JSON.stringify(catalogue),
);

await click("[...document.querySelectorAll('.add-object-item')].find(b => b.textContent.startsWith('Cube'))");
await sleep(400);
expect("the new object opens in the inspector", Object.keys(await transform()).join() === "Position,Rotation,Scale", JSON.stringify(await transform()));
expect("the new object appears in the hierarchy", await evaluate("[...document.querySelectorAll('.hierarchy-label')].some(n => n.textContent === 'Cube')"));
expect("the new object exists in the 3D scene", await evaluate("window.__gizmoHandles().length > 0"));
// Unity creates primitives axis-aligned. Objects used to be turned to face the
// camera, which left every box skewed against the room and the character (whose
// own rotation starts at 0), so equal rotation values did not mean equal facing.
expect("a new object is created unrotated", JSON.stringify((await transform()).Rotation) === "[0,0,0]", JSON.stringify(await transform()));
/* ---------------------------------------------------- move gizmo ----- */

await sleep(1200); // the shot camera eases after a scene change: grab where the arrow IS
const beforeMove = await transform();
const arrows = await evaluate("window.__gizmoHandles()");
expect("the move gizmo exposes three axis arrows", ["x", "y", "z"].every((axis) => arrows.some((handle) => handle.axis === axis)), JSON.stringify(arrows));
const xArrow = arrows.find((handle) => handle.axis === "x");
expect("the X arrow is grabbable where it is drawn", await evaluate(`window.__gizmoPick(${Math.round(xArrow.x)}, ${Math.round(xArrow.y)}) === 'x'`));
await drag(xArrow, { x: xArrow.x + 140, y: xArrow.y });
const afterMove = await transform();
expect("dragging the X arrow slides the object along X", Math.abs(afterMove.Position[0] - beforeMove.Position[0]) > 0.2, JSON.stringify(afterMove));
expect("an X drag leaves the other axes alone", afterMove.Position[1] === beforeMove.Position[1] && afterMove.Position[2] === beforeMove.Position[2]);

/* --------------------------------------------------- rotate gizmo ---- */

await pressKey("e", "KeyE");
expect("E selects the rotate tool", await evaluate("[...document.querySelectorAll('.gizmo-modes button')].find(b => b.classList.contains('active')).textContent.startsWith('Rotate')"));
await sleep(1200);
const rings = await evaluate("window.__gizmoHandles()");
expect("rotate mode shows one ring per axis plus the screen ring", ["x", "y", "z", "screen"].every((axis) => rings.some((handle) => handle.axis === axis)), JSON.stringify(rings));
// Rings overlap on screen; grab a spot whose whole neighbourhood picks Y so the
// press cannot land on the X ring instead.
const ringGrab = await evaluate(
	"(() => { const c = window.__gizmoHandles().find(h => h.axis === 'y');" +
		" const solid = (x, y) => [[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'y');" +
		" for (let r = 8; r < 260; r += 2) { for (let a = 0; a < 360; a += 15) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" if (solid(x, y)) return { x, y }; } } return null; })()",
);
expect("the Y ring is grabbable on screen", !!ringGrab);
const beforeRotate = await transform();
await drag(ringGrab, { x: ringGrab.x + 96, y: ringGrab.y + 60 });
const afterRotate = await transform();
expect("dragging the Y ring turns the object", afterRotate.Rotation[1] !== beforeRotate.Rotation[1], JSON.stringify(afterRotate));
expect("a Y ring drag leaves tilt and roll alone", afterRotate.Rotation[0] === beforeRotate.Rotation[0] && afterRotate.Rotation[2] === beforeRotate.Rotation[2]);
expect("snapping on, rotation lands on the 5 degree detents", afterRotate.Rotation[1] % 5 === 0, String(afterRotate.Rotation[1]));
// The outer camera-facing ring rolls about the view axis (Unity §3.3).
const screenGrab = await evaluate(
	"(() => { const c = window.__gizmoHandles().find(h => h.axis === 'screen'); if (!c) return null;" +
		" const solid = (x, y) => [[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'screen');" +
		" for (let r = 10; r < 320; r += 2) { for (let a = 0; a < 360; a += 15) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" if (solid(x, y)) return { x, y }; } } return null; })()",
);
expect("the screen-space ring is grabbable", !!screenGrab);
if (screenGrab) {
	const beforeRoll = await transform();
	await drag(screenGrab, { x: screenGrab.x + 70, y: screenGrab.y + 50 });
	const afterRoll = await transform();
	expect("the screen ring rolls the object about the view axis", JSON.stringify(afterRoll.Rotation) !== JSON.stringify(beforeRoll.Rotation), `${JSON.stringify(beforeRoll.Rotation)} -> ${JSON.stringify(afterRoll.Rotation)}`);
	expect("the screen ring never moves or scales the object", JSON.stringify(afterRoll.Position) === JSON.stringify(beforeRoll.Position) && JSON.stringify(afterRoll.Scale) === JSON.stringify(beforeRoll.Scale));
}

await pressKey("w", "KeyW");
expect("W returns to the move tool", await evaluate("[...document.querySelectorAll('.gizmo-modes button')].find(b => b.classList.contains('active')).textContent.startsWith('Move')"));

/* ---------------------------------------------------- scale gizmo ---- */

await pressKey("r", "KeyR");
expect("R selects the scale tool", await evaluate("[...document.querySelectorAll('.gizmo-modes button')].find(b => b.classList.contains('active')).textContent.startsWith('Scale')"));
await sleep(1200);
const knobs = await evaluate("window.__gizmoHandles()");
expect("scale mode exposes three axis knobs", new Set(knobs.map((handle) => handle.axis)).size >= 3, JSON.stringify(knobs));
const yKnob = knobs.find((handle) => handle.axis === "y");
const beforeScale = await transform();
// pull the Y knob further from the pivot: straight up on screen
await drag(yKnob, { x: yKnob.x, y: yKnob.y - 120 });
const afterScale = await transform();
expect("dragging the Y knob scales height", afterScale.Scale[1] > beforeScale.Scale[1], JSON.stringify(afterScale));
expect("a Y knob drag leaves the other axes alone", afterScale.Scale[0] === beforeScale.Scale[0] && afterScale.Scale[2] === beforeScale.Scale[2]);
expect("scale lands on 5 percent steps", Math.abs(afterScale.Scale[1] * 20 - Math.round(afterScale.Scale[1] * 20)) < 1e-6, String(afterScale.Scale[1]));
await pressKey("w", "KeyW");

/* ------------------------------------------------------ selection ---- */

const objectCentre = await evaluate(
	"(() => { const g = window.__gizmoHandles(); const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 }); return { x: Math.round(c.x), y: Math.round(c.y) }; })()",
);
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('SHOT 01'))");
await sleep(300);
expect("selecting something else drops the gizmo", await evaluate("window.__gizmoHandles().length === 0"));
await mouse("mousePressed", objectCentre.x, objectCentre.y);
await mouse("mouseReleased", objectCentre.x, objectCentre.y);
await sleep(400);
expect("clicking the object in the shot view selects it", await evaluate("window.__gizmoHandles().length > 0"));

/* ------------------------------ selection vs the camera (Unity) ------ */

// The reported fight: a press on an object both selected it AND slid it, and a
// press on empty space flew the camera, so aiming at something moved the set.
// Unity's split is what is asserted here — left is content, right/middle/Alt is
// the camera. (docs/unity-reference.md §1, §6, §9.6)
const gizmoPose = () => evaluate("JSON.stringify(window.__gizmoHandles().map(h => [Math.round(h.x), Math.round(h.y)]))");
const beforeBody = await transform();
// somewhere on the body that is NOT under a gizmo handle
const bodyGrab = await evaluate(
	"(() => { const g = window.__gizmoHandles(); const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 });" +
		" for (let dy = 20; dy < 200; dy += 6) { const x = Math.round(c.x); const y = Math.round(c.y + dy);" +
		" if (!window.__gizmoPick(x, y) && window.__objectPick(x, y)) return { x, y }; } return null; })()",
);
expect("the object body is pickable away from the handles", !!bodyGrab);
const poseBeforeBodyDrag = await gizmoPose();
await drag(bodyGrab, { x: bodyGrab.x + 110, y: bodyGrab.y + 40 });
expect("dragging the object body does NOT transform it", JSON.stringify(await transform()) === JSON.stringify(beforeBody), JSON.stringify(await transform()));
expect("dragging the object body does NOT fly the camera", (await gizmoPose()) === poseBeforeBodyDrag);

// Empty space: a left press clears the selection instead of flying.
await drag({ x: 60, y: 120 }, { x: 240, y: 210 });
expect("a left drag on empty space clears the selection and leaves the camera", await evaluate("window.__gizmoHandles().length === 0"));

// Right-drag is the camera.
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await sleep(300);
expect("the object is selectable again from the hierarchy", await evaluate("window.__gizmoHandles().length > 0"));
const beforeFly = await transform();
const restPose = await gizmoPose();
await drag({ x: 300, y: 300 }, { x: 420, y: 340 }, { button: "right" });
expect("right-drag flies the camera", (await gizmoPose()) !== restPose, `${restPose} -> ${await gizmoPose()}`);
expect("flying the camera does not move the object", JSON.stringify(await transform()) === JSON.stringify(beforeFly));

// Middle-drag pans, Alt+left orbits — both move the view, neither the object.
const beforePan = await gizmoPose();
await drag({ x: 300, y: 300 }, { x: 360, y: 330 }, { button: "middle" });
expect("middle-drag pans the camera", (await gizmoPose()) !== beforePan);
const beforeOrbit = await gizmoPose();
await drag({ x: 300, y: 300 }, { x: 380, y: 300 }, { modifiers: ALT });
expect("Alt+left orbits the camera", (await gizmoPose()) !== beforeOrbit);
expect("navigation never edits the object", JSON.stringify(await transform()) === JSON.stringify(beforeFly), JSON.stringify(await transform()));

/* ------------------------------------------------- plane handle ------ */

await pressKey("w", "KeyW");
await sleep(900);
const planeGrab = await evaluate(
	"(() => { const g = window.__gizmoHandles(); const c = g.reduce((a, h) => ({ x: a.x + h.x / g.length, y: a.y + h.y / g.length }), { x: 0, y: 0 });" +
		" for (let r = 6; r < 90; r += 2) { for (let a = 0; a < 360; a += 10) {" +
		" const x = Math.round(c.x + r * Math.cos(a * Math.PI / 180)); const y = Math.round(c.y + r * Math.sin(a * Math.PI / 180));" +
		" if (window.__gizmoPick(x, y) === 'plane:xz') return { x, y }; } } return null; })()",
);
expect("the move gizmo offers plane handles", !!planeGrab);
if (planeGrab) {
	const beforePlane = await transform();
	await drag(planeGrab, { x: planeGrab.x + 60, y: planeGrab.y + 30 });
	const afterPlane = await transform();
	expect(
		"the XZ plane handle slides the object on the floor",
		afterPlane.Position[0] !== beforePlane.Position[0] && afterPlane.Position[2] !== beforePlane.Position[2],
		`${JSON.stringify(beforePlane)} -> ${JSON.stringify(afterPlane)}`,
	);
	expect("the XZ plane handle never changes height", afterPlane.Position[1] === beforePlane.Position[1]);
}

/* ------------------------------------------------ snapping polarity -- */

// Snap is on by default, so Ctrl/Cmd gives the free drag.
const beforeFree = await transform();
// The axis proxies are fat and overlap near the pivot, so grab a point whose
// neighbourhood unambiguously picks X — the same trick the ring search uses.
const freeArrow = await evaluate(
	"(() => { const h = window.__gizmoHandles().find(e => e.axis === 'x'); if (!h) return null;" +
		" const solid = (x, y) => [[0,0],[2,0],[-2,0],[0,2],[0,-2]].every(([dx,dy]) => window.__gizmoPick(x+dx, y+dy) === 'x');" +
		" for (let r = 0; r < 60; r += 2) { for (const s of [1, -1]) { const x = Math.round(h.x + r * s); const y = Math.round(h.y);" +
		" if (solid(x, y)) return { x, y }; } } return null; })()",
);
expect("the X arrow has an unambiguous grab point", !!freeArrow);
await drag(freeArrow, { x: freeArrow.x + 37, y: freeArrow.y }, { modifiers: SNAP_MODIFIER });
const afterFree = await transform();
expect("the snap modifier during a drag escapes the grid", afterFree.Position[0] !== beforeFree.Position[0], `${JSON.stringify(beforeFree)} -> ${JSON.stringify(afterFree)}`);
expect(
	"the modified drag lands off the 5 cm detents",
	Math.abs(afterFree.Position[0] * 20 - Math.round(afterFree.Position[0] * 20)) > 1e-9,
	String(afterFree.Position[0]),
);

/* ----------------------------------------------------- plan parity --- */

const beforePlan = await transform();
await click("[...document.querySelectorAll('.viewmode button')].find(b => b.textContent.includes('Bird'))");
await sleep(1200);
const planGrab = await evaluate(
	`(() => { const b = document.querySelector('.vp-main').getBoundingClientRect(); const scale = (b.height / 2) / 7.2;
		return { x: Math.round(b.left + b.width / 2 + ${beforePlan.Position[0]} * scale), y: Math.round(b.top + b.height / 2 + ${beforePlan.Position[2]} * scale) }; })()`,
);
await drag(planGrab, { x: planGrab.x, y: planGrab.y + 60 });
await click("[...document.querySelectorAll('.viewmode button')].find(b => b.textContent.includes('Shot'))");
await sleep(700);
const afterPlan = await transform();
expect("the bird's-eye board drives the same object record", afterPlan.Position[2] !== beforePlan.Position[2], JSON.stringify(afterPlan));

/* ------------------------------------------- creation is world-aligned - */

// A fresh object stays axis-aligned even when the view is somewhere else
// entirely — creation must not inherit the camera's yaw.
await drag({ x: 300, y: 300 }, { x: 460, y: 320 }, { button: "right" });
await click("document.querySelector('.add-object-trigger')");
await sleep(200);
await click("[...document.querySelectorAll('.add-object-item')].find(b => b.textContent.startsWith('Chair'))");
await sleep(600);
expect("an object created from a swung camera is still unrotated", JSON.stringify((await transform()).Rotation) === "[0,0,0]", JSON.stringify(await transform()));
await click("[...document.querySelectorAll('.inspector-pane .btn')].find(b => b.textContent.startsWith('Remove'))");
await sleep(300);
await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await sleep(300);

/* --------------------------------------------- hierarchy actions ----- */

await click("[...document.querySelectorAll('.right-panel-tabs button')].find(b => b.textContent === 'Hierarchy')");
await sleep(250);
const cubeRow = await evaluate(
	"(() => { const row = [...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'));" +
		" if (!row) return null; const r = row.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
);
expect("the hierarchy lists the object row", !!cubeRow);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cubeRow.x, y: cubeRow.y, button: "right", buttons: 2, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cubeRow.x, y: cubeRow.y, button: "right", buttons: 0, clickCount: 1 });
await sleep(250);
const menuItems = await evaluate("[...document.querySelectorAll('.hierarchy-context-menu button, .context-menu button, [role=menu] button')].map(b => b.textContent.trim())");
expect("right-clicking a row offers Rename / Duplicate / Delete / Frame", ["Rename", "Duplicate", "Delete", "Frame"].every((label) => menuItems.some((item) => item.startsWith(label))), JSON.stringify(menuItems));
await pressKey("Escape", "Escape");

/* -------------------------------------------------------- removal ---- */

await click("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('Cube'))");
await sleep(250);
await click("[...document.querySelectorAll('.inspector-pane .btn')].find(b => b.textContent.startsWith('Remove'))");
await sleep(300);
expect("removing the object clears it from the hierarchy", await evaluate("![...document.querySelectorAll('.hierarchy-label')].some(n => n.textContent === 'Cube')"));
expect("the removed object leaves no gizmo behind", await evaluate("window.__gizmoHandles().length === 0"));

expect("the page logged no errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) process.exit(1);
console.log("all scene object browser checks PASS");

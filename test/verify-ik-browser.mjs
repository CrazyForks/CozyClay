#!/usr/bin/env node

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
const waitFor = async (expression, timeoutMs = 5000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return true;
		await sleep(50);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const mouse = (type, x, y, { modifiers = 0 } = {}) => send("Input.dispatchMouseEvent", {
	type,
	x: Math.round(x),
	y: Math.round(y),
	button: "left",
	clickCount: 1,
	buttons: type === "mouseReleased" ? 0 : 1,
	modifiers,
});
const click = async ({ x, y }) => {
	await mouse("mousePressed", x, y);
	await mouse("mouseReleased", x, y);
	await sleep(180);
};
const drag = async (from, to) => {
	await mouse("mousePressed", from.x, from.y);
	for (let i = 1; i <= 8; i++) {
		await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
		await sleep(16);
	}
	await mouse("mouseReleased", to.x, to.y);
	await sleep(180);
};
const altDrag = async (from, to) => {
	await mouse("mousePressed", from.x, from.y, { modifiers: 1 });
	for (let i = 1; i <= 8; i++) {
		await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y, { modifiers: 1 });
		await sleep(16);
	}
	await mouse("mouseReleased", to.x, to.y, { modifiers: 1 });
	await sleep(160);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:5180/app/" });
expect("app becomes ready", await waitFor("!!window.__cozyclay?.rigA && !window.__cozyclay?.ikMode", 10000));

expect("IK toggle exists", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK off");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("IK mode enables", await waitFor("window.__cozyclay?.ikMode === true && !!window.__ikVisibilityDetails"));
await sleep(300);

const front = await evaluate("({ visible: window.__ikVisibleControls(), positions: window.__ikControlScreenPositions() })");
for (const id of ["hips", "spine", "chest", "neck", "head", "leftShoulder", "rightShoulder"]) {
	expect(`front view exposes ${id}`, front.visible.includes(id));
	expect(`front view projects ${id}`, Number.isFinite(front.positions[id]?.x) && front.positions[id]?.exposed === true);
}
const idlePerfStart = await evaluate("window.__ikVisibilityPerformance()");
expect(
	"initial IK visibility pass stays below the interaction-jank threshold",
	idlePerfStart.lastPassMs < 100,
	JSON.stringify(idlePerfStart),
);
await sleep(500);
const idlePerfEnd = await evaluate("window.__ikVisibilityPerformance()");
expect(
	"idle IK reuses its exposure result instead of raycasting every frame",
	idlePerfEnd.passes - idlePerfStart.passes <= 1,
	JSON.stringify({ before: idlePerfStart, after: idlePerfEnd }),
);

await click(front.positions.head);
expect("visible head takes exact focus", await evaluate("window.__cozyclay?.ikFocus === 'head'"));
await click((await evaluate("window.__ikControlScreenPositions()" )).head);
expect("focused head toggles off", await evaluate("window.__cozyclay?.ikFocus === null"));

const stage = await evaluate(`(() => {
	const rect = document.querySelector(".stage").getBoundingClientRect();
	return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
})()`);
let profile = null;
for (let i = 0; i < 8; i++) {
	await altDrag(
		{ x: stage.left + stage.width * 0.18, y: stage.top + stage.height * 0.42 },
		{ x: stage.left + stage.width * 0.28, y: stage.top + stage.height * 0.42 },
	);
	profile = await evaluate("({ details: window.__ikVisibilityDetails(), positions: window.__ikControlScreenPositions() })");
	if (profile.details.leftShoulder.exposed !== profile.details.rightShoulder.exposed) break;
}
const hiddenShoulder = profile.details.leftShoulder.exposed ? "rightShoulder" : "leftShoulder";
const visibleShoulder = hiddenShoulder === "leftShoulder" ? "rightShoulder" : "leftShoulder";
expect("profile separates near and far shoulders", profile.details[hiddenShoulder].exposed === false && profile.details[visibleShoulder].exposed === true);
expect("hidden shoulder keeps a projected test position", Number.isFinite(profile.positions[hiddenShoulder]?.x) && profile.positions[hiddenShoulder].exposed === false);
expect("profile screen-position evidence matches the exposed shoulder mesh", profile.positions[visibleShoulder]?.exposed === true);
const profilePerf = await evaluate("window.__ikVisibilityPerformance()");
expect("camera orbit invalidates cached exposure", profilePerf.passes > idlePerfEnd.passes);
expect(
	"camera-only visibility updates stay within one frame",
	profilePerf.lastPassMs < 20,
	JSON.stringify(profilePerf),
);

await click(profile.positions[hiddenShoulder]);
const hiddenClickFocus = await evaluate("window.__cozyclay?.ikFocus");
expect(
	"hidden shoulder cannot take its own focus",
	hiddenClickFocus !== hiddenShoulder,
	JSON.stringify({ hiddenShoulder, focus: hiddenClickFocus, detail: profile.details[hiddenShoulder] }),
);
const overlapFocus = hiddenClickFocus;
if (overlapFocus) {
	const overlapPosition = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(overlapFocus)}]`);
	await click(overlapPosition);
}
expect("overlapping front-control focus toggles off", await evaluate("window.__cozyclay?.ikFocus === null"));
const currentVisibleShoulder = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(visibleShoulder)}]`);
await click(currentVisibleShoulder);
expect("exposed shoulder remains clickable", await evaluate(`window.__cozyclay?.ikFocus === ${JSON.stringify(visibleShoulder)}`));

expect("IK exit button exists", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK on");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("IK exit clears mode and stale focus", await waitFor("window.__cozyclay?.ikMode === false && window.__cozyclay?.ikFocus === null"));
expect("IK can re-enter for compound manipulator QA", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK off");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("IK re-entry starts clean", await waitFor("window.__cozyclay?.ikMode === true && window.__cozyclay?.ikFocus === null"));
await sleep(250);

const manipulatorControls = await evaluate("window.__ikControlScreenPositions()");
const handTrack = manipulatorControls.leftHand?.exposed ? "leftHand" : "rightHand";
await click(manipulatorControls[handTrack]);
expect("hand focus mounts its compound manipulator", await waitFor(`window.__cozyclay?.ikFocus === ${JSON.stringify(handTrack)} && window.__ikRingVisible()`));
const handCenter = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(handTrack)}]`);
const handPicks = await evaluate(`window.__ikPickScreenPositions().filter((pick) => pick.trackId === ${JSON.stringify(handTrack)})`);
expect(
	"focused hand registers enlarged invisible axis hit volumes",
	handPicks.some((pick) => pick.part === "hit-shaft") && handPicks.some((pick) => pick.part === "hit-tip"),
	JSON.stringify(handPicks),
);
const axisTip = handPicks.find((pick) => pick.part === "tip" && pick.axis === "x") ?? handPicks.find((pick) => pick.part === "tip");
expect("focused hand exposes an axis tip pick target", Number.isFinite(axisTip?.x), JSON.stringify(handPicks));
const axisDx = axisTip.x - handCenter.x;
const axisDy = axisTip.y - handCenter.y;
const axisLength = Math.hypot(axisDx, axisDy) || 1;
const handBeforeAxis = await evaluate(`window.__ikHandlePos(${JSON.stringify(handTrack)})`);
const perfBeforeAxis = await evaluate("window.__ikVisibilityPerformance()");
await drag(axisTip, {
	x: axisTip.x + (axisDx / axisLength) * 36,
	y: axisTip.y + (axisDy / axisLength) * 36,
});
const handAfterAxis = await evaluate(`window.__ikHandlePos(${JSON.stringify(handTrack)})`);
const axisWorldDelta = Math.hypot(
	handAfterAxis.x - handBeforeAxis.x,
	handAfterAxis.y - handBeforeAxis.y,
	handAfterAxis.z - handBeforeAxis.z,
);
const perfAfterAxis = await evaluate("window.__ikVisibilityPerformance()");
expect("axis drag moves the focused hand", axisWorldDelta > 0.005, `delta=${axisWorldDelta}`);
expect("axis drag invalidates the cached exposure", perfAfterAxis.passes > perfBeforeAxis.passes);

const ringPick = (await evaluate(`window.__ikPickScreenPositions().filter((pick) => pick.trackId === ${JSON.stringify(handTrack)})`))
	.find((pick) => pick.part === "ring");
expect("focused hand exposes a swing-ring pick target", Number.isFinite(ringPick?.x));
const movedHandCenter = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(handTrack)}]`);
const ringDx = ringPick.x - movedHandCenter.x;
const ringDy = ringPick.y - movedHandCenter.y;
const ringLength = Math.hypot(ringDx, ringDy) || 1;
const quatBeforeRing = await evaluate(`window.__ikEffectorQuat(${JSON.stringify(handTrack)})`);
await drag(ringPick, {
	x: ringPick.x - (ringDy / ringLength) * 34,
	y: ringPick.y + (ringDx / ringLength) * 34,
});
const quatAfterRing = await evaluate(`window.__ikEffectorQuat(${JSON.stringify(handTrack)})`);
const lastRingPick = await evaluate("window.__ikLastPick");
const quatDot = Math.abs(
	quatBeforeRing.x * quatAfterRing.x +
	quatBeforeRing.y * quatAfterRing.y +
	quatBeforeRing.z * quatAfterRing.z +
	quatBeforeRing.w * quatAfterRing.w
);
const ringAngle = 2 * Math.acos(Math.min(1, quatDot));
expect("swing-ring drag rotates the hand effector", ringAngle > 0.01, JSON.stringify({ ringAngle, lastRingPick }));

expect("final IK exit button exists", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK on");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("final IK exit clears compound focus", await waitFor("window.__cozyclay?.ikMode === false && window.__cozyclay?.ikFocus === null"));
expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) process.exit(1);
console.log("all IK browser checks PASS");

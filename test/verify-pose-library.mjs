#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { BUILT_IN_POSES, POSE_BONES } from "../src/poses.js";

const failures = [];
const expect = (name, condition, detail = "") => {
	if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const originalIds = [
	"tpose",
	"relaxed",
	"contrapposto",
	"walk",
	"seated",
	"arms-crossed",
	"pointing",
	"hands-on-hips",
	"looking-back",
	"hands-up",
];
const newIds = ["wave", "thinking", "crouch", "kneel", "run", "jump"];
const boneIds = new Set(POSE_BONES.map((bone) => bone.id));

expect(
	"existing built-in pose order is unchanged",
	originalIds.every((id, index) => BUILT_IN_POSES[index]?.id === id),
	BUILT_IN_POSES.slice(0, originalIds.length).map((pose) => pose.id).join(", ")
);

const ids = BUILT_IN_POSES.map((pose) => pose.id);
expect("pose ids are unique", new Set(ids).size === ids.length);

for (const id of newIds) {
	const pose = BUILT_IN_POSES.find((candidate) => candidate.id === id);
	expect(`${id} exists`, Boolean(pose));
	expect(`${id} has a beginner-facing category`, Boolean(pose?.category));
	expect(`${id} has several bone deltas`, Object.keys(pose?.bones ?? {}).length >= 4);
	for (const [boneId, value] of Object.entries(pose?.bones ?? {})) {
		expect(`${id}.${boneId} uses an editable bone`, boneIds.has(boneId));
		expect(`${id}.${boneId} is an Euler triple`, Array.isArray(value) && value.length === 3 && value.every(Number.isFinite));
	}
}

const studioSource = readFileSync(new URL("../src/posestudio.jsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
for (const [en, koText] of [["Wave", "손 흔들기"], ["Thinking", "생각하기"], ["Crouch", "웅크리기"], ["Kneel", "무릎 꿇기"], ["Run", "달리기"], ["Jump", "점프"]]) {
	expect(`Pose Studio maps ${en} to Korean for the ko locale`, studioSource.includes(`ko("${en}", "${koText}")`));
}
expect("Pose Studio exposes stable pose id hook", studioSource.includes("data-pose-id={pose.id}"));
expect("Pose Studio exposes save custom hook", studioSource.includes('data-pose-id="save-custom"'));
expect("Pose Studio keeps custom pose labels", studioSource.includes("pose.custom ? pose.label"));
expect("Pose Studio applies its synchronous draft selection", studioSource.includes("onApply(selectedIdRef.current)"));
expect("Pose Studio explains motion ownership", studioSource.includes("data-pose-motion-warning") && studioSource.includes('motionActive ? ko("Clear motion and apply pose"'));
expect("App clears loaded motion before applying a blocking pose", appSource.includes("motionActive={Boolean(motion)}") && appSource.includes("if (hadMotion) clearMotion()"));
expect("Pose Studio keeps tiles inside a scrollable panel", stylesSource.includes(".studio-filters") && stylesSource.includes(".pose-grid") && stylesSource.includes("min-height: 0"));

if (process.env.CDP_PORT) {
	const port = Number(process.env.CDP_PORT);
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
			if (await evaluate(expression)) return true;
			await sleep(100);
		}
		return false;
	};

	await send("Runtime.enable");
	await send("Page.enable");
	await send("Page.navigate", { url: process.env.QA_URL || "http://127.0.0.1:5180/" });
	expect("browser reaches app URL", await waitFor("location.href.startsWith('http')"));
	await evaluate(`(() => {
		localStorage.removeItem("cozyclay.scene.v1");
		localStorage.removeItem("cozyclay.scene.v1.quarantine");
		// The QA browser inherits the host machine locale; assertions are English.
		localStorage.setItem("cozyclay.locale", "en");
	})()`);
	await send("Page.reload");
	await waitFor("!!document.querySelector('canvas')");
	await waitFor("document.querySelectorAll('.hierarchy-row').length > 0");
	await sleep(900);
	await evaluate(`document.querySelector('.subject-box .cam-toggle')?.click()`);
	await waitFor("!!document.querySelector('.pose-studio')");

	expect("browser shows expanded pose hooks", await evaluate("document.querySelectorAll('.pose-tile[data-pose-id]').length >= 17"));
	expect("browser shows new run pose", await evaluate("document.querySelector('[data-pose-id=\"run\"]')?.textContent.includes('Run')"));
	expect("browser shows category filter", await evaluate("[...document.querySelectorAll('.pose-studio .studio-filters button')].some((button) => button.textContent.trim() === 'Action')"));
	await evaluate("[...document.querySelectorAll('.pose-studio .studio-filters button')].find((button) => button.textContent.trim() === 'Action')?.click()");
	await waitFor("document.querySelector('[data-pose-id=\"run\"]') && !document.querySelector('[data-pose-id=\"wave\"]')");
	expect("browser filters action poses", await evaluate("!!document.querySelector('[data-pose-id=\"run\"]') && !!document.querySelector('[data-pose-id=\"jump\"]') && !document.querySelector('[data-pose-id=\"wave\"]')"));
	await evaluate(`(() => {
		document.querySelector('[data-pose-id="run"]')?.click();
		document.querySelector('.pose-studio .studio-actions .btn.primary')?.click();
	})()`);
	await waitFor("!document.querySelector('.pose-studio')");
	await evaluate("document.querySelector('.subject-box .cam-toggle')?.click()");
	await waitFor("!!document.querySelector('.pose-studio')");
	expect("browser applies same-tick filtered pose", await evaluate("document.querySelector('[data-pose-id=\"run\"]')?.classList.contains('active')"));

	ws.close();
}

if (failures.length) {
	console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
	process.exit(1);
}

console.log(`pose library checks PASS (${newIds.length} new poses, ${BUILT_IN_POSES.length} total built-ins)`);

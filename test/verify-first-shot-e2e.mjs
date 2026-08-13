#!/usr/bin/env node
import { readFileSync } from "node:fs";

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
		if (await evaluate(expression)) return true;
		await sleep(100);
	}
	return false;
};
const clickText = (selector, text) => evaluate(`(() => {
	const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
		.find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
	if (!node) return false;
	node.click();
	return true;
})()`);
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

let failures = 0;
const onboardingSource = readFileSync("src/onboarding.jsx", "utf8");
expect("video root path step exposes stable onboarding attrs", onboardingSource.includes('id: "root-path"') && onboardingSource.includes("data-onboarding-optional") && onboardingSource.includes("data-onboarding-coach-step") && onboardingSource.includes("data-onboarding-action"));
expect("video root path step exposes status props", onboardingSource.includes("pathConfigured") && onboardingSource.includes("pathWarning"));
expect("video root path step teaches floor order, timing, top view, and approximate motion", onboardingSource.includes("in order from start to finish") && onboardingSource.includes("“2D Root” lane") && onboardingSource.includes("numbered pins") && onboardingSource.includes("roughly follows"));
await send("Runtime.enable");
await waitFor("location.href.startsWith('http')");
await evaluate(`(() => {
	localStorage.removeItem("cozyclay.scene.v1");
	localStorage.removeItem("cozyclay.scene.v1.quarantine");
	localStorage.removeItem("cozyclay.onboarding.v1");
	// Pin the UI locale: the QA browser inherits the host machine locale, and
	// these assertions are written against the English default.
	localStorage.setItem("cozyclay.locale", "en");
})()`);
await send("Page.reload");
await waitFor("!!document.querySelector('canvas')");
await waitFor("document.querySelectorAll('.hierarchy-row').length > 0");
await sleep(900);

const initialGuide = await evaluate("document.querySelector('.onboarding-guide')?.innerText || ''");
expect("first visit shows a guided E2E coach", initialGuide.includes("Let's build your first shot together"));
expect("camera guidance names the exact controls", initialGuide.includes("Shot type") && initialGuide.includes("Recenter on subject"));
expect("AI handoff guidance is present in the plan", initialGuide.includes("copy the prompt and frame into your AI service"));

await clickText(".onboarding-action", "Open shot settings");
await waitFor("document.querySelector('.inspector-sidebar')?.dataset.inspector === 'shot'");
await clickText(".inspector-sidebar[data-inspector='shot'] .presets button", "Wide");
await waitFor("document.querySelector('[data-onboarding-step=\\\"camera\\\"]')?.classList.contains('done')");
expect("camera step completes after choosing a shot preset", await evaluate("document.querySelector('[data-onboarding-step=\"camera\"]')?.classList.contains('done')"));

await clickText(".onboarding-action", "Choose a pose");
await waitFor("!!document.querySelector('.pose-studio')");
const poseGuide = await evaluate("document.querySelector('.onboarding-coach-card')?.innerText || ''");
expect("pose guidance names the exact controls", poseGuide.includes("“Pose” dropdown") && poseGuide.includes("Apply pose"));
await clickText(".pose-tile", "Walking");
await evaluate("document.querySelector('[data-pose-apply]')?.click()");
await waitFor("document.querySelector('[data-onboarding-step=\\\"pose\\\"]')?.classList.contains('done')");
expect("pose step completes after applying a pose", await evaluate("document.querySelector('[data-onboarding-step=\"pose\"]')?.classList.contains('done')"));

await clickText(".onboarding-action", "Open scene settings");
await waitFor("document.querySelector('.inspector-sidebar')?.dataset.inspector === 'shot'");
await evaluate(`(() => {
	const inputs = [...document.querySelectorAll('.inspector-sidebar[data-inspector="shot"] input[type="text"]')].filter((input) => input.getBoundingClientRect().height > 0);
	const values = ["지수, 따뜻한 니트와 청바지를 입은 인물", "햇살이 들어오는 작은 거실, 화분과 나무 테이블", "따뜻하고 포근한 오후의 영화 같은 조명"];
	for (let i = 0; i < 3; i += 1) {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
		setter.call(inputs[i], values[i]);
		inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
		inputs[i].dispatchEvent(new Event("change", { bubbles: true }));
	}
})()`);
await sleep(250);
expect("description step completes after editing scene inputs", await evaluate("document.querySelector('[data-onboarding-step=\"describe\"]')?.classList.contains('done')"));

await clickText(".onboarding-action", "Show the Generate button");
await waitFor("document.querySelector('.generate')?.getBoundingClientRect().height > 0");
await evaluate("document.querySelector('.generate').click()");
await waitFor("!!document.querySelector('.result-modal')", 15000);
if (await evaluate("!![...document.querySelectorAll('.result-modal button')].find((button) => button.textContent.trim() === 'Copy prompt')")) {
	await clickText(".result-modal button", "Copy prompt");
	await waitFor("document.querySelector('.result-modal')?.innerText.includes('Copied ✓')");
}
if (await evaluate("!![...document.querySelectorAll('.result-modal button')].find((button) => button.textContent.trim() === 'Download frame')")) {
	await clickText(".result-modal button", "Download frame");
}
const resultText = await evaluate("document.querySelector('.result-modal')?.innerText || ''");
expect("make opens the result handoff", Boolean(resultText));
expect("result explains the AI handoff order", resultText.includes("Handing off to your AI") && resultText.includes("Copy prompt"));
expect("result names the downloaded blocking frame", resultText.includes("blocking-frame.png"));
expect("result exposes the copy action", resultText.includes("Copied ✓") || resultText.includes("Copy prompt"));

await clickText(".result-modal button", "✕");
await waitFor("document.querySelector('.onboarding-guide-collapsed')?.innerText.includes('First shot complete')");
expect("the complete journey collapses to a finished state", await evaluate("document.querySelector('.onboarding-guide-collapsed')?.innerText.includes('First shot complete')"));

expect("completed onboarding exposes a reset control", await evaluate("document.querySelector('[data-onboarding-reset]')?.textContent.includes('Start over')"));
await evaluate("document.querySelector('[data-onboarding-reset]')?.click()");
await waitFor("document.querySelector('.onboarding-guide-coach') && document.querySelector('.onboarding-progress')?.innerText.includes('0/')");
expect("reset returns onboarding to the first step", await evaluate("document.querySelector('.onboarding-guide-coach') && document.querySelector('.onboarding-progress')?.innerText.includes('0/')"));

ws.close();
if (failures) process.exit(1);
console.log("first-shot E2E guidance checks PASS");

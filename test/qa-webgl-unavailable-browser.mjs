#!/usr/bin/env node
// Issue #518: prove the studio explains a missing WebGL context without
// obscuring a normally accelerated browser. Run this suite once with
// QA_CHROME_FLAGS="--disable-gpu --disable-software-rasterizer" and once with
// QA_CHROME_FLAGS unset. Screenshots are written to QA_OUT.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-webgl-unavailable-qa";
const disabled = /(?:^|\s)--disable-(?:gpu|software-rasterizer)(?:\s|$)/.test(process.env.QA_CHROME_FLAGS || process.env.CHROME_FLAGS || "");
mkdirSync(out, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

let sequence = 0;
const pending = new Map();
const pageErrors = [];
const consoleErrors = [];
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "unknown page error");
	}
	if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
		consoleErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") || "console error");
	}
	if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
		consoleErrors.push(message.params.entry.text || "browser log error");
	}
	if (!message.id || !pending.has(message.id)) return;
	const request = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) request.reject(new Error(JSON.stringify(message.error)));
	else request.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++sequence;
	const timer = setTimeout(() => {
		pending.delete(id);
		reject(new Error(`CDP timeout: ${method}`));
	}, 45_000);
	pending.set(id, {
		resolve: (value) => { clearTimeout(timer); resolve(value); },
		reject: (error) => { clearTimeout(timer); reject(error); },
	});
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = (expression, label) => evaluate(`new Promise((resolve, reject) => {
	const check = () => {
		try { if (${expression}) { cleanup(); resolve(true); } } catch (error) { cleanup(); reject(error); }
	};
	const cleanup = () => { clearTimeout(timer); observer.disconnect(); };
	const observer = new MutationObserver(check);
	const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for ${label}")); }, 45_000);
	observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	check();
})`);

try {
	await send("Runtime.enable");
	await send("Log.enable");
	await send("Page.enable");
	await waitFor("document.readyState === 'complete' && !!document.querySelector('.app, .crash-screen')", "the studio shell");
	if (disabled) {
		await waitFor("!!document.querySelector('[data-testid=webgl-unavailable]')", "the WebGL-unavailable overlay");
		const details = await evaluate(`(() => {
			const element = document.querySelector('[data-testid="webgl-unavailable"]');
			const style = getComputedStyle(element);
			return { text: element.textContent, visible: style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 };
		})()`);
		assert.equal(details.visible, true, "WebGL-unavailable overlay is visible");
		assert.match(details.text, /3D graphics \(WebGL\) is turned off in this browser/);
		console.log(`PASS GPU disabled: overlay visible with required text`);
	} else {
		await waitFor("!!document.querySelector('.stage canvas') || !!document.querySelector('.crash-screen')", "the WebGL stage");
		assert.equal(await evaluate("document.querySelector('[data-testid=webgl-unavailable]')"), null, "WebGL-unavailable overlay is absent with GPU enabled");
		assert.ok(await evaluate("!!document.querySelector('.stage canvas')"), "GPU-enabled browser renders the stage canvas");
		console.log("PASS GPU enabled: overlay absent and stage canvas present");
	}
	const screenshot = `${out}/task-4-webgl-${disabled ? "off" : "on"}.png`;
	const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
	console.log(`SCREENSHOT ${screenshot}`);
	const expectedWebGLFailure = /^Error: THREE\.WebGLRenderer: Error creating WebGL context\./;
	const unexpectedPageErrors = pageErrors.filter((error) => !(disabled && expectedWebGLFailure.test(error)));
	const expectedConsoleError = (error) =>
		/^Failed to load resource: net::ERR_CONNECTION_REFUSED$/.test(error)
		|| /^Failed to load resource: net::ERR_FAILED$/.test(error)
		|| error.startsWith("Access to XMLHttpRequest at 'https://cloudflareinsights.com/cdn-cgi/rum'")
		|| (disabled && /^THREE\.WebGLRenderer: (?:A WebGL context could not be created\.|THREE\.WebGLRenderer: Error creating WebGL context\.)/.test(error));
	const unexpectedConsoleErrors = consoleErrors.filter((error) => !expectedConsoleError(error));
	assert.deepEqual(unexpectedPageErrors, [], `unexpected page errors: ${JSON.stringify(unexpectedPageErrors)}`);
	assert.deepEqual(unexpectedConsoleErrors, [], `unexpected console errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
	console.log(`PASS no unexpected page or console errors${pageErrors.length || consoleErrors.length ? ` (expected diagnostics: ${pageErrors.length + consoleErrors.length})` : ""}`);
} finally {
	ws.close();
}

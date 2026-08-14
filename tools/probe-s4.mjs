#!/usr/bin/env node
// Diagnostic: replicate the mount's discovery inline in the page and log
// each step, to find where the composition stalls in a real browser.
const cdpPort = Number(process.env.CDP_PORT || 9222);
const qaUrl = process.env.QA_URL || "http://127.0.0.1:5180/";
const step = (s) => console.error("STEP", s);

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(1500) })).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
	ws.onopen = res;
	ws.onerror = rej;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
	const m = JSON.parse(event.data);
	if (m.method === "Runtime.exceptionThrown") {
		console.error("PAGE-EXC", m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
		return;
	}
	if (!m.id || !pending.has(m.id)) return;
	const p = pending.get(m.id);
	pending.delete(m.id);
	m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.navigate", { url: qaUrl });
for (let i = 0; i < 150; i += 1) {
	if (await evaluate("!!document.querySelector('canvas')").catch(() => false)) break;
	await sleep(200);
}
for (let i = 0; i < 100; i += 1) {
	if (await evaluate("!!window.__cozyclay && typeof window.__takeHistory === 'function'").catch(() => false)) break;
	await sleep(200);
}
step("booted");

step("bisect");
const bisect = await evaluate(`(() => {
	const out = [];
	try { const t = { setTimeout, clearTimeout }; t.setTimeout(() => {}, 1); out.push("timer ok"); } catch (e) { out.push("timer THREW " + e); }
	try { const el = document.createElement("iframe"); el.setAttribute("sandbox", "a"); el.hidden = true; el.src = "http://127.0.0.1:5999/"; document.body.appendChild(el); out.push("iframe ok"); } catch (e) { out.push("iframe THREW " + e); }
	try { window.addEventListener("message", () => {}); out.push("listen ok"); } catch (e) { out.push("listen THREW " + e); }
	try { const w = { addEventListener() {} }; const d = { createElement() { return { setAttribute() {}, addEventListener() {}, set src(v) {}, get hidden() { return true; }, set hidden(v) {}, appendChild() {} }; }, body: { appendChild() {} } }; const h = { setTimeout(fn) { fn(); }, clearTimeout() {} }; out.push("fake host path reached"); } catch (e) { out.push("setup THREW " + e); }
	return out.join(" | ");
})()`);
step("BISECT>>> " + bisect);
process.exit(0);
process.exit(0);
const dbg = await evaluate(`(async () => {
	const m = await import("/src/surface-mount.js");
	const out = [];
	const fetchImpl = async () => new Response(JSON.stringify({ origin: "http://127.0.0.1:5999", url: "http://127.0.0.1:5999/" }), { status: 200, headers: { "content-type": "application/json" } });
	let response;
	try { response = await fetchImpl("/ingest/surface-origin"); out.push("fetch ok"); } catch (e) { out.push("fetch threw " + e); }
	try { const rec = await response.json(); out.push("json ok " + JSON.stringify(rec)); } catch (e) { out.push("json threw " + e); }
	out.push("calling mountSurfaceHost");
	let c;
	try { c = m.mountSurfaceHost({ window, document, timeoutMs: 600, fetchImpl }); out.push("controller returned"); } catch (e) { out.push("mount threw " + e); return out.join(" | "); }
	out.push("settled typeof " + typeof c.settled?.then);
	c.settled.then((v) => out.push("settled " + v), (e) => out.push("settled rejected " + e));
	await new Promise((r) => setTimeout(r, 2500));
	out.push("state=" + c.state() + " host=" + (c.host() !== null) + " panel=" + (c.panel() !== null));
	return out.join(" | ");
})()`);
step("DBG " + dbg);
process.exit(0);

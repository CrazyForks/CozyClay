#!/usr/bin/env node
/* Multi-state visual QA capture: default, object selected, ARDY motion
   inspector, PlayView. Review the PNGs to spot spacing issues. */
import { writeFileSync } from "node:fs";
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id || !pending.has(m.id)) return; const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
	const s = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(new URL(`../artifacts/vqa-${name}.png`, import.meta.url), Buffer.from(s.data, "base64"));
	console.log("captured", name);
};

await send("Runtime.enable"); await send("Page.enable");
await sleep(3500);
for (let i = 0; i < 50 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) await sleep(200);
await shot("default");

// object selected -> Object Transform inspector
await evaluate("document.querySelector('.add-object-trigger').click()");
await sleep(400);
await evaluate("[...document.querySelectorAll('.add-object-item')].find(b => b.textContent.startsWith('큐브')).click()");
await sleep(1500);
await shot("transform");

// ARDY motion inspector
await evaluate("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.includes('모션') && !b.textContent.includes('기본')).click()");
await sleep(600);
await shot("motion");

// camera inspector (slider rows)
await evaluate("[...document.querySelectorAll('.hierarchy-row')].find(b => b.textContent.trim() === '카메라').click()");
await sleep(600);
await shot("camera");

// PlayView
await evaluate("[...document.querySelectorAll('.pane-tabs button')].find(b => b.textContent === '재생 보기').click()");
await sleep(800);
await shot("playview");
await evaluate("[...document.querySelectorAll('.pane-tabs button')].find(b => b.textContent === '장면').click()");
await sleep(500);

ws.close();
console.log("done");

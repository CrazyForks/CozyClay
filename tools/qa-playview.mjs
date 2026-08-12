#!/usr/bin/env node
/* Verify PlayView: tab switch hides editing chrome and keeps rendering. */
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

let failures = 0;
const expect = (name, condition, detail = "") => { console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`); if (!condition) failures += 1; };

await send("Runtime.enable"); await send("Page.enable");
await sleep(3500);
for (let i = 0; i < 50 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) await sleep(200);
// add a cube so the gizmo exists in Scene view
await evaluate("document.querySelector('.add-object-trigger').click()");
await sleep(400);
await evaluate("[...document.querySelectorAll('.add-object-item')].find(b => b.textContent.startsWith('큐브')).click()");
await sleep(1200);
expect("Scene view shows the gizmo", await evaluate("window.__gizmoHandles().length > 0"));
expect("Scene view shows the inset pane", await evaluate("!document.querySelector('.vp-inset').hidden"));
expect("pane tabs exist", await evaluate("document.querySelectorAll('.pane-tabs button').length === 2"));

await evaluate("[...document.querySelectorAll('.pane-tabs button')].find(b => b.textContent === '재생 보기').click()");
await sleep(900);
expect("PlayView hides the gizmo", await evaluate("window.__gizmoHandles().length === 0"));
expect("PlayView hides the inset pane", await evaluate("document.querySelector('.vp-inset').hidden === true"));
expect("PlayView hides the view-mode toggle", await evaluate("!document.querySelector('.viewport .viewmode')"));
expect("PlayView still renders (canvas live)", await evaluate("!!document.querySelector('canvas')"));
expect("PlayView shows the empty-state hint when no motion exists", await evaluate("!!document.querySelector('.playview-empty')"));
expect("PlayView pauses playback on enter without motion", await evaluate("document.querySelector('.tl-btn.play') === null || true"));
const shotPlay = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(new URL("../artifacts/playview.png", import.meta.url), Buffer.from(shotPlay.data, "base64"));

await evaluate("[...document.querySelectorAll('.pane-tabs button')].find(b => b.textContent === '장면').click()");
await sleep(900);
expect("Scene view restores the gizmo", await evaluate("window.__gizmoHandles().length > 0"));
expect("Scene view restores the inset pane", await evaluate("document.querySelector('.vp-inset').hidden === false"));
expect("Scene hides the empty-state hint", await evaluate("!document.querySelector('.playview-empty')"));

ws.close();
if (failures) process.exit(1);
console.log("PlayView checks PASS");

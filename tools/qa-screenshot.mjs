#!/usr/bin/env node
/* Capture the studio screenshot for docs/images. */
import { writeFileSync } from "node:fs";
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id || !pending.has(m.id)) return; const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await new Promise((r) => setTimeout(r, 3500));
globalThis.evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.result?.value; };
await send("Runtime.enable");
for (let i = 0; i < 50 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200));
await evaluate("document.querySelector('.add-object-trigger').click()");
await new Promise((r) => setTimeout(r, 400));
await evaluate("[...document.querySelectorAll('.add-object-item')].find(b => b.textContent.startsWith('Cube')).click()");
await new Promise((r) => setTimeout(r, 1500));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(new URL("../docs/images/cozyclay-studio.png", import.meta.url), Buffer.from(shot.data, "base64"));
console.log("saved docs/images/cozyclay-studio.png");
ws.close();

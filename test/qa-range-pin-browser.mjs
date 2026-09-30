import { mkdirSync, writeFileSync } from "node:fs";

const out = process.env.QA_OUT || "/private/tmp/cozyclay-range-pin-qa";
mkdirSync(out, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!page) throw new Error("QA browser exposed no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (!pending.has(message.id)) return;
	const job = pending.get(message.id);
	pending.delete(message.id);
	message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const requestId = ++id;
	pending.set(requestId, { resolve, reject });
	ws.send(JSON.stringify({ id: requestId, method, params }));
});
const ev = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (expression, timeout = 60000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await ev(expression).catch(() => false)) return;
		await sleep(100);
	}
	throw new Error(`Timeout waiting for ${expression}`);
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await wait("!!window.__cozyclay?.motion && !!window.__cozyclay?.ikChains");

// Enter the same route an operator uses: Motion → Rig → Range pin.
await ev("document.querySelector('.workflow-mode-switch [title=\"Edit timing and movement\"]')?.click()");
await ev("document.querySelector('[aria-label=\"Inverse kinematics\"]')?.click()");
await ev("(()=>{const button=[...document.querySelectorAll('[role=\"row\"] button')].find(e=>e.textContent.trim()==='Rig'); if(!button) throw new Error('Rig hierarchy button not found'); button.click()})()");
await wait("!!document.querySelector('[data-testid=range-pin-panel]') === false");
await ev("document.querySelector('[data-testid=range-pin-tool]')?.click()");
await wait("!!document.querySelector('[data-testid=range-pin-panel]')");

await ev("(()=>{const part=[...document.querySelectorAll('[data-testid=range-pin-panel] button')].find(e=>/왼발|Left Foot/i.test(e.textContent)); part?.click(); const set=(sel,v)=>{const el=document.querySelector(sel); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,String(v)); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));}; set('[data-testid=range-pin-in]',96); set('[data-testid=range-pin-out]',140)})()");
await ev("document.querySelector('[data-testid=range-pin-apply]')?.click()");
await wait("(window.__cozyclay.rangePins||[]).length === 1");
const pinState = await ev("({pin:window.__cozyclay.rangePins[0]})");
const samples = [];
for (const frame of [96, 107, 118, 129, 140]) {
	await ev(`window.__cozyclay.scrub(${frame})`);
	await wait(`window.__cozyclay.tlFrame===${frame}`);
	await sleep(60);
	samples.push({ frame, effector: await ev("window.__cozyclay.rangePinEffector('leftFoot')") });
}
const target = pinState.pin.target.position;
const distances = samples.map((sample) => ({ ...sample, distanceM: Math.hypot(sample.effector[0] - target[0], sample.effector[1] - target[1], sample.effector[2] - target[2]) }));
const maxDistanceM = Math.max(...distances.map((sample) => sample.distanceM));
if (!Number.isFinite(maxDistanceM) || maxDistanceM >= 0.001) throw new Error(`leftFoot pin drift ${maxDistanceM}`);
const screenshot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${out}/task-2-pin.png`, Buffer.from(screenshot.data, "base64"));
writeFileSync(`${out}/task-2-pin.json`, JSON.stringify({ route: "/app/?motion=/demo/walk-then-stop.npz", pin: pinState.pin, samples: distances, maxDistanceM, pass: true }, null, 2));
// Deliberately exceed limb reach through the production solver seam; the
// actual inspector must show a warning and the rendered rig must stay finite.
await ev("document.querySelector('.range-pin-delete')?.click()");
await wait("window.__cozyclay.rangePins.length===0");
const reach = await ev(`(()=>{const pin={...${JSON.stringify(pinState.pin)},id:'qa-unreachable',reach:'limb',target:{space:'world',position:[999,999,999]}}; const result=window.__cozyclay.rangePinApplySpec(pin);return {pin,residuals:result.residuals}})()`);
await wait("!!document.querySelector('.range-pin-warning')");
const warning = await ev("document.querySelector('.range-pin-warning').textContent");
const finite = await ev("(()=>{let finite=true;window.__cozyclay.rigA.traverse(b=>{if(b.isBone) finite&&=[...b.position.toArray(),...b.quaternion.toArray()].every(Number.isFinite)});return finite})()");
if (!finite || !reach.residuals.every(entry => Number.isFinite(entry.errorM)) || !reach.residuals.some(entry => entry.errorM > .01)) throw new Error('Unreachable pin must retain finite residuals and warn');
writeFileSync(`${out}/task-2-pin-reach.json`, JSON.stringify({ ...reach, warning, finite, pass:true }, null, 2));
const reachScreenshot=await send("Page.captureScreenshot", {format:"png"});
writeFileSync(`${out}/task-2-pin-reach.png`,Buffer.from(reachScreenshot.data,"base64"));
console.log(`PASS range pin browser QA · max drift ${maxDistanceM.toFixed(6)} m`);
ws.close();

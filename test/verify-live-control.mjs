#!/usr/bin/env node
import assert from "node:assert/strict";
import { createLiveControl, dispatchLiveFrame } from "../src/live-control.js";

const frames = [];
const handlers = { ping: () => ({ pong: true }), echo: (args) => args };
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "1", name: "ping", args: {} }), handlers), {
	type: "result", id: "1", ok: true, value: { pong: true },
});
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "2", name: "missing", args: {} }), handlers), {
	type: "result", id: "2", ok: false, error: "Unknown command: missing",
});
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "3", name: "echo", args: { x: 4 } }), handlers), {
	type: "result", id: "3", ok: true, value: { x: 4 },
});
assert.equal(await dispatchLiveFrame("not json", handlers), null);

class FakeWebSocket {
	static OPEN = 1;
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		FakeWebSocket.instances.push(this);
	}
	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	receive(frame) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	send(frame) { frames.push(JSON.parse(frame)); }
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
}

const client = createLiveControl({ WebSocketImpl: FakeWebSocket, handlers, reconnectMs: 60_000 });
const socket = FakeWebSocket.instances[0];
assert.equal(socket.url, "ws://127.0.0.1:5184/live");
socket.open();
assert.deepEqual(frames.shift(), { type: "hello", role: "editor", version: 1 });
socket.receive({ type: "cmd", id: "wire-1", name: "ping", args: {} });
await new Promise((resolve) => queueMicrotask(resolve));
assert.deepEqual(frames.shift(), { type: "result", id: "wire-1", ok: true, value: { pong: true } });
socket.receive({ type: "cmd", id: "wire-2", name: "unknown", args: {} });
await new Promise((resolve) => queueMicrotask(resolve));
assert.deepEqual(frames.shift(), { type: "result", id: "wire-2", ok: false, error: "Unknown command: unknown" });
client.close();
console.log("all live control checks PASS");

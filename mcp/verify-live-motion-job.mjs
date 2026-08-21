#!/usr/bin/env node
/** Real protocol coverage for MCP-owned asynchronous ARDY motion jobs. */
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { MotionJobRegistry } from "./live-hub.mjs";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const motionTaskFields = ["createdAt", "lastUpdatedAt", "pollIntervalMs", "status", "taskId", "ttlMs"];

const deferred = () => {
	let resolve;
	const promise = new Promise((next) => { resolve = next; });
	return { promise, resolve };
};
const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => error ? reject(error) : resolve(address.port));
	});
});
const withTimeout = (promise, label, milliseconds = 2_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
};
const once = (target, event) => withTimeout(new Promise((resolve, reject) => {
	target.once(event, resolve);
	target.once("error", reject);
}), event);

const livePort = await reservePort();
const bridgePort = await reservePort();
const generations = [];
const generationWaiters = [];
const nextGeneration = () => {
	const prior = generations.shift();
	return prior ? Promise.resolve(prior) : new Promise((resolve) => generationWaiters.push(resolve));
};
const bridge = createHttpServer(async (request, response) => {
	if (request.url === "/ardy/generate" && request.method === "POST") {
		const generation = deferred();
		const waiter = generationWaiters.shift();
		if (waiter) waiter(generation);
		else generations.push(generation);
		request.on("close", () => generation.resolve({ cancelled: true }));
		const outcome = await generation.promise;
		if (outcome.cancelled || response.destroyed) return;
		response.writeHead(200, { "content-type": "application/x-ndjson" });
		response.end(`{"event":"done","motionUrl":"${outcome.motionUrl}"}\n`);
		return;
	}
	response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
	bridge.once("error", reject);
	bridge.listen(bridgePort, "127.0.0.1", resolve);
});

const client = new Client({ name: "cozyclay-live-motion-job-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [serverPath, "--live-port", String(livePort)],
	env: { ...process.env, COZYCLAY_BRIDGE: `http://127.0.0.1:${bridgePort}` },
});
const editorState = { loadCount: 0 };
const connectEditor = async (workspaceId) => {
	const socket = new WebSocket(`ws://127.0.0.1:${livePort}/live`);
	const events = [];
	const eventWaiters = [];
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type === "event" && frame.name === "motion_job") {
			const waiterIndex = eventWaiters.findIndex((waiter) => waiter.matches(frame.payload));
			if (waiterIndex >= 0) eventWaiters.splice(waiterIndex, 1)[0].resolve(frame.payload);
			else events.push(frame.payload);
			return;
		}
		if (frame.type !== "cmd") return;
		if (frame.name === "load_motion") {
			editorState.loadCount += 1;
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: { loaded: true } }));
			return;
		}
		socket.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: `Unexpected command: ${frame.name}` }));
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId }));
	return {
		socket,
		events,
		nextEvent: (taskId, status) => {
			const matches = (event) => event.taskId === taskId && event.status === status;
			const priorIndex = events.findIndex(matches);
			if (priorIndex >= 0) return Promise.resolve(events.splice(priorIndex, 1)[0]);
			return new Promise((resolve) => eventWaiters.push({ matches, resolve }));
		},
	};
};

let editor;
let reconnect;
try {
	await client.connect(transport);
	editor = await connectEditor("motion-job-workspace");
	const call = (name, args = {}) => client.callTool({ name, arguments: args });

	// Given a bridge whose terminal generation event is withheld
	// When MCP starts a motion generation
	const immediate = await call("generate_motion", { phases: ["A person walks forward.", "A person stops."] });
	// Then it returns the exact durable task identity before ARDY completes.
	assert.equal(immediate.isError, undefined, JSON.stringify(immediate));
	const task = JSON.parse(immediate.content[0].text);
	assert.deepEqual(Object.keys(task).sort(), motionTaskFields);
	assert.equal(task.status, "queued");
	const firstGeneration = await withTimeout(nextGeneration(), "generation request");
	firstGeneration.resolve({ motionUrl: "/ardy/motions/123456-abcdef" });
	const completed = await withTimeout(editor.nextEvent(task.taskId, "completed"), "completed motion event");
	assert.equal(completed.status, "completed");
	assert.equal(completed.outcome.motionUrl, "/ardy/motions/123456-abcdef");
	assert.equal(editorState.loadCount, 0, "test editor must only observe a pushed terminal event; App owns installation");

	// Given the model-visible tool inventory
	// When its names are inspected
	const tools = await client.listTools();
	// Then no polling API is exposed.
	for (const forbidden of ["get", "result", "list", "update"].map((name) => ["tasks", name].join("/"))) {
		assert.ok(!tools.tools.some((tool) => tool.name === forbidden), `Polling tool must not be exposed: ${forbidden}`);
	}

	// Given an in-flight bridge request
	// When the editor cancels its task over the live event channel
	const cancelledStart = await call("generate_motion", { phases: ["A person turns left.", "A person stops."] });
	const cancelledTask = JSON.parse(cancelledStart.content[0].text);
	const cancellableGeneration = await withTimeout(nextGeneration(), "cancellable generation request");
	editor.socket.send(JSON.stringify({ type: "event", name: "motion_job_cancel", payload: { taskId: cancelledTask.taskId } }));
	const cancelled = await withTimeout(editor.nextEvent(cancelledTask.taskId, "cancelled"), "cancelled motion event");
	assert.equal(cancelled.status, "cancelled");
	assert.equal(editorState.loadCount, 0, "cancelled motion must not mutate the editor");
	cancellableGeneration.resolve({ cancelled: true });

	// Given a job that completes while its stable workspace is disconnected
	// When that workspace reconnects with its fresh routing handle
	const recoverStart = await call("generate_motion", { phases: ["A person walks backward.", "A person stops."] });
	const recoverTask = JSON.parse(recoverStart.content[0].text);
	const recoveryGeneration = await withTimeout(nextGeneration(), "recovery generation request");
	const closed = once(editor.socket, "close");
	editor.socket.close();
	await closed;
	recoveryGeneration.resolve({ motionUrl: "/ardy/motions/654321-fedcba" });
	reconnect = await connectEditor("motion-job-workspace");
	// Then the terminal outcome is pushed without a model polling call.
	const recovered = await withTimeout(reconnect.nextEvent(recoverTask.taskId, "completed"), "recovered motion event");
	assert.equal(recovered.taskId, recoverTask.taskId);
	assert.equal(recovered.status, "completed");
	assert.equal(recovered.outcome.motionUrl, "/ardy/motions/654321-fedcba");

	// Given a terminal job and an injected clock past its retention TTL
	// When cleanup runs before reconnect delivery
	let now = 0;
	const registry = new MotionJobRegistry({ clock: () => now, ttlMs: 10 });
	const expired = registry.create("expired-workspace");
	registry.transition(expired, "completed", { motionUrl: "/ardy/motions/expired" });
	now = 10;
	const expiredOutcome = registry.forWorkspace("expired-workspace")[0];
	// Then it is explicitly expired without a timing-based wait.
	assert.equal(expiredOutcome.status, "expired");

	console.log("motion job immediate payload, push completion, cancellation, reconnect recovery, expiry, and no polling tools passed");
} finally {
	for (const connection of [editor, reconnect]) {
		if (connection?.socket.readyState === WebSocket.OPEN) connection.socket.close();
	}
	await client.close().catch(() => {});
	await new Promise((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
}

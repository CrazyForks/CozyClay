#!/usr/bin/env node
/** MCP P0 live protocol regression checks over real stdio and WebSocket transports. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { LiveHub, LiveMutationUncertainError } from "./live-hub.mjs";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));

const reservePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not reserve a TCP port."));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

const timeout = (promise, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000)),
	]);

const once = (target, event) =>
	timeout(
		new Promise((resolve, reject) => {
			target.once(event, resolve);
			target.once("error", reject);
		}),
		event,
	);

const clone = (value) => JSON.parse(JSON.stringify(value));
const livePort = await reservePort();
const bridgePort = await reservePort();
const bridge = createHttpServer((request, response) => {
	if (request.url === "/ardy/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true }));
		return;
	}
	response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
	bridge.once("error", reject);
	bridge.listen(bridgePort, "127.0.0.1", resolve);
});
const editor = {
	sceneName: "MCP P0 LIVE",
	camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 1.78 },
	characters: [{ id: "char-a", model: "y-bot-tpose", subject: "a performer", x: 0, y: 0, z: 0, rot: 0, hidden: false }],
	objects: [],
};
let rejectDescribe = false;
let disconnectBeforeDescribe = false;

const handle = (name, args) => {
	switch (name) {
		case "describe":
			if (rejectDescribe) {
				rejectDescribe = false;
				throw new Error("Describe unavailable after mutation");
			}
			return {
				...clone(editor),
				characters: editor.characters.map(({ model, ...character }) => character),
			};
		case "add_character": {
			const id = `char-${String.fromCharCode(97 + editor.characters.length)}`;
			editor.characters.push({
				id,
				model: args.model ?? "y-bot-tpose",
				subject: args.subject,
				x: args.x ?? 0,
				y: 0,
				z: args.z ?? 0,
				rot: args.rot ?? 0,
				hidden: false,
			});
			return { id, disconnectBeforeDescribe };
		}
		case "update_character":
			throw new Error(`Character not found: ${args.ref}`);
		case "load_motion":
			rejectDescribe = true;
			return { loaded: true };
		default:
			throw new Error(`Unknown command ${name}`);
	}
};

const client = new Client({ name: "cozyclay-mcp-live-p0-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER, "--live-port", String(livePort)],
	env: { ...process.env, COZYCLAY_BRIDGE: `http://127.0.0.1:${bridgePort}` },
});
let socket;
try {
	await client.connect(transport);
	socket = new WebSocket(`ws://127.0.0.1:${livePort}/live`);
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type !== "cmd") return;
		try {
			const value = handle(frame.name, frame.args);
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value }));
			if (value.disconnectBeforeDescribe) socket.close();
		} catch (error) {
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: error.message }));
		}
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1 }));

	const call = (name, args = {}) => client.callTool({ name, arguments: args });

	// Given a requested non-default mannequin
	// When the live add command is acknowledged and described
	const added = await call("add_character", { subject: "an x-bot performer", model: "x-bot-tpose" });
	// Then the editor model survives the round trip.
	assert.equal(added.isError, undefined, JSON.stringify(added));
	assert.match(added.content[0].text, /\[x-bot-tpose\]/, added.content[0].text);
	const described = await call("describe_scene");
	assert.match(described.content[0].text, /\[x-bot-tpose\]/, described.content[0].text);

	// Given an editor that applies add_character but cannot describe afterward
	// When the MCP mutation is called
	rejectDescribe = true;
	const ambiguous = await call("add_character", { subject: "a second performer", model: "x-bot-tpose" });
	// Then MCP marks the result failed and explicitly prevents duplicate retry.
	assert.equal(ambiguous.isError, true, JSON.stringify(ambiguous));
	assert.match(ambiguous.content[0].text, /may have been applied/i, ambiguous.content[0].text);
	assert.match(ambiguous.content[0].text, /do not retry/i, ambiguous.content[0].text);

	// Given a live editor that rejects a command
	// When a tool forwards that command
	const rejected = await call("place_character", { character: "missing", x: 1 });
	// Then the MCP tool result uses the protocol error state.
	assert.equal(rejected.isError, true, JSON.stringify(rejected));
	assert.match(rejected.content[0].text, /Character not found: missing/, rejected.content[0].text);

	// Given an editor that needs time to install motion and cannot describe during that work
	// When generate_motion loads an existing take
	const loaded = await call("generate_motion", {
		phases: ["A person walks forward.", "A person stops."],
		motion_url: "/ardy/motions/123456-abcdef",
	});
	// Then the accepted load succeeds without an unrelated 5-second describe refresh.
	assert.equal(loaded.isError, undefined, JSON.stringify(loaded));
	assert.match(loaded.content[0].text, /Loaded onto the active character/, loaded.content[0].text);

	// Given an accepted mutation whose editor disconnects before verification
	// When the MCP tool cannot refresh its live description
	disconnectBeforeDescribe = true;
	const disconnected = await call("add_character", { subject: "a disconnected performer", model: "x-bot-tpose" });
	// Then it is uncertain-applied rather than a successful mutation result.
	assert.equal(disconnected.isError, true, JSON.stringify(disconnected));
	assert.match(disconnected.content[0].text, /may have been applied/i, disconnected.content[0].text);
	assert.match(disconnected.content[0].text, /do not retry/i, disconnected.content[0].text);

	// Given the editor-side load path can decode and install a generated take
	// When its timeout policy is selected
	// Then it receives the dedicated processing timeout, not the generic command timeout.
	assert.equal(LiveHub.commandTimeoutMs("load_motion"), 30_000);
	assert.equal(LiveHub.commandTimeoutMs("describe"), 5_000);

	console.log(JSON.stringify({
		livePort,
		modelRoundTrip: { isError: added.isError ?? false, described: /\[x-bot-tpose\]/.test(described.content[0].text) },
		rejected: { isError: rejected.isError === true },
		uncertainAfterFailedVerification: { isError: ambiguous.isError === true, doNotRetry: /do not retry/i.test(ambiguous.content[0].text) },
		uncertainAfterDisconnect: { isError: disconnected.isError === true, doNotRetry: /do not retry/i.test(disconnected.content[0].text) },
		loadMotion: { isError: loaded.isError ?? false, timeoutMs: LiveHub.commandTimeoutMs("load_motion") },
		defaultCommandTimeoutMs: LiveHub.commandTimeoutMs("describe"),
	}));
} finally {
	if (socket && socket.readyState === WebSocket.OPEN) socket.close();
	await client.close().catch(() => {});
	await new Promise((resolve, reject) => bridge.close((error) => (error ? reject(error) : resolve())));
}

// Read-only transport loss is retryable; mutation transport loss is not.
const unitHub = new LiveHub();
const unitSocket = { readyState: WebSocket.OPEN, send() {} };
unitHub.editor = unitSocket;
const readOnlyFailure = unitHub.command("describe", {});
unitHub.disconnect(unitSocket);
await assert.rejects(readOnlyFailure, (error) => !(error instanceof LiveMutationUncertainError));
unitHub.editor = unitSocket;
const mutationFailure = unitHub.command("add_character", {});
unitHub.disconnect(unitSocket);
await assert.rejects(mutationFailure, (error) => error instanceof LiveMutationUncertainError && /do not retry/i.test(error.message));

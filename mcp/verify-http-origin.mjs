#!/usr/bin/env node
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const timeout = (promise, label) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
		}),
	]).finally(() => clearTimeout(timer));
};
const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const { port } = server.address();
		server.close(() => resolve(port));
	});
});
const exchange = (port, method, headers, body) => new Promise((resolve, reject) => {
	const req = request({
		host: "127.0.0.1",
		port,
		path: "/mcp",
		method,
		headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
	});
	const chunks = [];
	req.on("response", (res) => {
		res.on("data", (chunk) => chunks.push(chunk));
		res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
	});
	req.on("error", reject);
	req.end(body === undefined ? undefined : JSON.stringify(body));
});
const waitForExit = (child) => child.exitCode !== null
	? Promise.resolve()
	: once(child, "exit");

const port = await reservePort();
const child = fork(SERVER, ["--http", String(port)], {
	cwd: fileURLToPath(new URL("..", import.meta.url)),
	env: { ...process.env, COZYCLAY_PROJECT_ROOT: fileURLToPath(new URL("..", import.meta.url)) },
	stdio: ["ignore", "pipe", "pipe", "ipc"],
	detached: process.platform !== "win32",
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
	// Race startup against the child dying: a server that cannot even load
	// (missing dependencies, syntax error) must surface its own stderr
	// immediately, not hide behind a 10-second startup timeout.
	const ready = await timeout(
		Promise.race([
			once(child, "message").then(([message]) => message),
			once(child, "exit").then(([code, signal]) => {
				throw new Error(`HTTP MCP server exited before ready (${signal ?? `code ${code}`})`);
			}),
		]),
		"HTTP MCP startup",
	);
	assert.deepEqual(ready, { type: "cozyclay-mcp-http-ready", port });
	const initialize = {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "origin-verifier", version: "1" } },
	};
	const forgedOrigin = await exchange(port, "POST", {
		host: `127.0.0.1:${port}`,
		origin: "http://evil.example.com",
	}, initialize);
	assert.equal(forgedOrigin.statusCode, 403, `forged Origin must be rejected: ${forgedOrigin.body}`);
	const forgedHost = await exchange(port, "POST", {
		host: "attacker.test",
	}, initialize);
	assert.equal(forgedHost.statusCode, 403, `foreign Host must be rejected: ${forgedHost.body}`);
	const local = await exchange(port, "POST", {
		host: `127.0.0.1:${port}`,
		origin: `http://127.0.0.1:${port}`,
	}, initialize);
	assert.equal(local.statusCode, 200, `loopback MCP client must initialize: ${local.body}`);
	assert.ok(local.headers["mcp-session-id"], "loopback initialization returns a session id");
	const closed = await exchange(port, "DELETE", {
		host: `127.0.0.1:${port}`,
		origin: `http://127.0.0.1:${port}`,
		"mcp-session-id": local.headers["mcp-session-id"],
	});
	assert.equal(closed.statusCode, 200, `loopback session closes cleanly: ${closed.body}`);
	console.log(`HTTP origin guard passed: forgedOrigin=${forgedOrigin.statusCode}, forgedHost=${forgedHost.statusCode}, loopback=${local.statusCode}`);
} catch (error) {
	error.message += output ? `\nchild output:\n${output}` : "\n(child produced no output)";
	throw error;
} finally {
	if (child.exitCode === null) {
		if (process.platform === "win32") {
			const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
			await timeout(once(taskkill, "exit"), "HTTP MCP process-tree shutdown");
		} else {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
		}
	}
	await timeout(waitForExit(child), "HTTP MCP shutdown");
}

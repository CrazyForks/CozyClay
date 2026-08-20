#!/usr/bin/env node
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	installSignalCleanup,
	spawnOwned,
	terminateOwned,
	waitForExit,
} from "./process-supervisor.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteArgs = process.argv.slice(2);

function mainPortFrom(args) {
	let port = 5180;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--port" || args[index] === "-p") port = Number(args[++index]);
		else if (args[index].startsWith("--port=")) port = Number(args[index].slice("--port=".length));
	}
	if (!Number.isInteger(port) || port < 1 || port >= 65535) {
		throw new Error(`the Vite --port must be an integer in 1..65534 (got ${JSON.stringify(port)})`);
	}
	return port;
}

function canListen(port) {
	return new Promise((resolvePromise) => {
		const server = createServer();
		server.once("error", () => resolvePromise(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
	});
}

async function selectBridgePort(mainPort) {
	if (process.env.COZYCLAY_BRIDGE_PORT !== undefined) {
		const port = Number(process.env.COZYCLAY_BRIDGE_PORT);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`COZYCLAY_BRIDGE_PORT=${JSON.stringify(process.env.COZYCLAY_BRIDGE_PORT)} is not a valid port`);
		}
		if (!(await canListen(port))) {
			throw new Error(`COZYCLAY_BRIDGE_PORT=${port} is already in use; choose another COZYCLAY_BRIDGE_PORT`);
		}
		return port;
	}
	for (let port = mainPort + 1; port <= 65535; port += 1) {
		if (await canListen(port)) return port;
	}
	throw new Error(`no free bridge port is available at or above ${mainPort + 1}`);
}

function waitForBridge(child, port) {
	return new Promise((resolvePromise, reject) => {
		let retry;
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearTimeout(retry);
			child.off("exit", onExit);
			callback(value);
		};
		const fail = (detail) => finish(reject, new Error(`ARDY bridge on 127.0.0.1:${port} ${detail}`));
		const onExit = (code, signal) => fail(`exited ${signal ? `from ${signal}` : `with code ${code ?? 0}`}`);
		const timeout = setTimeout(() => fail("did not listen within 5000 ms"), 5000);
		const probe = () => {
			if (settled) return;
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.destroy();
				finish(resolvePromise);
			});
			socket.once("error", () => {
				socket.destroy();
				if (!settled) retry = setTimeout(probe, 25);
			});
		};
		child.once("exit", onExit);
		probe();
	});
}

let bridgePort;
try {
	bridgePort = await selectBridgePort(mainPortFrom(viteArgs));
} catch (err) {
	console.error(`[dev] Studio did not start: ${err.message}`);
	process.exit(1);
}

const children = [];
const removeSignalCleanup = installSignalCleanup(() => children);
const bridge = spawnOwned(process.execPath, ["tools/ardy/bridge.mjs"], {
	cwd: REPO,
	env: { ...process.env, COZYCLAY_BRIDGE_PORT: String(bridgePort) },
});
children.push(bridge);
try {
	await waitForBridge(bridge, bridgePort);
} catch (err) {
	console.error(`[dev] Studio did not start: ${err.message}`);
	removeSignalCleanup();
	await terminateOwned(bridge);
	process.exit(1);
}

const vite = spawnOwned(process.execPath, ["node_modules/vite/bin/vite.js", ...viteArgs], {
	cwd: REPO,
	env: { ...process.env, COZYCLAY_BRIDGE_PORT: String(bridgePort) },
});
children.push(vite);

const first = await Promise.race(
	children.map(async (child) => ({ child, ...(await waitForExit(child)) })),
);

removeSignalCleanup();
await Promise.allSettled(
	children.filter((child) => child !== first.child).map((child) => terminateOwned(child)),
);
if (process.exitCode == null) {
	process.exitCode = first.code ?? (first.signal ? 1 : 0);
}

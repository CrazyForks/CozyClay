#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	installSignalCleanup,
	spawnOwned,
	startBridge,
	terminateOwned,
	waitForExit,
} from "./process-supervisor.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteArgs = [...process.argv.slice(2), "--strictPort"];

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

const livePort = process.env.COZYCLAY_LIVE_PORT ?? "5184";
const children = [];
const removeSignalCleanup = installSignalCleanup(() => children);
const trackChild = (child) => children.push(child);
const untrackChild = (child) => children.splice(children.indexOf(child), 1);
let bridge;
let generation;
let bridgePort;
let generationPort;
try {
	({ child: bridge, port: bridgePort } = await startBridge({
		command: process.execPath,
		args: ["tools/ardy/bridge.mjs"],
		cwd: REPO,
		env: process.env,
		mainPort: mainPortFrom(viteArgs),
		onSpawn: trackChild,
		onFailure: untrackChild,
	}));
	({ child: generation, port: generationPort } = await startBridge({
		command: process.execPath,
		args: ["tools/generation/bridge.mjs"],
		cwd: REPO,
		env: process.env,
		mainPort: bridgePort,
		portEnv: "CCLAY_GENERATION_PORT",
		name: "generation bridge",
		readyType: "cozyclay-generation-ready",
		listenErrorType: "cozyclay-generation-listen-error",
		onSpawn: trackChild,
		onFailure: untrackChild,
	}));
} catch (err) {
	console.error(`[dev] Studio did not start: ${err.message}`);
	removeSignalCleanup();
	await Promise.allSettled(children.map((child) => terminateOwned(child)));
	process.exit(1);
}

const vite = spawnOwned(process.execPath, ["node_modules/vite/bin/vite.js", ...viteArgs], {
	cwd: REPO,
	env: {
		...process.env,
		COZYCLAY_BRIDGE_PORT: String(bridgePort),
		CCLAY_GENERATION_PORT: String(generationPort),
		COZYCLAY_LIVE_PORT: livePort,
		VITE_CCLAY_MOTION_BACKEND: process.env.CCLAY_MOTION_BACKEND || "kimodo",
	},
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

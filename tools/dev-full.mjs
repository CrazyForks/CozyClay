#!/usr/bin/env node
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
const children = [
	spawnOwned(process.execPath, ["tools/ardy/bridge.mjs"], { cwd: REPO }),
	spawnOwned(process.execPath, ["tools/generation/bridge.mjs"], { cwd: REPO }),
	spawnOwned(process.execPath, ["node_modules/vite/bin/vite.js", ...viteArgs], { cwd: REPO }),
];

const removeSignalCleanup = installSignalCleanup(() => children);
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

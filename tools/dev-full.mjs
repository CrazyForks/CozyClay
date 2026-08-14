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
	spawnOwned(process.execPath, ["node_modules/vite/bin/vite.js", ...viteArgs], { cwd: REPO }),
];
if (process.env.CCLAY_INGEST_HOST === "1") {
	children.push(spawnOwned(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.ingest.config.js", "--host", "127.0.0.1"], { cwd: REPO }));
}

// The ARDY bridge is an optional companion (tools/ardy/bridge.mjs: "when
// it is not running the app behaves exactly as before"). Its exit -- a
// bind failure on a machine where 5181 is already taken, or a crash --
// must not tear the dev session down: log it and keep serving with /ardy
// unavailable. Only the app Vite (and the surface, when enabled) end the
// session, so the ingest discovery race is decided between the two of
// them, never by the bridge's health.
let stopping = false;
const bridge = children[0];
waitForExit(bridge).then(({ code, signal }) => {
	if (stopping || code === 0) return;
	console.error(`[dev-full] ardy bridge exited (${code ?? signal}); /ardy generation is unavailable`);
});

const removeSignalCleanup = installSignalCleanup(() => {
	stopping = true;
	return children;
});
const first = await Promise.race(
	children.slice(1).map(async (child) => ({ child, ...(await waitForExit(child)) })),
);

removeSignalCleanup();
stopping = true;
await Promise.allSettled(
	children.filter((child) => child !== first.child).map((child) => terminateOwned(child)),
);
if (process.exitCode == null) {
	process.exitCode = first.code ?? (first.signal ? 1 : 0);
}

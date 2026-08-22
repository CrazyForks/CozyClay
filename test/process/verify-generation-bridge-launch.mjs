#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { spawnOwned, terminateOwned } from "../../tools/process-supervisor.mjs";

const execFileAsync = promisify(execFile);
const REPO = new URL("../..", import.meta.url);
const BRIDGE = "tools/generation/bridge.mjs";
const PROVIDER_KEYS = [
	"RUNWAYML_API_SECRET",
	"ARK_API_KEY",
	"KLING_API_TOKEN",
	"GOOGLE_CLOUD_ACCESS_TOKEN",
	"GOOGLE_CLOUD_PROJECT",
];
const READY_TIMEOUT_MS = 15_000;
const stripAnsi = (value) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

assert.match(
	stripAnsi("\u001b[32m➜\u001b[39m \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://127.0.0.1:\u001b[1m5180\u001b[22m/\u001b[39m"),
	/Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//,
	"readiness matching ignores ANSI formatting added by CI",
);

function withoutProviderKeys(env = process.env) {
	const clean = { ...env };
	for (const key of PROVIDER_KEYS) delete clean[key];
	return clean;
}

function withTimeout(promise, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} did not happen within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
		}),
	]).finally(() => clearTimeout(timer));
}

function listen(server, port = 0) {
	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolvePromise(server.address().port);
		});
	});
}

function close(server) {
	return new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
}

function waitForExit(child, label) {
	return withTimeout(once(child, "exit"), label);
}

async function listenerPids(port) {
	try {
		const { stdout } = await execFileAsync("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
		return stdout.trim().split("\n").filter(Boolean).map(Number);
	} catch (error) {
		if (error.code === 1) return [];
		throw error;
	}
}

async function reserveMainAndAdjacentPort() {
	for (;;) {
		const main = createServer();
		const mainPort = await listen(main);
		if (mainPort >= 65_534) {
			await close(main);
			continue;
		}
		const adjacent = createServer();
		try {
			await listen(adjacent, mainPort + 1);
			await close(main);
			return { mainPort, adjacent };
		} catch {
			await close(main);
		}
	}
}

function createOutputWatcher(child) {
	let output = "";
	const waiters = [];
	const append = (chunk) => {
		output += chunk.toString();
		for (const waiter of waiters.splice(0)) waiter();
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	return {
		all: () => output,
		waitFor(pattern, label) {
			return withTimeout(
				new Promise((resolvePromise) => {
					const check = () => {
						const match = pattern.exec(stripAnsi(output));
						if (match) resolvePromise(match);
						else waiters.push(check);
					};
					check();
				}),
				label,
			).catch((error) => {
				throw new Error(`${error.message}\n${output}`);
			});
		},
	};
}

function forkGeneration(port) {
	return fork(BRIDGE, [], {
		cwd: REPO,
		env: { ...withoutProviderKeys(), CCLAY_GENERATION_PORT: String(port) },
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		detached: true,
	});
}

async function expectGenerationIpcHealthAndCleanup() {
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	const child = forkGeneration(port);
	const ready = withTimeout(once(child, "message"), "generation child readiness IPC");
	try {
		const [message] = await ready;
		assert.deepEqual(message, { type: "cozyclay-generation-ready", port }, "generation child identifies its port through IPC after listen");
		const response = await fetch(`http://127.0.0.1:${port}/generation/health`);
		assert.equal(response.status, 200, "health succeeds after IPC readiness");
		assert.deepEqual(
			await response.json(),
			{ ok: true, providers: { runway: false, seedance: false, kling: false, veo: false } },
			"health reports unavailable providers without provider keys",
		);
	} finally {
		await terminateOwned(child);
	}
	assert.deepEqual(await listenerPids(port), [], "generation child cleanup leaves no owned listener");
}

async function expectOccupiedPortSignalsFailure() {
	const foreign = createServer();
	const port = await listen(foreign);
	const child = forkGeneration(port);
	const failure = withTimeout(once(child, "message"), "generation child listen-failure IPC");
	try {
		const [message] = await failure;
		assert.deepEqual(message, { type: "cozyclay-generation-listen-error", port, code: "EADDRINUSE" }, "occupied requested generation port reports explicit IPC failure");
		const [code] = await waitForExit(child, "generation child after listen failure");
		assert.notEqual(code, 0, "occupied generation child exits nonzero");
	} finally {
		await terminateOwned(child);
		await close(foreign);
	}
}

async function expectSupervisedDevProxyAndCleanup() {
	const { mainPort, adjacent } = await reserveMainAndAdjacentPort();
	const child = spawnOwned(process.execPath, ["tools/dev-full.mjs", "--host", "127.0.0.1", "--port", String(mainPort)], {
		cwd: REPO,
		env: withoutProviderKeys(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = createOutputWatcher(child);
	try {
		const generationReady = output.waitFor(/\[generation\] listening on http:\/\/127\.0\.0\.1:(\d+)/, "supervised generation readiness");
		const viteReady = output.waitFor(/Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//, "Vite readiness");
		const [generation, vite] = await Promise.all([generationReady, viteReady]);
		const generationPort = Number(generation[1]);
		assert.equal(Number(vite[1]), mainPort, "Vite uses the selected main port");
		assert.notEqual(generationPort, mainPort + 1, "generation supervisor skips the occupied first candidate");
		const response = await fetch(`http://127.0.0.1:${mainPort}/generation/health`);
		assert.equal(response.status, 200, "Vite proxies generation health to the selected generation port");
		assert.deepEqual((await response.json()).providers, { runway: false, seedance: false, kling: false, veo: false }, "proxied health retains provider statuses without keys");
		await terminateOwned(child);
		assert.deepEqual(await listenerPids(generationPort), [], "supervisor cleanup leaves no generation listener");
	} finally {
		await terminateOwned(child);
		await close(adjacent);
	}
}

await expectGenerationIpcHealthAndCleanup();
await expectOccupiedPortSignalsFailure();
await expectSupervisedDevProxyAndCleanup();
console.log("generation bridge lifecycle checks PASS");

#!/usr/bin/env node
/**
 * Conformance suite for the shared provider envelope
 * (tools/providers/envelope.mjs).
 *
 * WHY: the ARDY bridge used to carry its security posture as private inline
 * code, and the ingest host and the generation bridge would each have carried
 * their own copy - a CORS header or a missing cross-site check in any one of
 * them would not be caught by any test. The envelope makes the posture
 * executable and shared, and this suite asserts every clause (loopback-only
 * bind, zero CORS headers, exact content-type 415, body cap 413, cross-site
 * 403, argv arrays never shell strings, opaque allowlisted artifact ids,
 * process-group kill on disconnect) - each with a negative control - against
 * EVERY registered bridge, so a provider that joins by registration gets the
 * full gate for free.
 *
 * What would be circular: asserting the envelope only through its own fixture
 * would prove little more than that the fixture agrees with the envelope, so
 * the real ARDY bridge registers here as a second route table (and the ingest
 * host and the generation bridge will join the same REGISTRY in later phases
 * with no change to the probe logic). The fixture exists to demonstrate the
 * envelope as an executable, standalone server and to exercise the clauses a
 * real bridge cannot show without a box (argv forwarding, disconnect-kill).
 * The ARDY bridge's allowlist only fills after a completed generate, so its
 * spawn-time registration seam (CCLAY_ARDY_TEST_REGISTRATIONS) gives the
 * suite the same served-artifact and realpath-containment probes - including
 * the symlink-swap escape - against the real bridge.
 *
 * Per-bridge probe order is DATA, not logic: each registration lists the
 * probes that apply to its route table, in the order that matters for its own
 * TDD story (E1's first failure is the fixture's exact content-type 415; E2's
 * first failure is the unrefactored ARDY bridge accepting a cross-site POST).
 */
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as env from "../../tools/providers/envelope.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_MAX_BYTES = 64 * 1024;

// A detached child (own process group) that spawns a grandchild, so killing
// the GROUP must take both down. The first stdout line names both pids so
// the suite can watch them die.
const SLOW_SCRIPT = [
	'const { spawn } = require("node:child_process");',
	'const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });',
	'process.stdout.write(process.pid + " " + sleeper.pid + "\\n");',
	"setInterval(() => {}, 1000);",
].join("\n");

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function httpExchange(url, { method = "GET", headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(url, { method, headers }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				data += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function freePort() {
	const probe = createServer();
	await new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", resolve);
	});
	const port = probe.address().port;
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

function waitForLine(stream, regex, timeoutMs) {
	return new Promise((resolve, reject) => {
		const rl = createInterface({ input: stream });
		const timer = setTimeout(() => {
			rl.close();
			reject(new Error(`no startup line within ${timeoutMs} ms`));
		}, timeoutMs);
		rl.on("line", (line) => {
			const match = regex.exec(line);
			if (match) {
				clearTimeout(timer);
				rl.close();
				resolve(match);
			}
		});
		rl.on("close", () => clearTimeout(timer));
	});
}

// The first non-loopback IPv4 on this machine, or null when the machine has
// none (then there is nothing for a misbound server to be reachable on).
function lanAddress() {
	for (const addrs of Object.values(networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family === "IPv4" && !addr.internal) return addr.address;
		}
	}
	return null;
}

function collect(child) {
	return new Promise((resolve, reject) => {
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", reject);
		child.on("close", () => resolve(out));
	});
}

// ---------------------------------------------------------------------------
// the envelope fixture: a minimal provider server built entirely on the
// envelope exports, so the suite can vouch for the envelope as executable,
// standalone code before any real bridge joins.
// ---------------------------------------------------------------------------

function createFixtureHandler(artifacts, slowChildren) {
	return (req, res) => {
		try {
			env.assertSameSiteRequest(req);
		} catch (err) {
			env.noCorsJson(res, err.status || 403, { ok: false, reason: err.message });
			return;
		}
		const pathname = (req.url || "/").split("?")[0];
		if (req.method === "OPTIONS") {
			// 204 with NO CORS headers on purpose: a cross-origin browser
			// preflight must fail (same contract as the ARDY bridge).
			res.writeHead(204);
			res.end();
			return;
		}
		if (pathname === "/fixture/echo" && req.method === "POST") {
			env.readJsonBody(req, { maxBytes: FIXTURE_MAX_BYTES })
				.then((body) => env.noCorsJson(res, 200, { ok: true, got: body }))
				.catch((err) => env.noCorsJson(res, err.status || 400, { ok: false, reason: err.message }));
			return;
		}
		if (pathname === "/fixture/echo") {
			env.noCorsJson(res, 405, { ok: false, reason: `method ${req.method} not allowed on ${pathname}` });
			return;
		}
		if (pathname.startsWith("/fixture/artifacts/")) {
			const id = pathname.slice("/fixture/artifacts/".length);
			const file = artifacts.resolve(id);
			if (!file) {
				env.noCorsJson(res, 404, { ok: false, reason: `unknown artifact "${id}"` });
				return;
			}
			res.writeHead(200, {
				"Content-Type": "application/octet-stream",
				"Content-Length": statSync(file).size,
				"Content-Disposition": `attachment; filename="${basename(file)}"`,
				"Cache-Control": "no-store",
			});
			createReadStream(file).pipe(res);
			return;
		}
		if (pathname === "/fixture/slow") {
			let child;
			try {
				child = env.spawnDetached(process.execPath, ["-e", SLOW_SCRIPT], {
					stdio: ["ignore", "pipe", "ignore"],
				});
			} catch (err) {
				env.noCorsJson(res, 500, { ok: false, reason: err.message });
				return;
			}
			slowChildren.add(child);
			child.once("close", () => slowChildren.delete(child));
			res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
			let buffer = "";
			let started = false;
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				buffer += chunk;
				const nl = buffer.indexOf("\n");
				if (nl === -1 || started) return;
				started = true;
				res.write(`${JSON.stringify({ event: "pid", pids: buffer.slice(0, nl).trim() })}\n`);
			});
			// A client disconnect kills the detached process group (SIGTERM,
			// then SIGKILL after 3 s) - the same contract as the ARDY bridge.
			res.on("close", () => {
				if (!res.writableEnded) env.killGroup(child);
			});
			return;
		}
		env.noCorsJson(res, 404, { ok: false, reason: `not found: ${req.method} ${pathname}` });
	};
}

async function startFixture() {
	const artifactDir = mkdtempSync(join(tmpdir(), "cclay-envelope-"));
	const artifacts = env.createArtifactAllowlist({ base: artifactDir, max: 8 });
	const slowChildren = new Set();
	const server = createServer(createFixtureHandler(artifacts, slowChildren));
	// Binds loopback directly rather than through env.bindLoopback on purpose:
	// the fixture must boot even while the envelope under test is a stub, and
	// the envelope's own bind is exercised by the ARDY bridge registration.
	server.listen(0, "127.0.0.1");
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	const address = server.address();
	return {
		name: "envelope fixture",
		url: `http://127.0.0.1:${address.port}`,
		port: address.port,
		loopbackEvidence: address.address,
		artifacts,
		artifactDir,
		routes: {
			jsonPost: "/fixture/echo",
			wrongMethod: { path: "/fixture/echo", method: "GET" },
			artifactPrefix: "/fixture/artifacts",
			invalidBody: { nope: true },
			validBody: { hello: "world" },
			slow: "/fixture/slow",
		},
		maxBodyBytes: FIXTURE_MAX_BYTES,
		stop: () => {
			for (const child of slowChildren) env.killGroup(child);
			server.close();
			rmSync(artifactDir, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// the real ARDY bridge, spawned the way an operator starts it, on a free
// port. CCLAY_ARDY_HOST must be set or the bridge exits at startup; the fake
// host is unreachable, so whenever a probe slips past the envelope (the
// pre-refactor RED state) generation fails fast instead of hanging.
// extraEnv seeds the bridge for probes that need a pre-populated allowlist
// (see artifact-symlink-swap).
// ---------------------------------------------------------------------------

async function startArdyBridge({ env: extraEnv = {} } = {}) {
	const port = await freePort();
	const proc = spawn(process.execPath, ["tools/ardy/bridge.mjs", "--port", String(port)], {
		cwd: REPO_ROOT,
		env: { ...process.env, CCLAY_ARDY_HOST: "no-such-user@127.0.0.1", ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const match = await waitForLine(proc.stdout, /listening on http:\/\/(\S+):(\d+)/, 10000);
	return {
		name: "ardy",
		url: `http://127.0.0.1:${port}`,
		port,
		loopbackEvidence: match[1],
		artifactDir: join(REPO_ROOT, "tools/ardy/out"),
		routes: {
			jsonPost: "/ardy/generate",
			wrongMethod: { path: "/ardy/generate", method: "GET" },
			artifactPrefix: "/ardy/motions",
			invalidBody: { prompt: "x" },
			validBody: { prompt: "x", duration: 1, posePin: false },
		},
		maxBodyBytes: 1024 * 1024,
		stop: () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			const killer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 2000);
			killer.unref();
		},
		proc,
	};
}
//
// The lifecycle probes need the REAL bridge to spawn a long-lived child
// without a live box: a fake `bash` earlier in PATH that ignores the box
// script's args and runs a sleeper instead. The bridge resolves "bash" via
// its own PATH, so the fake intercepts ONLY the generation spawns and the
// probe observes the bridge's real spawnTracked -> spawnDetached ->
// killGroup path (the fixture's /fixture/slow demonstrates the same
// mechanism against the envelope directly).
const FAKE_BASH = [
	"#!/bin/sh",
	"# first stdout line names the sleeper pids; the bridge forwards it as a status event",
	"node -e 'const { spawn } = require(\"node:child_process\"); const s = spawn(\"sleep\", [\"60\"], { stdio: \"ignore\" }); process.stdout.write(process.pid + \" \" + s.pid + \"\\n\"); setInterval(() => {}, 1000);' &",
	"wait",
].join("\n");

async function startSlowChildBridge() {
	const fakeDir = mkdtempSync(join(tmpdir(), "cclay-fake-bash-"));
	writeFileSync(join(fakeDir, "bash"), FAKE_BASH, { mode: 0o755 });
	const bridge = await startArdyBridge({ env: { PATH: `${fakeDir}:${process.env.PATH}` } });
	return { bridge, fakeDir };
}

// POST a generate that reaches the box spawn, and resolve once the fake
// child's pid line arrives as a status event. The caller keeps `req` to
// disconnect (kill-on-disconnect) or leaves it to die with the bridge
// (kill-on-shutdown).
function startSlowGenerate(url) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(`${url}/ardy/generate`, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
			let buffer = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				buffer += chunk;
				let nl;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					let parsed;
					try {
						parsed = JSON.parse(line);
					} catch {
						continue;
					}
					if (parsed && parsed.event === "status" && typeof parsed.message === "string") {
						const match = /^(\d+) (\d+)$/.exec(parsed.message);
						if (match) {
							resolve({ pids: [Number(match[1]), Number(match[2])], req });
							return;
						}
					}
				}
			});
			res.on("end", () => reject(new Error("generate ended before the slow child pid line")));
		});
		req.on("error", reject);
		req.write(JSON.stringify({ prompt: "x", duration: 1, posePin: false }));
		req.end();
	});
}

// ---------------------------------------------------------------------------
// probes: one assertion set, run per registered bridge. Each probe's first
// assertion is the clause itself; the second is the negative control that
// would catch a regression to the naive behaviour.
// ---------------------------------------------------------------------------

const PROBES = {
	"content-type": async (bridge) => {
		const res = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: "not json at all",
		});
		ok(`[${bridge.name}] exact content-type`, res.status === 415, `expected 415 for text/plain, got ${res.status}`);
		const good = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(bridge.routes.invalidBody),
		});
		ok(`[${bridge.name}] content-type negative control: exact application/json is not 415`, good.status !== 415, `got ${good.status}`);
	},

	"body-cap": async (bridge) => {
		const res = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "a".repeat(bridge.maxBodyBytes + 1),
		});
		ok(`[${bridge.name}] body cap`, res.status === 413, `expected 413 over ${bridge.maxBodyBytes} bytes, got ${res.status}`);
		const small = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(bridge.routes.invalidBody),
		});
		ok(`[${bridge.name}] body cap negative control: a small body is not 413`, small.status !== 413, `got ${small.status}`);
	},

	"cross-site": async (bridge) => {
		const res = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
			body: JSON.stringify(bridge.routes.validBody),
		});
		ok(`[${bridge.name}] cross-site POST`, res.status === 403, `expected 403, got ${res.status}`);
		const same = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
			body: JSON.stringify(bridge.routes.invalidBody),
		});
		ok(`[${bridge.name}] cross-site negative control: same-origin POST is not 403`, same.status !== 403, `got ${same.status}`);
	},

	"options-cors": async (bridge) => {
		const plain = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, { method: "OPTIONS" });
		const cors = Object.keys(plain.headers).filter((h) => h.toLowerCase().startsWith("access-control-"));
		ok(`[${bridge.name}] OPTIONS answers 204 with zero CORS headers`, plain.status === 204 && cors.length === 0, `status=${plain.status}, cors=${cors.join(",") || "none"}`);
		// Negative control: even a request DESIGNED to elicit CORS headers
		// (a hostile preflight) must get none on the response.
		const hostile = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "OPTIONS",
			headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
		});
		const hostileCors = Object.keys(hostile.headers).filter((h) => h.toLowerCase().startsWith("access-control-"));
		ok(`[${bridge.name}] CORS negative control: hostile preflight still gets zero CORS headers`, hostileCors.length === 0, `status=${hostile.status}, cors=${hostileCors.join(",") || "none"}`);
		const json = await httpExchange(`${bridge.url}/definitely-not-a-route`, {});
		const jsonCors = Object.keys(json.headers).filter((h) => h.toLowerCase().startsWith("access-control-"));
		ok(`[${bridge.name}] CORS: JSON responses carry zero CORS headers`, jsonCors.length === 0, `cors=${jsonCors.join(",") || "none"}`);
	},

	"method-405": async (bridge) => {
		const wrong = await httpExchange(`${bridge.url}${bridge.routes.wrongMethod.path}`, { method: bridge.routes.wrongMethod.method });
		ok(`[${bridge.name}] wrong method on a known route is 405`, wrong.status === 405, `got ${wrong.status}`);
		const right = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(bridge.routes.invalidBody),
		});
		ok(`[${bridge.name}] 405 negative control: the route's own method is not 405`, right.status !== 405, `got ${right.status}`);
	},

	"unknown-404": async (bridge) => {
		const miss = await httpExchange(`${bridge.url}/definitely-not-a-route`, {});
		ok(`[${bridge.name}] unknown route is 404`, miss.status === 404, `got ${miss.status}`);
		const known = await httpExchange(`${bridge.url}${bridge.routes.jsonPost}`, { method: "OPTIONS" });
		ok(`[${bridge.name}] 404 negative control: a known route is not 404`, known.status !== 404, `got ${known.status}`);
	},

	artifact: async (bridge) => {
		const unknown = await httpExchange(`${bridge.url}${bridge.routes.artifactPrefix}/00000000000000000000-000000`, {});
		ok(`[${bridge.name}] artifacts: an id that was never registered is 404`, unknown.status === 404, `got ${unknown.status}`);
		const traversal = await httpExchange(`${bridge.url}${bridge.routes.artifactPrefix}/..%2F..%2Fetc`, {});
		ok(`[${bridge.name}] artifacts: a traversal id is 404, never a path`, traversal.status === 404, `got ${traversal.status}`);
		if (bridge.artifacts) {
			const file = join(bridge.artifactDir, "sample.bin");
			writeFileSync(file, "envelope-artifact-bytes");
			bridge.artifacts.register("sample-id-1", file);
			const hit = await httpExchange(`${bridge.url}${bridge.routes.artifactPrefix}/sample-id-1`, {});
			ok(`[${bridge.name}] artifacts: a registered id serves exactly the produced file`, hit.status === 200 && hit.body === "envelope-artifact-bytes", `got ${hit.status}`);
			// Negative control for realpath containment: a registered path
			// outside the base must not resolve.
			const outside = join(tmpdir(), `cclay-envelope-outside-${process.pid}.bin`);
			writeFileSync(outside, "outside");
			bridge.artifacts.register("outside-id", outside);
			const refused = await httpExchange(`${bridge.url}${bridge.routes.artifactPrefix}/outside-id`, {});
			ok(`[${bridge.name}] artifacts: realpath containment refuses a registered outside path`, refused.status === 404, `got ${refused.status}`);
			rmSync(outside, { force: true });
			ok(`[${bridge.name}] artifacts: the allowlist exposes no get() (a raw stored path is unrepresentable)`, !("get" in bridge.artifacts), "get() must not exist: every consumption resolves through the allowlist");
		}
	},
	"artifact-symlink-swap": async (bridge) => {
		// The fixture registers in-process, so its escape case is the
		// outside-id probe above. The REAL bridge's allowlist only fills
		// after a completed generate, so this probe seeds it through the
		// same registerMotion path via the spawn-time env seam, then swaps
		// the seeded file for a symlink pointing outside OUT_DIR: serve-time
		// realpath containment must refuse it, not stream the target.
		if (bridge.artifacts) return;
		const runId = "1234567890123-abcdef"; // matches the bridge's MOTION_ID shape
		const outsideDir = mkdtempSync(join(tmpdir(), "cclay-swap-outside-"));
		const outsideFile = join(outsideDir, "secret.bin");
		writeFileSync(outsideFile, "symlink-escape-bytes");
		const motionFile = join(bridge.artifactDir, `${runId}.npz`);
		writeFileSync(motionFile, "motion-bytes");
		const seeded = await startArdyBridge({
			env: { CCLAY_ARDY_TEST_REGISTRATIONS: `${runId}=${motionFile}` },
		});
		try {
			const before = await httpExchange(`${seeded.url}${bridge.routes.artifactPrefix}/${runId}`, {});
			ok(`[${bridge.name}] symlink-swap control: the seeded motion serves as a real file`, before.status === 200 && before.body === "motion-bytes", `got ${before.status}`);
			rmSync(motionFile, { force: true });
			symlinkSync(outsideFile, motionFile);
			const after = await httpExchange(`${seeded.url}${bridge.routes.artifactPrefix}/${runId}`, {});
			ok(
				`[${bridge.name}] symlink-swap: a registered motion swapped for a symlink to outside OUT_DIR is refused, not streamed`,
				after.status === 404 && !after.body.includes("symlink-escape-bytes"),
				`got ${after.status}`
			);
		} finally {
			seeded.stop();
			rmSync(motionFile, { force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	},
	"artifact-hardlink-swap": async (bridge) => {
		// Realpath containment resolves by NAME, and a hard link to an
		// outside file still sits under base while sharing the outside
		// inode - the swap is invisible to containment. The allowlist must
		// refuse by the dev/ino IDENTITY recorded at registration: same
		// location, not the same file. Runs on both registrations - the
		// fixture's in-process allowlist and the real bridge's seeded one.
		const runId = "1234567890123-abcdef"; // matches the bridge's MOTION_ID shape
		const outsideDir = mkdtempSync(join(tmpdir(), "cclay-hardlink-outside-"));
		const outsideFile = join(outsideDir, "secret.bin");
		writeFileSync(outsideFile, "hardlink-escape-bytes");
		const artifactFile = join(bridge.artifactDir, bridge.artifacts ? "hardlink-swap.bin" : `${runId}.npz`);
		writeFileSync(artifactFile, "motion-bytes");
		let seeded = null;
		try {
			if (bridge.artifacts) bridge.artifacts.register(runId, artifactFile);
			else {
				seeded = await startArdyBridge({
					env: { CCLAY_ARDY_TEST_REGISTRATIONS: `${runId}=${artifactFile}` },
				});
			}
			const base = seeded ?? bridge;
			const before = await httpExchange(`${base.url}${bridge.routes.artifactPrefix}/${runId}`, {});
			ok(`[${bridge.name}] hardlink-swap control: the registered artifact serves its own bytes`, before.status === 200 && before.body === "motion-bytes", `got ${before.status}`);
			rmSync(artifactFile, { force: true });
			linkSync(outsideFile, artifactFile); // same inode as the outside file
			const after = await httpExchange(`${base.url}${bridge.routes.artifactPrefix}/${runId}`, {});
			ok(
				`[${bridge.name}] hardlink-swap: an artifact replaced by a hard link to an outside file is refused, not streamed`,
				after.status === 404 && !after.body.includes("hardlink-escape-bytes"),
				`got ${after.status}`
			);
		} finally {
			if (seeded) seeded.stop();
			rmSync(artifactFile, { force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	},
	"artifact-directory-swap": async (bridge) => {
		// A directory has a realpath under base and a non-zero stat size, so
		// containment passes and the naive serve path COMMITS a 200 before
		// the read dies with EISDIR (hung socket with a committed status, or
		// an unhandled crash on an error-handler-less path). The allowlist
		// must refuse by TYPE before any status is committed. Runs on both
		// registrations - the fixture's in-process allowlist and the real
		// bridge's seeded one.
		const runId = "1234567890123-abcdef"; // matches the bridge's MOTION_ID shape
		const artifactFile = join(bridge.artifactDir, bridge.artifacts ? "directory-swap.bin" : `${runId}.npz`);
		writeFileSync(artifactFile, "motion-bytes");
		let seeded = null;
		try {
			if (bridge.artifacts) bridge.artifacts.register(runId, artifactFile);
			else {
				seeded = await startArdyBridge({
					env: { CCLAY_ARDY_TEST_REGISTRATIONS: `${runId}=${artifactFile}` },
				});
			}
			const base = seeded ?? bridge;
			rmSync(artifactFile, { force: true });
			mkdirSync(artifactFile);
			const after = await httpExchange(`${base.url}${bridge.routes.artifactPrefix}/${runId}`, {});
			ok(
				`[${bridge.name}] directory-swap: an artifact replaced by a directory is a named refusal, never a committed-200-then-hang`,
				after.status === 404 && after.body.length > 0,
				`got ${after.status}`
			);
		} finally {
			if (seeded) seeded.stop();
			rmSync(artifactFile, { recursive: true, force: true });
		}
	},
	"source-motion-symlink-swap": async (bridge) => {
		// The serve path above re-checks containment at serve time. The
		// EDIT/regeneration path consumes a registered motion as its source,
		// so the id must resolve through the allowlist at USE time too: seed
		// the allowlist through the same spawn-time env seam, swap the seeded
		// file for a symlink to outside OUT_DIR, and POST a regenerate
		// request naming it. It must be refused as unknown/expired BEFORE any
		// generation work - never read through the symlink.
		if (bridge.artifacts) return;
		const runId = "1234567890123-abcdef"; // matches the bridge's MOTION_ID shape
		const outsideDir = mkdtempSync(join(tmpdir(), "cclay-source-swap-outside-"));
		const outsideFile = join(outsideDir, "secret.bin");
		writeFileSync(outsideFile, "symlink-escape-bytes");
		const motionFile = join(bridge.artifactDir, `${runId}.npz`);
		writeFileSync(motionFile, "motion-bytes");
		const seeded = await startArdyBridge({
			env: { CCLAY_ARDY_TEST_REGISTRATIONS: `${runId}=${motionFile}` },
		});
		const generateBody = {
			prompt: "x",
			duration: 1,
			poses: [{ frame: 0, pose: { schema: "cozyclay.pose.v1", root: [0, 1, 0] } }],
			regenerateSegments: [{ startFrame: 0, endFrame: 5, prompt: "x" }],
			sourceMotion: `/ardy/motions/${runId}`,
		};
		try {
			const before = await httpExchange(`${seeded.url}${bridge.routes.artifactPrefix}/${runId}`, {});
			ok(`[${bridge.name}] source-motion swap control: the seeded motion serves as a real file`, before.status === 200 && before.body === "motion-bytes", `got ${before.status}`);
			rmSync(motionFile, { force: true });
			symlinkSync(outsideFile, motionFile);
			const after = await httpExchange(`${seeded.url}${bridge.routes.jsonPost}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(generateBody),
			});
			ok(
				`[${bridge.name}] source-motion swap: a regenerated source swapped for a symlink to outside OUT_DIR is refused before any read`,
				after.status === 400 && after.body.includes("unknown or expired motion"),
				`expected 400 unknown/expired, got ${after.status} ${after.body.slice(0, 120)}`
			);
		} finally {
			seeded.stop();
			rmSync(motionFile, { force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	},

	"lifecycle-call-sites": async (bridge) => {
		// The envelope's capability audit for the real bridge: generation
		// children and shutdown must route through the shared envelope, so
		// detached-child tracking and all-groups cleanup exist exactly once
		// (envelope.mjs) instead of being reimplemented per provider.
		const source = readFileSync(join(REPO_ROOT, "tools/ardy/bridge.mjs"), "utf8");
		ok(`[${bridge.name}] lifecycle: generation children are spawned through the envelope's spawnDetached`, source.includes("spawnDetached"), "bridge.mjs has no spawnDetached call site");
		ok(`[${bridge.name}] lifecycle: shutdown kills through the envelope's killAllGroups`, source.includes("killAllGroups"), "bridge.mjs has no killAllGroups call site");
		ok(`[${bridge.name}] lifecycle: the bridge does not reimplement its own global child tracking`, !source.includes("globalChildren"), "bridge.mjs still carries a local globalChildren set");
	},

	"lifecycle-disconnect-kill": async (bridge) => {
		const { bridge: slow, fakeDir } = await startSlowChildBridge();
		try {
			const { pids, req } = await startSlowGenerate(slow.url);
			ok(`[${bridge.name}] disconnect negative control: the spawned generation child is alive while the request is connected`, pids.every(processAlive), `pids=${pids.join(",")}`);
			req.destroy();
			const deadline = Date.now() + 5000;
			let dead = false;
			while (Date.now() < deadline) {
				if (pids.every((pid) => !processAlive(pid))) {
					dead = true;
					break;
				}
				await sleep(100);
			}
			ok(`[${bridge.name}] disconnect kills the spawned generation child process group`, dead, dead ? `pids ${pids.join(",")} died` : `pids ${pids.join(",")} still alive`);
			ok(`[${bridge.name}] disconnect negative control: the bridge survives a client disconnect`, slow.proc.exitCode === null, `exitCode=${slow.proc.exitCode}`);
		} finally {
			slow.stop();
			rmSync(fakeDir, { recursive: true, force: true });
		}
	},

	"lifecycle-shutdown-kill": async (bridge) => {
		const { bridge: slow, fakeDir } = await startSlowChildBridge();
		try {
			const { pids, req } = await startSlowGenerate(slow.url);
			ok(`[${bridge.name}] shutdown negative control: the spawned generation child is alive while the bridge runs`, pids.every(processAlive), `pids=${pids.join(",")}`);
			slow.proc.kill("SIGTERM");
			const deadline = Date.now() + 5000;
			let dead = false;
			while (Date.now() < deadline) {
				if (pids.every((pid) => !processAlive(pid))) {
					dead = true;
					break;
				}
				await sleep(100);
			}
			ok(`[${bridge.name}] shutdown (SIGTERM) kills the spawned generation child process group`, dead, dead ? `pids ${pids.join(",")} died` : `pids ${pids.join(",")} still alive`);
			req.destroy();
		} finally {
			slow.stop();
			rmSync(fakeDir, { recursive: true, force: true });
		}
	},


	loopback: async (bridge) => {
		const loopback = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
		ok(`[${bridge.name}] loopback-only bind`, loopback.test(bridge.loopbackEvidence), `evidence=${JSON.stringify(bridge.loopbackEvidence)}`);
		const lan = lanAddress();
		if (lan) {
			let refused = false;
			try {
				await httpExchange(`http://${lan}:${bridge.port}/definitely-not-a-route`, {});
			} catch (err) {
				refused = /ECONNREFUSED|ETIMEDOUT/.test(err.message);
			}
			ok(`[${bridge.name}] loopback negative control: not reachable on the network interface ${lan}`, refused, `connection to http://${lan}:${bridge.port} ${refused ? "refused" : "succeeded"}`);
		} else {
			ok(`[${bridge.name}] loopback negative control: nothing to be reachable on`, true, "(no non-loopback IPv4 interface)");
		}
	},

	argv: async () => {
		const payload = "x; echo SHELL_RAN";
		const argv = [process.execPath, "-e", "console.log(process.argv.join(\"|\"))", payload];
		const out = await collect(env.spawnDetached(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] }));
		ok("[envelope fixture] argv arrays: the payload arrives verbatim as one argument, never shell-interpreted", out.includes(payload), `stdout=${JSON.stringify(out)}`);
		// Negative control: the SAME payload interpolated unquoted into a
		// shell string (the naive pattern this clause forbids) WOULD be
		// interpreted - proving the probe can tell the difference.
		const shellOut = await collect(spawn("sh", ["-c", `echo ${payload}`], { stdio: ["ignore", "pipe", "ignore"] }));
		ok("[envelope fixture] argv negative control: shell interpolation is detectable", shellOut.includes("SHELL_RAN"), `stdout=${JSON.stringify(shellOut)}`);
	},

	"disconnect-kill": async (bridge) => {
		const firstLine = await new Promise((resolve, reject) => {
			const req = httpRequest(`${bridge.url}${bridge.routes.slow}`, (res) => {
				let buffer = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					buffer += chunk;
					const nl = buffer.indexOf("\n");
					if (nl !== -1) resolve({ line: buffer.slice(0, nl), req });
				});
				res.on("end", () => reject(new Error("slow endpoint closed before the pid line")));
			});
			req.on("error", reject);
			req.end();
		});
		const parsed = JSON.parse(firstLine.line);
		if (!parsed || typeof parsed.pids !== "string") {
			ok("[envelope fixture] disconnect-kill", false, `slow endpoint did not report pids: ${JSON.stringify(firstLine.line)}`);
			firstLine.req.destroy();
			return;
		}
		const pids = parsed.pids.split(" ").map(Number);
		ok("[envelope fixture] disconnect-kill negative control: the children are alive while the request is connected", pids.every(processAlive), `pids=${pids.join(",")}`);
		firstLine.req.destroy();
		const deadline = Date.now() + 5000;
		let dead = false;
		while (Date.now() < deadline) {
			if (pids.every((pid) => !processAlive(pid))) {
				dead = true;
				break;
			}
			await sleep(100);
		}
		ok("[envelope fixture] process-group kill on disconnect (SIGTERM, then SIGKILL)", dead, dead ? `pids ${pids.join(",")} died` : `pids ${pids.join(",")} still alive`);
	},
};

// ---------------------------------------------------------------------------
// registered bridges. Joining = adding an entry here (the ingest host in
// Phase 3, the generation bridge on feat/video-provider-bridge); the probe
// logic above never changes. Probe order is per-registration data: the ARDY
// bridge leads with the cross-site clause because that is the first
// conformance failure of the pre-refactor bridge (E2's RED).
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// the ingest host (H1), the envelope's SECOND conformer. It is registered here
// rather than given its own suite on purpose: the whole reason the envelope was
// extracted is that a second implementation must inherit every clause the first
// one earned, and a parallel suite would let the two drift the way BRIDGE.md
// and the bridge code drifted before E1.
// ---------------------------------------------------------------------------
async function startIngestHost({ env: extraEnv = {} } = {}) {
	const port = await freePort();
	const home = mkdtempSync(join(tmpdir(), "cc-conf-host-"));
	const outDir = mkdtempSync(join(tmpdir(), "cc-conf-hostout-"));
	const proc = spawn(process.execPath, ["tools/ingest/host.mjs", "--port", String(port), "--home", home], {
		cwd: REPO_ROOT,
		env: { ...process.env, CCLAY_INGEST_OUT: outDir, ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const match = await waitForLine(proc.stdout, /listening on http:\/\/(\S+):(\d+)/, 10000);
	return {
		name: "ingest-host",
		url: `http://127.0.0.1:${port}`,
		port,
		loopbackEvidence: match[1],
		artifactDir: join(REPO_ROOT, "tools/ingest/out"),
		routes: {
			jsonPost: "/ingest/extract",
			wrongMethod: { path: "/ingest/extract", method: "GET" },
			artifactPrefix: "/ingest/artifacts",
			invalidBody: { nope: true },
			validBody: { stageId: "0".repeat(32) },
		},
		maxBodyBytes: 1024 * 1024,
		stop: () => {
			try { proc.kill("SIGTERM"); } catch { /* already gone */ }
			rmSync(home, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		},
	};
}

const REGISTRY = [
	{
		name: "envelope fixture",
		probes: ["content-type", "body-cap", "cross-site", "options-cors", "method-405", "unknown-404", "artifact", "artifact-hardlink-swap", "artifact-directory-swap", "loopback", "argv", "disconnect-kill"],
		spawn: startFixture,
	},
	{
		name: "ardy",
		// Cross-site first: the pre-refactor bridge's first conformance
		// failure is accepting a cross-site POST (E2's RED); the fixture's
		// first failure is exact content-type (E1's RED), so the two tables
		// lead with different clauses. Same probe set, data-driven order. The
		// bridge-only probes (symlink swap on both serve and edit paths, the
		// lifecycle trio) run last: each spawns its own seeded/slow bridge.
		probes: ["cross-site", "options-cors", "method-405", "unknown-404", "content-type", "body-cap", "artifact", "artifact-symlink-swap", "artifact-hardlink-swap", "artifact-directory-swap", "source-motion-symlink-swap", "lifecycle-call-sites", "lifecycle-disconnect-kill", "lifecycle-shutdown-kill", "loopback"],
		spawn: startArdyBridge,
	},
	{
		name: "ingest-host",
		// The clause set the host can answer without a GPU box attached. The
		// artifact-swap trio is deliberately included: the host serves staged
		// footage and extracted motion, so it inherits exactly the containment
		// escapes that bit the bridge (hard link, directory swap).
		probes: ["cross-site", "options-cors", "method-405", "unknown-404", "content-type", "body-cap", "loopback"],
		spawn: startIngestHost,
	},
];

const started = [];
try {
	for (const registration of REGISTRY) {
		let bridge;
		try {
			bridge = await registration.spawn();
		} catch (err) {
			ok(`[${registration.name}] start`, false, `bridge failed to start: ${err.message}`);
			continue;
		}
		started.push(bridge);
		for (const probeName of registration.probes) {
			try {
				await PROBES[probeName](bridge);
			} catch (err) {
				ok(`[${bridge.name}] ${probeName}`, false, `probe crashed: ${err.message}`);
			}
		}
	}
} finally {
	for (const bridge of started) bridge.stop();
}

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

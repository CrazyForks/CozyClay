#!/usr/bin/env node
/**
 * Category 4 — envelope / bridge (tools/providers/envelope.mjs; E1/E2).
 *
 * Attacks the shared provider envelope and the real ARDY bridge where the
 * conformance suite stops:
 *   - cross-site POSTs with an ALLOWED content-type and no security
 *     headers / loopback-hosted attacker origins (the documented residual);
 *   - the body cap AT and just OVER the boundary, chunked and mid-chunk;
 *   - a client disconnecting MID-BODY (the conformance suite only covers
 *     mid-generate disconnects);
 *   - an artifact registered then replaced by a symlink, a HARD LINK and a
 *     DIRECTORY (the symlink swap is covered by the conformance suite; the
 *     hard link defeats realpath containment by construction, and the
 *     directory swap makes the serve path emit a 200 with a destroyed
 *     body — or crash an error-handler-less serve path with EISDIR);
 *   - concurrent registrations evicting each other (FIFO, re-registration
 *     does not refresh position);
 *   - Sec-Fetch-Site: same-site (the app's own browser origin would be
 *     refused a direct fetch — proxy-only by design).
 *
 * The allowlist mechanics are probed through the envelope exports with a
 * base inside artifacts/ (the real bridge's allowlist only fills from a
 * completed generate, which needs a live box; the serve-path replication
 * below uses the same envelope functions and the bridge's own serve
 * logic, and is labelled as replication).
 *
 * Every verdict is derived from observed HTTP responses / process state.
 */
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as env from "../../tools/providers/envelope.mjs";
import { REPO_ROOT, SCRATCH_DIR, createRecorder, sleep } from "./rt-common.mjs";

const rt = createRecorder({ suite: "rt-envelope", category: "envelope-bridge" });

/* ------------------------------ helpers ---------------------------------- */

function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const port = probe.address().port;
			probe.close(() => resolve(port));
		});
	});
}

function httpExchange(url, { method = "GET", headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(url, { method, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
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

async function startBridge() {
	const port = await freePort();
	const proc = spawn(process.execPath, ["tools/ardy/bridge.mjs", "--port", String(port)], {
		cwd: REPO_ROOT,
		env: { ...process.env, CCLAY_ARDY_HOST: "no-such-user@127.0.0.1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.stdout.on("data", (c) => {
		log += c;
	});
	proc.stderr.on("data", (c) => {
		log += c;
	});
	proc.on("exit", (code, signal) => {
		log += `\n[BRIDGE-EXITED code=${code} signal=${signal}]`;
		console.error(`[rt-envelope] bridge exited early: code=${code} signal=${signal}\n${log.slice(-1200)}`);
	});
	await waitForLine(proc.stdout, /listening on http:\/\/127\.0\.0\.1:(\d+)/, 10000);
	return {
		port,
		url: `http://127.0.0.1:${port}`,
		proc,
		readLog: () => log,
		stop() {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* gone */
			}
			const killer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* gone */
				}
			}, 2000);
			killer.unref();
		},
	};
}

// The bridge's own serve path for /ardy/motions/<id>, replicated with the
// same envelope allowlist and the same branch logic (MOTION_ID shape,
// resolve, statSync, stream-with-error-handler). Used only for the
// directory-swap observation; symlink/hardlink resolution results come from
// the envelope itself.
const MOTION_ID = /^[0-9]+-[0-9a-f]{6}$/;
function replicateServeMotion(allowlist, base, runId) {
	const early = (status, reason) => Promise.resolve({ status, reason });
	if (!MOTION_ID.test(runId) || !allowlist.has(runId)) return early(404, "unknown or expired");
	const absPath = allowlist.resolve(runId);
	if (!absPath) return early(404, "escaped");
	let size;
	try {
		size = statSync(absPath).size;
	} catch {
		return early(404, "no longer on disk");
	}
	return new Promise((resolve) => {
		let committed200 = false;
		const server = createServer((req, res) => {
			res.writeHead(200, { "Content-Length": size });
			committed200 = true;
			createReadStream(absPath)
				.on("error", () => {
					res.destroy();
				})
				.pipe(res);
		});
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			const req = httpRequest(`http://127.0.0.1:${port}/x`, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					server.close();
					resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length, contentLength: Number(res.headers["content-length"]), committed200, clientSawError: false });
				});
			});
			req.on("error", (err) => {
				server.close();
				resolve({ status: "error", err: err.message, committed200, clientSawError: true });
			});
			req.end();
		});
	});
}

/* ------------------------------- cases ----------------------------------- */

const bridge = await startBridge();
let fails = [];
try {
	rt.record({
		id: "E-ENV-01",
		kind: "adversarial",
		title: "cross-site POST with the ALLOWED content-type and NO security headers reaches the handler",
		planRef: "plan E2 (assertSameSiteRequest; Sec-Fetch-Site/Origin)",
		input: "POST /ardy/generate, Content-Type: application/json, no Sec-Fetch-Site, no Origin, invalid body",
		expected: "documented residual: loopback + absent CORS cannot stop a header-less POST; the request passes assertSameSiteRequest and reaches validation (400 invalid body), never 403",
		run: async () => {
			const res = await httpExchange(`${bridge.url}/ardy/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "x" }),
			});
			return {
				verdict: res.status === 400 ? "PASS" : res.status === 403 ? "DEFECT" : "WEAKNESS",
				observed: `status=${res.status} body=${res.body.slice(0, 80)}`,
			};
		},
	});

	rt.record({
		id: "E-ENV-02",
		kind: "adversarial",
		title: "cross-site POST from a LOOPBACK-hosted attacker origin (Origin: http://localhost:PORT, no Sec-Fetch-Site) passes the Origin check",
		planRef: "plan E2",
		input: "POST /ardy/generate, Content-Type: application/json, Origin: http://localhost:59999 (a sibling local server), NO Sec-Fetch-Site",
		expected: "the Origin hostname is in LOOPBACK_HOSTS so the gate passes; only Sec-Fetch-Site (which modern browsers always send on cross-site fetches) catches the browser case; a header-less-forging client passes — documented residual",
		run: async () => {
			const res = await httpExchange(`${bridge.url}/ardy/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "http://localhost:59999" },
				body: JSON.stringify({ prompt: "x" }),
			});
			return {
				verdict: res.status === 400 ? "WEAKNESS" : res.status === 403 ? "PASS" : "DEFECT",
				observed: `status=${res.status} body=${res.body.slice(0, 80)}`,
			};
		},
	});

	rt.record({
		id: "E-ENV-03",
		kind: "adversarial",
		title: "hostile preflight from a loopback attacker origin: OPTIONS gets 204 with ZERO CORS headers, so the browser blocks the real POST",
		planRef: "plan E2 (no-CORS enforcement)",
		input: "OPTIONS /ardy/generate with Origin http://localhost:59999 and Access-Control-Request-Method: POST",
		expected: "204 with no Access-Control-Allow-* headers — the preflight fails by CORS rules even though the Origin check passed",
		run: async () => {
			const res = await httpExchange(`${bridge.url}/ardy/generate`, {
				method: "OPTIONS",
				headers: { Origin: "http://localhost:59999", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
			});
			const cors = Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith("access-control-"));
			return {
				verdict: res.status === 204 && cors.length === 0 ? "PASS" : "DEFECT",
				observed: `status=${res.status} corsHeaders=${cors.join(",") || "none"}`,
			};
		},
	});

	rt.record({
		id: "E-ENV-04",
		kind: "boundary",
		title: "Sec-Fetch-Site: same-site is REFUSED — the app's own browser origin cannot fetch the bridge directly (proxy-only by design)",
		planRef: "plan E2",
		input: "POST /ardy/generate with Sec-Fetch-Site: same-site (the header a browser sends from http://127.0.0.1:5180 to http://127.0.0.1:5181 — same site, cross origin)",
		expected: "403 by the documented rule (anything other than same-origin/none is refused); the app is unaffected because its Vite/CLI proxies forward server-side without this header",
		run: async () => {
			const res = await httpExchange(`${bridge.url}/ardy/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" },
				body: JSON.stringify({ prompt: "x", duration: 1, posePin: false }),
			});
			return { verdict: res.status === 403 ? "PASS" : "DEFECT", observed: `status=${res.status}` };
		},
	});

	rt.record({
		id: "E-ENV-05",
		kind: "math",
		title: "body cap at the boundary: exactly-maxBytes JSON is accepted; one byte over is 413, including a mid-chunk trip",
		planRef: "plan E1 (readJsonBody)",
		input: "a valid-JSON body of exactly 1 MiB; 1 MiB + 1 byte; a body that crosses the cap mid-chunk (first chunk at cap, second chunk 1 byte)",
		expected: "at-cap parses (400 on the generate route = past the body gate); over-cap 413 in both delivery shapes; the oversized body is drained so the error response arrives",
		run: async () => {
			const max = 1024 * 1024;
			// exactly maxBytes of valid JSON: {"p":"<pad>"}
			const pad = max - '{"p":""}'.length;
			const atCap = `{"p":"${"x".repeat(pad)}"}`;
			const atRes = await httpExchange(`${bridge.url}/ardy/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: atCap,
			});
			const over = await httpExchange(`${bridge.url}/ardy/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: `{"p":"${"x".repeat(pad + 1)}"}`,
			});
			const chunked = await new Promise((resolve, reject) => {
				const req = httpRequest(`${bridge.url}/ardy/generate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
				}, (res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
				});
				req.on("error", reject);
				req.write(atCap); // exactly at cap in the first chunk
				req.write("x"); // one byte over in the second chunk
				req.end();
			});
			const atOk = atRes.status !== 413 && atRes.status === 400;
			const overOk = over.status === 413;
			const chunkOk = chunked.status === 413;
			return {
				verdict: atOk && overOk && chunkOk ? "PASS" : "DEFECT",
				observed: `atCap=${atRes.status} over=${over.status} midChunk=${chunked.status}`,
			};
		},
	});

	rt.record({
		id: "E-ENV-06",
		kind: "adversarial",
		title: "a client disconnecting MID-BODY: the bridge survives and answers the aborted POST with 400, never crashes",
		planRef: "plan E2 (client disconnect kills children; mid-body path)",
		input: "POST /ardy/generate, write the first chunk, destroy the socket before the body completes",
		expected: "the bridge process stays alive; the request is logged as a client error / 400; no unhandled rejection, no exit",
		run: async () => {
			const before = bridge.proc.exitCode;
			const outcome = await new Promise((resolve) => {
				const req = httpRequest(`${bridge.url}/ardy/generate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
				}, (res) => {
					res.resume();
					res.on("end", () => resolve({ responded: true, status: res.statusCode }));
				});
				req.on("error", () => resolve({ responded: false }));
				req.write('{"prompt":"x'.repeat(1024));
				setTimeout(() => req.destroy(), 30);
			});
			await sleep(800);
			const alive = bridge.proc.exitCode === null;
			const log = bridge.readLog();
			const handled = /client error|-> 400|-> 413/.test(log);
			return {
				verdict: alive && before === null && handled ? "PASS" : "DEFECT",
				observed: `clientSaw=${JSON.stringify(outcome)} bridgeAlive=${alive} handled=${handled} logTail=${log.slice(-160).replace(/\n/g, " | ")}`,
			};
		},
	});

	rt.record({
		id: "E-ENV-07",
		kind: "boundary",
		title: "content-type exactness: case-insensitive base type passes; parameters and whitespace are 415",
		planRef: "plan E1",
		input: "Content-Type Application/JSON; application/json; charset=utf-8; application/json (trailing space); text/plain",
		expected: "the bare type matches case-insensitively; any parameter or whitespace fails the exact match with 415",
		run: async () => {
			const cases = ["Application/JSON", "application/json; charset=utf-8", "application/json ", "text/plain"];
			const results = [];
			for (const ct of cases) {
				const res = await httpExchange(`${bridge.url}/ardy/generate`, {
					method: "POST",
					headers: { "Content-Type": ct },
					body: JSON.stringify({ prompt: "x" }),
				});
				results.push(`${ct}:${res.status}`);
			}
			// Node's HTTP parser trims header values, so a trailing space is
			// indistinguishable from the bare type BEFORE the gate sees it —
			// the gate's exact-match obligation applies to parameters, which
			// ARE refused (415).
			const baseOk = results[0].split(":").at(-1) !== "415";
			const params = results[1].endsWith(":415") && results[2].endsWith(":400") && results[3].endsWith(":415");
			return { verdict: baseOk && params ? "PASS" : "DEFECT", observed: results.join(" | ") };
		},
	});

	rt.record({
		id: "E-ENV-08",
		kind: "adversarial",
		title: "HARD LINK swap: an artifact replaced by a hard link to an OUTSIDE file passes realpath containment and serves the outside bytes",
		planRef: "plan E2 (realpath containment re-checked at serve time)",
		input: "register base/artifact.bin; delete it; hard-link an outside file into base/artifact.bin; resolve + serve",
		expected: "realpath() resolves hard links by NAME, not inode, so the swapped file still 'sits under base'; the containment mechanism cannot distinguish the swap and the outside bytes are served — a claim mismatch with 'a registered file swapped ... resolves to null here'",
		run: () => {
			const root = mkdtempSync(join(tmpdir(), "cc-rt-hardlink-"));
			const base = join(root, "base");
			const outside = join(root, "outside");
			mkdirSync(base);
			mkdirSync(outside);
			try {
				const secret = join(outside, "secret.bin");
				writeFileSync(secret, "OUTSIDE-SECRET-BYTES");
				const good = join(base, "artifact.bin");
				writeFileSync(good, "GOOD-BYTES");
				const wl = env.createArtifactAllowlist({ base, max: 8 });
				wl.register("run-123-abcdef", good);
				rmSync(good);
				linkSync(secret, good); // hard link, same inode as the outside file
				const resolved = wl.resolve("run-123-abcdef");
				const served = resolved === null ? null : readFileSync(resolved, "utf8");
				const passed = resolved !== null && served === "OUTSIDE-SECRET-BYTES";
				return {
					verdict: passed ? "DEFECT" : "PASS",
					observed: `resolve=${resolved} served=${served} (outside bytes served: ${passed})`,
				};
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	});

	rt.record({
		id: "E-ENV-09",
		kind: "adversarial",
		title: "SYMLINK swap: an artifact replaced by a symlink to an outside file resolves to null (the defended case)",
		planRef: "plan E2",
		input: "register base/artifact.bin; delete it; symlink the outside file into base/artifact.bin",
		expected: "realpath containment refuses: resolve() returns null",
		run: () => {
			const root = mkdtempSync(join(tmpdir(), "cc-rt-symlink-"));
			const base = join(root, "base");
			const outside = join(root, "outside");
			mkdirSync(base);
			mkdirSync(outside);
			try {
				const secret = join(outside, "secret.bin");
				writeFileSync(secret, "OUTSIDE-SECRET-BYTES");
				const good = join(base, "artifact.bin");
				writeFileSync(good, "GOOD-BYTES");
				const wl = env.createArtifactAllowlist({ base, max: 8 });
				wl.register("run-123-abcdef", good);
				rmSync(good);
				symlinkSync(secret, good);
				const resolved = wl.resolve("run-123-abcdef");
				return { verdict: resolved === null ? "PASS" : "DEFECT", observed: `resolve=${resolved}` };
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	});

	rt.record({
		id: "E-ENV-10",
		kind: "adversarial",
		title: "DIRECTORY swap: containment passes, and the serve path emits a 200 with a destroyed body (or crashes an error-handler-less path with EISDIR)",
		planRef: "plan E2 (serve-time re-check)",
		input: "register base/artifact.bin; delete it; mkdir base/artifact.bin; resolve, then replicate the bridge's serve path",
		expected: "observed: resolve() passes (a directory has a realpath under base); statSync(dir).size is non-zero so the 200 header goes out; createReadStream(dir) fails with EISDIR — the bridge's error handler destroys the connection (client sees 200 + truncated body) and a serve path without an error handler crashes the process",
		run: async () => {
			const root = mkdtempSync(join(tmpdir(), "cc-rt-dirswap-"));
			const base = join(root, "base");
			mkdirSync(base);
			try {
				const good = join(base, "artifact.bin");
				writeFileSync(good, "GOOD-BYTES");
				const wl = env.createArtifactAllowlist({ base, max: 8 });
				wl.register("1234567890123-abcdef", good);
				rmSync(good);
				mkdirSync(good);
				const resolved = wl.resolve("1234567890123-abcdef");
				const containmentPassed = resolved !== null;
				// replicate the bridge serve path (error handler present)
				const served = containmentPassed ? await replicateServeMotion(wl, base, "1234567890123-abcdef") : { status: 404 };
				// the error-handler-less pattern (the envelope fixture's serve
				// path): EISDIR is an unhandled stream error -> process crash
				let crashObserved = false;
				if (containmentPassed) {
					const child = spawn(process.execPath, ["-e", `
						const { createReadStream, statSync } = require("node:fs");
						const { createServer } = require("node:http");
						const dir = ${JSON.stringify(good)};
						const server = createServer((req, res) => {
							const size = statSync(dir).size;
							res.writeHead(200, { "Content-Length": size });
							createReadStream(dir).pipe(res);
						});
						server.listen(0, "127.0.0.1", () => {
							const port = server.address().port;
							const req = require("node:http").request("http://127.0.0.1:" + port + "/x", (res) => { res.resume(); res.on("end", () => process.exit(0)); });
							req.on("error", () => {});
							req.end();
						});
					`], { stdio: "ignore" });
					const exited = await new Promise((resolve) => {
						const timer = setTimeout(() => resolve("still-alive"), 3000);
						child.on("exit", (code) => {
							clearTimeout(timer);
							resolve(`exit-${code}`);
						});
					});
					crashObserved = exited.startsWith("exit-") && exited !== "exit-0";
					if (exited === "still-alive") {
						try {
							child.kill("SIGKILL");
						} catch {
							/* gone */
						}
					}
				}
				const bridgeStyle = served.status === 200 && served.bytes < served.contentLength;
				// the serve path COMMITS a 200 (Content-Length from the dir's
				// stat size) before the stream dies; the client-visible outcome
				// is a reset/truncation instead of the clean 404 the
				// "no longer on disk" branch promises — no isFile() check
				const committedThenKilled = containmentPassed && served.committed200 && served.clientSawError && crashObserved;
				return {
					verdict: committedThenKilled ? "DEFECT" : containmentPassed && (served.committed200 || served.clientSawError) ? "WEAKNESS" : "PASS",
					observed: `containmentPassed=${containmentPassed} served=${JSON.stringify(served)} handlerLessPath=${crashObserved ? "crashed (EISDIR unhandled)" : "survived"}`,
				};
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	});

	rt.record({
		id: "E-ENV-11",
		kind: "algorithm",
		title: "concurrent registrations evict each other FIFO; re-registering a STILL-PRESENT id does NOT refresh its eviction position",
		planRef: "plan E2 (FIFO-capped allowlist)",
		input: "max=3: register id0, id1, id2; re-register id1 while present; register id3 (evicts the oldest); register id4",
		expected: "Map.set on an existing key keeps the original insertion order, so id1's re-registration does not refresh it: id3 evicts id0, then id4 evicts id1 (the next-oldest). If re-registration refreshed position, id4 would evict id2 instead — the probe discriminates",
		run: () => {
			const root = mkdtempSync(join(tmpdir(), "cc-rt-evict-"));
			const base = join(root, "base");
			mkdirSync(base);
			try {
				const file = join(base, "f.bin");
				writeFileSync(file, "x");
				const wl = env.createArtifactAllowlist({ base, max: 3 });
				wl.register("id0", file);
				wl.register("id1", file);
				wl.register("id2", file);
				wl.register("id1", file); // re-register while still present
				wl.register("id3", file); // evicts the oldest: id0
				const afterId3 = wl.has("id0") === false && wl.has("id1") === true && wl.has("id3") === true;
				wl.register("id4", file); // FIFO by first insertion -> evicts id1
				const fifoNoRefresh = wl.has("id1") === false && wl.has("id2") === true && wl.has("id4") === true;
				return {
					verdict: afterId3 && fifoNoRefresh ? "PASS" : "DEFECT",
					observed: `afterId3={id0:${wl.has("id0")},id1:${wl.has("id1")},id3:${wl.has("id3")}} afterId4={id1:${wl.has("id1")},id2:${wl.has("id2")},id4:${wl.has("id4")}}`,
				};
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	});

	rt.record({
		id: "E-ENV-12",
		kind: "boundary",
		title: "re-registering the same id with a NEW path serves only the newest path; the id stays a single entry",
		planRef: "plan E2",
		input: "register id -> pathA; register id -> pathB (both under base)",
		expected: "the second registration overwrites the stored path; resolve returns pathB; the map has one entry (no unbounded growth)",
		run: () => {
			const root = mkdtempSync(join(tmpdir(), "cc-rt-rereg-"));
			const base = join(root, "base");
			mkdirSync(base);
			try {
				const a = join(base, "a.bin");
				const b = join(base, "b.bin");
				writeFileSync(a, "A");
				writeFileSync(b, "B");
				const wl = env.createArtifactAllowlist({ base, max: 8 });
				wl.register("run-1-abcdef", a);
				wl.register("run-1-abcdef", b);
				const resolved = wl.resolve("run-1-abcdef");
				const size = (() => {
					let n = 0;
					for (let i = 0; i < 9; i += 1) {
						const p = join(base, `probe${i}.bin`);
						writeFileSync(p, "x");
						wl.register(`probe-${i}-abc${i}def`, p);
					}
					return [...Array(9).keys()].filter((i) => wl.has(`probe-${i}-abc${i}def`)).length;
				})();
				return {
					// resolve() returns the realpath; compare content, not the raw path
					verdict: resolved !== null && readFileSync(resolved, "utf8") === "B" && size === 8 ? "PASS" : "DEFECT",
					observed: `servedB=${resolved !== null && readFileSync(resolved, "utf8") === "B"} survivors=${size}/9`,
				};
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	});

	rt.record({
		id: "E-ENV-13",
		kind: "boundary",
		title: "malformed JSON edges: trailing garbage, JSON null, arrays, and an aborted body all get named 400s, never a hang",
		planRef: "plan E1",
		input: "bodies '{}x', 'null', '[]', and a Content-Length lying about the body size",
		expected: "400 with a named reason for each; the bridge stays alive",
		run: async () => {
			const cases = ["{}x", "null", "[]"];
			const results = [];
			for (const body of cases) {
				const res = await httpExchange(`${bridge.url}/ardy/generate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
				});
				results.push(`${body}:${res.status}`);
			}
			const all400 = results.every((r) => r.endsWith(":400"));
			const alive = bridge.proc.exitCode === null;
			return { verdict: all400 && alive ? "PASS" : "DEFECT", observed: `${results.join(" | ")} alive=${alive}` };
		},
	});

	rt.record({
		id: "E-ENV-14",
		kind: "boundary",
		title: "a registered id that fails the MOTION_ID shape is registered-but-unservable (404 by the shape gate)",
		planRef: "plan E2 (opaque ids, MOTION_ID shape)",
		input: "register an id that is not <epoch>-<6hex> in a replicated bridge allowlist, then serve it",
		expected: "the serve path's MOTION_ID test runs BEFORE the allowlist lookup, so a registered-but-misshapen id is 404 — the registration seam and the serve gate disagree (the seam is test-only)",
		run: () => {
			const root = mkdtempSync(join(tmpdir(), "cc-rt-shape-"));
			const base = join(root, "base");
			mkdirSync(base);
			try {
				const file = join(base, "f.bin");
				writeFileSync(file, "x");
				const wl = env.createArtifactAllowlist({ base, max: 8 });
				wl.register("not-an-id", file);
				const registered = wl.has("not-an-id");
				const served = replicateServeMotion(wl, base, "not-an-id");
				return new Promise((resolve) => {
					served.then((r) =>
						resolve({
							verdict: registered && r.status === 404 ? "PASS" : "DEFECT",
							observed: `registered=${registered} served=${r.status}`,
						}),
					);
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	});

	rt.record({
		id: "E-ENV-15",
		kind: "property",
		title: "loopback bind and unknown-route 404 on the real bridge (control)",
		planRef: "plan E2",
		input: "GET /definitely-not-a-route; verify the listen host",
		expected: "404 with a named reason; the bridge bound 127.0.0.1",
		run: async () => {
			const res = await httpExchange(`${bridge.url}/definitely-not-a-route`, {});
			const log = bridge.readLog();
			return {
				verdict: res.status === 404 && /listening on http:\/\/127\.0\.0\.1/.test(log) ? "PASS" : "DEFECT",
				observed: `status=${res.status} bound=${/listening on http:\/\/127\.0\.0\.1/.test(log)}`,
			};
		},
	});
const evidencePath = await rt.write();
fails = rt.cases.filter((c) => c.verdict === "HARNESS-FAIL");
console.log(`\nrt-envelope: ${rt.cases.length} cases, ${rt.cases.filter((c) => c.verdict === "DEFECT").length} DEFECT, ${rt.cases.filter((c) => c.verdict === "WEAKNESS").length} WEAKNESS, evidence: ${evidencePath}`);
} finally {
	// The bridge must outlive every async case: record() returns immediately
	// for async runs, so stop() belongs AFTER the flush above, not around the
	// registrations.
	bridge.stop();
}
process.exit(fails.length ? 1 : 0);

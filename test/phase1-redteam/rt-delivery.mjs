#!/usr/bin/env node
/**
 * Category 5 — delivery topology (plan §11; D1-D3).
 *
 * Attacks the launch ordering and discovery mechanics where the green
 * suite stops:
 *   - the app started BEFORE the surface (cold-start ordering, per-request
 *     proxy resolution) and the surface before the app;
 *   - a stale discovery file naming a DEAD pid (must be ignored);
 *   - a discovery file with a LIVE pid but a CLOSED port, and pid 0 —
 *     the liveness check is `process.kill(pid, 0)` alone, which cannot
 *     tell a live-but-unrelated pid (or pid 0) from the real publisher;
 *     plan 11.2's rule is "never proxy to a port nobody owns";
 *   - the packaged CLI reads the record ONCE at startup, so a stale record
 *     poisons the whole session;
 *   - CSP headers in dev versus packaged, on document and non-document
 *     responses, and the built child's meta policy.
 *
 * Every spawned process gets an isolated XDG_CONFIG_HOME; every case runs
 * inside the recorder's protected run(), so an observation failure is a
 * recorded HARNESS-FAIL, never a suite crash. Verdicts are derived from
 * observed HTTP responses and discovery records.
 */
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { REPO_ROOT, createRecorder, sleep } from "./rt-common.mjs";

const rt = createRecorder({ suite: "rt-delivery", category: "delivery-topology" });

const VITE_BIN = join("node_modules", "vite", "bin", "vite.js");
const SURFACE_CONFIG = "vite.ingest.config.js";
const APP_CONFIG = "vite.config.js";
const CLI = join("bin", "cozyclay.mjs");
const INGEST_PORT_FROM = 5183;
const INGEST_PORT_TO = 5199;
const PARENT_CSP = "frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'";
const PROD_CHILD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

const tmpHome = () => mkdtempSync(join(tmpdir(), "cozyclay-redteam-delivery-"));
const discoveryPath = (home) => join(home, "cozyclay", "ingest.json");

function portOpen(port, { timeoutMs = 3000 } = {}) {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const probeOnce = () => {
			const p = createConnection({ port, host: "127.0.0.1" });
			let settled = false;
			const finish = (v) => {
				if (!settled) {
					settled = true;
					p.destroy();
					resolve(v);
				}
			};
			p.once("error", () => {
				if (Date.now() >= deadline) finish(false);
				else setTimeout(probeOnce, 100);
			});
			p.once("connect", () => finish(true));
		};
		probeOnce();
	});
}

async function freePort(from = 5201) {
	for (let port = from; port < 60000; port += 1) {
		if (!(await portOpen(port, { timeoutMs: 200 }))) return port;
	}
	throw new Error("no free test port");
}

function httpGet(port, path) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function waitForHttp(port, { timeoutMs = 25000, child } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		if (child && child.exitCode !== null) {
			throw new Error(`child on ${port} exited (code ${child.exitCode}) before serving: ${(child.log ?? "").slice(-400)}`);
		}
		try {
			return await httpGet(port, "/");
		} catch (err) {
			last = err;
			await sleep(100);
		}
	}
	throw last ?? new Error(`no HTTP response from 127.0.0.1:${port}`);
}

async function waitForDiscovery(home, { timeoutMs = 25000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(discoveryPath(home))) {
			try {
				return JSON.parse(readFileSync(discoveryPath(home), "utf8"));
			} catch {
				/* still being written */
			}
		}
		await sleep(100);
	}
	return null;
}

function collect(child) {
	child.log = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c) => {
		child.log += c;
	});
	child.stderr.on("data", (c) => {
		child.log += c;
	});
	return child;
}

// --strictPort only for explicit-port app spawns: the surface negotiates
// 5183..5199 and must NOT fail when 5183 is busy.
function spawnVite(config, { home, args = [], env = {}, strictPort = false }) {
	const argv = [VITE_BIN, "--config", config, "--host", "127.0.0.1", ...(strictPort ? ["--strictPort"] : []), ...args];
	return collect(spawn(process.execPath, argv, {
		cwd: REPO_ROOT,
		env: { ...process.env, XDG_CONFIG_HOME: home, ...env },
		stdio: "pipe",
	}));
}

function spawnCli(port, { home, args = [] }) {
	return collect(spawn(process.execPath, [CLI, "--port", String(port), "--no-open", "--no-star", ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, XDG_CONFIG_HOME: home },
		stdio: "pipe",
	}));
}

function writeDiscovery(home, record) {
	mkdirSync(join(home, "cozyclay"), { recursive: true });
	writeFileSync(discoveryPath(home), JSON.stringify(record) + "\n", { mode: 0o600 });
}

// SIGTERM, then wait for exit; SIGKILL fallback after 3 s. The packaged
// CLI's shutdown can linger (its goodbye path is async), so stop() must
// not return while the child is still alive.
const stop = async (child) => {
	if (!child || child.exitCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		/* gone */
	}
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		new Promise((resolve) => {
			const killer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* gone */
				}
				resolve();
			}, 3000);
			killer.unref();
		}),
	]);
};

// a port that is bound then closed: owned by nobody, recorded anyway
const closedPort = async () => {
	const port = await freePort();
	const srv = createServer();
	await new Promise((r) => srv.listen(port, "127.0.0.1", r));
	await new Promise((r) => srv.close(r));
	return port;
};

const safeParse = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

/* --------------------------------- cases ---------------------------------- */

await rt.record({
	id: "D-DEL-01",
	kind: "property",
	title: "the app started BEFORE the surface: /ingest/surface-origin resolves per request with no restart",
	planRef: "plan §11.2 (per-request target resolution)",
	input: "app Vite up first (isolated home); then surface Vite; poll through the app origin",
	expected: "before the surface publishes, the probe is absent (app shell, no origin); after publication the probe resolves without any app restart",
	run: async () => {
		const home = tmpHome();
		const appPort = await freePort();
		const app = spawnVite(APP_CONFIG, { home, args: ["--port", String(appPort)], strictPort: true });
		let surface = null;
		try {
			await waitForHttp(appPort, { child: app });
			const before = await httpGet(appPort, "/ingest/surface-origin");
			const beforeAbsent = before.status === 200 && /<!doctype html/i.test(before.body);
			surface = spawnVite(SURFACE_CONFIG, { home });
			const record = await waitForDiscovery(home);
			let resolved = null;
			const deadline = Date.now() + 20000;
			while (Date.now() < deadline) {
				const probe = await httpGet(appPort, "/ingest/surface-origin").catch(() => null);
				const parsed = probe?.status === 200 ? safeParse(probe.body) : null;
				if (parsed?.origin) {
					resolved = parsed;
					break;
				}
				await sleep(100);
			}
			const ok2 = !!record && !!resolved && resolved.origin === record.origin && resolved.url === `${record.origin}/src/ingest/index.html`;
			return {
				verdict: beforeAbsent && ok2 ? "PASS" : "DEFECT",
				observed: `before=${before.status} ${beforeAbsent ? "absent" : "UNEXPECTED"} record=${record ? record.origin : null} resolved=${resolved ? resolved.origin : null}`,
			};
		} finally {
			await stop(surface);
			await stop(app);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-02",
	kind: "property",
	title: "the surface BEFORE the app: the first probe through the app already resolves",
	planRef: "plan §11.2",
	input: "surface Vite publishes first; then app Vite on a free port",
	expected: "the app's very first /ingest/surface-origin probe resolves (per-request resolution)",
	run: async () => {
		const home = tmpHome();
		const surface = spawnVite(SURFACE_CONFIG, { home });
		let app = null;
		try {
			const record = await waitForDiscovery(home);
			const appPort = await freePort();
			app = spawnVite(APP_CONFIG, { home, args: ["--port", String(appPort)], strictPort: true });
			await waitForHttp(appPort, { child: app });
			const probe = await httpGet(appPort, "/ingest/surface-origin");
			const parsed = probe.status === 200 ? safeParse(probe.body) : null;
			const ok2 = !!record && parsed?.origin === record.origin && parsed?.url === `${record.origin}/src/ingest/index.html`;
			return { verdict: ok2 ? "PASS" : "DEFECT", observed: `record=${record?.origin} probe=${parsed?.origin ?? probe.status}` };
		} finally {
			await stop(app);
			await stop(surface);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-03",
	kind: "boundary",
	title: "a stale discovery file naming a DEAD pid is ignored: the probe falls through to the app shell",
	planRef: "plan §11.2",
	input: "discovery record with pid 2147483647 (dead); dev app server; GET /ingest/surface-origin",
	expected: "no proxy branch; the SPA fallback answers the app shell (absent origin)",
	run: async () => {
		const home = tmpHome();
		writeDiscovery(home, { port: 59999, origin: "http://127.0.0.1:59999", token: "x", pid: 2147483647, startedAt: new Date().toISOString() });
		const appPort = await freePort();
		const app = spawnVite(APP_CONFIG, { home, args: ["--port", String(appPort)], strictPort: true });
		try {
			await waitForHttp(appPort, { child: app });
			const res = await httpGet(appPort, "/ingest/surface-origin");
			const absent = res.status === 200 && /<!doctype html/i.test(res.body);
			return { verdict: absent ? "PASS" : "DEFECT", observed: `status=${res.status} absent=${absent}` };
		} finally {
			await stop(app);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-04",
	kind: "adversarial",
	title: "a discovery file with a LIVE pid but a CLOSED port: the dev server proxies to a port nobody owns (502 instead of absent)",
	planRef: "plan §11.2 (never proxy to a port nobody owns)",
	input: "record with pid=<live> and a closed port; dev app server; GET /ingest/surface-origin",
	expected: "the liveness check is pid-only, so the record passes; the proxy is added and every /ingest/* request answers 502 'ingest surface is not running' instead of the clean absent state",
	run: async () => {
		const port = await closedPort();
		const home = tmpHome();
		writeDiscovery(home, { port, origin: `http://127.0.0.1:${port}`, token: "x", pid: process.pid, startedAt: new Date().toISOString() });
		const appPort = await freePort();
		const app = spawnVite(APP_CONFIG, { home, args: ["--port", String(appPort)], strictPort: true });
		try {
			await waitForHttp(appPort, { child: app });
			const res = await httpGet(appPort, "/ingest/surface-origin");
			return {
				verdict: res.status === 502 && res.body.includes("ingest surface is not running") ? "DEFECT" : "PASS",
				observed: `status=${res.status} body=${res.body.slice(0, 60)}`,
			};
		} finally {
			await stop(app);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-05",
	kind: "adversarial",
	title: "packaged CLI: a stale live-pid record poisons the whole session — 503, and a later real surface is never seen (one-shot discovery read)",
	planRef: "plan §11.2 (never proxy to a port nobody owns; dev re-resolves per request)",
	input: "CLI started with a live-pid/closed-port record; then a real surface publishes a fresh record in the same home; probe /ingest/surface-origin before and after",
	expected: "the record is accepted (pid live) so /ingest/* answers 503 'ingest host is not running'; the CLI read the record ONCE at startup, so even after the real surface publishes, the probe stays 503 — the session is poisoned for its lifetime",
	run: async () => {
		const port = await closedPort();
		const home = tmpHome();
		writeDiscovery(home, { port, origin: `http://127.0.0.1:${port}`, token: "x", pid: process.pid, startedAt: new Date().toISOString() });
		const cliPort = await freePort();
		const cli = spawnCli(cliPort, { home });
		try {
			await waitForHttp(cliPort, { child: cli });
			const before = await httpGet(cliPort, "/ingest/surface-origin");
			const surface = spawnVite(SURFACE_CONFIG, { home });
			let record = null;
			try {
				record = await waitForDiscovery(home);
				const after = await httpGet(cliPort, "/ingest/surface-origin");
				return {
					verdict: before.status === 503 && after.status === 503 && !!record ? "DEFECT" : "PASS",
					observed: `before=${before.status} after=${after.status} newRecord=${record?.origin ?? null}`,
				};
			} finally {
				await stop(surface);
			}
		} finally {
			await stop(cli);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-06",
	kind: "adversarial",
	title: "a discovery file with pid 0 passes process.kill(0, 0) — the liveness check is trivially satisfied and the proxy is added",
	planRef: "plan §11.2",
	input: "record with pid: 0 (process.kill(0,0) checks the caller's own process group and never throws) and a closed port; packaged CLI",
	expected: "the record passes liveness; /ingest/surface-origin answers 503 instead of the clean 404 absent state",
	run: async () => {
		const port = await closedPort();
		const home = tmpHome();
		writeDiscovery(home, { port, origin: `http://127.0.0.1:${port}`, token: "x", pid: 0, startedAt: new Date().toISOString() });
		const cliPort = await freePort();
		const cli = spawnCli(cliPort, { home });
		try {
			await waitForHttp(cliPort, { child: cli });
			const res = await httpGet(cliPort, "/ingest/surface-origin");
			return { verdict: res.status === 503 ? "DEFECT" : "PASS", observed: `status=${res.status} body=${res.body.slice(0, 60)}` };
		} finally {
			await stop(cli);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-07",
	kind: "property",
	title: "CSP dev: the parent frame-src policy rides on document AND SPA-fallback responses",
	planRef: "plan §11.4",
	input: "GET / and GET /some/deep/spa/route on the dev app server",
	expected: "both carry the exact parent frame-src policy",
	run: async () => {
		const home = tmpHome();
		const appPort = await freePort();
		const app = spawnVite(APP_CONFIG, { home, args: ["--port", String(appPort)], strictPort: true });
		try {
			await waitForHttp(appPort, { child: app });
			const root = await httpGet(appPort, "/");
			const deep = await httpGet(appPort, "/some/deep/spa/route");
			const rootCsp = root.headers["content-security-policy"] ?? "";
			const deepCsp = deep.headers["content-security-policy"] ?? "";
			const ok2 = rootCsp === PARENT_CSP && deepCsp === PARENT_CSP;
			return { verdict: ok2 ? "PASS" : "DEFECT", observed: `root=${rootCsp || "(none)"} deep=${deepCsp || "(none)"}` };
		} finally {
			await stop(app);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-08",
	kind: "edge",
	title: "CSP dev: the proxy error body (502 JSON) carries no CSP — it is not a document",
	planRef: "plan §11.4",
	input: "GET /ingest/surface-origin through a stale-record dev proxy (502)",
	expected: "the parent CSP is a document policy; the JSON error response does not carry it (observed, informational)",
	run: async () => {
		const port = await closedPort();
		const home = tmpHome();
		writeDiscovery(home, { port, origin: `http://127.0.0.1:${port}`, token: "x", pid: process.pid, startedAt: new Date().toISOString() });
		const appPort = await freePort();
		const app = spawnVite(APP_CONFIG, { home, args: ["--port", String(appPort)], strictPort: true });
		try {
			await waitForHttp(appPort, { child: app });
			const proxyErr = await httpGet(appPort, "/ingest/surface-origin");
			const proxyCsp = proxyErr.headers["content-security-policy"];
			return {
				verdict: proxyErr.status === 502 && proxyCsp === undefined ? "PASS" : "WEAKNESS",
				observed: `status=${proxyErr.status} csp=${proxyCsp ?? "(none)"}`,
			};
		} finally {
			await stop(app);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-09",
	kind: "boundary",
	title: "CSP packaged: the parent frame-src policy rides on the document; 404 error bodies carry none",
	planRef: "plan §11.4",
	input: "GET / and GET /ingest/surface-origin on the packaged CLI",
	expected: "the document carries the exact parent policy; the 404 text body is not a document so it carries no CSP",
	run: async () => {
		const home = tmpHome();
		const cliPort = await freePort();
		const cli = spawnCli(cliPort, { home });
		try {
			await waitForHttp(cliPort, { child: cli });
			const root = await httpGet(cliPort, "/");
			const miss = await httpGet(cliPort, "/ingest/surface-origin");
			const rootCsp = root.headers["content-security-policy"] ?? "";
			const missCsp = miss.headers["content-security-policy"];
			const ok2 = rootCsp === PARENT_CSP && missCsp === undefined && miss.status === 404;
			return { verdict: ok2 ? "PASS" : "DEFECT", observed: `root=${rootCsp || "(none)"} miss=${miss.status} csp=${missCsp ?? "(none)"}` };
		} finally {
			await stop(cli);
		}
	},
}).done;

await rt.record({
	id: "D-DEL-10",
	kind: "boundary",
	title: "CSP packaged child: the built surface carries the PROD meta policy and no dev tokens, and frame-ancestors is header-only (absent from meta)",
	planRef: "plan §11.4 (frame-ancestors is ignored in meta)",
	input: "read-only inspection of dist-ingest/src/ingest/index.html",
	expected: "the PROD policy meta is present verbatim; no dev-variant tokens; frame-ancestors absent from the meta (it is a response-header-only directive)",
	run: () => {
		const htmlPath = join(REPO_ROOT, "dist-ingest", "src", "ingest", "index.html");
		const html = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : "";
		const htmlText = html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
		const hasProdMeta = htmlText.includes(`<meta http-equiv="Content-Security-Policy" content="${PROD_CHILD_CSP}">`);
		const devTokens = ["ws://127.0.0.1:", "script-src 'self' 'unsafe-inline'", "frame-ancestors"].filter((t) => html.includes(t));
		const built = existsSync(htmlPath);
		return {
			verdict: built && hasProdMeta && devTokens.length === 0 ? "PASS" : "DEFECT",
			observed: `built=${built} prodMeta=${hasProdMeta} devTokens=${devTokens.join(",") || "none"}`,
		};
	},
}).done;

await rt.record({
	id: "D-DEL-11",
	kind: "property",
	title: "the surface publishes a well-formed discovery record, mode 0600, inside the negotiated range (control)",
	planRef: "plan §11.2",
	input: "spawn the surface Vite in an isolated home; read the record",
	expected: "port in 5183..5199, matching origin, 32-char token, integer pid, mode 0600",
	run: async () => {
		const home = tmpHome();
		const surface = spawnVite(SURFACE_CONFIG, { home });
		try {
			const record = await waitForDiscovery(home);
			const mode = record ? statSync(discoveryPath(home)).mode & 0o777 : 0;
			const ok2 =
				!!record &&
				Number.isInteger(record.port) &&
				record.port >= INGEST_PORT_FROM &&
				record.port <= INGEST_PORT_TO &&
				record.origin === `http://127.0.0.1:${record.port}` &&
				typeof record.token === "string" &&
				record.token.length === 32 &&
				Number.isInteger(record.pid) &&
				mode === 0o600;
			return { verdict: ok2 ? "PASS" : "DEFECT", observed: JSON.stringify(record ?? { mode: mode.toString(8) }) };
		} finally {
			await stop(surface);
		}
	},
}).done;

const evidencePath = await rt.write();
const fails = rt.cases.filter((c) => c.verdict === "HARNESS-FAIL");
console.log(`\nrt-delivery: ${rt.cases.length} cases, ${rt.cases.filter((c) => c.verdict === "DEFECT").length} DEFECT, ${rt.cases.filter((c) => c.verdict === "WEAKNESS").length} WEAKNESS, evidence: ${evidencePath}`);
process.exit(fails.length ? 1 : 0);

/**
 * D1-D3 delivery matrix (plan 11): the three launch modes, port negotiation,
 * discovery, the packaged proxy, and both CSP policies.
 *
 * WHY this test exists: the delivery topology is the phase's acceptance
 * surface -- "available" means something different per launch mode, and the
 * plan's 11.1 matrix is only true if each mode is exercised for real. A
 * static reading of configs cannot catch a negotiated port that silently
 * slides out of range, a discovery record that publishes before bind, a
 * proxy branch that 404s, or a CSP whose dev variant leaked into the
 * packaged output. This test therefore spawns the actual servers (surface
 * Vite, app Vite, packaged CLI) and asserts the wire behaviour. Pages and
 * the offline PWA are asserted unavailable by design -- the user accepted
 * that -- rather than worked around.
 *
 * Canonical REDs (plan 13): D1 "all ports taken: expected exit 1, bound 5200
 * anyway"; D2 "packaged /ingest/artifacts proxy: expected 200, got 404";
 * D3 "dev CSP variant present in packaged mode".
 *
 * Every spawned process gets an isolated XDG_CONFIG_HOME so a discovery
 * record from a previous session can never leak into this run.
 */
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer as listenProbe } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwned, terminateOwned, waitForExit } from "../tools/process-supervisor.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITE_BIN = join("node_modules", "vite", "bin", "vite.js");
const SURFACE_CONFIG = "vite.ingest.config.js";
const CLI = join("bin", "cozyclay.mjs");
const INGEST_PORT_FROM = 5183;
const INGEST_PORT_TO = 5199;
const PARENT_CSP = "frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'";

const PROD_CHILD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

const DIST_INGEST_HTML = join(REPO_ROOT, "dist-ingest", "src", "ingest", "index.html");
const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const tmpHome = () => mkdtempSync(join(tmpdir(), "cozyclay-delivery-"));
const discoveryPath = (home) => join(home, "cozyclay", "ingest.json");

function httpGet(port, path, host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host, port, path, method: "GET" }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
			});
		});
		req.on("error", reject);
		req.end();
	});
}

async function waitForHttp(port, path = "/", { timeoutMs = 15000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		try {
			return await httpGet(port, path);
		} catch (err) {
			last = err;
			await sleep(100);
		}
	}
	throw last ?? new Error(`no HTTP response from 127.0.0.1:${port}${path}`);
}

async function portOpen(port, { timeoutMs = 5000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const probe = createConnection({ port, host: "127.0.0.1" });
		const opened = await new Promise((done) => {
			probe.once("error", () => done(false));
			probe.once("connect", () => done(true));
		});
		probe.destroy();
		if (opened) return true;
		await sleep(100);
	}
	return false;
}

async function freePort(from = 5201) {
	for (let port = from; port < 60000; port += 1) {
		if (!(await portOpen(port, { timeoutMs: 200 }))) return port;
	}
	throw new Error("no free test port");
}

async function occupyPorts(from, to) {
	const servers = [];
	for (let port = from; port <= to; port += 1) {
		const server = listenProbe();
		await new Promise((done, fail) => {
			server.once("error", fail);
			server.listen(port, "127.0.0.1", done);
		});
		servers.push(server);
	}
	return {
		close: () => Promise.allSettled(servers.map((server) => new Promise((done) => server.close(done)))),
	};
}
// a port that is bound then closed: owned by nobody, recorded anyway
async function closedPort() {
	const port = await freePort();
	const server = listenProbe();
	await new Promise((done, fail) => {
		server.once("error", fail);
		server.listen(port, "127.0.0.1", done);
	});
	await new Promise((done) => server.close(done));
	return port;
}

function collect(child) {
	let out = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		out += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		out += chunk;
	});
	return () => out;
}

function safeParseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function spawnVite(config, { home, args = [], env = {} }) {
	return spawnOwned(process.execPath, [VITE_BIN, "--config", config, "--host", "127.0.0.1", ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, XDG_CONFIG_HOME: home, ...env },
		stdio: "pipe",
	});
}

function spawnCli(port, { home, args = [] }) {
	return spawnOwned(process.execPath, [CLI, "--port", String(port), "--no-open", "--no-star", ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, XDG_CONFIG_HOME: home },
		stdio: "pipe",
	});
}

// Wait until the surface has published its discovery record, then return it.
async function waitForDiscovery(home, { timeoutMs = 20000 } = {}) {
	const path = discoveryPath(home);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			try {
				return JSON.parse(readFileSync(path, "utf8"));
			} catch {
				/* still being written */
			}
		}
		await sleep(100);
	}
	return null;
}

// --- D1: port negotiation and the discovery mechanism ------------------------
// Negative first (the canonical RED): with every port in the negotiated range
// taken, the surface dev server must exit 1 with a named error -- never slide
// past the range the way Vite's default port fallback would.
{
	const occupiers = await occupyPorts(INGEST_PORT_FROM, INGEST_PORT_TO);
	try {
		const home = tmpHome();
		const child = spawnVite(SURFACE_CONFIG, { home });
		const output = collect(child);
		const exited = waitForExit(child).then((r) => ({ ...r, ran: true }));
		const bound5200 = await Promise.race([exited.then(() => false), portOpen(5200).then(() => true)]);
		const exit = bound5200 ? await terminateOwned(child).then(() => waitForExit(child)) : await exited;
		ok(
			"all ports taken: expected exit 1, bound 5200 anyway",
			exit.code === 1 && !bound5200,
			`exit ${exit.code ?? "null"}${exit.signal ? ` (${exit.signal})` : ""}, 5200 ${bound5200 ? "bound" : "free"}`,
		);
		ok(
			"negotiation names the exhausted range on stderr",
			exit.code === 1 && /all ports 5183\.\.5199 are taken/.test(output()),
			(output().trim().split("\n").filter(Boolean).at(-1) ?? "").slice(0, 160),
		);
	} finally {
		await occupiers.close();
	}
}

// Positive: with the range free, the surface dev server binds inside
// 5183..5199 and publishes its discovery record only after listening.
{
	const home = tmpHome();
	const child = spawnVite(SURFACE_CONFIG, { home });
	try {
		const record = await waitForDiscovery(home);
		const fileOk =
			record &&
			Number.isInteger(record.port) &&
			record.port >= INGEST_PORT_FROM &&
			record.port <= INGEST_PORT_TO &&
			record.origin === `http://127.0.0.1:${record.port}` &&
			typeof record.token === "string" &&
			record.token.length === 32 &&
			Number.isInteger(record.pid) &&
			!Number.isNaN(Date.parse(record.startedAt));
		ok("surface dev server negotiates 5183..5199 and publishes discovery", !!fileOk, JSON.stringify(record ?? null));
		const mode = record ? statSync(discoveryPath(home)).mode & 0o777 : 0;
		ok("discovery record is written mode 0600", mode === 0o600, `mode ${mode.toString(8)}`);
		// The record exists only after bind, so the published origin answers
		// immediately -- including the surface-origin probe the parent uses
		// to learn the child origin.
		const res = record ? await httpGet(record.port, "/ingest/surface-origin").catch(() => null) : null;
		const parsed = res?.status === 200 ? safeParseJson(res.body) : null;
		ok(
			"surface-origin resolves to the exact child origin and entry URL",
			parsed?.origin === record?.origin && parsed?.url === `${record?.origin}/src/ingest/index.html`,
			JSON.stringify(parsed ?? { status: res?.status ?? "unreachable" }),
		);
	} finally {
		await terminateOwned(child);
	}
}
// A minimal published-origin stand-in for the packaged CLI *proxy* rows
// (b) and (d): it binds a port, writes the discovery record the launcher
// reads, and answers the /ingest/* routes the launcher proxies. It stands
// in for any origin the launcher might proxy to -- it is NOT the H1 host
// (tools/ingest/host.mjs, phase 3), and nothing here vouches for host
// behaviour; the packaged-host row below is explicitly not-applicable.
async function startStubHost(home) {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const server = createServer((req, res) => {
		const pathname = (req.url ?? "/").split("?")[0];
		if (pathname === "/ingest/surface-origin") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ origin, url: `${origin}/` }));
			return;
		}
		if (/^\/ingest\/artifacts\/[0-9a-f]{32}\/[a-z0-9_-]{1,32}$/.test(pathname)) {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end("stub artifact");
			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	});
	await new Promise((done, fail) => {
		server.once("error", fail);
		server.listen(port, "127.0.0.1", done);
	});
	mkdirSync(join(home, "cozyclay"), { recursive: true });
	// The launcher ignores a discovery record whose pid is dead, so the stub
	// publishes its own live pid, exactly as the host will.
	writeFileSync(
		discoveryPath(home),
		JSON.stringify({ port, origin, token: "stub-token", pid: process.pid, startedAt: new Date().toISOString() }, null, "\t") + "\n",
		{ mode: 0o600 },
	);
	return {
		port,
		origin,
		close: () => new Promise((done) => server.close(done)),
	};
}


// --- D2: the packaged CLI proxy and packaging --------------------------------
// (a) no discovery record: /ingest/* falls through to dist/ and 404s, so the
// surface never mounts.
{
	const home = tmpHome();
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home });
	try {
		await waitForHttp(cliPort);
		const res = await httpGet(cliPort, "/ingest/surface-origin");
		ok("packaged CLI without a host: /ingest/surface-origin 404 (unavailable)", res.status === 404, `got ${res.status}`);
	} finally {
		await terminateOwned(child);
	}
}

// (b) a live host: the launcher proxies /ingest/* to the published origin.
{
	const home = tmpHome();
	const stub = await startStubHost(home);
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home });
	try {
		await waitForHttp(cliPort);
		const artifact = await httpGet(cliPort, "/ingest/artifacts/0123456789abcdef0123456789abcdef/track_a");
		ok("packaged /ingest/artifacts proxy: expected 200, got 404", artifact.status === 200, `got ${artifact.status}`);
		const probe = await httpGet(cliPort, "/ingest/surface-origin");
		const parsed = probe.status === 200 ? safeParseJson(probe.body) : null;
		ok(
			"packaged surface-origin resolves to the published host",
			parsed?.origin === stub.origin && parsed?.url === `${stub.origin}/`,
			JSON.stringify(parsed ?? { status: probe.status }),
		);
	} finally {
		await terminateOwned(child);
		await stub.close();
	}
}

// (c) a stale record (dead pid) is ignored, so the proxy is not added.
{
	const home = tmpHome();
	mkdirSync(join(home, "cozyclay"), { recursive: true });
	writeFileSync(
		discoveryPath(home),
		JSON.stringify({ port: 59999, origin: "http://127.0.0.1:59999", token: "x", pid: 2147483647, startedAt: new Date().toISOString() }),
	);
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home });
	try {
		await waitForHttp(cliPort);
		const res = await httpGet(cliPort, "/ingest/surface-origin");
		ok("stale discovery record (dead pid) is ignored", res.status === 404, `got ${res.status}`);
	} finally {
		await terminateOwned(child);
	}
}
// (c2) a pid-0 record is rejected by name: process.kill(0, 0) targets the
// caller's own process group and never throws, so pid "liveness" alone
// would accept the record; the packaged CLI must treat it as absent.
{
	const home = tmpHome();
	mkdirSync(join(home, "cozyclay"), { recursive: true });
	writeFileSync(
		discoveryPath(home),
		JSON.stringify({ port: 59998, origin: "http://127.0.0.1:59998", token: "x", pid: 0, startedAt: new Date().toISOString() }),
	);
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home });
	try {
		await waitForHttp(cliPort);
		const res = await httpGet(cliPort, "/ingest/surface-origin");
		ok("pid 0 discovery record is rejected by name (packaged CLI)", res.status === 404, `got ${res.status}`);
	} finally {
		await terminateOwned(child);
	}
}

// (c3) a negative-pid record is rejected the same way: non-positive pids
// are never publishers (dev app server side).
{
	const home = tmpHome();
	mkdirSync(join(home, "cozyclay"), { recursive: true });
	writeFileSync(
		discoveryPath(home),
		JSON.stringify({ port: 59997, origin: "http://127.0.0.1:59997", token: "x", pid: -42, startedAt: new Date().toISOString() }),
	);
	const appPort = await freePort();
	const child = spawnVite("vite.config.js", { home, args: ["--port", String(appPort)] });
	try {
		await waitForHttp(appPort);
		const res = await httpGet(appPort, "/ingest/surface-origin");
		const origin = res.status === 200 ? safeParseJson(res.body) : null;
		ok("negative-pid discovery record is rejected by name (dev)", origin === null, `got ${res.status}${origin ? " " + JSON.stringify(origin) : ""}`);
	} finally {
		await terminateOwned(child);
	}
}

// (c4) a LIVE pid naming a CLOSED port is treated as absent: pid liveness
// cannot tell a live-but-unrelated pid from the real publisher, so the
// record counts only when its published origin answers -- never proxy to
// a port nobody owns (plan 11.2). The dev probe falls through to the app
// shell, not into a 502.
{
	const port = await closedPort();
	const home = tmpHome();
	mkdirSync(join(home, "cozyclay"), { recursive: true });
	writeFileSync(
		discoveryPath(home),
		JSON.stringify({ port, origin: `http://127.0.0.1:${port}`, token: "x", pid: process.pid, startedAt: new Date().toISOString() }),
	);
	const appPort = await freePort();
	const child = spawnVite("vite.config.js", { home, args: ["--port", String(appPort)] });
	try {
		await waitForHttp(appPort);
		const res = await httpGet(appPort, "/ingest/surface-origin");
		const origin = res.status === 200 ? safeParseJson(res.body) : null;
		ok(
			"live-pid/closed-port record is treated as absent (dev, not a 502)",
			origin === null && res.status !== 502,
			`got ${res.status}${res.status === 200 ? " (app shell, not an origin)" : " " + res.body.slice(0, 60)}`,
		);
	} finally {
		await terminateOwned(child);
	}
}

// (c5) a stale live-pid/closed-port record must not poison the packaged
// session: the CLI re-evaluates the record on every request, so once a
// real surface publishes a fresh record in the same home, the VERY NEXT
// request resolves through it -- no restart.
{
	const port = await closedPort();
	const staleOrigin = `http://127.0.0.1:${port}`;
	const home = tmpHome();
	mkdirSync(join(home, "cozyclay"), { recursive: true });
	writeFileSync(
		discoveryPath(home),
		JSON.stringify({ port, origin: staleOrigin, token: "x", pid: process.pid, startedAt: new Date().toISOString() }),
	);
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home });
	let surface = null;
	try {
		await waitForHttp(cliPort);
		const before = await httpGet(cliPort, "/ingest/surface-origin");
		surface = spawnVite(SURFACE_CONFIG, { home });
		// The stale record already parses, so waitForDiscovery would return
		// it instantly; wait for the file to actually be REPLACED by the
		// surface's own record (a different origin).
		const deadline = Date.now() + 20000;
		let record = null;
		while (Date.now() < deadline) {
			try {
				const parsed = JSON.parse(readFileSync(discoveryPath(home), "utf8"));
				if (parsed.origin !== staleOrigin) {
					record = parsed;
					break;
				}
			} catch {
				/* still being written */
			}
			await sleep(100);
		}
		const after = await httpGet(cliPort, "/ingest/surface-origin");
		const parsed = after.status === 200 ? safeParseJson(after.body) : null;
		ok(
			"stale live-pid record is re-evaluated: the next request reaches the fresh surface",
			before.status === 404 && !!record && parsed?.origin === record.origin && parsed?.url === `${record.origin}/src/ingest/index.html`,
			`before=${before.status} after=${after.status} record=${record?.origin ?? null}`,
		);
	} finally {
		await terminateOwned(surface);
		await terminateOwned(child);
	}
}

// (d) --no-ingest suppresses the proxy branch even with a live host.
{
	const home = tmpHome();
	const stub = await startStubHost(home);
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home, args: ["--no-ingest"] });
	try {
		try {
			await waitForHttp(cliPort);
		} catch {
			/* the CLI may have exited before serving (unknown flag at RED time) */
		}
		const res = await httpGet(cliPort, "/ingest/surface-origin").catch(() => ({ status: 0 }));
		ok("--no-ingest suppresses the /ingest proxy", res.status === 404, `got ${res.status}`);
	} finally {
		await terminateOwned(child);
		await stub.close();
	}
}

// (e) dev mode without a host (matrix row: "npm run dev -- no host,
// unavailable"): the app dev server 404s -- the app-Vite-first ordering
// produces the unavailable state, never a hang or a silent success.
{
	const home = tmpHome();
	const appPort = await freePort();
	const child = spawnVite("vite.config.js", { home, args: ["--port", String(appPort)] });
	try {
		await waitForHttp(appPort);
		const res = await httpGet(appPort, "/ingest/surface-origin");
		// No proxy exists, so the probe yields no origin. Vite's SPA fallback
		// answers unknown paths with the app shell (200 HTML), so "absent" is
		// "not a JSON origin", not literally 404 -- the packaged CLI keeps the
		// literal 404 because it has no SPA fallback.
		const origin = res.status === 200 ? safeParseJson(res.body) : null;
		ok(
			"plain dev: no host means no surface origin (unavailable, not a hang)",
			res.status !== 200 || origin === null,
			`got ${res.status}${res.status === 200 ? " (app shell, not an origin)" : ""}`,
		);
	} finally {
		await terminateOwned(child);
	}
}

// (f) dev:ingest: the DECLARED entry (package.json "dev:ingest":
// CCLAY_INGEST_HOST=1 node tools/dev-full.mjs --host 127.0.0.1 --port 5180)
// spawned cold from a clean isolated config home -- bridge, app Vite and
// surface Vite all in the entry's own spawn order, no hand-ordering. The
// proxy target resolves per request, so the surface-origin probe succeeds
// once the surface has published, with no restart; if the cold-start race
// ever came back this poll would time out and fail.
{
	const home = tmpHome();
	const appPort = await freePort();
	const entry = spawnOwned(process.execPath, ["tools/dev-full.mjs", "--host", "127.0.0.1", "--port", String(appPort)], {
		cwd: REPO_ROOT,
		env: { ...process.env, XDG_CONFIG_HOME: home, CCLAY_INGEST_HOST: "1", CCLAY_APP_ORIGIN: `http://127.0.0.1:${appPort}` },
		stdio: "pipe",
	});
	const entryOut = collect(entry);
	try {
		// A startup failure (e.g. the ARDY sidecar's port occupied by a
		// foreign process) must surface as a FAIL with the entry's own
		// output, never as an unhandled-rejection crash.
		const appError = await waitForHttp(appPort).then(() => null, (err) => err);
		const record = await waitForDiscovery(home);
		if (appError !== null) {
			ok(
				"dev:ingest cold start: the app dev server came up",
				false,
				`${appError.message}  ${entryOut().trim().split("\n").filter(Boolean).at(-1) ?? ""}`,
			);
		} else {
			// The surface publishes only after its port is bound, which can
			// be later than the app's first answer -- poll through the app
			// origin, exactly as a cold-started browser would.
			const deadline = Date.now() + 20000;
			let probe = null;
			while (Date.now() < deadline) {
				probe = await httpGet(appPort, "/ingest/surface-origin").catch(() => null);
				const parsed = probe?.status === 200 ? safeParseJson(probe.body) : null;
				if (parsed?.origin) break;
				await sleep(100);
			}
			const parsed = probe?.status === 200 ? safeParseJson(probe.body) : null;
			const detail = JSON.stringify(parsed ?? { status: probe?.status ?? "unreachable" });
			ok(
				"dev:ingest cold start: surface-origin resolves through the app origin without a restart",
				!!record && parsed?.origin === record?.origin && parsed?.url === `${record?.origin}/src/ingest/index.html`,
				`${detail}${parsed?.origin ? "" : "  " + (entryOut().trim().split("\n").filter(Boolean).at(-1) ?? "")}`,
			);
		}
	} finally {
		await terminateOwned(entry);
	}
}

// (g) packaging, and the unavailable-by-design rows (Pages, offline PWA).
{
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	ok("npm package ships dist-ingest", Array.isArray(pkg.files) && pkg.files.includes("dist-ingest"), (pkg.files ?? []).join(","));
	ok("prepack builds both artifacts", /npm run build && npm run build:ingest/.test(pkg.scripts?.prepack ?? ""), pkg.scripts?.prepack ?? "");
	ok("build:ingest targets the surface config", pkg.scripts?.["build:ingest"] === "vite build --config vite.ingest.config.js", pkg.scripts?.["build:ingest"] ?? "");
	ok(
		"dev:ingest runs the full dev topology",
		pkg.scripts?.["dev:ingest"] === "CCLAY_INGEST_HOST=1 node tools/dev-full.mjs --host 127.0.0.1 --port 5180",
		pkg.scripts?.["dev:ingest"] ?? "",
	);

	const pages = readFileSync(join(REPO_ROOT, ".github", "workflows", "pages.yml"), "utf8");
	ok(
		"Pages workflow uploads dist/ only (unavailable by design)",
		!/ingest/i.test(pages) && /dist/.test(pages),
		pages.split("\n").filter((l) => /dist/i.test(l)).join(" | ").slice(0, 120),
	);

	const sw = readFileSync(join(REPO_ROOT, "public", "sw.js"), "utf8");
	const core = /const CORE_ASSETS = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? "";
	ok("offline PWA caches no ingest assets (unavailable by design)", !/ingest/i.test(core), core.replace(/\s+/g, " ").slice(0, 120));
	const appIndex = readFileSync(join(REPO_ROOT, "index.html"), "utf8");
	ok("offline app shell cannot mount the surface statically", !/ingest/i.test(appIndex), "");
}
// --- D3: CSP, both sides, dev and packaged -----------------------------------
// The packaged output is built from the surface config, then inspected: the
// production policy must be present and the declared dev variant must be
// absent from it (canonical RED).
{
	const build = spawnOwned(process.execPath, [VITE_BIN, "build", "--config", SURFACE_CONFIG], { cwd: REPO_ROOT, stdio: "pipe" });
	const output = collect(build);
	const { code } = await waitForExit(build);
	ok("dist-ingest builds from the surface config", code === 0, output().trim().split("\n").filter(Boolean).at(-1) ?? "");
	const html = existsSync(DIST_INGEST_HTML) ? readFileSync(DIST_INGEST_HTML, "utf8") : "";
	const devTokens = ["ws://127.0.0.1:", "script-src 'self' 'unsafe-inline'"].filter((t) => html.includes(t));
	ok("dev CSP variant present in packaged mode", code === 0 && devTokens.length === 0, devTokens.join(", ") || "no dev tokens");
	// Vite escapes attribute values in the built html, so unescape before
	// comparing the policy verbatim.
	const htmlText = html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
	ok(
		"packaged surface carries the production CSP meta",
		htmlText.includes(`<meta http-equiv="Content-Security-Policy" content="${PROD_CHILD_CSP}">`),
		html.match(/<meta[^>]*Content-Security-Policy[^>]*>/)?.[0] ?? "no CSP meta",
	);
}

// Dev mode: the surface dev server emits the declared dev-variant CSP as a
// response header -- frame-ancestors is ignored in meta, so the header is the
// only enforcement point for the embedding restriction.
{
	const home = tmpHome();
	const appPort = await freePort();
	const surface = spawnVite(SURFACE_CONFIG, { home, env: { CCLAY_APP_ORIGIN: `http://127.0.0.1:${appPort}` } });
	try {
		const record = await waitForDiscovery(home);
		const res = record ? await httpGet(record.port, "/src/ingest/index.html").catch(() => null) : null;
		const csp = res?.headers["content-security-policy"] ?? "";
		ok(
			"dev surface responses carry the declared dev-variant CSP",
			csp.includes("script-src 'self' 'unsafe-inline'") &&
				csp.includes(`connect-src 'self' ws://127.0.0.1:${record?.port}`) &&
				csp.includes(`frame-ancestors http://127.0.0.1:${appPort}`),
			csp || `no CSP header (status ${res?.status ?? "unreachable"})`,
		);
	} finally {
		await terminateOwned(surface);
	}
}

// Parent policy, dev: the app dev server adds frame-src on every response.
{
	const home = tmpHome();
	const appPort = await freePort();
	const child = spawnVite("vite.config.js", { home, args: ["--port", String(appPort)] });
	try {
		await waitForHttp(appPort);
		const res = await httpGet(appPort, "/");
		ok(
			"parent frame-src CSP on the dev app server",
			res.headers["content-security-policy"] === PARENT_CSP,
			res.headers["content-security-policy"] ?? "(none)",
		);
	} finally {
		await terminateOwned(child);
	}
}

// Parent policy, packaged: the launcher serves .html with the same frame-src.
{
	const home = tmpHome();
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home });
	try {
		await waitForHttp(cliPort);
		const res = await httpGet(cliPort, "/");
		ok(
			"parent frame-src CSP on the packaged CLI",
			res.headers["content-security-policy"] === PARENT_CSP,
			res.headers["content-security-policy"] ?? "(none)",
		);
	} finally {
		await terminateOwned(child);
	}
}

// Packaged child: the CLI is the D2/D3 delivery owner, so it serves the
// built surface from dist-ingest/ at the same URL shape dev uses
// (/src/ingest/index.html) and emits the production child policy as a
// response header -- frame-ancestors is ignored in a meta tag, so the
// header is the only enforcement point (plan 11.4), and it must name the
// exact app origin: the CLI's own. When H1 (tools/ingest/host.mjs, phase
// 3) lands it serves the same artifact on its own origin; that is a host
// row, not a delivery row.
{
	const home = tmpHome();
	const cliPort = await freePort();
	const child = spawnCli(cliPort, { home });
	try {
		await waitForHttp(cliPort);
		const res = await httpGet(cliPort, "/src/ingest/index.html");
		const header = res.headers["content-security-policy"] ?? "";
		const expected = PROD_CHILD_CSP.replace(
			"connect-src 'self';",
			`connect-src 'self'; frame-ancestors http://127.0.0.1:${cliPort};`,
		);
		ok(
			"packaged child CSP header: frame-ancestors names the exact app origin",
			res.status === 200 && header === expected,
			`status ${res.status}, header ${header || "(none)"}`,
		);
	} finally {
		await terminateOwned(child);
	}
}

// The Pages row's mechanism: the parent frame-src admits only loopback http,
// which an HTTPS Pages document cannot embed (active mixed content) -- so
// Pages is unavailable by design, not by accident.
ok(
	"frame-src admits only loopback http (HTTPS Pages cannot embed it)",
	/^frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*;/.test(PARENT_CSP) && !/https:/.test(PARENT_CSP),
	PARENT_CSP,
);


console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

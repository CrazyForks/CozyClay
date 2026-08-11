#!/usr/bin/env node
/**
 * cozyclay - run the studio from a published package.
 *
 * `npx cozyclay` / `bunx cozyclay` should behave like `npm run dev` does in a
 * clone: the studio in a browser, with the optional ARDY sidecar wired up.
 * The difference is that nothing is built here. The package ships the built
 * `dist/`, so this launcher only has to
 *
 *   - serve those files over loopback,
 *   - forward /ardy to the sidecar on 5181 (the job Vite's dev proxy does),
 *   - keep the sidecar's lifetime tied to this process.
 *
 * It has no dependencies on purpose. A launcher that needs an install step
 * before it can serve a prebuilt app is a launcher that will break.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(PKG_ROOT, "dist");
const BRIDGE = join(PKG_ROOT, "tools", "ardy", "bridge.mjs");
const BRIDGE_PORT = Number(process.env.COZYCLAY_BRIDGE_PORT ?? 5181);

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".fbx": "application/octet-stream",
	".npz": "application/octet-stream",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

function parseArgs(argv) {
	const opts = { port: 5180, host: "127.0.0.1", ardy: true, open: true };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--port" || arg === "-p") opts.port = Number(argv[++i]);
		else if (arg.startsWith("--port=")) opts.port = Number(arg.slice(7));
		else if (arg === "--host") opts.host = String(argv[++i]);
		else if (arg.startsWith("--host=")) opts.host = arg.slice(7);
		else if (arg === "--no-ardy") opts.ardy = false;
		else if (arg === "--no-open") opts.open = false;
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg === "--version" || arg === "-v") opts.version = true;
		else {
			console.error(`cozyclay: unknown option ${arg}`);
			opts.help = true;
		}
	}
	if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
		console.error("cozyclay: --port must be a port number");
		opts.help = true;
	}
	return opts;
}

const HELP = `cozyclay - browser-based 3D staging studio

  npx cozyclay              start the studio and open it
  npx cozyclay --port 5200  serve on another port
  npx cozyclay --no-ardy    skip the optional motion-generation sidecar
  npx cozyclay --no-open    do not open a browser

Motion generation needs an SSH-reachable NVIDIA machine running ARDY; point
the sidecar at it with CCLAY_ARDY_HOST. Everything else - staging, posing,
paths, cameras, timeline, playback - runs locally with no extra setup.`;

function serveFile(res, path) {
	const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
	res.writeHead(200, {
		"content-type": type,
		"content-length": statSync(path).size,
		// The studio is served from a local process a user just started; a
		// stale cache across versions is more confusing than a re-read.
		"cache-control": "no-cache",
	});
	createReadStream(path).pipe(res);
}

// Forward /ardy to the sidecar. Same contract as the Vite dev proxy, so the
// browser code needs no build-time knowledge of how it was launched.
function proxyToBridge(req, res) {
	const upstream = httpRequest(
		{ host: "127.0.0.1", port: BRIDGE_PORT, path: req.url, method: req.method, headers: req.headers },
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on("error", () => {
		// An absent sidecar is an expected state, not a crash: the app treats a
		// failed probe as "generation unavailable" and carries on.
		res.writeHead(503, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "ardy sidecar is not running" }));
	});
	req.pipe(upstream);
}

function openBrowser(url) {
	const cmd =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
	child.on("error", () => {
		/* headless box, no browser: the URL is printed anyway */
	});
	child.unref();
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
	console.log(HELP);
	process.exit(0);
}
if (opts.version) {
	const pkg = JSON.parse(await import("node:fs").then((fs) => fs.promises.readFile(join(PKG_ROOT, "package.json"), "utf8")));
	console.log(pkg.version);
	process.exit(0);
}
if (!existsSync(join(DIST, "index.html"))) {
	console.error("cozyclay: this package is missing its build (dist/index.html).");
	console.error("cozyclay: from a clone, run `npm install && npm run build` first.");
	process.exit(1);
}

// The sidecar exits immediately without a box to talk to, so starting it
// unconditionally would greet a first-time `npx cozyclay` with an error it
// cannot act on. An unset CCLAY_ARDY_HOST is the normal case, not a fault.
const ardyHost = process.env.CCLAY_ARDY_HOST?.trim();
let bridge = null;
if (opts.ardy && ardyHost && existsSync(BRIDGE)) {
	bridge = spawn(process.execPath, [BRIDGE], { cwd: PKG_ROOT, stdio: "inherit" });
	bridge.on("error", () => {
		bridge = null;
	});
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname.startsWith("/ardy/")) {
		proxyToBridge(req, res);
		return;
	}
	const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
	// normalize + prefix check: a request must not escape dist/.
	const target = join(DIST, normalize(rel));
	if (!target.startsWith(DIST) || !existsSync(target) || statSync(target).isDirectory()) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
		return;
	}
	serveFile(res, target);
});

function shutdown() {
	if (bridge) bridge.kill("SIGTERM");
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("error", (err) => {
	if (err && err.code === "EADDRINUSE") {
		console.error(`cozyclay: port ${opts.port} is taken. Try --port ${opts.port + 1}.`);
		if (bridge) bridge.kill("SIGTERM");
		process.exit(1);
	}
	throw err;
});

server.listen(opts.port, opts.host, () => {
	const url = `http://${opts.host}:${opts.port}/`;
	console.log(`CozyClay is running at ${url}`);
	if (!opts.ardy) console.log("Motion generation: off (--no-ardy).");
	else if (bridge) console.log(`Motion generation: sidecar running against ${ardyHost}.`);
	else
		console.log(
			"Motion generation: off. It runs on an SSH-reachable NVIDIA machine with ARDY;\n" +
				"set CCLAY_ARDY_HOST=user@host to turn it on. Everything else works without it.",
		);
	if (opts.open) openBrowser(url);
});

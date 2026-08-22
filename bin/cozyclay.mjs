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
 *   - forward /ardy to its dynamically selected sidecar port (the job Vite's dev proxy does),
 *   - keep the sidecar's lifetime tied to this process.
 *
 * It has no dependencies on purpose. A launcher that needs an install step
 * before it can serve a prebuilt app is a launcher that will break.
 */
import { spawn } from "node:child_process";
import { startBridge, terminateOwned } from "../tools/process-supervisor.mjs";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runMcp } from "./mcp-runtime.mjs";
import { openBrowser } from "./open-browser.mjs";
import { checkForUpdate, runUpdate } from "./update-check.mjs";

const PKG_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(PKG_ROOT, "dist");
const BRIDGE = join(PKG_ROOT, "tools", "ardy", "bridge.mjs");
let bridgePort = 5181;

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
	const opts = { port: 5180, host: "127.0.0.1", ardy: true, open: true, star: true, updateCheck: true };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--port" || arg === "-p") opts.port = Number(argv[++i]);
		else if (arg.startsWith("--port=")) opts.port = Number(arg.slice(7));
		else if (arg === "--host") opts.host = String(argv[++i]);
		else if (arg.startsWith("--host=")) opts.host = arg.slice(7);
		else if (arg === "--no-ardy") opts.ardy = false;
		else if (arg === "--no-open") opts.open = false;
		else if (arg === "--no-star") opts.star = false;
		else if (arg === "--no-update-check") opts.updateCheck = false;
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg === "--version" || arg === "-v") opts.version = true;
		else {
			console.error(`cozyclay: unknown option ${arg}`);
			opts.help = true;
			opts.invalid = true;
		}
	}
	if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65534) {
		console.error("cozyclay: --port must be an integer in 1..65534");
		opts.help = true;
		opts.invalid = true;
	}
	if (opts.host !== "127.0.0.1") {
		console.error("cozyclay: --host is restricted to 127.0.0.1");
		opts.help = true;
		opts.invalid = true;
	}
	return opts;
}

const REPO_URL = "https://github.com/NomaDamas/CozyClay";
const STATE_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay");
const STATE_FILE = join(STATE_DIR, "state.json");
// Only worth asking someone who actually used the thing. A prompt three
// seconds in is a popup; a prompt after a real session is a question.
const STAR_AFTER_MS = Number(process.env.COZYCLAY_STAR_AFTER_MS ?? 60_000);

const HELP = `cozyclay - browser-based 3D staging studio

  npx cozyclay              start the studio and open it
  npx cozyclay mcp          run the MCP server (for Claude, Cursor, any MCP client)
  cclay update              install the latest cozyclay globally (npm install -g)
  npx cozyclay --port 5200  serve on another port
  npx cozyclay --no-ardy    skip the optional motion-generation sidecar
  npx cozyclay --no-open    do not open a browser
  npx cozyclay --no-star    never ask about starring the repo
  npx cozyclay --no-update-check
                            do not look for a newer release

cclay is the same command, shorter: a global install gives you both.

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
		{ host: "127.0.0.1", port: bridgePort, path: req.url, method: req.method, headers: req.headers },
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

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeState(patch) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, "\t"));
	} catch {
		/* a read-only home is not a reason to fail a local dev server */
	}
}

async function starCount() {
	try {
		const res = await fetch("https://api.github.com/repos/NomaDamas/CozyClay", {
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return null;
		const body = await res.json();
		return Number.isInteger(body?.stargazers_count) ? body.stargazers_count : null;
	} catch {
		return null;
	}
}

// Asked once, on the way out, and never again on this machine. A CLI that
// nags on every run is worse than one that never asks.
async function maybeAskForStar(startedAt, opts) {
	if (!opts.star) return;
	if (process.env.CI || process.env.COZYCLAY_NO_STAR) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return;
	if (Date.now() - startedAt < STAR_AFTER_MS) return;
	if (readState().starPromptedAt) return;

	writeState({ starPromptedAt: new Date().toISOString() });
	const stars = await starCount();
	const tally = stars === null ? "" : ` (${stars} so far)`;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise((done) => {
		const timer = setTimeout(() => done(""), 12_000);
		rl.question(`\nWas CozyClay any good? A star helps people find it${tally}. Open GitHub? [Y/n] `, (a) => {
			clearTimeout(timer);
			done(a);
		});
	});
	rl.close();
	if (/^(y|yes|)$/i.test(answer.trim())) {
		openBrowser(REPO_URL);
		console.log("Thanks. Opening the repo.");
	} else {
		console.log(`Fair enough. ${REPO_URL} if you change your mind.`);
	}
}

// Read on every launch now, so it must not be able to take the launcher down:
// the version is cosmetic here, and "0.0.0" just suppresses a bogus notice.
function readVersion() {
	try {
		return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
	await runMcp(argv.slice(1));
} else if (argv[0] === "update") {
	// This branch bypasses parseArgs, so anything trailing would be swallowed
	// and `cclay update --help` would perform an unrequested global install.
	if (argv.length > 1) {
		console.error(`cozyclay: update takes no arguments (got ${argv.slice(1).join(" ")})`);
		process.exit(1);
	}
	runUpdate();
} else {

const opts = parseArgs(argv);
	if (opts.help) {
		console.log(HELP);
		process.exit(opts.invalid ? 1 : 0);
}
const version = readVersion();
if (opts.version) {
	console.log(version);
	process.exit(0);
}
// Fired before anything blocking and never awaited on the launch path: the
// notice is worth a line of output, never a second of startup.
const updatePending = opts.updateCheck && !process.env.CI && !process.env.COZYCLAY_NO_UPDATE_CHECK ? checkForUpdate(version, STATE_DIR) : null;
if (!existsSync(join(DIST, "app", "index.html"))) {
	console.error("cozyclay: this package is missing its build (dist/app/index.html).");
	console.error("cozyclay: from a clone, run `npm install && npm run build` first.");
	process.exit(1);
}

// The sidecar exits immediately without a box to talk to, so starting it
// unconditionally would greet a first-time `npx cozyclay` with an error it
// cannot act on. An unset CCLAY_ARDY_HOST is the normal case, not a fault.
const ardyHost = process.env.CCLAY_ARDY_HOST?.trim();
let bridge = null;
let server = null;
const startedAt = Date.now();
let shuttingDown = false;
async function shutdown(exitCode = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	if (bridge) await terminateOwned(bridge);
	if (server?.listening) await new Promise((resolvePromise) => server.close(() => resolvePromise()));
	try {
		await maybeAskForStar(startedAt, opts);
	} catch {
		/* never let the goodbye prompt hold the process hostage */
	}
	process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

if (opts.ardy && ardyHost && existsSync(BRIDGE)) {
	try {
		({ child: bridge, port: bridgePort } = await startBridge({
			command: process.execPath,
			args: [BRIDGE],
			cwd: PKG_ROOT,
			env: process.env,
			mainPort: opts.port,
			onSpawn: (child) => {
				bridge = child;
			},
			onReady: (child) => {
				child.once("exit", (code, signal) => {
					if (shuttingDown) return;
					console.error(`cozyclay: motion generation sidecar exited ${signal ? `from ${signal}` : `with code ${code ?? 0}`}.`);
					void shutdown(1);
				});
				child.once("error", (err) => {
					if (shuttingDown) return;
					console.error(`cozyclay: motion generation sidecar failed: ${err.message}`);
					void shutdown(1);
				});
			},
		}));
	} catch (err) {
		console.error(`cozyclay: motion generation sidecar failed: ${err.message}`);
		console.error("cozyclay: studio did not start; set COZYCLAY_BRIDGE_PORT to an available port or use --no-ardy.");
		if (bridge) await terminateOwned(bridge);
		process.exit(1);
	}
}

server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	// Only the routes the bridge actually owns: /ardy/ is ALSO a public asset
	// directory (cskel27-rest.json), and those files live in dist/, not behind
	// the sidecar. Same rule as the Vite dev proxy bypass.
	if (/^\/ardy\/(health|bases|generate|footage|extract|motions)(\/|$)/.test(url.pathname)) {
		proxyToBridge(req, res);
		return;
	}
	const rel = decodeURIComponent(url.pathname);
	// normalize + prefix check: a request must not escape dist/.
	let target = join(DIST, normalize(rel));
	if (!target.startsWith(DIST)) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
		return;
	}
	// The build is multi-page: "/" is the landing and "/app/" is the studio, so a
	// directory has to resolve to its index the way a static host would. Without
	// this the studio 404s and the CLI only ever serves the landing page.
	if (existsSync(target) && statSync(target).isDirectory()) {
		target = join(target, "index.html");
	}
	if (!existsSync(target) || statSync(target).isDirectory()) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
		return;
	}
	serveFile(res, target);
});

server.on("error", (err) => {
	if (err && err.code === "EADDRINUSE") {
		console.error(`cozyclay: port ${opts.port} is taken. Try --port 5200.`);
		void shutdown(1);
		return;
	}
	throw err;
});

server.listen({ port: opts.port, host: "127.0.0.1", ipv6Only: false }, () => {
	// The package exists to open the studio, which the site serves from /app/.
	// Landing on "/" would greet someone who just typed `npx cozyclay` with a
	// marketing page.
	const url = `http://127.0.0.1:${opts.port}/app/`;
	console.log(`CozyClay is running at ${url}`);
	if (!opts.ardy) console.log("Motion generation: off (--no-ardy).");
	else if (bridge) console.log(`Motion generation: sidecar running against ${ardyHost}.`);
	else
		console.log(
			"Motion generation: off. It runs on an SSH-reachable NVIDIA machine with ARDY;\n" +
				"set CCLAY_ARDY_HOST=user@host to turn it on. Everything else works without it.",
		);
	if (opts.open) openBrowser(url);
	void updatePending?.then((latest) => {
		// `cclay` only exists after a global install, so name the command that
		// works from an npx run too.
		if (latest) console.log(`cozyclay ${latest} is available (you have ${version}). Run: npm install -g cozyclay@latest`);
	});
});

}

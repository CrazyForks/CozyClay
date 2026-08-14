import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { createServer as listenProbe } from "node:net";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

// Second build entry for the ingest surface (plan 6, I1): the default build
// (vite.config.js) must stay free of src/ingest modules, so the surface gets its
// own config and its own outDir. In dev the surface is "negotiated, available"
// (plan 11.1): no fixed port in any client (plan 11.2), so the dev server scans
// 5183..5199 and binds the first free port with strictPort -- sliding past the
// range would bind a port nobody can discover, which is why an exhausted range
// exits 1 with a named error instead.

const INGEST_PORT_FROM = 5183;
const INGEST_PORT_TO = 5199;
const DISCOVERY_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay", "ingest.json");
const APP_ORIGIN = process.env.CCLAY_APP_ORIGIN || "http://127.0.0.1:5180";

// The dev variant is the declared, strictly wider policy (plan 11.4): HMR
// needs the websocket and the react preamble needs an inline script.
function devChildCsp(port) {
	return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:${port}; frame-ancestors ${APP_ORIGIN}; base-uri 'none'; form-action 'none'; object-src 'none'`;
}
// The production policy is what ships in dist-ingest (plan 11.4).
// frame-ancestors cannot ride a meta tag (response-header-only), so it is
// omitted here and appended by whoever serves the built surface -- the host,
// from --app-origin.
const PROD_CHILD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

async function negotiatePort() {
	for (let port = INGEST_PORT_FROM; port <= INGEST_PORT_TO; port += 1) {
		const probe = listenProbe();
		try {
			await new Promise((done, fail) => {
				probe.once("error", fail);
				probe.listen(port, "127.0.0.1", done);
			});
			await new Promise((done) => probe.close(done));
			return port;
		} catch {
			/* taken: try the next */
		}
	}
	console.error(`ingest: all ports ${INGEST_PORT_FROM}..${INGEST_PORT_TO} are taken; refusing to bind outside the published range`);
	process.exit(1);
}

// The parent (app dev server or packaged CLI) learns the surface origin from
// its own origin through /ingest/surface-origin (plan 11.2); the discovery
// record is written only after the server is actually listening, so a
// published port is always a bound port.
function publishDiscovery(port) {
	mkdirSync(dirname(DISCOVERY_FILE), { recursive: true });
	const record = {
		port,
		origin: `http://127.0.0.1:${port}`,
		token: randomBytes(16).toString("hex"),
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};
	writeFileSync(DISCOVERY_FILE, JSON.stringify(record, null, "\t") + "\n", { mode: 0o600 });
	console.log(`[ingest] surface published ${DISCOVERY_FILE} (${record.origin})`);
	console.log("[ingest] if the app dev server was already running, restart it once to pick up the /ingest proxy");
}

function removeDiscovery() {
	try {
		rmSync(DISCOVERY_FILE, { force: true });
	} catch {
		/* already gone */
	}
}

export default defineConfig(async ({ command }) => {
	const port = command === "serve" ? await negotiatePort() : null;
	const plugins = [];
	if (command === "serve") {
		const origin = `http://127.0.0.1:${port}`;
		plugins.push({
			name: "ingest-surface-dev",
			configureServer(server) {
				// Interim host role until H1: the parent probes the surface
				// origin through the app's own /ingest proxy, so this route
				// answers with the exact strings the embedder compares.
				// The child CSP is a response header here (plan 11.4):
				// frame-ancestors is ignored in meta, and the dev variant is the
				// declared, strictly wider policy HMR needs.
				server.middlewares.use((req, res, next) => {
					res.setHeader("content-security-policy", devChildCsp(port));
					next();
				});
				server.middlewares.use("/ingest/surface-origin", (req, res) => {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ origin, url: `${origin}/src/ingest/index.html` }));
				});
				server.httpServer?.once("listening", () => publishDiscovery(port));
				server.httpServer?.once("close", removeDiscovery);
			},
		});
	}
	else {
		plugins.push({
			name: "ingest-surface-build",
			transformIndexHtml() {
				return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: PROD_CHILD_CSP }, injectTo: "head" }];
			},
		});
	}
	return {
		base: "./",
		build: {
			outDir: "dist-ingest",
			emptyOutDir: true,
			// The app's public/ assets belong to dist/; the surface artifact carries
			// only its own entry until Phase 4 decides what else it needs.
			copyPublicDir: false,
			rollupOptions: {
				input: fileURLToPath(new URL("./src/ingest/index.html", import.meta.url)),
			},
		},
		server: command === "serve" ? { port, strictPort: true, host: "127.0.0.1" } : undefined,
		plugins,
	};
});

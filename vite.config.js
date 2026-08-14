import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";

// The ingest surface negotiates its own loopback port and publishes the
// discovery record only after listening (plan 11.2); the /ingest target is
// resolved per request, so a cold `dev:ingest` start needs no restart.
function discoveryOrigin() {
	try {
		const record = JSON.parse(readFileSync((process.env.XDG_CONFIG_HOME || os.homedir() + "/.config") + "/cozyclay/ingest.json", "utf8"));
		// A record whose publisher is dead is stale (plan 11.2; the same
		// liveness check bin/cozyclay.mjs makes): never proxy to a port
		// nobody owns.
		process.kill(record.pid, 0);
		return record.origin;
	} catch {
		return null;
	}
}

// node's http client de-chunks the upstream body, so hop-by-hop framing
// headers must not be replayed verbatim; the dev server re-frames.
const HOP_BY_HOP = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/i;

function ingestProxy() {
	return {
		name: "ingest-proxy",
		// configureServer runs before Vite's internal middlewares, so
		// /ingest/* is proxied, never swallowed by the SPA fallback; with
		// no live record the request falls through ("absent"). The
		// surface's HMR websocket targets its own origin, so plain HTTP
		// forwarding suffices.
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith("/ingest")) return next();
				const target = discoveryOrigin();
				if (!target) return next();
				const upstream = httpRequest(target + req.url, { method: req.method, headers: req.headers }, (upstreamRes) => {
					const headers = { ...upstreamRes.headers };
					for (const name of Object.keys(headers)) {
						if (HOP_BY_HOP.test(name)) delete headers[name];
					}
					res.writeHead(upstreamRes.statusCode ?? 502, headers);
					upstreamRes.pipe(res);
				});
				// Same degradation as the packaged proxy (bin/cozyclay.mjs):
				// an unreachable surface is "unavailable", never a hang.
				upstream.on("error", () => {
					if (res.headersSent) {
						res.destroy();
					} else {
						res.writeHead(502, { "content-type": "application/json" });
						res.end(JSON.stringify({ error: "ingest surface is not running" }));
					}
				});
				req.pipe(upstream);
			});
		},
	};
}

export default defineConfig({
	base: "./",
	plugins: [react(), ingestProxy()],
	server: {
		port: 5180,
		headers: { "content-security-policy": "frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'" },
		// Dev-only: the ARDY sidecar (tools/ardy/bridge.mjs) is an optional
		// companion on 127.0.0.1:5181. The production build stays fully static
		// (`base: "./"`, no build-time coupling), so this proxy must never be
		// promoted into a server-side requirement.
		proxy: {
			"/ardy": "http://127.0.0.1:5181",
		},
	},
});

// envelope.mjs - shared security envelope for dev-only loopback HTTP sidecars.
//
// The ARDY bridge (tools/ardy/bridge.mjs) is refactored onto this, and the
// ingest host and generation bridge will join the same conformance suite
// (test/providers/verify-envelope-conformance.mjs) by registration. Every
// clause the suite asserts lives here, so one suite run vouchs for every
// provider that routes its request handling through these exports.
//
// The posture (mirrors tools/ardy/BRIDGE.md "Security posture"):
//  - loopback-only bind, host not configurable;
//  - zero Access-Control-Allow-* headers on every response (JSON, NDJSON,
//    binary, OPTIONS) - the same-origin proxy is the only browser path in;
//  - bounded exact-content-type JSON bodies (415 on a wrong type, 413 over
//    the cap, both before anything is parsed);
//  - cross-site request defence (403): loopback + absent CORS does NOT stop
//    a simple cross-site side-effecting POST, so Sec-Fetch-Site and Origin
//    are checked on every request;
//  - children are spawn()ed with argv ARRAYS, never shell strings;
//  - artifacts are allowlisted and addressed by opaque id, never by a path
//    from the request, with realpath containment re-checked at serve time;
//  - detached child process groups are killed on disconnect and on
//    SIGINT/SIGTERM so no remote session is orphaned.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { sep } from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const SAME_SITE = new Set(["same-origin", "none"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// Errors carry the HTTP status the contract names, so a handler maps a
// rejection to the exact status without knowing which clause fired.
export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

// Loopback only, and the host is not configurable: this process shells out to
// a machine that can run GPU work, so it must never be reachable from the
// network.
export function bindLoopback(server, port) {
	server.listen(port, LOOPBACK_HOST);
	return server;
}

// The no-CORS JSON response: the browser's same-origin policy is the
// enforcement boundary, so no response may carry an Access-Control-Allow-*
// header that would let another origin read it.
export function noCorsJson(res, status, obj) {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(`${JSON.stringify(obj)}\n`);
}

// Bounded, exact-content-type JSON body read. The content-type must match
// exactly (no parameters): a text/plain form POST must never reach JSON
// handling. The cap is enforced while buffering, so an oversized body is
// refused (413) without being stored, and the request is drained so the error
// response can still be written.
export function readJsonBody(req, { maxBytes, contentType = "application/json" }) {
	return new Promise((resolvePromise, reject) => {
		const header = (req.headers["content-type"] || "").toLowerCase();
		if (header !== contentType) {
			req.resume();
			reject(new HttpError(415, `Content-Type must be ${contentType}, got ${JSON.stringify(req.headers["content-type"] || "")}`));
			return;
		}
		const chunks = [];
		let total = 0;
		let capped = false;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > maxBytes) {
				if (!capped) {
					capped = true;
					reject(new HttpError(413, `request body exceeds ${maxBytes} bytes`));
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (capped) return;
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (err) {
				reject(new HttpError(400, `malformed JSON body: ${err.message}`));
				return;
			}
			resolvePromise(parsed);
		});
		req.on("error", (err) => reject(new HttpError(400, `request aborted: ${err.message}`)));
	});
}

// Cross-site request defence. Loopback + absent CORS does NOT stop a simple
// cross-site side-effecting POST: a form POST from another origin arrives on
// the loopback interface indistinguishable from a local call. Browsers tag
// requests with Sec-Fetch-Site; anything other than same-origin/none is
// refused. An explicit Origin must be loopback (the app's dev origins are all
// loopback; the Vite proxy and the packaged launcher forward it unchanged).
export function assertSameSiteRequest(req) {
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && !SAME_SITE.has(String(site).toLowerCase())) {
		throw new HttpError(403, `cross-site request refused (Sec-Fetch-Site: ${site})`);
	}
	const origin = req.headers["origin"];
	if (origin !== undefined) {
		let hostname = null;
		try {
			hostname = new URL(origin).hostname;
		} catch {
			/* not a URL, hence not a loopback origin */
		}
		if (!LOOPBACK_HOSTS.has(hostname)) {
			throw new HttpError(403, `cross-site request refused (Origin: ${origin})`);
		}
	}
}

// Per-session token check for hosts that mint one at surface load (the
// ingest host). Absence or mismatch is a 403; no token configured means no
// check, which is the ARDY bridge's mode (it relies on assertSameSiteRequest).
export function requireSessionToken(req, token) {
	if (token && req.headers["x-cclay-session-token"] !== token) {
		throw new HttpError(403, "missing or invalid session token");
	}
}

// NDJSON response with the same no-CORS posture. The returned send(obj) is a
// no-op after the response ended and never lets a write error escape: a dead
// socket must trigger the caller's close handler (killing the request's
// children), not crash the writer.
export function ndjson(res) {
	res.writeHead(200, {
		"Content-Type": "application/x-ndjson",
		"Cache-Control": "no-store",
	});
	return (obj) => {
		if (res.writableEnded) return;
		try {
			res.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* socket gone; the close handler cleans up */
		}
	};
}

// In-memory artifact allowlist. An id resolves to a file only when THIS
// process registered it (after producing and verifying it) and the file still
// sits under base (realpath containment re-checked at serve time). A path
// never comes from the request. Registration is FIFO-capped at max so a
// long-lived sidecar cannot grow without bound; evicted ids become stale.
export function createArtifactAllowlist({ base, max }) {
	const entries = new Map();
	return {
		has(id) {
			return entries.has(id);
		},
		register(id, absPath) {
			entries.set(id, absPath);
			if (entries.size > max) entries.delete(entries.keys().next().value);
		},
		// The stored path, exactly as registered (for size checks etc.).
		get(id) {
			return entries.get(id) ?? null;
		},
		// The realpath of the stored file when it is still inside base, else
		// null (unregistered, escaped, or gone from disk).
		resolve(id) {
			const stored = entries.get(id);
			if (stored === undefined) return null;
			let baseReal;
			try {
				baseReal = realpathSync(base);
			} catch {
				return null;
			}
			try {
				const fileReal = realpathSync(stored);
				if (fileReal !== baseReal && !fileReal.startsWith(baseReal + sep)) return null;
				return fileReal;
			} catch {
				return null;
			}
		},
	};
}

// Every child spawned for generation is detached so it leads its own process
// group; killing the group takes down bash AND the ssh it waits on, so no
// remote session is orphaned. Tracked globally so Ctrl-C can clean up too.
const childGroups = new Set();

// Command and args stay separate argv entries - request data is never
// interpolated into a shell string.
export function spawnDetached(command, args, options = {}) {
	const child = spawn(command, args, { ...options, detached: true });
	childGroups.add(child);
	child.once("close", () => childGroups.delete(child));
	return child;
}

export function killGroup(child) {
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		/* process group already gone */
	}
	// SIGKILL backup for anything that ignores SIGTERM; unref'd so it never
	// keeps the host alive on its own.
	const backup = setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* gone */
		}
	}, 3000);
	backup.unref();
}

// Returns how many groups were live (for the caller's log line), then kills
// them all - the Ctrl-C / SIGTERM path every host installs.
export function killAllGroups() {
	const count = childGroups.size;
	for (const child of [...childGroups]) killGroup(child);
	return count;
}

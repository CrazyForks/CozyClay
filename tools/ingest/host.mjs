#!/usr/bin/env node
// The ingest host (plan §11, §12, commit H1).
//
// This is the second conformer to tools/providers/envelope.mjs, and it exists
// as a separate process for the same reason the ARDY bridge does: it shells out
// to a GPU box, so it must never be reachable from anything but loopback and
// must never interpolate request data into a shell string.
//
// It reimplements NO envelope clause. That is a deliberate constraint, not a
// style preference: the ARDY bridge was caught twice re-deriving behaviour the
// envelope already owned -- a lexical containment check that a hard link walked
// straight past, and its own detached-child tracking -- and each time the fix
// had to be made again. Mounting the shared contract means the second conformer
// inherits every fix the first one earned. The export-by-export audit lives in
// test/ingest/verify-host.mjs so the claim is checked, not asserted here.
//
// The GPU dependency is deliberately NOT faked. With no box configured the host
// refuses the job by name; a host that pretended to run would produce a
// plausible empty result, and the whole Phase-0 decision record exists to stop
// exactly that kind of confident nonsense.

import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	HttpError,
	assertSameSiteRequest,
	bindLoopback,
	createArtifactAllowlist,
	killAllGroups,
	killGroup,
	ndjson,
	noCorsJson,
	readJsonBody,
	spawnDetached,
} from "../providers/envelope.mjs";
import { createUploadStore, isStageId } from "./uploads.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIND_HOST = "127.0.0.1";
const DEFAULT_PORT = 5184;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const ARTIFACT_MAX = 64;

function parseArgs(argv) {
	const args = { port: DEFAULT_PORT, dryRun: false, appOrigin: null, home: null };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--port") args.port = Number(argv[++i]);
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--app-origin") args.appOrigin = argv[++i];
		else if (a === "--home") args.home = argv[++i];
	}
	return args;
}

const stateHome = (override) => join(override ?? homedir(), ".config", "cozyclay");

// The record the app-side consumers already read (bin/cozyclay.mjs,
// vite.config.js). Liveness there probes the published origin rather than
// trusting the pid, so the origin-identity route below is load-bearing: it is
// what proves the port is served by US and not by whoever inherited it.
function publishDiscovery(home, record) {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const path = join(home, "ingest-host.json");
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

export function createIngestHost({ port = DEFAULT_PORT, appOrigin = null, home = null, outDir = join(HERE, "out") } = {}) {
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	const artifacts = createArtifactAllowlist({ base: outDir, max: ARTIFACT_MAX });
	const uploads = createUploadStore({ base: join(outDir, "stage"), maxStageBytes: MAX_UPLOAD_BYTES });
	const origin = `http://${BIND_HOST}:${port}`;

	const server = createServer(async (req, res) => {
		try {
			// Cross-site defence comes first: loopback binding plus absent CORS
			// headers does NOT stop a simple cross-site side-effecting POST, so
			// the check has to run before any route does work.
			assertSameSiteRequest(req);
			const url = new URL(req.url, origin);

			if (req.method === "OPTIONS") {
				// 204 with ZERO CORS headers. Answering the preflight at all is
				// courtesy; answering it with an allow-origin would hand a
				// cross-site page the very permission the loopback bind and the
				// same-site check exist to withhold.
				res.writeHead(204, { "cache-control": "no-store" });
				res.end();
				return undefined;
			}

			if (url.pathname === "/ingest/surface-origin" && req.method === "GET") {
				// Identity, not liveness: answering with our own origin is what
				// lets a consumer tell "the port is served by the host I
				// published" from "something else grabbed the port".
				return noCorsJson(res, 200, { origin });
			}

			if (url.pathname === "/ingest/health" && req.method === "GET") {
				return noCorsJson(res, 200, { ok: true, gpu: gpuConfigured(), stages: uploads.stats() });
			}

			if (url.pathname === "/ingest/stage" && req.method === "POST") {
				const body = await readBinaryBody(req, MAX_UPLOAD_BYTES);
				const id = uploads.put(body);
				return noCorsJson(res, 200, { stageId: id });
			}

			if (url.pathname.startsWith("/ingest/stage/") && req.method === "GET") {
				const id = url.pathname.slice("/ingest/stage/".length);
				if (!isStageId(id)) throw new HttpError(400, "malformed stage id");
				// Resolve BEFORE committing a status: a directory or a swapped
				// inode must become a clean 404, never a 200 whose body then
				// fails and hangs the client.
				const opened = openStageOrNull(uploads, id);
				if (opened === null) throw new HttpError(404, "no live stage");
				res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(opened.bytes), "cache-control": "no-store" });
				opened.stream.pipe(res);
				return undefined;
			}

			if (url.pathname.startsWith("/ingest/artifacts/") && req.method === "GET") {
				// Opaque id only. A path from the request never reaches the
				// filesystem; the allowlist answers with a realpath-contained,
				// inode-identical regular file or null.
				const id = url.pathname.slice("/ingest/artifacts/".length);
				const resolved = artifacts.resolve(id);
				if (resolved === null) throw new HttpError(404, "unknown artifact");
				const { createReadStream, statSync } = await import("node:fs");
				const st = statSync(resolved);
				res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(st.size), "cache-control": "no-store" });
				createReadStream(resolved).pipe(res);
				return undefined;
			}

			if (url.pathname === "/ingest/extract" && req.method === "POST") {
				const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
				// `return await`, not `return`: returning the promise bare would
				// hand the rejection past this try/catch and crash the process
				// instead of answering the client.
				return await runExtract(req, res, body, { uploads, artifacts, outDir });
			}

			throw new HttpError(url.pathname.startsWith("/ingest/") ? 405 : 404, "no such route");
		} catch (err) {
			const status = err instanceof HttpError ? err.status : 500;
			if (!res.headersSent) noCorsJson(res, status, { ok: false, reason: err.message });
			else res.destroy();
			return undefined;
		}
	});

	return {
		server,
		origin,
		port,
		outDir,
		uploads,
		artifacts,
		listen() {
			return new Promise((resolve) => {
				bindLoopback(server, port);
				server.once("listening", () => {
					const home_ = stateHome(home);
					const path = publishDiscovery(home_, {
						port,
						origin,
						appOrigin,
						pid: process.pid,
						startedAt: new Date().toISOString(),
					});
					console.log(`ingest host listening on ${origin} (discovery ${path})`);
					resolve({ origin, discovery: path });
				});
			});
		},
		close() {
			killAllGroups();
			try {
				rmSync(join(stateHome(home), "ingest-host.json"), { force: true });
			} catch {
				/* nothing published */
			}
			server.close();
		},
	};
}

function openStageOrNull(uploads, id) {
	try {
		return uploads.open(id);
	} catch {
		return null;
	}
}

// A configured GPU box is the only thing that can actually extract motion. With
// none, refusing is the honest answer; see the header.
const gpuConfigured = () => typeof process.env.CCLAY_INGEST_BOX === "string" && process.env.CCLAY_INGEST_BOX.length > 0;

const RUN_EXTRACT = join(HERE, "run-extract-on-box.sh");

async function runExtract(req, res, body, { uploads }) {
	if (typeof body?.stageId !== "string" || !isStageId(body.stageId)) {
		throw new HttpError(400, "stageId must be an opaque stage id");
	}
	if (uploads.resolve(body.stageId) === null) throw new HttpError(404, "no live stage for that id");
	if (!gpuConfigured()) throw new HttpError(503, "no GPU box configured (set CCLAY_INGEST_BOX); refusing rather than faking a result");
	if (!existsSync(RUN_EXTRACT)) throw new HttpError(503, `missing runner ${RUN_EXTRACT}`);

	const send = ndjson(res);
	// argv array, never a shell string: the stage id is opaque and validated,
	// but the rule holds regardless of the value's provenance.
	const child = spawnDetached("bash", [RUN_EXTRACT, process.env.CCLAY_INGEST_BOX, body.stageId], { stdio: ["ignore", "pipe", "pipe"] });
	req.on("close", () => {
		// Disconnect kills the whole process group, so the remote ssh session
		// dies with it instead of being orphaned on the box.
		if (!res.writableEnded) killGroup(child);
	});
	child.stdout.on("data", (chunk) => send({ type: "log", line: String(chunk) }));
	child.stderr.on("data", (chunk) => send({ type: "log", stream: "stderr", line: String(chunk) }));
	child.on("exit", (code) => {
		send({ type: "done", code });
		res.end();
	});
	return undefined;
}

function readBinaryBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (c) => {
			total += c.length;
			if (total > maxBytes) {
				reject(new HttpError(413, `body exceeds ${maxBytes} bytes`));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("host.mjs");
if (invokedDirectly) {
	const args = parseArgs(process.argv.slice(2));
	if (args.dryRun) {
		// --dry-run opens ZERO connections: it reports what would run and exits.
		// Asserted in the verifier by watching for any socket at all, because
		// "no job ran" is a weaker claim than "nothing was opened".
		console.log(JSON.stringify({ dryRun: true, port: args.port, appOrigin: args.appOrigin, gpu: gpuConfigured() }));
		process.exit(0);
	}
	const host = createIngestHost({ port: args.port, appOrigin: args.appOrigin, home: args.home });
	await host.listen();
	const shutdown = () => {
		host.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

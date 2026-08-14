#!/usr/bin/env node
/**
 * bridge.mjs - dev-only HTTP sidecar that drives the ARDY loop for the
 * CozyClay SPA.
 *
 * CozyClay stays a static SPA: `vite build` emits a dist/ that needs no
 * server. The box work (pose -> npz -> remote constrained generation) cannot
 * run in a browser, so this sidecar exposes it on 127.0.0.1:5181 and the Vite
 * dev server proxies /ardy to it. The sidecar is OPTIONAL: when it is not
 * running the app behaves exactly as before, with the generate affordance
 * unavailable. The production build never depends on it.
 *
 * The heavy lifting is done by the existing, verified CLIs - pose-to-npz.mjs
 * and run-on-box.sh - never reimplemented here. The box host, repo, generator
 * venv and encoder URL come from the SAME env var names run-on-box.sh reads
 * (with the same defaults), so the bridge and the scripts cannot disagree.
 *
 * Security posture (detailed in BRIDGE.md):
 *  - binds 127.0.0.1 only;
 *  - every child is spawn()ed with an argv ARRAY; request data never reaches
 *    a shell string (the only remote shell strings are built from the box's
 *    own listing, regex-whitelisted, or from operator env vars);
 *  - every request field is validated before use: prompt length-capped,
 *    duration/dstFrame range-checked, base matched against the list the box
 *    actually reported, waypoints bounds/order-checked, body size-capped;
 *    posePin boolean-checked (default true = full-body pose constraint;
 *    false = path/prompt only, pose ignored, base optional - with waypoints
 *    and no base the box free-generates the base clip first, two-pass);
 *  - generated npz files are served back through an in-memory allowlist
 *    populated only after this process generated and verified the file; a
 *    path is never accepted from the URL;
 *  - a client disconnect kills the detached child process group instead of
 *    orphaning an ssh session.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMotionNpz } from "../../src/ardy/npz.js";
import { motionArraysToNpzMembers, replaceMotionSegment, writeNpz } from "./npz.mjs";
import { assertSameSiteRequest, bindLoopback, createArtifactAllowlist, killAllGroups, killGroup, ndjson, noCorsJson, readJsonBody, spawnDetached } from "../providers/envelope.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const OUT_DIR = join(HERE, "out");
const REFS_DIR = join(OUT_DIR, "refs");
const DUMP_SCRIPT = join(HERE, "dump-npz.py");
const POSE_TO_NPZ = join(HERE, "pose-to-npz.mjs");
const RUN_ON_BOX = join(HERE, "run-on-box.sh");
const RUN_SEQUENCE_ON_BOX = join(HERE, "run-sequence-on-box.sh");
const RUN_EDIT_ON_BOX = join(HERE, "run-edit-on-box.sh");

const BIND_HOST = "127.0.0.1"; // loopback only: this process shells out
const DEFAULT_PORT = 5181;
const HEALTH_TTL_MS = 5000; // the UI polls health; a cached answer avoids hammering ssh
const BASES_TTL_MS = 120000; // the box's motion list changes rarely
const MAX_BODY_BYTES = 1024 * 1024;
const PROMPT_MAX_CHARS = 500;
const DURATION_MIN = 0.15;
const DURATION_MAX = 1200;
const SEED_MAX = 2 ** 31 - 1; // optional request seed: an integer in 0..2**31-1 (bridge contract)
const FPS = 20; // ARDY Core is 20 fps; clip length is int(duration * 20)
const ROOT_2D_RANGE_M = 20; // |x| and |z| cap, meters (ARDY Y-up, X/Z horizontal)
const HEADING_RANGE_RAD = 2 * Math.PI; // |heading| cap, radians
const WAYPOINTS_MAX = 32; // sparse authored root keys including frame 0
const WAYPOINT_CLIP_MAX_S = 10; // ARDY trained window: one-shot constrained calls must fit it
const WAYPOINT_SPEED_MIN_MPS = 0.3; // dense-sample gait floor (authored floor 0.5, arcs dip through corners)
const WAYPOINT_SPEED_MAX_MPS = 3.6; // dense-sample ceiling (authored ceiling 3.0)
const WAYPOINT_HOLD_EPS_M = 0.06; // pairs closer than this are a deliberate hold, any duration
const MOTION_ALLOWLIST_MAX = 64; // newest runs only; evicted ids become stale 404s
// The bridge's own gen stamp (<epoch-ms>-<3 random bytes hex>); keeping the
// motions URL id to that shape keeps /ardy/motions/<run-id> predictable and
// path-free (the id is a lookup key, never a path).
const MOTION_ID = /^[0-9]+-[0-9a-f]{6}$/;

// Same env var names as run-on-box.sh, so health, the bases listing and
// generation all talk to one operator-configured host/venv/encoder.
const HOST = process.env.CCLAY_ARDY_HOST?.trim() || "";
const REMOTE = process.env.CCLAY_ARDY_REPO || "$HOME/ardy"; // literal $HOME: the REMOTE shell expands it
const VENV_PY = process.env.CCLAY_ARDY_VENV || "~/ardy/.venv-cuda/bin/python"; // generator venv (tilde expands on the box)
const ENCODER_URL = process.env.CCLAY_ARDY_ENCODER_URL || "http://127.0.0.1:9550/";
// Numpy-only read paths (bases listing, reference dumps) use the CPU venv on
// purpose: the box's two venvs are NOT interchangeable, and this is the one
// the dump tooling is verified under.
const DUMP_PY = "~/ardy/.venv/bin/python";

// BatchMode: never hang on a password prompt. ConnectTimeout fails fast on a
// dead host; ServerAlive* drops a wedged connection (same set run-on-box.sh
// uses).
const SSH_OPTS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "ServerAliveInterval=30",
	"-o", "ServerAliveCountMax=240",
];
const SCP_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

// A box base path is produced by the box's own `ls outputs/*.npz` /
// `ls outputs/omb/*.npz` and is still whitelisted before it is embedded in a
// remote shell string: only a plain, metacharacter-free relative npz path is
// ever allowed through.
const SAFE_BASE_PATH = /^outputs\/(?:omb\/)?[A-Za-z0-9._-]+\.npz$/;
const SAFE_BASE_ID = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

// Run a short, non-streaming child (ssh/scp probes) to completion.
function run(argv, { timeoutMs = 0 } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer = null;
		const finish = (err, code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (err) reject(err);
			else resolvePromise({ code, stdout, stderr });
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (err) => finish(err));
		child.on("close", (code) => finish(null, code));
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* gone */
				}
				finish(new Error(`timed out after ${timeoutMs} ms`));
			}, timeoutMs);
		}
	});
}

// Split a child's stdout/stderr into lines as they arrive; empty lines are
// dropped. The trailing partial line is flushed on end so the generator's
// last line is never lost.
function streamLines(stream, onLine) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		let idx;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx).replace(/\r$/, "");
			buffer = buffer.slice(idx + 1);
			if (line) onLine(line);
		}
	});
	stream.on("end", () => {
		const rest = buffer.replace(/\r$/, "");
		if (rest) onLine(rest);
	});
}

// Resolves with the exit code; rejects when the child could not be started.
function runStreaming(child, onLine) {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		const finish = (fn, value) => {
			if (!settled) {
				settled = true;
				fn(value);
			}
		};
		child.on("error", (err) => finish(reject, err));
		child.on("close", (code) => finish(resolvePromise, code));
		for (const [streamName, stream] of [
			["stdout", child.stdout],
			["stderr", child.stderr],
		]) {
			streamLines(stream, (line) => onLine(line, streamName));
		}
	});
}

function lastLine(text) {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.length ? lines[lines.length - 1] : "";
}

// ---------------------------------------------------------------------------
// box probes (health, bases) with caching
// ---------------------------------------------------------------------------

// One ssh round trip covers everything health needs: the host answering is
// the ssh call itself, then the encoder HTTP code and the device the
// generator venv would pick are read on the box with the same env the
// generator runs under. The device line mirrors run-on-box.sh's probe
// exactly, so what health reports is what the generation will use.
function healthRemoteCmd() {
	return [
		`ENC="$(curl -s -o /dev/null -w '%{http_code}' -m 10 ${ENCODER_URL})"`,
		'[ -n "$ENC" ] || ENC="000"',
		`DEV="$(cd ${REMOTE} && ${VENV_PY} -c 'import torch; print("cuda:0" if torch.cuda.is_available() else "cpu")')"`,
		`printf 'encoder=%s\\ndevice=%s\\n' "$ENC" "$DEV"`,
	].join(" && ");
}

async function probeHealth() {
	const { code, stdout, stderr } = await run(
		["ssh", ...SSH_OPTS, HOST, healthRemoteCmd()],
		{ timeoutMs: 60_000 }
	);
	if (code !== 0) {
		throw new Error(`ssh probe on ${HOST} failed (exit ${code}): ${lastLine(stderr)}`);
	}
	const fields = {};
	for (const line of stdout.split("\n")) {
		const match = /^(encoder|device)=(.*)$/.exec(line.trim());
		if (match) fields[match[1]] = match[2];
	}
	if (!("encoder" in fields)) {
		throw new Error(`encoder probe on ${HOST} produced no answer`);
	}
	if (fields.encoder !== "200") {
		throw new Error(`text encoder at ${ENCODER_URL} answered ${fields.encoder}, not 200`);
	}
	if (!("device" in fields) || fields.device === "") {
		const tail = lastLine(stderr);
		throw new Error(
			`device probe on ${HOST} produced no answer${tail ? `: ${tail}` : ""}`
		);
	}
	if (!/^(cpu|cuda:\d+)$/.test(fields.device)) {
		throw new Error(
			`device probe on ${HOST} returned unexpected ${JSON.stringify(fields.device)}`
		);
	}
	return { ok: true, host: HOST, encoder: Number(fields.encoder), device: fields.device };
}

// Frame counts come from a real load of each npz, in ONE ssh call: the script
// is fed to the box's python over a quoted heredoc (no local shell step), and
// entries that fail to load are skipped with a note on the box stderr instead
// of failing the whole listing.
function basesRemoteCmd() {
	const script = [
		"import glob, json, sys",
		"import numpy as np",
		"entries = []",
		'for pattern in ("outputs/*.npz", "outputs/omb/*.npz"):',
		"    for path in sorted(glob.glob(pattern)):",
		"        try:",
		'            data = np.load(path, allow_pickle=False)',
		'            frames = int(data["posed_joints"].shape[0])',
		"            data.close()",
		"        except Exception as exc:",
		'            print("bases: skipping %s: %s" % (path, exc), file=sys.stderr)',
		"            continue",
		'        entries.append({"id": path.rsplit("/", 1)[-1][:-4], "path": path, "frames": frames})',
		"print(json.dumps(entries))",
	].join("\n");
	return `cd ${REMOTE} && ${DUMP_PY} - <<'COZYCLAY_PY_EOF'\n${script}\nCOZYCLAY_PY_EOF`;
}

async function listBases() {
	const { code, stdout, stderr } = await run(
		["ssh", ...SSH_OPTS, HOST, basesRemoteCmd()],
		{ timeoutMs: 120_000 }
	);
	if (code !== 0) {
		throw new Error(`bases listing on ${HOST} failed (exit ${code}): ${lastLine(stderr)}`);
	}
	let entries;
	try {
		entries = JSON.parse(stdout);
	} catch (err) {
		throw new Error(
			`bases listing on ${HOST} did not parse as JSON: ${lastLine(stderr) || err.message}`
		);
	}
	if (!Array.isArray(entries)) {
		throw new Error(`bases listing on ${HOST} was not an array`);
	}
	const bases = [];
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.id !== "string" ||
			typeof entry.path !== "string" ||
			!Number.isInteger(entry.frames) ||
			entry.frames < 0
		) {
			console.error(`[bridge] skipping malformed bases entry from ${HOST}: ${JSON.stringify(entry)}`);
			continue;
		}
		if (!SAFE_BASE_ID.test(entry.id) || !SAFE_BASE_PATH.test(entry.path)) {
			console.error(`[bridge] skipping unsafe bases entry from ${HOST}: ${JSON.stringify(entry)}`);
			continue;
		}
		bases.push({ id: entry.id, path: entry.path, frames: entry.frames });
	}
	// Duplicate ids (same name under outputs/ and outputs/omb/) are kept as-is;
	// generate matches the first, which is exactly the lookup order
	// run-on-box.sh uses, so the two cannot pick different files.
	return { bases };
}

let healthCache = null;
let healthInflight = null;

// Successes AND failures are cached for the TTL so a dead box does not turn
// the UI's health polling into an ssh stampede.
async function getHealth() {
	const now = Date.now();
	if (healthCache && now - healthCache.at < HEALTH_TTL_MS) {
		if (healthCache.error) throw healthCache.error;
		return healthCache.value;
	}
	if (!healthInflight) {
		healthInflight = probeHealth()
			.then((value) => {
				healthCache = { at: Date.now(), value };
				return value;
			})
			.catch((err) => {
				healthCache = { at: Date.now(), error: err };
				throw err;
			})
			.finally(() => {
				healthInflight = null;
			});
	}
	return healthInflight;
}

let basesCache = null;
let basesInflight = null;

async function getBases() {
	const now = Date.now();
	if (basesCache && now - basesCache.at < BASES_TTL_MS) {
		if (basesCache.error) throw basesCache.error;
		return basesCache.value;
	}
	if (!basesInflight) {
		basesInflight = listBases()
			.then((value) => {
				basesCache = { at: Date.now(), value };
				return value;
			})
			.catch((err) => {
				basesCache = { at: Date.now(), error: err };
				throw err;
			})
			.finally(() => {
				basesInflight = null;
			});
	}
	return basesInflight;
}

// ---------------------------------------------------------------------------
// reference frame dumps
// ---------------------------------------------------------------------------

// The synthetic pose borrows its skeleton proportions and root from the base
// clip, so a frame dump of the chosen base is required by pose-to-npz.mjs.
// Dumps are cached on disk under tools/ardy/out/refs/<base>.json and produced
// by running tools/ardy/dump-npz.py on the box (copied to /tmp, never into
// ~/ardy, removed afterwards). Concurrent requests for the same base share
// one dump via refInflight.
const refInflight = new Map();

function ensureReference(baseId, basePath) {
	mkdirSync(REFS_DIR, { recursive: true });
	const cachePath = join(REFS_DIR, `${baseId}.json`);
	if (existsSync(cachePath)) {
		try {
			const cached = JSON.parse(readFileSync(cachePath, "utf8"));
			if (cached && cached.schema === "ardy.frame.v1") return Promise.resolve(cachePath);
			console.error(`[bridge] cached reference ${cachePath} is not ardy.frame.v1; re-dumping`);
		} catch {
			console.error(`[bridge] cached reference ${cachePath} is unreadable; re-dumping`);
		}
	}
	if (refInflight.has(baseId)) return refInflight.get(baseId);
	const promise = dumpReference(baseId, basePath, cachePath).finally(() => {
		refInflight.delete(baseId);
	});
	refInflight.set(baseId, promise);
	return promise;
}

async function dumpReference(baseId, basePath, cachePath) {
	// basePath is already whitelisted by SAFE_BASE_PATH, so it cannot carry
	// shell metacharacters into the remote command below.
	const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
	const remoteScript = `/tmp/cozyclay-dump-${suffix}.py`;
	try {
		await run(
			["scp", "-q", ...SCP_OPTS, DUMP_SCRIPT, `${HOST}:${remoteScript}`],
			{ timeoutMs: 30_000 }
		);
		const { stdout, stderr } = await run(
			["ssh", ...SSH_OPTS, HOST, `cd ${REMOTE} && ${DUMP_PY} ${remoteScript} ${basePath} 0`],
			{ timeoutMs: 120_000 }
		);
		let parsed;
		try {
			parsed = JSON.parse(stdout);
		} catch (err) {
			throw new Error(
				`reference dump for ${baseId} produced no JSON: ${lastLine(stderr) || err.message}`
			);
		}
		if (!parsed || parsed.schema !== "ardy.frame.v1") {
			throw new Error(
				`reference dump for ${baseId} has schema ${JSON.stringify(parsed && parsed.schema)}`
			);
		}
		writeFileSync(cachePath, stdout);
		return cachePath;
	} finally {
		// Cleanup failure must never mask the real result.
		await run(["ssh", ...SSH_OPTS, HOST, `rm -f ${remoteScript}`], { timeoutMs: 30_000 }).catch(
			(err) => console.error(`[bridge] could not remove ${remoteScript} on ${HOST}: ${err.message}`)
		);
	}
}

// ---------------------------------------------------------------------------
// request validation
// ---------------------------------------------------------------------------

// Returns an error message naming the offending field, or null when valid.
function validateGenerate(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
	if (body.posePin !== undefined && typeof body.posePin !== "boolean") {
		return `field 'posePin' must be a boolean, got ${JSON.stringify(body.posePin)}`;
	}
	if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) return "field 'prompt' must be a non-empty string";
	if (body.prompt.length > PROMPT_MAX_CHARS) return `field 'prompt' is ${body.prompt.length} chars; the cap is ${PROMPT_MAX_CHARS}`;
	if (typeof body.duration !== "number" || !Number.isFinite(body.duration)) return `field 'duration' must be a finite number`;
	if (body.duration < DURATION_MIN || body.duration > DURATION_MAX) return `field 'duration' must be in ${DURATION_MIN}..${DURATION_MAX} seconds`;
	const clipFrames = Math.floor(body.duration * FPS);
	if (clipFrames < 3) return `field 'duration' yields fewer than 3 frames`;

	const posePinned = body.posePin !== false;
	if (posePinned) {
		const poses = body.motionEdit
			? body.motionEdit.edits
			: Array.isArray(body.poses)
				? body.poses
				: body.pose
					? [{ frame: body.dstFrame, pose: body.pose }]
					: null;
		if (!poses || poses.length === 0 || poses.length > 64) return `field 'poses' must have 1..64 entries when posePin is true`;
		let previous = -1;
		for (let i = 0; i < poses.length; i += 1) {
			const entry = poses[i];
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `field 'poses[${i}]' must be an object`;
			if (!Number.isInteger(entry.frame) || entry.frame < 0 || entry.frame >= clipFrames) return `field 'poses[${i}].frame' must be an integer in 0..${clipFrames - 1}`;
			if (entry.frame <= previous) return `field 'poses' frames must be strictly ascending and distinct`;
			previous = entry.frame;
			if (!entry.pose || typeof entry.pose !== "object" || Array.isArray(entry.pose)) return `field 'poses[${i}].pose' must be an object`;
		if (entry.pose.schema !== "cozyclay.pose.v1") return `field 'poses[${i}].pose.schema' must be "cozyclay.pose.v1"`;
			if (!Array.isArray(entry.pose.root) || entry.pose.root.length !== 3 || !entry.pose.root.every(Number.isFinite)) return `field 'poses[${i}].pose.root' must be [x, y, z] finite metres`;
		}
	}
	if (body.base !== undefined && (typeof body.base !== "string" || body.base.length === 0)) return "field 'base' must be a non-empty string";
	if (body.segments !== undefined) {
		const error = validateSegments(body.segments, clipFrames);
		if (error) return error;
		if (posePinned) return "field 'segments' uses autoregressive history and requires posePin:false";
		// segments + waypoints run TOGETHER on the sequence generator: the
		// Root2D constraint set is built over the whole rollout and each
		// chained call sees its own slice (the interactive demo's pattern).
		// The trained window then binds each segment call, not the total.
		if (body.waypoints !== undefined) {
			for (let i = 0; i < body.segments.length; i += 1) {
				const segment = body.segments[i];
				if (segment.endFrame - segment.startFrame > WAYPOINT_CLIP_MAX_S * FPS) {
					return `field 'segments[${i}]' must be <= ${WAYPOINT_CLIP_MAX_S} seconds when 'waypoints' are present (each chained call must fit ARDY's trained window)`;
				}
			}
		}
	}
	if (body.regenerateSegments !== undefined) {
		const error = validateRegenerateSegments(body.regenerateSegments, clipFrames);
		if (error) return error;
		if (!posePinned) return "field 'regenerateSegments' requires posePin:true";
		if (body.segments !== undefined || body.waypoints !== undefined) {
			return "field 'regenerateSegments' cannot be combined with segments or waypoints";
		}
		if (typeof body.sourceMotion !== "string" || !/^\/ardy\/motions\/[0-9]+-[0-9a-f]{6}$/.test(body.sourceMotion)) {
			return "field 'sourceMotion' must be a generated /ardy/motions/<run-id> URL";
		}
	}
	if (body.motionEdit !== undefined) {
		const edit = body.motionEdit;
		if (!edit || typeof edit !== "object" || Array.isArray(edit)) return "field 'motionEdit' must be an object";
		if (!posePinned) return "field 'motionEdit' requires posePin:true";
		if (body.segments !== undefined || body.regenerateSegments !== undefined || body.waypoints !== undefined) {
			return "field 'motionEdit' cannot be combined with segments, regenerateSegments, or waypoints";
		}
		if (typeof edit.sourceMotion !== "string" || !/^\/ardy\/motions\/[0-9]+-[0-9a-f]{6}$/.test(edit.sourceMotion)) {
			return "field 'motionEdit.sourceMotion' must be a generated /ardy/motions/<run-id> URL";
		}
		if (
			!Number.isInteger(edit.startFrame) ||
			!Number.isInteger(edit.endFrame) ||
			edit.startFrame < 0 ||
			edit.endFrame > clipFrames ||
			edit.endFrame - edit.startFrame < 3
		) {
			return `field 'motionEdit' range must be 3+ frames inside 0..${clipFrames}`;
		}
		if (!Array.isArray(edit.edits) || edit.edits.length < 1 || edit.edits.length > 64) {
			return "field 'motionEdit.edits' must have 1..64 entries";
		}
		for (let index = 0; index < edit.edits.length; index += 1) {
			const entry = edit.edits[index];
			if (!Array.isArray(entry.tracks) || entry.tracks.length < 1 || entry.tracks.some((track) => typeof track !== "string")) {
				return `field 'motionEdit.edits[${index}].tracks' must contain track names`;
			}
		}
		for (const key of ["contextBefore", "contextAfter"]) {
			if (!Number.isInteger(edit[key]) || edit[key] < 0 || edit[key] > 160) {
				return `field 'motionEdit.${key}' must be an integer in 0..160`;
			}
		}
	}
	if (body.waypoints !== undefined) {
		// Without segments, a root path runs the ONE-SHOT constrained
		// generator: a single model sampling call for the whole clip, so the
		// clip itself must fit ARDY's 10 s trained window. With segments the
		// sequence generator chains calls and the per-segment check above is
		// the binding one instead.
		if (body.segments === undefined && body.duration > WAYPOINT_CLIP_MAX_S) {
			return `field 'duration' must be <= ${WAYPOINT_CLIP_MAX_S} seconds when 'waypoints' are present without 'segments' (one-shot constrained generation; ARDY's trained window)`;
		}
		const error = validateWaypoints(body.waypoints, clipFrames);
		if (error) return error;
	}
	if (body.seed !== undefined && (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > SEED_MAX)) return `field 'seed' must be an integer in 0..${SEED_MAX}`;
	if (body.cpu !== undefined && typeof body.cpu !== "boolean") return `field 'cpu' must be a boolean`;
	return null;
}

function validateSegments(segments, clipFrames) {
	if (!Array.isArray(segments) || segments.length < 2 || segments.length > 64) return "field 'segments' must have 2..64 entries";
	let cursor = 0;
	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i];
		if (!segment || typeof segment !== "object" || Array.isArray(segment)) return `field 'segments[${i}]' must be an object`;
		if (!Number.isInteger(segment.startFrame) || !Number.isInteger(segment.endFrame)) return `field 'segments[${i}]' frames must be integers`;
		if (segment.startFrame !== cursor || segment.endFrame <= segment.startFrame || segment.endFrame > clipFrames) return `field 'segments' must be contiguous from frame 0 through ${clipFrames}`;
		if (segment.endFrame - segment.startFrame < 3) return `field 'segments[${i}]' must contain at least 3 frames`;
		if (typeof segment.prompt !== "string" || !segment.prompt.trim() || segment.prompt.length > PROMPT_MAX_CHARS) return `field 'segments[${i}].prompt' must be 1..${PROMPT_MAX_CHARS} characters`;
		cursor = segment.endFrame;
	}
	return cursor === clipFrames ? null : `field 'segments' must end at frame ${clipFrames}`;
}

function validateRegenerateSegments(segments, clipFrames) {
	if (!Array.isArray(segments) || segments.length < 1 || segments.length > 64) {
		return "field 'regenerateSegments' must have 1..64 entries";
	}
	let previousEnd = -1;
	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i];
		if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
			return `field 'regenerateSegments[${i}]' must be an object`;
		}
		if (
			!Number.isInteger(segment.startFrame) ||
			!Number.isInteger(segment.endFrame) ||
			segment.startFrame < 0 ||
			segment.endFrame > clipFrames ||
			segment.endFrame - segment.startFrame < 4
		) {
			return `field 'regenerateSegments[${i}]' must be a 4+ frame range inside 0..${clipFrames}`;
		}
		if (segment.startFrame < previousEnd) {
			return "field 'regenerateSegments' must be sorted and non-overlapping";
		}
		if (typeof segment.prompt !== "string" || !segment.prompt.trim() || segment.prompt.length > PROMPT_MAX_CHARS) {
			return `field 'regenerateSegments[${i}].prompt' must be 1..${PROMPT_MAX_CHARS} characters`;
		}
		previousEnd = segment.endFrame;
	}
	return null;
}

// Returns an error message naming the offending field, or null when valid.
// The fixed contract: 2..32 sparse {frame,x,z,heading} keys, starting at
// frame 0 with strictly ascending frames. ARDY generates every in-between
// frame. x/z are finite meters in [-20,20], heading null or finite radians
// in [-2π,2π].
// Every rejection names 'waypoints' so the client can point at the offending
// entry.
function validateWaypoints(waypoints, clipFrames) {
	if (!Array.isArray(waypoints)) {
		return "field 'waypoints' must be an array";
	}
	if (waypoints.length < 2 || waypoints.length > WAYPOINTS_MAX) {
		return `field 'waypoints' must have 2..${WAYPOINTS_MAX} sparse entries, got ${waypoints.length}`;
	}
	let prevFrame = -1;
	for (let i = 0; i < waypoints.length; i += 1) {
		const wp = waypoints[i];
		if (!wp || typeof wp !== "object" || Array.isArray(wp)) {
			return `field 'waypoints[${i}]' must be an object`;
		}
		if (!Number.isInteger(wp.frame) || wp.frame < 0 || wp.frame >= clipFrames) {
			return `field 'waypoints[${i}].frame' must be an integer in 0..${clipFrames - 1}, got ${JSON.stringify(wp.frame)}`;
		}
		if (wp.frame <= prevFrame) {
			return `field 'waypoints' frames must be strictly ascending: frame ${wp.frame} duplicates or precedes frame ${prevFrame} (index ${i})`;
		}
		prevFrame = wp.frame;
		if (i === 0 && wp.frame !== 0) {
			return `field 'waypoints[0].frame' must be 0 (start + destination path), got ${wp.frame}`;
		}
		for (const axis of ["x", "z"]) {
			const value = wp[axis];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return `field 'waypoints[${i}].${axis}' must be a finite number, got ${JSON.stringify(value)}`;
			}
			if (value < -ROOT_2D_RANGE_M || value > ROOT_2D_RANGE_M) {
				return `field 'waypoints[${i}].${axis}' ${value} is outside -${ROOT_2D_RANGE_M}..${ROOT_2D_RANGE_M} meters`;
			}
		}
		if (!("heading" in wp) || wp.heading === undefined) {
			return `field 'waypoints[${i}].heading' is missing; must be null or a number of radians`;
		}
		if (wp.heading !== null) {
			if (typeof wp.heading !== "number" || !Number.isFinite(wp.heading)) {
				return `field 'waypoints[${i}].heading' must be null or a finite number of radians, got ${JSON.stringify(wp.heading)}`;
			}
			if (Math.abs(wp.heading) > HEADING_RANGE_RAD) {
				return `field 'waypoints[${i}].heading' ${wp.heading} rad is outside -2π..2π`;
			}
		}
	}
	// Root pins are inpainting observations the model cannot refuse, so a pin
	// pair demanding an inexpressible pace collapses the gait into
	// foot-sliding instead of erroring. The bands are wider than the authored
	// 0.5..3 m/s walk band because these are the dense C1 samples, which dip
	// through corners and pause dead in authored holds.
	// holdPair[i]: the pair ending at waypoint i is a deliberate hold.
	// Index 0 has no pair — false, so the first real leg gets no exemption.
	const holdPair = waypoints.map((wp, i) =>
		i === 0 ? false : Math.hypot(wp.x - waypoints[i - 1].x, wp.z - waypoints[i - 1].z) <= WAYPOINT_HOLD_EPS_M,
	);
	for (let i = 1; i < waypoints.length; i += 1) {
		if (holdPair[i]) continue; // a deliberate hold
		const prev = waypoints[i - 1];
		const wp = waypoints[i];
		const speed = Math.hypot(wp.x - prev.x, wp.z - prev.z) / ((wp.frame - prev.frame) / FPS);
		if (speed > WAYPOINT_SPEED_MAX_MPS) {
			return `field 'waypoints[${i}]' implies ${speed.toFixed(1)} m/s from waypoint ${i - 1} — faster than the ${WAYPOINT_SPEED_MAX_MPS} m/s locomotion ceiling`;
		}
		// Pairs beside a hold are the C1 ramp down to (or up from) zero and
		// legitimately pass under the floor; everywhere else, sub-gait creep
		// means foot-sliding.
		const besideHold = holdPair[i - 1] || (i + 1 < waypoints.length && holdPair[i + 1]);
		if (speed < WAYPOINT_SPEED_MIN_MPS && !besideHold) {
			return `field 'waypoints[${i}]' implies ${speed.toFixed(2)} m/s from waypoint ${i - 1} — below the ${WAYPOINT_SPEED_MIN_MPS} m/s gait floor (hold still or move at walking pace, nothing between)`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

// Every response goes through the envelope's no-CORS JSON writer: JSON,
// NDJSON, binary and OPTIONS responses carry zero Access-Control-Allow-*
// headers, so the browser's same-origin policy is the enforcement boundary.
const sendJson = noCorsJson;

// The generator's single-line JSON report is the LAST stdout line of
// cclay_constrained_generate.py and is compact-printed (starts with "{").
// Constrained generation reports carry target_space; autoregressive sequence
// reports carry a segment table and continuity metrics.
function tryParseReport(line) {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith("{")) return null;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const constrained = parsed && typeof parsed === "object" && typeof parsed.target_space === "string";
	const sequence =
		parsed &&
		typeof parsed === "object" &&
		Number.isInteger(parsed.frames) &&
		Number.isInteger(parsed.fps) &&
		Array.isArray(parsed.segments) &&
		parsed.continuity &&
		typeof parsed.continuity === "object";
	const motionEdit =
		parsed &&
		typeof parsed === "object" &&
		Array.isArray(parsed.edit_range) &&
		Array.isArray(parsed.history_range) &&
		Array.isArray(parsed.future_range);
	if (!constrained && !sequence && !motionEdit) {
		return null;
	}
	return parsed;
}

// Force the same box config onto run-on-box.sh even when the bridge was
// started with different env values; they must not disagree.
function boxEnv() {
	return {
		...process.env,
		CCLAY_ARDY_HOST: HOST,
		CCLAY_ARDY_REPO: REMOTE,
		CCLAY_ARDY_VENV: VENV_PY,
		CCLAY_ARDY_ENCODER_URL: ENCODER_URL,
	};
}

// ---------------------------------------------------------------------------
// generated-motion delivery
// ---------------------------------------------------------------------------

// run-id -> absolute npz path, populated ONLY after this process generated
// the file and verified it on disk (see handleGenerate's done branch). The
// GET handler never accepts a path from the URL: an id that is not in this
// map is 404 by definition. Capped so a long-lived dev sidecar cannot grow
// without bound; evicted ids become stale and 404, which is documented.
const motionAllowlist = createArtifactAllowlist({ base: OUT_DIR, max: MOTION_ALLOWLIST_MAX });

function registerMotion(runId, absPath) {
	motionAllowlist.register(runId, absPath);
}

// Serves /ardy/motions/<run-id>; returns the HTTP status to log.
function serveMotion(req, res, pathname) {
	const match = /^\/ardy\/motions\/([^/]+)$/.exec(pathname);
	if (!match) {
		sendJson(res, 404, { ok: false, reason: `not found: ${req.method} ${pathname}` });
		return 404;
	}
	const runId = match[1];
	if (!MOTION_ID.test(runId) || !motionAllowlist.has(runId)) {
		sendJson(res, 404, { ok: false, reason: `unknown or expired motion "${runId}"` });
		return 404;
	}
	const absPath = motionAllowlist.resolve(runId);
	// resolve() re-checks the allowlist at serve time: realpath containment,
	// regular-file type AND the dev/ino identity recorded at registration.
	// A registered file swapped for a symlink or hard link to outside
	// OUT_DIR, or for a directory, resolves to null here - before any
	// status is committed, so a swap is a named 404, never a streamed
	// outside file or a committed-200-then-EISDIR hang.
	if (!absPath) {
		sendJson(res, 404, { ok: false, reason: `motion "${runId}" is no longer on disk or escaped ${OUT_DIR}` });
		return 404;
	}
	let size;
	try {
		size = statSync(absPath).size;
	} catch {
		sendJson(res, 404, { ok: false, reason: `motion "${runId}" is no longer on disk` });
		return 404;
	}
	res.writeHead(200, {
		"Content-Type": "application/octet-stream",
		"Content-Length": size,
		"Content-Disposition": `attachment; filename="${basename(absPath)}"`,
		"Cache-Control": "no-store",
	});
	createReadStream(absPath)
		.on("error", (err) => {
			console.error(`[bridge] error streaming ${absPath}: ${err.message}`);
			res.destroy();
		})
		.pipe(res);
	return 200;
}

async function handleGenerate(req, res) {
	const started = Date.now();
	const finish = (status) => {
		console.log(`[bridge] POST /ardy/generate -> ${status} (${Date.now() - started} ms)`);
	};

	let body;
	try {
		body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
	} catch (err) {
		sendJson(res, err.status || 400, { ok: false, reason: err.message });
		finish(err.status || 400);
		return;
	}
	const invalid = validateGenerate(body);
	if (invalid) {
		sendJson(res, 400, { ok: false, reason: invalid });
		finish(400);
		return;
	}
	// A given base must be one of the ids the box actually reported, so a
	// typo or a guessed id never reaches run-on-box. posePin:false requests
	// may omit base entirely - with waypoints that is the two-pass mode
	// (run-on-box.sh free-generates the base clip first) and without
	// waypoints it is free generation - so the listing is skipped there.
	const posePinned = body.posePin !== false;
	const requestedPoses = posePinned
		? (body.motionEdit
			? body.motionEdit.edits
			: Array.isArray(body.poses)
				? body.poses
				: [{ frame: body.dstFrame, pose: body.pose }])
		: [];
	const baseLabel = body.base === undefined ? "internal-neutral" : body.base;
	const dstFrameLabel = requestedPoses.map((entry) => entry.frame).join(",") || "none";
	let match = null;
	let sourceMotionPath = null;
	if (body.regenerateSegments || body.motionEdit) {
		const sourceUrl = body.motionEdit?.sourceMotion || body.sourceMotion;
		const sourceId = sourceUrl.slice("/ardy/motions/".length);
		sourceMotionPath = motionAllowlist.resolve(sourceId);
		if (!sourceMotionPath || !existsSync(sourceMotionPath)) {
			sendJson(res, 400, { ok: false, reason: `field 'sourceMotion': unknown or expired motion "${sourceId}"` });
			finish(400);
			return;
		}
	}
	if (body.base !== undefined) {
		let bases;
		try {
			bases = await getBases();
		} catch (err) {
			sendJson(res, 503, { ok: false, reason: `cannot list base motions on ${HOST}: ${err.message}` });
			finish(503);
			return;
		}
		match = bases.bases.find((entry) => entry.id === body.base);
		if (!match) {
			sendJson(res, 400, {
				ok: false,
				reason: `field 'base': unknown base "${body.base}" (the box reports ${bases.bases.length} base motion(s))`,
			});
			finish(400);
			return;
		}
	}
	// NDJSON writer with the same no-CORS posture; send() no-ops once the response ended.
	const send = ndjson(res);
	const sendStatus = (message) => send({ event: "status", message });
	const sendError = (message) => {
		send({ event: "error", message });
		res.end();
	};

	// Children spawned for THIS request, killed on client disconnect or any
	// terminal error. Detached groups, so killGroup takes down the whole tree
	// (bash + the ssh session it waits on).
	const children = new Set();
	const spawnTracked = (command, args, options) => {
		const child = spawnDetached(command, args, options);
		children.add(child);
		return child;
	};
	const killChildren = () => {
		for (const child of children) killGroup(child);
		children.clear();
	};
	res.on("close", () => {
		if (!res.writableEnded) {
			console.error(
				`[bridge] client disconnected mid-generate; killing ${children.size} child process group(s)`
			);
			killChildren();
		}
	});

	const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
	const poseJsonPaths = requestedPoses.map((_, index) => join(OUT_DIR, `gen-${stamp}-pose-${index}.json`));
	const poseNpzPaths = requestedPoses.map((_, index) => join(OUT_DIR, `gen-${stamp}-pose-${index}.npz`));
	// posePin:false runs carry no pose, so the artifact name says what the
	// run actually was: constrained (pose pinned) vs generated (no pose).
	const outNpzPath = join(OUT_DIR, posePinned ? `gen-${stamp}-constrained.npz` : `gen-${stamp}-generated.npz`);
	try {
		mkdirSync(OUT_DIR, { recursive: true });

		// --- pose -> ARDY motion npz (local, fast). Skipped when posePin is
		// false: the pose constraint is dropped, so there is nothing to
		// convert, dump a reference for, or push.
		if (posePinned) {
			for (let index = 0; index < requestedPoses.length; index += 1) {
				const entry = requestedPoses[index];
				const poseJsonPath = poseJsonPaths[index];
				const poseNpzPath = poseNpzPaths[index];
				writeFileSync(poseJsonPath, `${JSON.stringify(entry.pose, null, 2)}
`);
				sendStatus(`[bridge] pose ${index + 1}/${requestedPoses.length} frame ${entry.frame} written`);
				const conv = spawnTracked(
					process.execPath,
					[POSE_TO_NPZ, poseJsonPath, "--out", poseNpzPath],
					{ cwd: REPO, detached: true }
				);
				const convLast = { stderr: "", stdout: "" };
				const convCode = await runStreaming(conv, (line, streamName) => {
					convLast[streamName] = line;
					sendStatus(line);
				});
				children.delete(conv);
				if (convCode !== 0) {
					killChildren();
					sendError(`pose-to-npz failed (exit ${convCode}): ${convLast.stderr || convLast.stdout || "no output"}`);
					finish(200);
					return;
				}
			}
		}

		// --- generation on the box -----------------------------------------
		const clipFrames = Math.floor(body.duration * FPS);
		const segments = body.segments || [{ startFrame: 0, endFrame: clipFrames, prompt: body.prompt }];
		if (body.motionEdit) {
			const manifestPath = join(OUT_DIR, `gen-${stamp}-edit-manifest.json`);
			const manifest = {
				start_frame: body.motionEdit.startFrame,
				end_frame: body.motionEdit.endFrame,
				edits: body.motionEdit.edits.map((entry, index) => ({
					frame: entry.frame,
					tracks: entry.tracks,
					root: entry.pose.root,
					pose_path: `pose-${index}.npz`,
				})),
			};
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
			const args = [
				RUN_EDIT_ON_BOX,
				"--source", sourceMotionPath,
				"--manifest", manifestPath,
				"--prompt", body.prompt,
				"--context-before", String(body.motionEdit.contextBefore),
				"--context-after", String(body.motionEdit.contextAfter),
				"--output", outNpzPath,
			];
			if (Number.isInteger(body.seed)) args.push("--seed", String(body.seed));
			for (const posePath of poseNpzPaths) args.push("--pose", posePath);
			sendStatus(
				`[bridge] editing frames ${body.motionEdit.startFrame}..${body.motionEdit.endFrame - 1} ` +
				"with ARDY history and sparse constraints"
			);
			const box = spawnTracked("bash", args, { cwd: REPO, detached: true, env: boxEnv() });
			const last = { stderr: "", stdout: "" };
			let report = null;
			let done = null;
			const code = await runStreaming(box, (line, streamName) => {
				last[streamName] = line;
				if (streamName === "stdout") {
					const parsed = tryParseReport(line);
					if (parsed) {
						report = parsed;
						return;
					}
					const marker = /^run-edit-on-box: done - (.+) \((\d+) bytes\)$/.exec(line);
					if (marker) {
						done = { path: marker[1], bytes: Number(marker[2]) };
						return;
					}
				}
				sendStatus(line);
			});
			children.delete(box);
			if (code !== 0) throw new Error(`run-edit-on-box failed (exit ${code}): ${last.stderr || last.stdout || "no output"}`);
			if (!done || done.path !== outNpzPath) throw new Error("run-edit-on-box did not return the requested output");
			const finalSize = statSync(outNpzPath).size;
			if (finalSize !== done.bytes) throw new Error("run-edit-on-box output size mismatch");
			if (report) send({ event: "report", report });
			registerMotion(stamp, outNpzPath);
			send({ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
			res.end();
			console.log(`[bridge] context-aware motion edit finished: ${outNpzPath}`);
			killChildren();
			finish(200);
			return;
		}
		if (body.segments) {
			const args = [RUN_SEQUENCE_ON_BOX];
			for (const segment of segments) {
				args.push(
					"--segment",
					segment.prompt,
					String((segment.endFrame - segment.startFrame) / FPS)
				);
			}
			// Root waypoints ride the same chained rollout (rollout-global
			// frames): the sequence generator slices the constraint set per
			// segment call, so a path and a prompt schedule coexist.
			for (const wp of body.waypoints ?? []) {
				args.push("--root-2d", String(wp.frame), String(wp.x), String(wp.z), wp.heading === null ? "none" : String(wp.heading));
			}
			if (Number.isInteger(body.seed)) args.push("--seed", String(body.seed));
			if (body.cpu === true) args.push("--cpu");
			args.push("--output", outNpzPath);
			sendStatus(
				`[bridge] generating ${segments.length} blocks in one autoregressive ARDY session` +
				(body.waypoints?.length ? ` with a ${body.waypoints.length}-pin root path` : "")
			);

			const box = spawnTracked("bash", args, { cwd: REPO, detached: true, env: boxEnv() });
			const last = { stderr: "", stdout: "" };
			let finalReport = null;
			let done = null;
			const code = await runStreaming(box, (line, streamName) => {
				last[streamName] = line;
				if (streamName === "stdout") {
					const parsed = tryParseReport(line);
					if (parsed) {
						finalReport = parsed;
						return;
					}
					const marker = /^run-sequence-on-box: done - (.+) \((\d+) bytes\)$/.exec(line);
					if (marker) {
						done = { path: marker[1], bytes: Number(marker[2]) };
						return;
					}
				}
				sendStatus(line);
			});
			children.delete(box);
			if (code !== 0) {
				throw new Error(`run-sequence-on-box failed (exit ${code}): ${last.stderr || last.stdout || "no output"}`);
			}
			if (!done) throw new Error('run-sequence-on-box exited 0 without a "done" marker');
			if (done.path !== outNpzPath) throw new Error(`run-sequence-on-box returned unexpected output ${done.path}`);
			const finalSize = statSync(outNpzPath).size;
			if (finalSize === 0 || finalSize !== done.bytes) {
				throw new Error(`run-sequence-on-box output size mismatch for ${outNpzPath}`);
			}
			if (finalReport) send({ event: "report", report: finalReport });
			registerMotion(stamp, outNpzPath);
			send({ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
			res.end();
			console.log(`[bridge] sequence generation finished: ${outNpzPath} (${segments.length} blocks)`);
			killChildren();
			finish(200);
			return;
		}
		const runSingle = async (segment, outputPath = outNpzPath) => {
			const localPoses = requestedPoses
				.map((entry, poseIndex) => ({ ...entry, poseIndex }))
				.filter((entry) => entry.frame >= segment.startFrame && entry.frame < segment.endFrame);
			if (posePinned && localPoses.length === 0) {
				throw new Error("generation has no pose constraint");
			}
			const segmentFrames = segment.endFrame - segment.startFrame;
			const args = [RUN_ON_BOX];
			for (const entry of localPoses) {
				args.push(
					"--pose-from",
					poseNpzPaths[entry.poseIndex],
					"0",
					String(entry.frame - segment.startFrame)
				);
			}
			if (match) args.push("--base", match.path);
			args.push("--prompt", segment.prompt, "--duration", String(segmentFrames / FPS));
			if (Number.isInteger(body.seed)) args.push("--seed", String(body.seed));
			if (body.cpu === true) args.push("--cpu");
			for (const wp of body.waypoints || []) {
				args.push("--root-2d", String(wp.frame), String(wp.x), String(wp.z), wp.heading === null ? "none" : String(wp.heading));
			}
			args.push("--output", outputPath);
			sendStatus(`[bridge] generating frames ${segment.startFrame}..${segment.endFrame - 1}`);

			const box = spawnTracked("bash", args, { cwd: REPO, detached: true, env: boxEnv() });
			const last = { stderr: "", stdout: "" };
			let report = null;
			let done = null;
			const code = await runStreaming(box, (line, streamName) => {
				last[streamName] = line;
				if (streamName === "stdout") {
					const parsed = tryParseReport(line);
					if (parsed) {
						report = parsed;
						return;
					}
					const marker = /^run-on-box: done - (.+) \((\d+) bytes\)$/.exec(line);
					if (marker) {
						done = { path: marker[1], bytes: Number(marker[2]) };
						return;
					}
				}
				sendStatus(line);
			});
			children.delete(box);
			if (code !== 0) throw new Error(`run-on-box failed (exit ${code}): ${last.stderr || last.stdout || "no output"}`);
			if (!done) throw new Error('run-on-box exited 0 without a "run-on-box: done" marker');
			if (done.path !== outputPath) throw new Error(`run-on-box returned unexpected output ${done.path}`);
			const size = statSync(outputPath).size;
			if (size === 0 || size !== done.bytes) throw new Error(`run-on-box output size mismatch for ${outputPath}`);
			return report;
		};

		if (body.regenerateSegments) {
			const source = await decodeMotionNpz(new Uint8Array(readFileSync(sourceMotionPath)));
			if (source.frames !== clipFrames || source.fps !== FPS) {
				throw new Error(`source motion is ${source.frames} frames @ ${source.fps} fps; expected ${clipFrames} @ ${FPS}`);
			}
			let result = source;
			const reports = [];
			for (let index = 0; index < body.regenerateSegments.length; index += 1) {
				const segment = body.regenerateSegments[index];
				const segmentPath = join(OUT_DIR, `gen-${stamp}-edit-${index}.npz`);
				const report = await runSingle(segment, segmentPath);
				const generated = await decodeMotionNpz(new Uint8Array(readFileSync(segmentPath)));
				const segmentFrames = segment.endFrame - segment.startFrame;
				if (generated.frames !== segmentFrames || generated.fps !== FPS) {
					throw new Error(`edited block ${index + 1} returned ${generated.frames} frames @ ${generated.fps} fps`);
				}
				result = replaceMotionSegment(result, generated, segment.startFrame);
				if (report) reports.push({ ...report, startFrame: segment.startFrame, endFrame: segment.endFrame });
			}
			writeNpz(outNpzPath, motionArraysToNpzMembers(result));
			const boundaryJumps = [];
			for (const segment of body.regenerateSegments) {
				for (const frame of [segment.startFrame, segment.endFrame]) {
					if (frame <= 0 || frame >= result.frames) continue;
					let maxJump = 0;
					for (let joint = 0; joint < 27; joint += 1) {
						const current = (frame * 27 + joint) * 3;
						const previous = current - 27 * 3;
						maxJump = Math.max(
							maxJump,
							Math.hypot(
								result.posedJoints[current] - result.posedJoints[previous],
								result.posedJoints[current + 1] - result.posedJoints[previous + 1],
								result.posedJoints[current + 2] - result.posedJoints[previous + 2]
							)
						);
					}
					boundaryJumps.push({ frame, max_joint_jump_m: maxJump });
				}
			}
			send({
				event: "report",
				report: {
					target_space: "skeleton_joint_center",
					frames: result.frames,
					fps: result.fps,
					regenerated_segments: body.regenerateSegments,
					segments: reports,
					boundaries: boundaryJumps,
				},
			});
			const finalSize = statSync(outNpzPath).size;
			registerMotion(stamp, outNpzPath);
			send({ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
			res.end();
			console.log(`[bridge] regenerated ${body.regenerateSegments.length} edited block(s): ${outNpzPath}`);
			killChildren();
			finish(200);
			return;
		}

		const finalReport = await runSingle(segments[0]);
		if (finalReport) {
			const poseResults = finalReport.poses || [];
			const worst = (key) => poseResults.length ? Math.max(...poseResults.map((pose) => pose[key] ?? 0)) : null;
			finalReport.root_error_m = worst("root_error_m");
			finalReport.shape_mean_error_m = worst("shape_mean_error_m");
			finalReport.shape_max_error_m = worst("shape_max_error_m");
			finalReport.base_root_error_m = worst("base_root_error_m");
			finalReport.base_shape_mean_error_m = worst("base_shape_mean_error_m");
			finalReport.base_shape_max_error_m = worst("base_shape_max_error_m");
			send({ event: "report", report: finalReport });
		}
		const finalSize = statSync(outNpzPath).size;
		registerMotion(stamp, outNpzPath);
		send({ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
		res.end();
		console.log(`[bridge] generate finished: ${outNpzPath} (base ${baseLabel}, ${body.duration}s, dstFrame ${dstFrameLabel})`);

		killChildren();
		finish(200);
	} catch (err) {
		killChildren();
		if (!res.writableEnded) sendError(`generate failed: ${err.message}`);
		console.error(`[bridge] generate error: ${err.stack || err}`);
		finish(200);
	}
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function usage() {
	console.log(`usage: node tools/ardy/bridge.mjs [--port <n>]

Dev-only HTTP sidecar for the ARDY loop. See tools/ardy/BRIDGE.md.

  --port <n>            port to listen on (default 5181, loopback only)

env:
  COZYCLAY_BRIDGE_PORT    same as --port (default 5181)
  CCLAY_ARDY_HOST         ssh destination for the ARDY host (required)
  CCLAY_ARDY_REPO         ARDY checkout on the box       (default $HOME/ardy)
  CCLAY_ARDY_VENV         generator venv python on the box (default ~/ardy/.venv-cuda/bin/python)
  CCLAY_ARDY_ENCODER_URL  text encoder service           (default http://127.0.0.1:9550/)
`);
}

function die(message) {
	console.error(`[bridge] ${message}`);
	process.exit(2);
}

function resolvePort(argv) {
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--help" || argv[i] === "-h") {
			usage();
			process.exit(0);
		}
		if (argv[i] === "--port") {
			const value = argv[i + 1];
			if (value === undefined) die("--port needs a value");
			const port = Number(value);
			if (!Number.isInteger(port) || port < 1 || port > 65535) die(`invalid --port value '${value}'`);
			return port;
		}
	}
if (process.env.COZYCLAY_BRIDGE_PORT !== undefined) {
	const port = Number(process.env.COZYCLAY_BRIDGE_PORT);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
		die(`invalid COZYCLAY_BRIDGE_PORT value '${process.env.COZYCLAY_BRIDGE_PORT}'`);
		}
		return port;
	}
	return DEFAULT_PORT;
}

const port = resolvePort(process.argv.slice(2));
if (!HOST) die("CCLAY_ARDY_HOST is required (for example: user@ardy-host)");
// Conformance-suite seam: pre-seed the allowlist through registerMotion,
// the same path a completed generate uses, so serve-time realpath
// containment can be probed without a live box. id=absPath pairs.
const seeded = process.env.CCLAY_ARDY_TEST_REGISTRATIONS || "";
if (seeded) {
	for (const pair of seeded.split(",")) {
		const eq = pair.indexOf("=");
		if (eq === -1) die(`CCLAY_ARDY_TEST_REGISTRATIONS entry must be id=absPath: "${pair}"`);
		registerMotion(pair.slice(0, eq), pair.slice(eq + 1));
	}
}

const server = createServer((req, res) => {
	const started = Date.now();
	const pathname = (req.url || "/").split("?")[0];
	const log = (status) => {
		console.log(`[bridge] ${req.method} ${pathname} -> ${status} (${Date.now() - started} ms)`);
	};
	// Cross-site defence first: loopback + absent CORS does NOT stop a simple
	// cross-site side-effecting POST (a form POST from another origin arrives
	// on loopback indistinguishable from a local call), so Sec-Fetch-Site and
	// Origin are checked on every request, preflight included.
	try {
		assertSameSiteRequest(req);
	} catch (err) {
		sendJson(res, err.status || 403, { ok: false, reason: err.message });
		log(403);
		return;
	}
	if (req.method === "OPTIONS") {
		// 204 with NO CORS headers on purpose: a cross-origin browser
		// preflight must fail, and the same-origin Vite proxy never
		// preflights the bridge (it forwards server-side).
		res.writeHead(204);
		res.end();
		log(204);
		return;
	}
	if (pathname === "/ardy/health" && req.method === "GET") {
		getHealth()
			.then((value) => {
				sendJson(res, 200, value);
				log(200);
			})
			.catch((err) => {
				sendJson(res, 503, { ok: false, reason: err.message });
				log(503);
			});
		return;
	}
	if (pathname === "/ardy/bases" && req.method === "GET") {
		getBases()
			.then((value) => {
				sendJson(res, 200, value);
				log(200);
			})
			.catch((err) => {
				sendJson(res, 503, { ok: false, reason: err.message });
				log(503);
			});
		return;
	}
	if (pathname === "/ardy/generate" && req.method === "POST") {
		handleGenerate(req, res).catch((err) => {
			if (!res.headersSent) sendJson(res, 500, { ok: false, reason: `internal error: ${err.message}` });
			else {
				try {
					res.end();
				} catch {
					/* socket gone */
				}
			}
			console.error(`[bridge] ${req.method} ${pathname} threw: ${err.stack || err}`);
			log(500);
		});
		return;
	}
	if (/^\/ardy\/motions\//.test(pathname) && req.method === "GET") {
		log(serveMotion(req, res, pathname));
		return;
	}
	if (
		pathname === "/ardy/health" ||
		pathname === "/ardy/bases" ||
		pathname === "/ardy/generate" ||
		/^\/ardy\/motions\//.test(pathname)
	) {
		sendJson(res, 405, { ok: false, reason: `method ${req.method} not allowed on ${pathname}` });
		log(405);
		return;
	}
	sendJson(res, 404, { ok: false, reason: `not found: ${req.method} ${pathname}` });
	log(404);
});

server.on("clientError", (err, socket) => {
	if (socket.writable) {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	}
	console.error(`[bridge] client error: ${err.message}`);
});

bindLoopback(server, port);
server.on("listening", () => {
	console.log(`[bridge] ARDY dev bridge listening on http://${BIND_HOST}:${port}`);
	console.log("[bridge] dev-only sidecar: the static dist/ build does not need it; stop with Ctrl-C");
	console.log(`[bridge] box ${HOST} (repo ${REMOTE}, generator venv ${VENV_PY}, encoder ${ENCODER_URL})`);
});

server.on("error", (err) => {
	console.error(`[bridge] cannot listen on ${BIND_HOST}:${port}: ${err.message}`);
	process.exit(1);
});

// Ctrl-C / SIGTERM: take the in-flight process groups down with us; ssh dies,
// sshd closes the session, and the remote generation is not orphaned.
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		console.error(`[bridge] received ${signal}; killing ${killAllGroups()} in-flight child process group(s)`);
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

/**
 * extract.mjs — the bridge's GPU motion-extraction side. The browser's
 * MediaPipe path is per-frame guessing (jittery, rough blocking only); this
 * route ships the footage to the ARDY box, runs SAM-3D-Body over the whole
 * clip (temporal context, real 3D body prior), converts the returned Mixamo
 * BVH to cskel27 arrays and serves them as an ordinary motion npz — so the
 * app loads a GPU-extracted take through the exact same loadMotion path an
 * ARDY generation uses.
 *
 * Same posture as generation: children die with the client connection, the
 * served npz enters the motion allowlist only after this process wrote and
 * verified it, and every failure is a NAMED reason.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killGroup, track } from "./runners/proc.mjs";
import { EXTRACT_FPS_MAX, conformToExtractFps } from "./footage.mjs";
import { motionArraysToNpzMembers, writeNpz } from "./npz.mjs";
import { bvhToCskel27Motion, parseBvh } from "./bvh-cskel27.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");
const SAM_DIR = "~/cclay-ingest/SAM3DBody-cpp"; // the box-side checkout the old ingest pipeline left behind
// Non-interactive ssh shells carry no LD_LIBRARY_PATH, and the CUDA EP needs
// the cudnn that lives inside the ingest workspace's venv — without it the
// pipeline silently falls back to CPU and then refuses to load at all.
const SAM_ENV = 'LD_LIBRARY_PATH="$(echo $HOME/cclay-ingest/.venv/lib/python3.12/site-packages/nvidia/*/lib | tr \' \' :)"';
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;
const SSH_BASE_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

// Extraction can run on a DIFFERENT machine than ARDY generation — e.g. a
// Slurm GPU cluster (measured ~5× the default box). Point it there with:
//   CCLAY_EXTRACT_HOST      ssh destination (default: CCLAY_ARDY_HOST)
//   CCLAY_EXTRACT_SSH_PORT  ssh port (default 22)
//   CCLAY_EXTRACT_TMP       REMOTE work dir for video/BVH — must be visible
//                           to the node that runs the job (a Slurm node's
//                           /tmp is node-local, use a shared home path)
//   CCLAY_EXTRACT_CMD       remote command invoked as `CMD <video> <bvh>`;
//                           it owns GPU allocation (srun …) and env. Unset →
//                           the default box invocation below.
function sshHost() {
	return process.env.CCLAY_EXTRACT_HOST?.trim() || process.env.CCLAY_ARDY_HOST?.trim() || "";
}
const EXTRACT_SSH_PORT = process.env.CCLAY_EXTRACT_SSH_PORT?.trim() || "";
const EXTRACT_TMP = process.env.CCLAY_EXTRACT_TMP?.trim() || "/tmp";
const EXTRACT_CMD = process.env.CCLAY_EXTRACT_CMD?.trim() || "";
const SSH_OPTS = EXTRACT_SSH_PORT ? [...SSH_BASE_OPTS, "-p", EXTRACT_SSH_PORT] : SSH_BASE_OPTS;
const SCP_OPTS = EXTRACT_SSH_PORT ? [...SSH_BASE_OPTS, "-P", EXTRACT_SSH_PORT] : SSH_BASE_OPTS;

/** Read a raw binary request body with a hard cap. The bridge's json readBody
 *  is utf-8 and would corrupt video bytes. */
function readVideoBody(req, limitBytes) {
	return new Promise((resolvePromise, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limitBytes) {
				reject(new Error("extract-upload-too-large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolvePromise(Buffer.concat(chunks)));
		req.on("error", (err) => reject(new Error(`request aborted: ${err.message}`)));
	});
}

function run(command, args, { children, timeoutMs, onLine }) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		children.add(child);
		track(child);
		let err = "";
		let buffered = "";
		const timer = timeoutMs
			? setTimeout(() => {
				killGroup(child);
				reject(new Error("extract-timeout"));
			}, timeoutMs)
			: null;
		const feed = (text) => {
			buffered += text;
			const lines = buffered.split(/[\r\n]/);
			buffered = lines.pop() ?? "";
			for (const line of lines) if (line) onLine?.(line);
		};
		child.stdout.on("data", (chunk) => feed(String(chunk)));
		child.stderr.on("data", (chunk) => {
			err += chunk;
			feed(String(chunk));
		});
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			children.delete(child);
			reject(new Error(`spawn ${command}: ${error.message}`));
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			children.delete(child);
			if (code === 0) resolvePromise();
			else reject(new Error(err.split("\n").filter(Boolean).pop() || `${command} exited ${code}`));
		});
	});
}

/**
 * POST /ardy/extract — input is either JSON {footage:"<id>"} referencing a
 * bridge-downloaded clip, or the raw video bytes themselves. Answer ndjson:
 *   {event:"status", message}                  upload / extract / convert
 *   {event:"progress", stage:"extract", ratio} per-frame GPU movement
 *   {event:"done", motionUrl, frames, fps}
 *   {event:"error", message}                   a NAMED reason
 */
export async function handleExtract(req, res, { readBody, footagePath, registerMotion }) {
	const host = sshHost();
	const contentType = req.headers["content-type"] ?? "";
	let localVideo = null;
	let uploadedTemp = null;
	let cappedTemp = null;

	if (/^application\/json\b/.test(contentType)) {
		let body;
		try {
			body = JSON.parse(await readBody(req));
		} catch (err) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: err.message })}\n`);
			return;
		}
		localVideo = typeof body?.footage === "string" ? footagePath(body.footage) : null;
		if (!localVideo) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: "extract-footage-unknown" })}\n`);
			return;
		}
	} else {
		let bytes;
		try {
			bytes = await readVideoBody(req, MAX_UPLOAD_BYTES);
		} catch (err) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: err.message })}\n`);
			return;
		}
		if (bytes.length < 1024) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: "extract-upload-empty" })}\n`);
			return;
		}
		mkdirSync(OUT_DIR, { recursive: true });
		uploadedTemp = join(OUT_DIR, `extract-upload-${Date.now()}.mp4`);
		writeFileSync(uploadedTemp, bytes);
		localVideo = uploadedTemp;
	}

	res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
	const send = (obj) => {
		if (res.writableEnded) return;
		try {
			res.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* socket gone */
		}
	};
	const children = new Set();
	const cleanupLocal = () => {
		if (uploadedTemp) rmSync(uploadedTemp, { force: true });
		if (cappedTemp) rmSync(cappedTemp, { force: true });
	};
	const fail = (message) => {
		send({ event: "error", message });
		res.end();
		cleanupLocal();
	};
	res.on("close", () => {
		if (!res.writableEnded) {
			console.error(`[bridge] client disconnected mid-extract; killing ${children.size} child group(s)`);
			for (const child of children) killGroup(child);
			children.clear();
			cleanupLocal();
		}
	});

	if (!host) {
		fail("extract-host-missing");
		return;
	}

	const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
	const remoteVideo = `${EXTRACT_TMP}/cclay-extract-${stamp}.mp4`;
	const remoteBvh = `${EXTRACT_TMP}/cclay-extract-${stamp}.bvh`;
	const cleanupRemote = () => {
		run("ssh", [...SSH_OPTS, host, `rm -f ${remoteVideo} ${remoteBvh} ${remoteBvh.replace(/\.bvh$/, "")}_*.bvh`], {
			children: new Set(),
			timeoutMs: 30000,
		}).catch(() => {});
	};

	// Both intake routes converge here, and only here is the rate SAM will see
	// certain: a bridge download was already normalized at the same ceiling
	// (so this probes ≤ the cap and re-encodes nothing — a second encode would
	// cost a generation of quality for no frames removed), while raw bytes
	// posted from the browser are whatever the user's camera shot. Frame rate
	// only: the clip keeps its length and its speed.
	mkdirSync(OUT_DIR, { recursive: true });
	// Claimed before the pass runs, not after it succeeds: a half-written file
	// from an ffmpeg that died mid-encode has to be swept too, and the rm is a
	// no-op when the pass never wrote anything.
	cappedTemp = join(OUT_DIR, `extract-capped-${stamp}.mp4`);
	try {
		const conformed = await conformToExtractFps(localVideo, cappedTemp, {
			children,
			onCap: (fps) => {
				send({ event: "status", message: "normalizing" });
				console.error(`[bridge] extract input capped to ${fps} fps (ceiling ${EXTRACT_FPS_MAX})`);
			},
			onProgress: (ratio) => send({ event: "progress", stage: "normalize", ratio }),
		});
		if (conformed.capped) {
			localVideo = conformed.path;
		} else if (conformed.fps === null) {
			console.error("[bridge] extract input rate unreadable; sending it to the box as it is");
		}
	} catch (err) {
		console.error(`[bridge] extract fps cap failed: ${err.message}`);
		// The same ffmpeg pass the download path runs, so the same named
		// reason — the UI already tells the user a conversion is what broke.
		fail("footage-normalize-failed");
		return;
	}

	try {
		send({ event: "status", message: "uploading" });
		await run("scp", [...SCP_OPTS, localVideo, `${host}:${remoteVideo}`], { children, timeoutMs: 300000 });
	} catch (err) {
		console.error(`[bridge] extract upload failed: ${err.message}`);
		fail("extract-upload-failed");
		return;
	}

	// SAM-3D-Body's OFFLINE multi-pass renderer — the live binary's causal
	// filter lags in phase and skips the repair passes, and measured 80 %
	// more wrist jitter on the same clip. The offline pipeline runs identity
	// tracking, gap fill, spike interpolation (--interpolate-jitter), then
	// ZERO-PHASE forward+backward smoothing at 6 Hz, and --foot-contact's
	// per-foot leg IK pins planted feet against skate. --max-persons 2
	// matches the scene: CozyClay holds two subjects, so the two most
	// confident performers come back (one BVH each) and a single-person clip
	// simply yields one file.
	send({ event: "status", message: "extracting" });
	try {
		const remoteCommand = EXTRACT_CMD
			? `${EXTRACT_CMD} ${remoteVideo} ${remoteBvh}`
			: `cd ${SAM_DIR} && ${SAM_ENV} ./build/offline_sam_3dbody_render ` +
				`--onnx-dir ./onnx --gguf ./onnx/pipeline.gguf --yolo ./onnx/yolo.onnx ` +
				`--from ${remoteVideo} --bvh ${remoteBvh} --bvh-template ./mixamo.bvh --max-persons 2 ` +
				`--smoothing zero-phase --bw-cutoff 6 --interpolate-jitter --foot-contact`;
		await run(
			"ssh",
			[...SSH_OPTS, host, remoteCommand],
			{
				children,
				timeoutMs: EXTRACT_TIMEOUT_MS,
				onLine: (line) => {
					// "[pass1]   120 / 514 frames  (eta ~3 s)" — pass1 is the
					// GPU inference and dominates the wall clock.
					const progress = /\[pass1\]\s+(\d+)\s*\/\s*(\d+) frames/.exec(line);
					if (progress && Number(progress[2]) > 0) {
						send({ event: "progress", stage: "extract", ratio: Math.min(1, Number(progress[1]) / Number(progress[2])) });
					}
				},
			}
		);
	} catch (err) {
		console.error(`[bridge] extract run failed: ${err.message}`);
		cleanupRemote();
		fail("extract-run-failed");
		return;
	}

	send({ event: "status", message: "converting" });
	mkdirSync(OUT_DIR, { recursive: true });
	// One BVH per tracked person. Person 0 must exist; person 1 is optional
	// (a single-person clip yields one file, and that is not an error).
	const motions = [];
	for (let person = 0; person < 2; person += 1) {
		const localBvh = join(OUT_DIR, `extract-${stamp}-p${person}.bvh`);
		try {
			await run("scp", [...SCP_OPTS, `${host}:${remoteBvh.replace(/\.bvh$/, "")}_${person}.bvh`, localBvh], {
				children,
				timeoutMs: 120000,
			});
		} catch (err) {
			if (person === 0) {
				console.error(`[bridge] extract fetch failed: ${err.message}`);
				cleanupRemote();
				fail("extract-no-person");
				return;
			}
			break;
		}
		try {
			motions.push(bvhToCskel27Motion(parseBvh(readFileSync(localBvh, "utf8"))));
		} catch (err) {
			console.error(`[bridge] extract convert failed (person ${person}): ${err.message}`);
			if (person === 0) {
				cleanupRemote();
				fail("extract-convert-failed");
				return;
			}
		} finally {
			rmSync(localBvh, { force: true });
		}
	}
	cleanupRemote();
	cleanupLocal();

	const takes = [];
	for (let person = 0; person < motions.length; person += 1) {
		const motion = motions[person];
		const id = person === 0 ? stamp : `${Date.now()}-${randomBytes(3).toString("hex")}`;
		const npzPath = join(OUT_DIR, `extract-${id}.npz`);
		try {
			// motion.personScale goes into the archive as `person_scale`: the
			// conversion divided this person's root travel by it, so the take
			// is only metrically right when the character is scaled by the same
			// number. Shipping it in the response alone would let a reload —
			// or any other path to the same npz — replay the stride at
			// canonical size. The response keeps the field for older clients.
			writeNpz(npzPath, motionArraysToNpzMembers(motion));
		} catch (err) {
			console.error(`[bridge] extract npz write failed (person ${person}): ${err.message}`);
			if (person === 0) {
				fail("extract-convert-failed");
				return;
			}
			continue;
		}
		registerMotion(id, npzPath);
		takes.push({
			motionUrl: `/ardy/motions/${id}`,
			frames: motion.frames,
			fps: motion.fps,
			personScale: motion.personScale,
			// person 1's placement RELATIVE to person 0, in the shared raw
			// camera space (real metres, X/Z on the floor plane).
			offsetX: person === 0 ? 0 : motion.rawRootStart[0] - motions[0].rawRootStart[0],
			offsetZ: person === 0 ? 0 : motion.rawRootStart[2] - motions[0].rawRootStart[2],
		});
	}
	send({
		event: "done",
		motionUrl: takes[0].motionUrl,
		frames: takes[0].frames,
		fps: takes[0].fps,
		personScale: takes[0].personScale,
		takes,
	});
	res.end();
}

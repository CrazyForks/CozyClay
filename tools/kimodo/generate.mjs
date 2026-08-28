/**
 * generate.mjs — drive Kimodo's own `kimodo_gen` CLI on the configured box and
 * bring the result back as cskel27 motion arrays.
 *
 * There is deliberately NO python of our own here. The ARDY path needs ~2000
 * lines of cclay_*.py because it drives ARDY's model API directly to place
 * constraints; Kimodo ships a CLI that already covers multi-prompt sequencing
 * (`--duration "3.0 2.0"`) and constraint files, so the whole backend is: run
 * the CLI, copy the npz back, convert somaskel77 → cskel27.
 *
 * PROMPT SEGMENTATION IS BY PERIOD. `kimodo_gen "A. B." --duration "3 2"`
 * splits the prompt on sentence boundaries and pairs them with the durations
 * in order, so a prompt containing its own period would silently shift every
 * later segment onto the wrong duration. joinPrompts refuses that instead.
 *
 * SCHEDULED INPAINTING lands here rather than in the bridge because this is the
 * only layer that knows the GENERATION clock. The bridge speaks the app's 24 fps
 * clip frames; the wrapper scripts speak seconds; genFps and the generated frame
 * count are resolved below, for buildRoot2dConstraints, and the preserve mask is
 * built from the same pair. Computing the frame count a second time upstream is
 * exactly how the two would drift, and a mask whose length disagrees with the
 * clip by one frame is a hard error on the box.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoot2dConstraints } from "./constraints.mjs";
import { buildFullBodyConstraints } from "./pose-constraints.mjs";
import { buildPreserveMask, preserveMaskStats } from "./preserve-mask.mjs";
import { readKimodoMotion } from "./read-npz.mjs";
import { soma77ToCskel27Motion } from "./soma77-to-cskel27.mjs";

const SSH_OPTS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "ServerAliveInterval=30",
	"-o", "ServerAliveCountMax=240",
];

export const DEFAULT_MODEL = "Kimodo-SOMA-RP-v1.1";

function run(argv, { timeoutMs = 3_600_000, onLine } = {}) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (onLine) for (const line of String(chunk).split("\n")) if (line.trim()) onLine(line);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (onLine) for (const line of String(chunk).split("\n")) if (line.trim()) onLine(line);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/**
 * Join segment prompts into the single period-separated string kimodo_gen
 * expects, and the matching space-separated duration string.
 */
export function joinPrompts(segments) {
	if (!Array.isArray(segments) || segments.length === 0) {
		throw new Error("joinPrompts: at least one segment is required");
	}
	const prompts = [];
	const durations = [];
	for (const [index, segment] of segments.entries()) {
		const text = String(segment.prompt ?? "").trim().replace(/\.+$/, "").trim();
		if (!text) throw new Error(`joinPrompts: segment ${index} has an empty prompt`);
		if (text.includes(".")) {
			throw new Error(
				`joinPrompts: segment ${index} contains a '.', which kimodo_gen reads as a segment break: ${JSON.stringify(segment.prompt)}`
			);
		}
		const duration = Number(segment.duration);
		if (!Number.isFinite(duration) || duration <= 0) {
			throw new Error(`joinPrompts: segment ${index} needs a positive duration, got ${segment.duration}`);
		}
		prompts.push(`${text}.`);
		durations.push(String(duration));
	}
	return { prompt: prompts.join(" "), duration: durations.join(" ") };
}

/**
 * How many frames kimodo_gen will ACTUALLY generate for a single-segment
 * `--duration` string.
 *
 * scripts/generate.py computes `int(duration_sec * fps)` — truncation, not
 * rounding — and then refuses a preserve mask whose `genFrames` differs from
 * that by even one ("Preserve mask ... declares genFrames=N but generation uses
 * M"). The constraint builders take the ROUNDED count below, which disagrees for
 * durations that land on a half frame (119 app frames at 24 fps = 4.9583 s =
 * 148.75 generation frames: 148 generated, 149 rounded). For a constraint index
 * that overshoot is harmless clamping; for a mask length it is a failed run. So
 * the mask, and only the mask, is sized with the CLI's own arithmetic — and the
 * rounded count is left exactly as it was, because changing it would move every
 * measured waypoint index.
 *
 * Both sides are IEEE-754 doubles, so Math.trunc reproduces Python's int()
 * including the cases where the product lands a hair below a whole number:
 * 196 app frames is 8.166666666666666 s and that times 30 is
 * 244.99999999999997 in Node AND in Python, so both take 244 while rounding
 * would ask the box for a 245-frame mask over a 244-frame clip.
 */
export function cliGenFrames(durationSeconds, genFps) {
	return Math.trunc(Number(durationSeconds) * Number(genFps));
}

/**
 * This run's scheduled-inpainting inputs, as tools/kimodo/runner.mjs passes
 * them. They arrive in the environment because the wrapper scripts between the
 * bridge and this module have a frozen argv shared with the ARDY wrappers, and
 * because every other Kimodo tunable already arrives the same way.
 */
function preserveFromEnv() {
	const raw = process.env.CCLAY_KIMODO_PRESERVE;
	if (!raw) return null;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`CCLAY_KIMODO_PRESERVE is not valid JSON: ${error.message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("CCLAY_KIMODO_PRESERVE must be a JSON object");
	}
	return parsed;
}

/** Largest and mean per-frame root displacement, the same shape of number
 * cclay_sequence_generate.py's continuity gate reports for ARDY, so the two
 * backends can be compared on one metric. */
export function continuityMetrics(motion) {
	const jumps = [];
	for (let frame = 1; frame < motion.frames; frame += 1) {
		const a = frame * 3;
		const b = (frame - 1) * 3;
		jumps.push(
			Math.hypot(
				motion.rootPos[a] - motion.rootPos[b],
				motion.rootPos[a + 1] - motion.rootPos[b + 1],
				motion.rootPos[a + 2] - motion.rootPos[b + 2]
			)
		);
	}
	if (jumps.length === 0) return { mean_jump_m: 0, max_jump_m: 0, max_jump_frame: 0 };
	let max = 0;
	let maxFrame = 0;
	let total = 0;
	for (const [index, jump] of jumps.entries()) {
		total += jump;
		if (jump > max) {
			max = jump;
			maxFrame = index;
		}
	}
	return { mean_jump_m: total / jumps.length, max_jump_m: max, max_jump_frame: maxFrame };
}

/**
 * Generate a multi-segment take with Kimodo on the box and return cskel27
 * motion arrays plus the continuity metrics for the result.
 */
export async function generateOnBox({
	segments,
	// CozyClay's authored plan-view path, in app clip frames and absolute world
	// metres. Translated to Kimodo's canonical constraint space by
	// buildRoot2dConstraints before it is shipped.
	waypoints,
	// Authored poses to pin, as [{frame, pose:{local_rot_mats, posed_joints}}]
	// with `frame` in the caller's app clip space.
	poses,
	appFps = Number(process.env.CCLAY_KIMODO_APP_FPS || 24),
	model = process.env.CCLAY_KIMODO_MODEL || DEFAULT_MODEL,
	transitionFrames = Number(process.env.CCLAY_KIMODO_TRANSITION_FRAMES || 5),
	diffusionSteps = Number(process.env.CCLAY_KIMODO_DIFFUSION_STEPS || 100),
	seed,
	host = process.env.CCLAY_KIMODO_HOST || "",
	repo = process.env.CCLAY_KIMODO_REPO || "$HOME/kimodo",
	// Kimodo wants ~17 GB of VRAM with the text encoder resident; on anything
	// smaller the encoder has to run on the CPU, which the upstream docs give
	// as the supported way to fit under 3 GB.
	textEncoderDevice = process.env.CCLAY_KIMODO_TEXT_ENCODER_DEVICE || "cpu",
	// Scheduled inpainting for THIS run (contracts C1/C3):
	// {basePath, sigmaS, sigmaE, editRanges, maskPath}. null = the CLI is invoked
	// exactly as before, which is the contract's regression invariant.
	preserve = preserveFromEnv(),
	// Where to keep Kimodo's own npz so a LATER run can preserve from this take.
	nativeOut = process.env.CCLAY_KIMODO_NATIVE_OUT || "",
	onLine,
} = {}) {
	if (!host) {
		throw new Error("generateOnBox: CCLAY_KIMODO_HOST is required");
	}
	const { prompt, duration } = joinPrompts(segments);

	// Kimodo's own generation rate decides the constraint frame indices, and the
	// clip length it will produce follows from the requested seconds. Both are
	// known before the call, so the path can be translated up front.
	const genFps = Number(process.env.CCLAY_KIMODO_GEN_FPS || 30);
	const requestedS = segments.reduce((total, segment) => total + Number(segment.duration), 0);
	const genFrames = Math.max(1, Math.round(requestedS * genFps));
	// Where each prompt segment begins, in GENERATION frames. Kimodo owns the
	// first `transitionFrames` of every segment after the first, so constraints
	// are kept clear of those windows.
	//
	// NOTE: segmentBoundaries (re-expressing constraint POSITIONS per segment) is
	// deliberately NOT passed. That was implemented and measured twice on the
	// box, and both times it tracked far worse than whole-clip absolute authoring
	// (waypoint error 0.11 m -> 3.6 m).
	//
	// What DOES ship for a multi-segment take is DENSIFICATION plus the
	// transition-window nudge. Kimodo crops constraints per segment with a
	// half-open [start, end), so a waypoint on a boundary belongs entirely to the
	// later segment and the earlier one never learns the path exists -- it ends
	// wherever it likes and the root teleports at the seam (measured 2.353 m).
	// The nudge ALONE traded that for arriving ~0.3 s late (waypoint miss 2.26 m);
	// densifying the authored polyline every `densifyStride` generation frames
	// gives the earlier segment intermediate targets, so it arrives at the
	// boundary already in place and the nudged pin merely confirms it. Both
	// behaviours are pinned by test/verify-kimodo-waypoints.mjs.
	const segmentStarts = [];
	{
		let cursorS = 0;
		for (const segment of segments.slice(0, -1)) {
			cursorS += Number(segment.duration);
			segmentStarts.push(Math.round(cursorS * genFps));
		}
	}
	const densifyStride = segmentStarts.length > 0 ? Number(process.env.CCLAY_KIMODO_DENSIFY_STRIDE || 10) : 0;
	const root2d = buildRoot2dConstraints(waypoints, {
		appFps,
		genFps,
		genFrames,
		segmentStarts,
		transitionFrames,
		densifyStride,
	});

	// Pinned poses ride in the SAME constraints file as the path: Kimodo's loader
	// reads a JSON array and dispatches per entry `type`, so one file can carry a
	// root2d path and fullbody keyframes together.
	const genScale = genFps / appFps;
	const poseEntries = (poses || []).map((entry) => ({
		...entry,
		frame: Math.min(genFrames - 1, Math.max(0, Math.round(entry.frame * genScale))),
	}));
	const fullBody = buildFullBodyConstraints(poseEntries, { genFrames });
	const constraints = [...root2d, ...fullBody];

	// --- scheduled inpainting plan (contracts C1/C3) --------------------------
	// Built here and nowhere else: see the file header. Everything that reaches a
	// remote shell string below (the two sigmas) is re-checked as an integer even
	// though the bridge already validated it, because this module is also driven
	// straight from the environment.
	let preservePlan = null;
	if (preserve) {
		if (segments.length > 1) {
			throw new Error(
				`scheduled inpainting v1 supports a single segment; this take has ${segments.length} prompt segments`
			);
		}
		if (typeof preserve.basePath !== "string" || !preserve.basePath) {
			throw new Error("preserve.basePath must be the path of a kimodo-native npz to reconstruct");
		}
		const sigma = (value, label) => {
			const number = Number(value);
			if (!Number.isInteger(number) || number < 0 || number > 1000) {
				throw new Error(`preserve.${label} must be an integer in 0..1000, got ${JSON.stringify(value)}`);
			}
			return number;
		};
		const sigmaS = sigma(preserve.sigmaS, "sigmaS");
		const sigmaE = sigma(preserve.sigmaE, "sigmaE");
		if (sigmaE > sigmaS) {
			throw new Error(`preserve.sigmaE (${sigmaE}) must be <= preserve.sigmaS (${sigmaS})`);
		}
		// The CLI's own frame count, not the rounded one the constraints use.
		const maskFrames = cliGenFrames(duration, genFps);
		if (!Number.isInteger(maskFrames) || maskFrames < 1) {
			throw new Error(`preserve: ${duration}s at ${genFps} fps generates ${maskFrames} frames, nothing to preserve`);
		}
		const mask = buildPreserveMask(preserve.editRanges || [], {
			appFps,
			genFps,
			genFrames: maskFrames,
			...(preserve.influenceRadius === undefined ? {} : { influenceRadius: preserve.influenceRadius }),
		});
		preservePlan = {
			basePath: preserve.basePath,
			maskPath: preserve.maskPath || null,
			sigmaS,
			sigmaE,
			mask,
			stats: preserveMaskStats(mask),
		};
	}

	const remoteStem = `/tmp/cclay-kimodo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	// `repo` may hold an unexpanded $HOME for the REMOTE shell to expand, so it
	// is quoted rather than escaped: unquoted it word-splits and `cd` sees two
	// arguments the moment the path contains a space.
	const localDir = await mkdtemp(join(tmpdir(), "cclay-kimodo-"));
	try {
		// Everything the CLI reads as a FILE has to exist on the BOX, so it is
		// written locally and copied up before generation rather than passed on
		// the command line. The remote directory is made once, on demand.
		let remoteDirReady = false;
		const ensureRemoteDir = async () => {
			if (remoteDirReady) return;
			const madeDir = await run(["ssh", ...SSH_OPTS, host, `mkdir -p ${remoteStem}`]);
			if (madeDir.code !== 0) {
				throw new Error(`could not create ${remoteStem} on ${host}: ${madeDir.stderr.trim()}`);
			}
			remoteDirReady = true;
		};
		// Local paths travel as scp ARGV entries, never inside a shell string;
		// the remote side of each pair is built from remoteStem, which this
		// process generated.
		const push = async (localPath, remotePath, label) => {
			await ensureRemoteDir();
			const pushed = await run(["scp", ...SSH_OPTS, localPath, `${host}:${remotePath}`]);
			if (pushed.code !== 0) {
				throw new Error(`could not copy ${label} to ${host} (exit ${pushed.code}): ${pushed.stderr.trim()}`);
			}
		};

		const remoteConstraints = `${remoteStem}/constraints.json`;
		if (constraints.length > 0) {
			const localConstraints = join(localDir, "constraints.json");
			await writeFile(localConstraints, JSON.stringify(constraints));
			await push(localConstraints, remoteConstraints, "constraints");
		}

		// The base motion and its mask ride up the same way. The mask is written
		// to the RUN directory when the caller named one, so a finished take keeps
		// the exact weights it was generated against next to it.
		const remoteBase = `${remoteStem}/base.npz`;
		const remoteMask = `${remoteStem}/preserve-mask.json`;
		if (preservePlan) {
			const localMask = preservePlan.maskPath || join(localDir, "preserve-mask.json");
			await writeFile(localMask, `${JSON.stringify(preservePlan.mask)}\n`, { mode: 0o600 });
			await push(preservePlan.basePath, remoteBase, "the preserved base motion");
			await push(localMask, remoteMask, "the preserve mask");
			const { freeFrames, rampFrames, preservedFrames } = preservePlan.stats;
			console.log(
				`kimodo-preserve: base=${preservePlan.basePath} sigma_s=${preservePlan.sigmaS} ` +
					`sigma_e=${preservePlan.sigmaE} mask=${preservePlan.mask.genFrames} generation frames ` +
					`(free ${freeFrames}, ramp ${rampFrames}, preserved ${preservedFrames})`
			);
		}

		// One `kimodo_gen` invocation: the env assignment and every flag are one
		// shell WORD list for that single command, so they join with spaces, while
		// `cd` is a separate command and must be chained with `&&`.
		const generateWords = [
			`TEXT_ENCODER_DEVICE=${textEncoderDevice}`,
			`.venv/bin/kimodo_gen ${JSON.stringify(prompt)}`,
			`--model ${model}`,
			`--duration ${JSON.stringify(duration)}`,
			`--num_transition_frames ${transitionFrames}`,
			`--diffusion_steps ${diffusionSteps}`,
			seed === undefined ? "" : `--seed ${Number(seed)}`,
			constraints.length > 0 ? `--constraints ${remoteConstraints}` : "",
			// Contract C2. All four are omitted together when nothing is being
			// preserved, which is what keeps a no-preserve run bit-identical to
			// the pre-inpainting code path for a given seed.
			preservePlan ? `--base_motion ${remoteBase}` : "",
			preservePlan ? `--preserve_start ${preservePlan.sigmaS}` : "",
			preservePlan ? `--preserve_end ${preservePlan.sigmaE}` : "",
			preservePlan ? `--preserve_mask ${remoteMask}` : "",
			`--output ${remoteStem}/take`,
		]
			.filter(Boolean)
			.join(" ");
		const remoteCmd = [`mkdir -p ${remoteStem}`, `cd "${repo}"`, generateWords].join(" && ");

		const generated = await run(["ssh", ...SSH_OPTS, host, remoteCmd], { onLine });
		if (generated.code !== 0) {
			throw new Error(
				`kimodo_gen on ${host} failed (exit ${generated.code}):\n${generated.stderr.split("\n").slice(-25).join("\n")}`
			);
		}

		const localNpz = join(localDir, "take.npz");
		const copied = await run(["scp", ...SSH_OPTS, `${host}:${remoteStem}/take.npz`, localNpz]);
		if (copied.code !== 0) {
			throw new Error(`scp of the generated npz failed (exit ${copied.code}): ${copied.stderr.trim()}`);
		}
		// A later run can only preserve THIS take if Kimodo's own npz survives:
		// --base_motion reads that format and the cskel27 file the caller writes
		// is a lossy conversion of it. Best-effort on purpose — a failed local
		// copy must not throw away a finished GPU take.
		if (nativeOut) {
			try {
				await copyFile(localNpz, nativeOut);
			} catch (error) {
				console.error(`kimodo-preserve: could not keep the base motion at ${nativeOut}: ${error.message}`);
			}
		}
		const loaded = readKimodoMotion(localNpz);
		const fps = loaded.fps ?? 30;
		const motion = soma77ToCskel27Motion({
			frames: loaded.frames,
			fps,
			globalRotMats: loaded.globalRotMats,
			posedJoints: loaded.posedJoints,
		});
		return {
			motion,
			metrics: continuityMetrics(motion),
			raw: { frames: loaded.frames, joints: loaded.joints, fps },
			constraints,
			// What this run preserved, and where its own base motion was kept for
			// the next one. Both null on a plain generation.
			preserve: preservePlan
				? {
					basePath: preservePlan.basePath,
					maskPath: preservePlan.maskPath,
					sigmaS: preservePlan.sigmaS,
					sigmaE: preservePlan.sigmaE,
					genFrames: preservePlan.mask.genFrames,
					...preservePlan.stats,
				}
				: null,
			nativeNpz: nativeOut || null,
			npzBytes: (await readFile(localNpz)).length,
		};
	} finally {
		await rm(localDir, { recursive: true, force: true });
		await run(["ssh", ...SSH_OPTS, host, `rm -rf ${remoteStem}`]);
	}
}

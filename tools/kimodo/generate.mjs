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
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoot2dConstraints } from "./constraints.mjs";
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
	appFps = Number(process.env.CCLAY_KIMODO_APP_FPS || 20),
	model = process.env.CCLAY_KIMODO_MODEL || DEFAULT_MODEL,
	transitionFrames = Number(process.env.CCLAY_KIMODO_TRANSITION_FRAMES || 5),
	diffusionSteps = Number(process.env.CCLAY_KIMODO_DIFFUSION_STEPS || 100),
	seed,
	host = process.env.CCLAY_KIMODO_HOST || process.env.CCLAY_ARDY_HOST || "",
	repo = process.env.CCLAY_KIMODO_REPO || "$HOME/kimodo",
	// Kimodo wants ~17 GB of VRAM with the text encoder resident; on anything
	// smaller the encoder has to run on the CPU, which the upstream docs give
	// as the supported way to fit under 3 GB.
	textEncoderDevice = process.env.CCLAY_KIMODO_TEXT_ENCODER_DEVICE || "cpu",
	onLine,
} = {}) {
	if (!host) {
		throw new Error("generateOnBox: CCLAY_KIMODO_HOST (or CCLAY_ARDY_HOST) is required");
	}
	const { prompt, duration } = joinPrompts(segments);

	// Kimodo's own generation rate decides the constraint frame indices, and the
	// clip length it will produce follows from the requested seconds. Both are
	// known before the call, so the path can be translated up front.
	const genFps = Number(process.env.CCLAY_KIMODO_GEN_FPS || 30);
	const requestedS = segments.reduce((total, segment) => total + Number(segment.duration), 0);
	const genFrames = Math.max(1, Math.round(requestedS * genFps));
	// NOTE: segmentBoundaries is deliberately NOT passed. Re-expressing
	// constraints per segment was implemented and measured twice on the box, and
	// both times it was far worse than whole-clip absolute authoring (waypoint
	// error 0.11 m -> 3.6 m). See tools/kimodo/constraints.mjs for the numbers.
	const constraints = buildRoot2dConstraints(waypoints, { appFps, genFps, genFrames });

	const remoteStem = `/tmp/cclay-kimodo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	// `repo` may hold an unexpanded $HOME for the REMOTE shell to expand, so it
	// is quoted rather than escaped: unquoted it word-splits and `cd` sees two
	// arguments the moment the path contains a space.
	const localDir = await mkdtemp(join(tmpdir(), "cclay-kimodo-"));
	try {
		// The constraints file has to exist on the BOX, so it is written locally
		// and copied up before generation rather than passed on the command line.
		const remoteConstraints = `${remoteStem}/constraints.json`;
		if (constraints.length > 0) {
			const localConstraints = join(localDir, "constraints.json");
			await writeFile(localConstraints, JSON.stringify(constraints));
			const madeDir = await run(["ssh", ...SSH_OPTS, host, `mkdir -p ${remoteStem}`]);
			if (madeDir.code !== 0) {
				throw new Error(`could not create ${remoteStem} on ${host}: ${madeDir.stderr.trim()}`);
			}
			const pushed = await run(["scp", ...SSH_OPTS, localConstraints, `${host}:${remoteConstraints}`]);
			if (pushed.code !== 0) {
				throw new Error(`could not copy constraints to ${host} (exit ${pushed.code}): ${pushed.stderr.trim()}`);
			}
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
			npzBytes: (await readFile(localNpz)).length,
		};
	} finally {
		await rm(localDir, { recursive: true, force: true });
		await run(["ssh", ...SSH_OPTS, host, `rm -rf ${remoteStem}`]);
	}
}

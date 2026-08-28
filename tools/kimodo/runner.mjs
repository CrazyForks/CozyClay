/**
 * runner.mjs — Kimodo backend for the generation bridge.
 *
 * Implements the same runner surface as tools/ardy/runners/{local,remote}.mjs
 * ({ mode, describe, probeHealth, listBases, singleCommand, sequenceCommand,
 * editCommand }) so bridge.mjs needs no backend-specific branch: it spawns the
 * returned command and greps its `done - <path> (<bytes>)` line exactly as it
 * does for ARDY.
 *
 * WHAT THIS BACKEND DOES NOT DO. Kimodo is wired here for text-to-motion
 * sequencing, root 2D paths, pinned poses and motion edit. Base clips remain
 * ARDY-specific machinery in this repo (a base clip is autoregressive history,
 * which Kimodo has no input for) and refuse by name instead of silently
 * producing a take that ignored them.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_SEQUENCE = join(HERE, "run-sequence-on-box.mjs");
const RUN_EDIT = join(HERE, "run-edit-on-box.mjs");

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

function run(argv, timeoutMs = 60_000) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

function unsupported(feature) {
	return () => {
		throw new Error(
			`the Kimodo backend does not implement ${feature}; run with CCLAY_MOTION_BACKEND=ardy for that path`
		);
	};
}

export function createKimodoRunner() {
	const HOST = process.env.CCLAY_KIMODO_HOST || "";
	const REPO = process.env.CCLAY_KIMODO_REPO || "$HOME/kimodo";
	const MODEL = process.env.CCLAY_KIMODO_MODEL || "Kimodo-SOMA-RP-v1.1";
	const TARGET_FPS = Number(process.env.CCLAY_KIMODO_TARGET_FPS || 24);

	if (!HOST) {
		throw new Error(
			"CCLAY_KIMODO_HOST is required for the Kimodo backend (for example: user@gpu-box)"
		);
	}

	async function probeHealth() {
		const remote = [
			`cd ${REPO}`,
			`DEV="$(.venv/bin/python -c 'import torch; print("cuda:0" if torch.cuda.is_available() else "cpu")')"`,
			`printf 'device=%s\\n' "$DEV"`,
		].join(" && ");
		const { code, stdout, stderr } = await run(["ssh", ...SSH_OPTS, HOST, remote]);
		if (code !== 0) {
			throw new Error(`ssh probe on ${HOST} failed (exit ${code}): ${stderr.trim().split("\n").pop()}`);
		}
		const device = /^device=(.*)$/m.exec(stdout)?.[1] ?? "unknown";
		// Kimodo needs no separate encoder sidecar: the text encoder loads in
		// the generation process (on the CPU by default here), so health has
		// nothing to report for it and says so rather than faking a port.
		return { ok: true, host: HOST, encoder: "in-process", device };
	}

	// Kimodo generates from text and constraints only — it takes no base clip,
	// so there is nothing to list. An empty listing is a valid answer, not a
	// failure, and the bridge already tolerates it.
	async function listBases() {
		return [];
	}

	function sequenceCommand({ segments, waypoints, poseFroms, seed, output }) {
		const args = [RUN_SEQUENCE];
		for (const segment of segments) {
			args.push("--segment", segment.prompt, String(segment.durationS));
		}
		// Root waypoints become a Kimodo root2d constraint downstream; the same
		// 4-token shape the ARDY wrapper takes, so the bridge passes them through
		// unchanged regardless of backend.
		for (const waypoint of waypoints || []) {
			args.push(
				"--root-2d",
				String(waypoint.frame),
				String(waypoint.x),
				String(waypoint.z),
				waypoint.heading === null || waypoint.heading === undefined ? "none" : String(waypoint.heading)
			);
		}
		for (const entry of poseFroms || []) {
			args.push("--pose", entry.npz, String(entry.dstFrame));
		}
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		args.push("--target-fps", String(TARGET_FPS), "--output", output);
		return {
			command: process.execPath,
			args,
			env: {
				...process.env,
				CCLAY_KIMODO_HOST: HOST,
				CCLAY_KIMODO_REPO: REPO,
				CCLAY_KIMODO_MODEL: MODEL,
			},
			doneRe: /^run-kimodo-sequence: done - (.+) \((\d+) bytes\)$/,
			label: "run-kimodo-sequence",
		};
	}

	// A single prompt is just a one-segment sequence, but only when the request
	// carries none of the ARDY-only conditioning.
	function singleCommand({ prompt, durationS, seed, output, basePath, poseFroms, waypoints }) {
		if (basePath) throw new Error("the Kimodo backend does not implement base clips");
		return sequenceCommand({
			segments: [{ prompt, durationS }],
			waypoints,
			// Pinned poses become Kimodo `fullbody` constraints downstream. The
			// bridge hands them over as npz paths plus the clip frame to pin them
			// at; src-frame is an ARDY concept (which frame of a multi-frame npz to
			// read) and a cclay pose npz always holds exactly one.
			poseFroms,
			seed,
			output,
		});
	}

	// Regenerating a span is a whole-clip generation pinned to the source take on
	// both sides of the edit, then spliced back — Kimodo has no history input, so
	// the surrounding motion is expressed as constraints instead.
	function editCommand({ source, manifest, prompt, contextBefore, contextAfter, seed, output }) {
		const args = [
			RUN_EDIT,
			"--source", source,
			"--manifest", manifest,
			"--prompt", prompt,
			"--context-before", String(contextBefore ?? 0),
			"--context-after", String(contextAfter ?? 0),
			"--target-fps", String(TARGET_FPS),
		];
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		args.push("--output", output);
		return {
			command: process.execPath,
			args,
			env: {
				...process.env,
				CCLAY_KIMODO_HOST: HOST,
				CCLAY_KIMODO_REPO: REPO,
				CCLAY_KIMODO_MODEL: MODEL,
			},
			doneRe: /^run-kimodo-edit: done - (.+) \((\d+) bytes\)$/,
			label: "run-kimodo-edit",
		};
	}

	return {
		mode: "kimodo",
		describe: () => `box ${HOST} (repo ${REPO}, model ${MODEL}, retimed to ${TARGET_FPS} fps)`,
		probeHealth,
		listBases,
		singleCommand,
		sequenceCommand,
		editCommand,
	};
}

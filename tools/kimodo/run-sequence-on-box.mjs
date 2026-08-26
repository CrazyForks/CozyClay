#!/usr/bin/env node
/**
 * run-sequence-on-box.mjs — the Kimodo twin of tools/ardy/run-sequence-on-box.sh.
 *
 * Generates a multi-segment take with Kimodo on the configured box and writes a
 * cclay motion npz that is byte-compatible with the ARDY path, so the bridge and
 * the app consume it without knowing which backend produced it.
 *
 * FRAME RATE. Kimodo-SOMA generates at 30 fps and ARDY-Core at 20, and the app
 * converts timeline frames with a hardcoded ARDY_FPS of 20 (src/App.jsx). A raw
 * 30 fps take would therefore be read as 1.5x its real duration, so the take is
 * retimed onto the target rate before it is written. retimeMotion re-grows
 * positions with FK, so bone lengths survive the resample exactly.
 *
 * The final stdout line matches the shape bridge.mjs greps for:
 *   run-kimodo-sequence: done - <path> (<bytes>)
 */

import { statSync } from "node:fs";
import { writeNpz, motionArraysToNpzMembers } from "../ardy/npz.mjs";
import { retimeMotion } from "../../src/ardy/retime.js";
import { generateOnBox, continuityMetrics } from "./generate.mjs";

const TARGET_FPS_DEFAULT = 20;

function usage(message) {
	if (message) console.error(`run-kimodo-sequence: ${message}`);
	console.error(
		'usage: run-sequence-on-box.mjs --segment "<prompt>" <seconds> [--segment ...] ' +
			"[--root-2d <frame> <x> <z> <heading|none> ...] [--seed N] [--target-fps N] --output <path>"
	);
	process.exit(2);
}

function parseArgs(argv) {
	const segments = [];
	const waypoints = [];
	let seed;
	let output;
	let targetFps = TARGET_FPS_DEFAULT;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--root-2d") {
			// Same 4-token shape as tools/ardy/run-sequence-on-box.sh so a caller
			// can swap backends without rewriting the path arguments.
			const frame = Number(argv[index + 1]);
			const x = Number(argv[index + 2]);
			const z = Number(argv[index + 3]);
			const rawHeading = argv[index + 4];
			if (!Number.isInteger(frame) || !Number.isFinite(x) || !Number.isFinite(z) || rawHeading === undefined) {
				usage("--root-2d needs FRAME X Z HEADING|none");
			}
			const heading = rawHeading === "none" ? null : Number(rawHeading);
			if (heading !== null && !Number.isFinite(heading)) usage("--root-2d heading must be a number or 'none'");
			waypoints.push({ frame, x, z, heading });
			index += 4;
		} else if (flag === "--segment") {
			const prompt = argv[index + 1];
			const seconds = Number(argv[index + 2]);
			if (prompt === undefined || !Number.isFinite(seconds)) usage("--segment needs PROMPT SECONDS");
			segments.push({ prompt, duration: seconds });
			index += 2;
		} else if (flag === "--seed") {
			seed = Number(argv[index += 1]);
			if (!Number.isInteger(seed)) usage("--seed must be an integer");
		} else if (flag === "--target-fps") {
			targetFps = Number(argv[index += 1]);
			if (!Number.isInteger(targetFps) || targetFps < 1) usage("--target-fps must be a positive integer");
		} else if (flag === "--output") {
			output = argv[index += 1];
		} else if (flag === "--cpu") {
			// accepted for parity with the ARDY wrapper; Kimodo picks its own
			// device and already runs the text encoder on the CPU.
		} else {
			usage(`unknown argument ${flag}`);
		}
	}
	if (segments.length === 0) usage("at least one --segment is required");
	if (!output) usage("--output is required");
	return { segments, waypoints, seed, output, targetFps };
}

const { segments, waypoints, seed, output, targetFps } = parseArgs(process.argv.slice(2));

try {
	const requestedS = segments.reduce((total, segment) => total + segment.duration, 0);
	const { motion, raw, constraints } = await generateOnBox({
		segments,
		waypoints,
		// The authored path is in the SAME frame space this script retimes to,
		// which is the app's clock — so target-fps is also the waypoint clock.
		appFps: targetFps,
		seed,
		onLine: (line) => console.log(line),
	});

	// Kimodo's npz carries no fps member, so the real rate is recovered from the
	// frame count against the duration that was actually asked for.
	const sourceFps = Math.round(raw.frames / requestedS);
	if (!Number.isFinite(sourceFps) || sourceFps < 1) {
		throw new Error(`could not infer source fps from ${raw.frames} frames over ${requestedS}s`);
	}
	const atSourceRate = { ...motion, fps: sourceFps };
	const retimed = retimeMotion(atSourceRate, targetFps);

	const members = motionArraysToNpzMembers({
		frames: retimed.frames,
		fps: retimed.fps,
		rotMats: retimed.rotMats,
		rootPos: retimed.rootPos,
		posedJoints: retimed.posedJoints,
	});
	writeNpz(output, members);

	const boundaries = [];
	let cursor = 0;
	for (const segment of segments.slice(0, -1)) {
		cursor += segment.duration;
		boundaries.push(Math.round(cursor * retimed.fps));
	}
	console.log(
		JSON.stringify({
			frames: retimed.frames,
			fps: retimed.fps,
			source_fps: sourceFps,
			model: process.env.CCLAY_KIMODO_MODEL || "Kimodo-SOMA-RP-v1.1",
			segments: segments.map((segment) => ({ prompt: segment.prompt, requested_s: segment.duration })),
			boundaries,
			waypoints: waypoints.length,
			constraints: constraints.length,
			continuity: continuityMetrics(retimed),
		})
	);
	const { size } = statSync(output);
	console.log(`run-kimodo-sequence: done - ${output} (${size} bytes)`);
} catch (error) {
	console.error(`run-kimodo-sequence: ${error.message}`);
	process.exit(1);
}

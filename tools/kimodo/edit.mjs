/**
 * edit.mjs — regenerate one span of an existing take with Kimodo.
 *
 * ARDY does this by feeding the surrounding motion in as autoregressive
 * history. Kimodo has no history input, so the same intent is expressed with the
 * constraint protocol it does have: the span is regenerated as part of a whole
 * clip that is PINNED to the original take on both sides of the edit, and only
 * the edited span is kept.
 *
 *   frames <  start   anchored to the source  -> the take rejoins what came before
 *   frames in [start,end)  free, except the author's own IK keyframes
 *   frames >= end     anchored to the source  -> the take rejoins what comes after
 *
 * Anchors are ordinary `fullbody` constraints built by pose-constraints.mjs, the
 * same ones pose pinning uses and which measured 0.00 deg tracking, so the joins
 * are as tight as a pinned pose rather than a blend.
 *
 * The result is spliced back with replaceMotionSegment: everything outside the
 * edited range is copied from the source byte for byte, because the author
 * changed one span and expects the rest of their take untouched.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { buildFullBodyConstraints } from "./pose-constraints.mjs";
import { readNpz } from "./read-npz.mjs";

/** How many source frames to pin on each side when the caller asks for context. */
const ANCHOR_SAMPLES = 3;

/**
 * Read the bridge's edit-manifest.json into a resolved plan.
 * Paths inside it are relative to the manifest, which is what the bridge writes.
 */
export function parseEditManifest(manifestPath) {
	const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
	const base = dirname(resolve(manifestPath));

	if (!Number.isInteger(raw.start_frame) || raw.start_frame < 0) {
		throw new Error(`parseEditManifest: start_frame must be a non-negative integer, got ${JSON.stringify(raw.start_frame)}`);
	}
	if (!Number.isInteger(raw.end_frame)) {
		throw new Error(`parseEditManifest: end_frame must be an integer, got ${JSON.stringify(raw.end_frame)}`);
	}
	if (raw.end_frame <= raw.start_frame) {
		throw new Error(`parseEditManifest: range ${raw.start_frame}..${raw.end_frame} is empty or inverted`);
	}
	if (!Array.isArray(raw.edits) || raw.edits.length === 0) {
		throw new Error("parseEditManifest: edits must be a non-empty array");
	}

	let previous = -1;
	const edits = raw.edits.map((entry, index) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`parseEditManifest: edits[${index}] must be an object`);
		}
		if (!Number.isInteger(entry.frame)) {
			throw new Error(`parseEditManifest: edits[${index}].frame must be an integer`);
		}
		if (entry.frame < raw.start_frame || entry.frame >= raw.end_frame) {
			throw new Error(
				`parseEditManifest: edits[${index}].frame ${entry.frame} is outside the edited range ${raw.start_frame}..${raw.end_frame}`
			);
		}
		if (entry.frame <= previous) {
			throw new Error(
				`parseEditManifest: edit frames must be strictly ascending; edits[${index}].frame ${entry.frame} follows ${previous}`
			);
		}
		previous = entry.frame;
		if (typeof entry.pose_path !== "string" || !entry.pose_path) {
			throw new Error(`parseEditManifest: edits[${index}].pose_path is required`);
		}
		return {
			frame: entry.frame,
			tracks: Array.isArray(entry.tracks) ? entry.tracks : [],
			posePath: isAbsolute(entry.pose_path) ? entry.pose_path : resolve(base, entry.pose_path),
		};
	});

	return { startFrame: raw.start_frame, endFrame: raw.end_frame, edits };
}

/** One frame of a cclay motion npz as the {local_rot_mats, posed_joints} a pose wants. */
function frameAsPose(members, frame) {
	const rot = members.local_rot_mats;
	const pos = members.posed_joints;
	const joints = rot.shape.at(-3);
	if (joints !== 27) throw new Error(`planEditConstraints: source motion has ${joints} joints, expected 27`);
	const local_rot_mats = [];
	const posed_joints = [];
	for (let j = 0; j < 27; j += 1) {
		const b = (frame * 27 + j) * 9;
		local_rot_mats.push([
			[rot.data[b], rot.data[b + 1], rot.data[b + 2]],
			[rot.data[b + 3], rot.data[b + 4], rot.data[b + 5]],
			[rot.data[b + 6], rot.data[b + 7], rot.data[b + 8]],
		]);
		const p = (frame * 27 + j) * 3;
		posed_joints.push([pos.data[p], pos.data[p + 1], pos.data[p + 2]]);
	}
	return { local_rot_mats, posed_joints };
}

/** A cclay pose npz (single keyframe) as the same shape. */
function poseFromNpz(path) {
	const members = readNpz(path);
	for (const key of ["local_rot_mats", "posed_joints"]) {
		if (!members[key]) throw new Error(`planEditConstraints: pose npz ${path} is missing ${key}`);
	}
	return frameAsPose(members, 0);
}

/**
 * Build the constraint set for an edit: the author's keyframes inside the range,
 * plus source anchors on both sides so the regenerated span rejoins the take.
 *
 * `poses` are the same pins in APP frame space, which is what generateOnBox
 * takes; `constraints` is the already-scaled Kimodo form, used by the tests and
 * for reporting how many frames ended up pinned.
 *
 * @returns {{constraints:Array<object>, poses:Array<object>, startFrame:number, endFrame:number, sourceFrames:number, fps:number}}
 */
export function planEditConstraints({ sourcePath, manifestPath, contextBefore = 0, contextAfter = 0, genFps = 30, appFps = 20 }) {
	const manifest = parseEditManifest(manifestPath);
	const source = readNpz(sourcePath);
	if (!source.local_rot_mats || !source.posed_joints) {
		throw new Error(`planEditConstraints: ${sourcePath} is not a cclay motion npz`);
	}
	const sourceFrames = source.local_rot_mats.shape[0];
	const fps = source.fps ? Math.round(source.fps.data[0]) : appFps;
	if (manifest.endFrame > sourceFrames) {
		throw new Error(
			`planEditConstraints: edited range ends at ${manifest.endFrame} but the source has ${sourceFrames} frames`
		);
	}

	// Anchor frames: the last few source frames before the range and the first
	// few at/after it. Sampling several rather than one gives the model a
	// direction to rejoin on, not just a point.
	const anchors = [];
	if (contextBefore > 0) {
		const from = Math.max(0, manifest.startFrame - contextBefore);
		const step = Math.max(1, Math.floor((manifest.startFrame - from) / ANCHOR_SAMPLES) || 1);
		for (let f = from; f < manifest.startFrame; f += step) anchors.push(f);
	}
	if (contextAfter > 0) {
		const to = Math.min(sourceFrames - 1, manifest.endFrame + contextAfter - 1);
		const step = Math.max(1, Math.floor((to - manifest.endFrame) / ANCHOR_SAMPLES) || 1);
		for (let f = manifest.endFrame; f <= to; f += step) anchors.push(f);
	}

	// Author keyframes win over an anchor on the same frame: the whole point of
	// the edit is that those frames changed.
	const byFrame = new Map();
	for (const frame of anchors) {
		if (frame < 0 || frame >= sourceFrames) continue;
		byFrame.set(frame, { frame, pose: frameAsPose(source, frame) });
	}
	for (const edit of manifest.edits) {
		byFrame.set(edit.frame, { frame: edit.frame, pose: poseFromNpz(edit.posePath) });
	}
	const poses = [...byFrame.values()].sort((a, b) => a.frame - b.frame);

	// The clip Kimodo generates runs at genFps; the manifest speaks in app frames.
	const scale = genFps / appFps;
	const genFrames = Math.max(1, Math.round(sourceFrames * scale));
	const scaled = [];
	const seen = new Set();
	for (const entry of poses) {
		const genFrame = Math.min(genFrames - 1, Math.max(0, Math.round(entry.frame * scale)));
		if (seen.has(genFrame)) continue;
		seen.add(genFrame);
		scaled.push({ frame: genFrame, pose: entry.pose });
	}

	return {
		constraints: buildFullBodyConstraints(scaled, { genFrames }),
		poses,
		startFrame: manifest.startFrame,
		endFrame: manifest.endFrame,
		sourceFrames,
		fps,
		genFrames,
	};
}

/** Byte size of a written artifact, for the bridge's done line. */
export function artifactSize(path) {
	return statSync(path).size;
}

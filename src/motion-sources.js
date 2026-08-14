/**
 * The neutral motion registry — the only seam through which the app names a
 * clip slot. Two fixed slots today ("A", "B"); Phase 6 widens the shape to
 * an N-entry `motions: Map`, so every accessor here is subject-keyed and
 * callers never reach into slot-shaped state. App.jsx must never name the
 * feature: it only reads these keyed helpers.
 */
import { resolveIkRig } from "./ardy/ik.js";

/** The two fixed slots today; the future `motions: Map` iterates these. */
export const SUBJECTS = ["A", "B"];

/** Clip lookup by subject; null when the slot is empty. Map-shaped registries
 * (the Phase-6 `motions: Map`) route through the same accessor. */
export function motionFor(subject, motions) {
	if (motions instanceof Map) return motions.get(subject) ?? null;
	return motions[subject] ?? null;
}

/** True when any slot holds a clip — a take is loaded, so subject dragging
 * is disabled everywhere. */
export function anyLoaded(motions) {
	return SUBJECTS.some((subject) => motionFor(subject, motions) != null);
}

/** One canonical per-subject scene transform (plan 7.1): with a clip loaded
 * the subject stands at the clip anchor with the clip yaw, otherwise at the
 * authored state. Every consumer — Character, ShotRig, PlanBoard,
 * SubjectBox, follow yaw, deriveShot, persistence — reads the derived
 * values, never the raw states, so a clip cannot leave the camera, plan
 * pucks and inspector disagreeing about where a subject is (the pre-existing
 * A-side divergence this seam repairs). */
export function effectiveTransform(subject, { base, clip }) {
	if (clip) return { x: clip.anchorX, z: clip.anchorZ, rot: clip.rotationDeg };
	return base;
}

/** All subjects' canonical transforms at once, so the app derives them ONCE. */
export function effectiveChars(chars, motions) {
	const out = {};
	for (const subject of SUBJECTS) {
		out[subject] = effectiveTransform(subject, { base: chars[subject], clip: motionFor(subject, motions) });
	}
	return out;
}

/** Per-subject IK (plan 7.4): chains resolve from the SELECTED subject's
 * rig, replacing the A-only resolveIkRig(rigA). */
export function resolveSubjectIk(subject, rigs) {
	return resolveIkRig(rigs[subject] ?? null);
}

/** In/out trim (plan 7.4): the trimmed range stays inside the clip's frame
 * bounds, 0..frames-1, no matter what the UI asks for. */
export function clampTrim(trim, clip) {
	const last = clip.frames - 1;
	const start = Math.max(0, Math.min(trim.start, last));
	const end = Math.max(start, Math.min(trim.end, last));
	return { start, end };
}

/** The clip frame a playhead frame samples: clamped to the trimmed range, so
 * frames outside the trim hold the edge pose instead of leaving the clip. */
export function playbackFrame(frame, trim) {
	if (!trim) return frame;
	return Math.max(trim.start, Math.min(frame, trim.end));
}

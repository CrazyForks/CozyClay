/**
 * The neutral motion registry — the only seam through which the app names a
 * clip slot. Two fixed slots today ("A", "B"); Phase 6 widens the shape to
 * an N-entry `motions: Map`, so every accessor here is subject-keyed and
 * callers never reach into slot-shaped state. App.jsx must never name the
 * feature: it only reads these keyed helpers.
 *
 * The registry also owns the clip-state machinery the app seam needs and the
 * node tests must drive: the take wiring (capture/apply/restore over the app
 * fields a take owns), the ONE undo coordinator both stores register with,
 * the empty-take marker a clear pushes, per-subject IK state keying, and
 * clip persistence. All of it is subject-keyed and node-importable, so the
 * seam's behavioural tests run the same code the app runs.
 */
import { resolveIkRig } from "./ardy/ik.js";
import { createUndoCoordinator } from "./undo-coordinator.js";
import { createPerformanceTakeStore } from "./performance-take.js";
import { createSceneHistoryStore } from "./scene-history.js";

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

/** Per-subject IK working state (plan 7.4): each subject keeps its own key
 * set, so switching subjects can never apply A's corrections to B. */
export function ikStateFor(subject, states) {
	if (states instanceof Map) return states.get(subject) ?? null;
	return states[subject] ?? null;
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

/** The take wiring (plan 7.2): capture/apply/restore over the fields a take
 * owns — both clips, both trims, Subject 2 visibility and the shared
 * timeline. The store calls these through the coordinator; read() must
 * return the live field values (the app mirrors them in a ref because the
 * store is built once) and write() applies a patch. A landing applies both
 * clips in one batch and pushes exactly ONE entry, so one Ctrl+Z reverts
 * the whole operation. */
export function createTakeAdapters({ read, write }) {
	const clipFrom = (subject, clip, fields) => ({
		...clip.decoded,
		url: clip.artifactPath,
		anchorX: subject === "A" ? fields.charA.x : fields.charB.x,
		anchorZ: subject === "A" ? fields.charA.z : fields.charB.z,
		anchorFrame: 0,
		rotationDeg: clip.rotationDeg,
	});
	return {
		capture() {
			return read();
		},
		apply(value) {
			// The empty-take marker (clearTakePayload): both lanes empty in
			// one entry; the timeline the clear resets to rides on the marker.
			if (value.clear === true) {
				write({ motion: null, motionB: null, trimA: null, trimB: null, ...(value.timeline ?? {}) });
				return;
			}
			// The door decodes before landing, so a take without decoded
			// clips cannot half-apply — refuse rather than land empties.
			if (!value.a?.decoded || !value.b?.decoded) throw new Error("clip-not-decoded");
			const fields = read();
			const motion = clipFrom("A", value.a, fields);
			const motionB = clipFrom("B", value.b, fields);
			write({
				motion,
				motionB,
				trimA: { start: 0, end: motion.frames - 1 },
				trimB: { start: 0, end: motionB.frames - 1 },
				showB: true,
				tlFrameCount: motion.frames,
				tlFps: motion.fps,
				tlFrame: 0,
				tlPlaying: false,
			});
		},
		restore(snapshot) {
			write(snapshot);
		},
	};
}

/** The app's ONE undo authority (plan 7.3): the scene store and the take
 * store register with a single coordinator, so Ctrl/Cmd+Z lands on the most
 * recent entry whichever store owns it, and a new entry invalidates every
 * other store's redo branch atomically. */
export function createUndoStores({ sceneObjects, onObjects, read, write }) {
	const coordinator = createUndoCoordinator();
	const scene = createSceneHistoryStore(sceneObjects, { onObjects, coordinator });
	const take = createPerformanceTakeStore(createTakeAdapters({ read, write }), { coordinator });
	return { coordinator, scene, take };
}

/** The empty-take marker a clear pushes (plan 7.4). The take store's clear
 * op (createPerformanceTakeStore.clear) reuses the landing validator, which
 * demands a structurally complete §5 payload, so the clear IS that payload
 * plus `clear: true` and the current timeline to reset to — the wiring
 * interprets the marker and never decodes the placeholder clips. The
 * requestId is inert plumbing: the clear op bypasses the landing replay
 * table entirely, so no external id can collide with an internal one, and
 * the fresh id per clear merely satisfies the validator's non-empty-string
 * rule. */
export function clearTakePayload(requestId, timeline = {}) {
	const clip = {
		rotationDeg: 0,
		fps: 20,
		frames: 1,
		artifactPath: "/ingest/artifacts/00000000000000000000000000000000/empty",
		provenance: {
			command: "",
			sourceUrl: "",
			licence: "",
			sourceSha256: "",
			trimStartS: 0,
			trimEndS: 0,
			gvhmrCommit: "",
			weightsSha256: "",
			annotationPath: "/ingest/artifacts/00000000000000000000000000000000/empty",
		},
	};
	return { requestId, clear: true, timeline, a: clip, b: clip };
}

/** Clip persistence (plan 7.4): both clips and their trims serialize under
 * the subject keys so a reload restores exactly what was on the lanes.
 * Typed arrays become plain arrays; parse failures return null so a corrupt
 * entry degrades to an empty session instead of crashing. */
export function serializeClipState(motions, trims) {
	const slot = (subject) => {
		const clip = motionFor(subject, motions);
		if (!clip) return { clip: null, trim: trims[subject] ?? null };
		return {
			clip: {
				frames: clip.frames,
				fps: clip.fps,
				anchorX: clip.anchorX,
				anchorZ: clip.anchorZ,
				anchorFrame: clip.anchorFrame,
				rotationDeg: clip.rotationDeg,
				url: clip.url,
				rotMats: Array.from(clip.rotMats),
				rootPos: Array.from(clip.rootPos),
				posedJoints: Array.from(clip.posedJoints),
			},
			trim: trims[subject] ?? null,
		};
	};
	return JSON.stringify({ A: slot("A"), B: slot("B") });
}

export function deserializeClipState(text) {
	try {
		const parsed = JSON.parse(text);
		const slot = (subject) => {
			const entry = parsed?.[subject];
			if (!entry || !entry.clip) return { clip: null, trim: entry?.trim ?? null };
			const c = entry.clip;
			return {
				clip: {
					frames: c.frames,
					fps: c.fps,
					anchorX: c.anchorX,
					anchorZ: c.anchorZ,
					anchorFrame: c.anchorFrame,
					rotationDeg: c.rotationDeg,
					url: c.url,
					rotMats: Float32Array.from(c.rotMats),
					rootPos: Float32Array.from(c.rootPos),
					posedJoints: Float32Array.from(c.posedJoints),
				},
				trim: entry.trim ?? null,
			};
		};
		return { A: slot("A"), B: slot("B") };
	} catch {
		return null;
	}
}

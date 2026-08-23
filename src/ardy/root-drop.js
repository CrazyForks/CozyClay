import { sliceMotion } from "./trim.js";

// A vertical drop authored ONTO a take. ARDY generates motion on flat
// ground — nothing in a generated clip can carry a body off a 14 m roof.
// The plunge is previs staging, not motion synthesis, so it is applied to
// the decoded clip as a rigid vertical offset: every joint of a frame moves
// down by the same amount, and the amount follows a gravity curve.
//
// Seconds, not frames: a take crosses two clocks on its way in (ARDY's
// 20 fps, the 24 fps production timeline), and a boundary in seconds means
// the caller never has to know which side of the retime it is speaking to.

/** Validated {fromS, toS, meters} or null — malformed input is no drop. */
export function normalizeRootDrop(drop) {
	if (!drop || typeof drop !== "object" || Array.isArray(drop)) return null;
	const fromS = Number(drop.fromS ?? drop.from_s);
	const toS = Number(drop.toS ?? drop.to_s);
	const meters = Number(drop.meters);
	if (!Number.isFinite(fromS) || !Number.isFinite(toS) || !Number.isFinite(meters)) return null;
	if (fromS < 0 || toS <= fromS || meters <= 0) return null;
	return { fromS, toS, meters };
}

/** Point-in-footprint on the floor plane, honouring the support's yaw. */
function insideSupport(support, px, pz) {
	const yaw = ((support.rotDeg ?? 0) * Math.PI) / 180;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	const dx = px - support.x;
	const dz = pz - support.z;
	const lx = cos * dx - sin * dz;
	const lz = sin * dx + cos * dz;
	return Math.abs(lx) <= support.width / 2 && Math.abs(lz) <= support.depth / 2;
}

/**
 * Stage a fall the author did not have to ask for: a character standing on a
 * raised support (a roof — place_character's y) whose take walks past the
 * support's edge should drop, because ARDY only generates flat-ground motion.
 *
 * `subject` is { x, z, y, rotationDeg } — the character's blocking, with the
 * take's root rotation. `supports` are world-space tops: { x, z, rotDeg,
 * topY, width, depth }. The walk is sampled with the same root convention
 * playback uses (frame-zero anchored, yaw-rotated into scene space).
 *
 * Returns a { fromS, toS, meters } drop, or null when the character is on
 * the ground, never stood on a support, or never leaves it — null means
 * "stage nothing", so this is safe to leave on the load path.
 */
export function autoRoofDrop(motion, subject, supports, { gravity = 9.81, topTolerance = 0.3, fallTimeScale = 1.15 } = {}) {
	if (!motion || !Number.isFinite(motion.fps) || motion.fps <= 0 || !motion.rootPos) return null;
	const frames = motion.frames;
	if (!Number.isFinite(frames) || frames < 2) return null;
	const y = Number(subject?.y) || 0;
	if (y <= 0.05 || !Array.isArray(supports) || supports.length === 0) return null;

	const radians = ((Number.isFinite(subject.rotationDeg) ? subject.rotationDeg : 0) * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const worldAt = (frame) => {
		const dx = motion.rootPos[frame * 3] - motion.rootPos[0];
		const dz = motion.rootPos[frame * 3 + 2] - motion.rootPos[2];
		return {
			x: subject.x + dx * cos + dz * sin,
			z: subject.z + (-dx * sin + dz * cos),
		};
	};

	const start = worldAt(0);
	const carriers = supports.filter((support) =>
		support.width > 0 && support.depth > 0 &&
		Math.abs(support.topY - y) <= topTolerance &&
		insideSupport(support, start.x, start.z));
	if (carriers.length === 0) return null;

	for (let frame = 1; frame < frames; frame += 1) {
		const point = worldAt(frame);
		if (carriers.some((support) => insideSupport(support, point.x, point.z))) continue;
		// Land on the tallest lower support under the exit point, else the street.
		const landing = supports.reduce((top, support) =>
			support.topY < y - topTolerance && support.topY > top && insideSupport(support, point.x, point.z)
				? support.topY
				: top, 0);
		const meters = y - landing;
		if (meters <= 0) return null;
		const fromS = frame / motion.fps;
		// Near-real gravity: a lightly stretched clock keeps weight without
		// drifting into moon-fall. The readability comes from applyAutoFall's
		// ballistic arc and impact cut, not from slowing the clock down.
		return { fromS, toS: fromS + Math.sqrt((2 * meters) / gravity) * fallTimeScale, meters };
	}
	return null;
}

/**
 * Bake an auto-staged fall so it reads like a stunt, not a glitch:
 * - past the edge the root leaves the authored walk path and flies a true
 *   ballistic arc — the exit velocity carries, gravity owns the vertical;
 * - the horizontal drift stops at impact (bodies do not keep strolling);
 * - the take is cut just after the landing, because whatever the flat-ground
 *   clip does next (walking away twelve metres underground-level) is comedy.
 * Explicit MCP drops keep the rigid applyRootDrop bake below.
 */
export function applyAutoFall(motion, spec, { landHoldS = 0.35, launchLookbackS = 0.15 } = {}) {
	if (!spec || !motion || !Number.isFinite(motion.fps) || motion.fps <= 0) return motion;
	const fps = motion.fps;
	const fExit = Math.max(0, Math.round(spec.fromS * fps));
	if (fExit >= motion.frames - 1) return motion;
	const fallS = Math.max(spec.toS - spec.fromS, 1 / fps);
	const joints = Math.round(motion.posedJoints.length / motion.frames / 3);
	const rootPos = Float32Array.from(motion.rootPos);
	const posedJoints = Float32Array.from(motion.posedJoints);
	const lookback = Math.max(1, Math.round(launchLookbackS * fps));
	const f0 = Math.max(0, fExit - lookback);
	const span = Math.max(1, fExit - f0);
	const vx = ((rootPos[fExit * 3] - rootPos[f0 * 3]) / span) * fps;
	const vz = ((rootPos[fExit * 3 + 2] - rootPos[f0 * 3 + 2]) / span) * fps;
	const exitX = rootPos[fExit * 3];
	const exitZ = rootPos[fExit * 3 + 2];
	const fLand = Math.min(motion.frames - 1, Math.ceil(spec.toS * fps));
	for (let f = fExit + 1; f < motion.frames; f += 1) {
		const t = (f - fExit) / fps;
		const progress = Math.min(t / fallS, 1);
		const air = Math.min(t, fallS);
		const dy = -spec.meters * progress * progress;
		const dx = exitX + vx * air - rootPos[f * 3];
		const dz = exitZ + vz * air - rootPos[f * 3 + 2];
		rootPos[f * 3] += dx;
		rootPos[f * 3 + 1] += dy;
		rootPos[f * 3 + 2] += dz;
		for (let j = 0; j < joints; j += 1) {
			const base = (f * joints + j) * 3;
			posedJoints[base] += dx;
			posedJoints[base + 1] += dy;
			posedJoints[base + 2] += dz;
		}
	}
	const rotMats = Float32Array.from(motion.rotMats);
	for (let f = fLand + 1; f < motion.frames; f += 1) {
		rootPos.set(rootPos.subarray(fLand * 3, fLand * 3 + 3), f * 3);
		posedJoints.set(
			posedJoints.subarray(fLand * joints * 3, (fLand + 1) * joints * 3),
			f * joints * 3,
		);
		rotMats.set(
			rotMats.subarray(fLand * joints * 9, (fLand + 1) * joints * 9),
			f * joints * 9,
		);
	}
	const baked = { ...motion, rootPos, posedJoints, rotMats };
	const fEnd = Math.min(motion.frames - 1, Math.ceil((spec.toS + landHoldS) * fps));
	return fEnd < motion.frames - 1 ? sliceMotion(baked, 0, fEnd) : baked;
}

/**
 * The clip with the drop applied. The input clip is never mutated — the
 * caller may hold it as a trim source — and an invalid drop returns the
 * clip untouched, so this is safe to leave on the load path unconditionally.
 *
 * The curve is t² (uniform acceleration): a body leaving a roof gathers
 * speed, and an eased-both-ends fall reads as a elevator, not gravity.
 */
export function applyRootDrop(motion, drop) {
	const spec = normalizeRootDrop(drop);
	if (!spec || !motion || !Number.isFinite(motion.fps) || motion.fps <= 0) return motion;
	const frames = motion.frames;
	if (!Number.isFinite(frames) || frames <= 0) return motion;

	const posedJoints = Float32Array.from(motion.posedJoints);
	const rootPos = Float32Array.from(motion.rootPos);
	const joints = Math.round(posedJoints.length / frames / 3);
	for (let f = 0; f < frames; f += 1) {
		const t = Math.min(Math.max((f / motion.fps - spec.fromS) / (spec.toS - spec.fromS), 0), 1);
		if (t === 0) continue;
		const dy = -spec.meters * t * t;
		for (let j = 0; j < joints; j += 1) posedJoints[(f * joints + j) * 3 + 1] += dy;
		rootPos[f * 3 + 1] += dy;
	}
	return { ...motion, posedJoints, rootPos };
}

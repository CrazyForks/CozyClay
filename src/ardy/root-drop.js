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

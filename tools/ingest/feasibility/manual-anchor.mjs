/**
 * manual-anchor feasibility runner (F2c), the degraded fallback.
 *
 * WHY: when neither contacts nor foot observations can be trusted, the operator can still
 * mark the fighter's foot on a handful of frames; this mode linearly interpolates the
 * world position between those anchors and holds the ends. rawTrack/floorFrame are
 * accepted for signature symmetry with the other runners -- only the frame count and the
 * track ids come from the RawTrack, because the operator's marks REPLACE the observations.
 *
 * KEY SPACE: anchor.frameIndex is a SOURCE frame number -- the operator marks the
 * footage, not the emitted slice -- while rawTrack's per-frame arrays (and this runner's
 * rootWorld) are ROWS of a possibly trimmed and decimated slice. Row p corresponds to
 * source frame rawTrack.frameIndex[p] (RAWTRACK-CONTRACT §1, §4.1); the interpolant is
 * therefore evaluated at frameIndex[row], never at the row position itself. On the
 * contiguous zero-based synthetic fixtures the two coincide, which is exactly why the
 * decimated regression in verify-feasibility-modes.mjs exists.
 *
 * The synthetic control anchors every stance start AND end with the stance's own value, so
 * the interpolant reproduces the step-function GT exactly (a lerp between equal values is
 * constant, and a zero-width interval jumps to the later value). Anchor semantics: the
 * caller must supply each track's anchors in non-decreasing frameIndex order -- out-of-order
 * input is rejected with the named ANCHOR-ORDER error, never silently re-sorted, because
 * manual anchors are operator input and re-ordering them hides the operator's mistake.
 * Where two anchors share a frameIndex the LATER one wins for that frame -- that is what
 * makes the jump exact rather than sloped. Every anchor key must be a source frame of the
 * take -- present in, or bracketed by, the track's frameIndex -- or the input is rejected
 * with the named ANCHOR-OUT-OF-SPAN error: an anchor outside the take is operator error,
 * not something to clamp or extrapolate from.
 *
 * Degraded mode: F3 must display "spacing may read soft" and keep separate telemetry
 * (plan 10.3) when it selects this mode.
 *
 * @feasibility-only -- disposable Phase-0 feasibility code (plan 10.2). NOT production:
 * no envelope integration, no HTTP route, no UI, no contract obligations, no provenance emission,
 * no error taxonomy. Mechanically fenced (6.2): nothing outside
 * tools/ingest/feasibility/** and test/ingest/** may import it. Removed in Stage B.
 */

export function solveManualAnchor(rawTrack, floorFrame, anchors) {
	// Source frame IDs are NOT row offsets (same contract as measure.mjs's
	// rowOf): frameIndex is the synchronization key from the source footage,
	// and the emitted arrays are rows of a trimmed/decimated slice. Validate
	// the track's sync keys before any anchor touches them, so a malformed
	// track fails with a named error instead of misreading anchors.
	const frameIds = Array.isArray(rawTrack.frameIndex) ? rawTrack.frameIndex : [];
	if (rawTrack.frames > 0 && frameIds.length !== rawTrack.frames) {
		throw new Error(
			`manual-anchor: frameIndex has ${frameIds.length} entries for ${rawTrack.frames} frames`,
		);
	}
	const rowByFrame = new Map();
	frameIds.forEach((f, row) => {
		if (rowByFrame.has(f)) throw new Error(`manual-anchor: duplicate frameIndex ${f}`);
		rowByFrame.set(f, row);
	});
	const subjects = rawTrack.subjects.map((s) => {
		// validate the caller's ORIGINAL order before anything else: a sorted copy made
		// this rejection dead code and silently re-ordered operator marks -- the very
		// mistake the check exists to surface
		const original = anchors[s.trackId];
		if (original.length === 0) throw new Error("manual-anchor: no anchors for " + s.trackId);
		for (let i = 1; i < original.length; i += 1) {
			if (original[i].frameIndex < original[i - 1].frameIndex) {
				throw new Error(
					"manual-anchor: ANCHOR-ORDER " + s.trackId +
						" anchors must be non-decreasing in frameIndex (out of order at index " + i + ")",
				);
			}
		}
		// the input is validated non-decreasing, so no sort is needed; the copy keeps the
		// caller's array untouched and input order decides ties (the later anchor wins)
		const list = [...original];
		// anchor keys are SOURCE frames: every key must exist in, or be bracketed
		// by, the track's source keys -- an anchor outside the take interpolates
		// nothing the footage contains and is rejected by name, never clamped
		if (rawTrack.frames > 0) {
			const lo = frameIds[0];
			const hi = frameIds[frameIds.length - 1];
			for (const a of list) {
				if (a.frameIndex < lo || a.frameIndex > hi) {
					throw new Error(
						"manual-anchor: ANCHOR-OUT-OF-SPAN " + s.trackId +
							" anchor frameIndex " + a.frameIndex +
							" is not in or bracketed by the track's source keys [" + lo + ", " + hi + "]",
					);
				}
			}
		}
		const rootWorld = [];
		for (let row = 0; row < rawTrack.frames; row += 1) {
			const f = frameIds[row]; // this row's SOURCE frame
			if (f <= list[0].frameIndex) {
				rootWorld.push([...list[0].world]);
				continue;
			}
			const last = list[list.length - 1];
			if (f >= last.frameIndex) {
				rootWorld.push([...last.world]);
				continue;
			}
			// advance to the last anchor at or before f, so a zero-width anchor pair
			// (same frameIndex, new value) resolves to the NEW value exactly at f
			let i = 0;
			while (list[i + 1].frameIndex <= f) i += 1;
			const a = list[i];
			const b = list[i + 1];
			// interpolation in SOURCE-KEY space: the fraction is over source
			// frames, never over row positions
			const s = (f - a.frameIndex) / (b.frameIndex - a.frameIndex);
			rootWorld.push([
				a.world[0] + s * (b.world[0] - a.world[0]),
				a.world[1] + s * (b.world[1] - a.world[1]),
				a.world[2] + s * (b.world[2] - a.world[2]),
			]);
		}
		return { trackId: s.trackId, rootWorld };
	});
	return { mode: "manual-anchor", subjects };
}

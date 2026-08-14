/**
 * manual-anchor feasibility runner (F2c), the degraded fallback.
 *
 * WHY: when neither contacts nor foot observations can be trusted, the operator can still
 * mark the fighter's foot on a handful of frames; this mode linearly interpolates the
 * world position between those anchors and holds the ends. rawTrack/floorFrame are
 * accepted for signature symmetry with the other runners -- only the frame count and the
 * track ids come from the RawTrack, because the operator's marks REPLACE the observations.
 *
 * The synthetic control anchors every stance start AND end with the stance's own value, so
 * the interpolant reproduces the step-function GT exactly (a lerp between equal values is
 * constant, and a zero-width interval jumps to the later value). Anchor semantics:
 * non-decreasing frameIndex, and where two anchors share a frameIndex the LATER one wins
 * for that frame -- that is what makes the jump exact rather than sloped.
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
	const subjects = rawTrack.subjects.map((s) => {
		const list = [...anchors[s.trackId]].sort((a, b) => a.frameIndex - b.frameIndex);
		if (list.length === 0) throw new Error("manual-anchor: no anchors for " + s.trackId);
		for (let i = 1; i < list.length; i += 1) {
			if (list[i].frameIndex < list[i - 1].frameIndex) {
				throw new Error("manual-anchor: anchor frameIndex must be sorted");
			}
		}
		const rootWorld = [];
		for (let f = 0; f < rawTrack.frames; f += 1) {
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

// Longest continuous take selection (plan §13 commit C3).
//
// Why the margin trims INWARD: cuts are the only fatal flaw in found
// footage (cut-spanning footage is out of v1, plan §16), and the frames at
// a cut are transition garbage — motion and pose data there belongs to two
// shots at once. The safety margin therefore trims away both ends of the
// chosen run, and because the window is the run shrunk (never grown), a
// window that contains a cut is impossible by construction. The naive
// outward application is exactly the defect this module exists to prevent:
// "margin crossed a cut boundary at 41.2s" (plan §13), which would hand a
// two-shot mixture to every downstream solver.
//
// Rejections are named and happen BEFORE any selection: a malformed cut
// list (non-finite, out of range, unsorted, duplicated), a non-positive
// duration, or a negative margin can never read as a window. A margin that
// cannot fit the longest run (margin * 2 >= run length) rejects with
// take-margin-exceeds-run rather than returning a zero-length or inverted
// window — an inverted window would silently SPAN the neighbour run, the
// exact poisoning this module exists to stop.

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

export function selectLongestTake(input = {}) {
	if (input === null || typeof input !== "object") throw new Error("take-selection-input");
	const { cutsS, durationS, marginS } = input;
	if (cutsS === null || typeof cutsS !== "object" || !Array.isArray(cutsS)) throw new Error("take-selection-input");
	if (!isFiniteNumber(durationS) || durationS <= 0) throw new Error("take-selection-input");
	if (!isFiniteNumber(marginS) || marginS < 0) throw new Error("take-selection-input");
	// Cuts are strictly inside the take and strictly increasing: a cut at an
	// edge is not a cut (it is the take boundary), and a duplicate or
	// out-of-order cut describes a timeline that cannot exist.
	let prev = 0;
	for (const c of cutsS) {
		if (!isFiniteNumber(c) || c <= prev || c >= durationS) throw new Error("take-selection-input");
		prev = c;
	}
	const bounds = [0, ...cutsS, durationS];
	let best = { start: 0, end: 0, len: -1 };
	for (let i = 0; i + 1 < bounds.length; i++) {
		const len = bounds[i + 1] - bounds[i];
		// Strictly-greater keeps the EARLIEST run on a tie, so the same
		// input always selects the same run.
		if (len > best.len) best = { start: bounds[i], end: bounds[i + 1], len };
	}
	if (marginS * 2 >= best.len) throw new Error("take-margin-exceeds-run");
	return {
		runStartS: best.start,
		runEndS: best.end,
		startS: best.start + marginS,
		endS: best.end - marginS,
	};
}

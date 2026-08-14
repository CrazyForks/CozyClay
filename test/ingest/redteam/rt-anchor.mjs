/**
 * Red-team: the F2c manual-anchor runner (tools/ingest/feasibility/manual-anchor.mjs)
 * in SOURCE-KEY space vs its own documented contract (module header) and the
 * RAWTRACK-CONTRACT §4.1 sync-key rule.
 *
 * KEY SPACE: anchor.frameIndex is a SOURCE frame number (the operator marks
 * the footage), while the emitted rootWorld is a ROW array of a possibly
 * trimmed/decimated slice — row p corresponds to source frame
 * rawTrack.frameIndex[p]. The interpolant must be evaluated at
 * frameIndex[row], never at the row position, and the interpolation fraction
 * is over source frames, never over row positions. On contiguous zero-based
 * synthetic fixtures the two coincide, which is exactly the hiding place the
 * decimated cases below exist to break.
 *
 * Anchor semantics (module header, quoted where asserted):
 *   - "the caller must supply each track's anchors in non-decreasing
 *     frameIndex order — out-of-order input is rejected with the named
 *     ANCHOR-ORDER error"
 *   - "Where two anchors share a frameIndex the LATER one wins for that
 *     frame — that is what makes the jump exact rather than sloped."
 *   - "Every anchor key must be a source frame of the take — present in, or
 *     bracketed by, the track's frameIndex — or the input is rejected with
 *     the named ANCHOR-OUT-OF-SPAN error"
 *   - "linearly interpolates the world position between those anchors and
 *     holds the ends"
 *
 * Attack inputs: anchors exactly on the span endpoints, duplicate anchor
 * keys (start / middle / end of the list), a single anchor, anchors that
 * bracket no emitted row, anchor keys that exist in frameIndex versus keys
 * that only fall between two emitted rows, and malformed tracks (duplicate /
 * unsorted frameIndex).
 */

import { solveManualAnchor } from "../../../tools/ingest/feasibility/manual-anchor.mjs";
import { newRegistry } from "./rt-common.mjs";

const reg = newRegistry();

const mkTrack = (keys, over = {}) => ({
	schemaVersion: 1,
	clipId: "redteam-anchor-probe",
	fps: 29.97,
	frames: keys.length,
	frameIndex: keys,
	timeS: keys.map((f) => f / 29.97),
	subjects: [
		{
			trackId: "p0",
			footObservations2d: { left: { keypoints: [] }, right: { keypoints: [] } },
			leftContact: [],
			rightContact: [],
		},
	],
	...over,
});

const solve = (track, anchors) => solveManualAnchor(track, {}, anchors).subjects[0].rootWorld;
const xs = (rows) => rows.map((p) => p[0]);
const close = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;
const closeAll = (xs, want, eps = 1e-12) => xs.length === want.length && xs.every((v, i) => close(v, want[i], eps));

// ---------------------------------------------------------------------------
// Anchors exactly on the span endpoints
// ---------------------------------------------------------------------------
{
	// decimated take: 5 emitted rows over source keys [10, 26]; anchors at the
	// exact lo (10) and hi (26) source keys. The hold-the-ends convention must
	// reproduce the anchor values at the endpoints and the key-space ramp
	// between them; a row-position lerp would give a different ramp.
	const track = mkTrack([10, 14, 18, 22, 26]);
	const rows = solve(track, {
		p0: [
			{ frameIndex: 10, world: [0, 0, 0] },
			{ frameIndex: 26, world: [2, 0, 0] },
		],
	});
	const ramp = [10, 14, 18, 22, 26].map((f) => ((f - 10) / (26 - 10)) * 2);
	reg.record({
		id: "ANCH-endpoints-hold", category: "manual-anchor",
		attack: "anchors exactly on the take's span endpoints (decimated keys [10,26])",
		input: "anchors at frameIndex 10 -> x=0 and 26 -> x=2 on a 5-row take",
		expected: "endpoints hold the anchor values exactly (row 0 = 0, row 4 = 2); the middle rows ramp in SOURCE-KEY space: 14 -> 0.5, 18 -> 1, 22 -> 1.5",
		observed: `rows x = ${JSON.stringify(xs(rows))}`,
		verdict: closeAll(xs(rows), ramp) ? "PASS" : "WEAKNESS",
	});
	// contiguous take, anchors at the very first and very last emitted keys
	const track2 = mkTrack([0, 5, 10, 15, 20]);
	const rows2 = solve(track2, {
		p0: [
			{ frameIndex: 0, world: [0, 0, 0] },
			{ frameIndex: 20, world: [4, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-endpoints-on-rows", category: "manual-anchor",
		attack: "anchors exactly on the first and last emitted keys (0 and 20)",
		input: "anchors at frameIndex 0 -> x=0 and 20 -> x=4 on a contiguous 5-row take",
		expected: "row 0 = 0 and row 4 = 4 exactly; rows at keys 5/10/15 lerp at source-key fractions 1/4, 1/2, 3/4 -> 1, 2, 3",
		observed: `rows x = ${JSON.stringify(xs(rows2))}`,
		verdict: closeAll(xs(rows2), [0, 1, 2, 3, 4]) ? "PASS" : "WEAKNESS",
	});
	// one key PAST the last source key is outside the span: named rejection
	let spanErr = null;
	try {
		solve(track2, {
			p0: [
				{ frameIndex: 0, world: [0, 0, 0] },
				{ frameIndex: 21, world: [4, 0, 0] },
			],
		});
	} catch (e) { spanErr = e; }
	const namedSpan = spanErr instanceof Error && /ANCHOR-OUT-OF-SPAN/.test(spanErr.message) && /21/.test(spanErr.message);
	reg.record({
		id: "ANCH-out-of-span-hi-1", category: "manual-anchor",
		attack: "anchor one key past the last emitted key (21 on keys 0..20)",
		input: "second anchor at frameIndex 21",
		expected: "named ANCHOR-OUT-OF-SPAN rejection naming key 21 — never clamped or held",
		observed: spanErr ? `${spanErr.name}: ${spanErr.message}` : "no throw — the out-of-span anchor was accepted",
		verdict: namedSpan ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Duplicate anchor keys
// ---------------------------------------------------------------------------
{
	const track = mkTrack([0, 5, 10, 15]);
	// duplicate pair in the MIDDLE of the list: the documented "later wins"
	// must hold at the shared frame and the jump must be exact, not sloped
	const mid = solve(track, {
		p0: [
			{ frameIndex: 0, world: [0, 0, 0] },
			{ frameIndex: 5, world: [1, 0, 0] },
			{ frameIndex: 5, world: [9, 0, 0] },
			{ frameIndex: 15, world: [15, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-dup-mid-later-wins", category: "manual-anchor",
		attack: "duplicate anchor keys in the middle of the list (5 -> 1 and 5 -> 9)",
		input: "anchors 0->0, 5->1, 5->9, 15->15",
		expected: "the LATER anchor (9) wins at frame 5 (zero-width jump exact); rows 10 lerp from (5,9) to (15,15) -> 12; rows: [0, 9, 12, 15]",
		observed: `rows x = ${JSON.stringify(xs(mid))}`,
		verdict: closeAll(xs(mid), [0, 9, 12, 15]) ? "PASS" : "WEAKNESS",
	});
	// duplicate pair at the END of the list
	const end = solve(track, {
		p0: [
			{ frameIndex: 0, world: [0, 0, 0] },
			{ frameIndex: 15, world: [1, 0, 0] },
			{ frameIndex: 15, world: [9, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-dup-end-later-wins", category: "manual-anchor",
		attack: "duplicate anchor keys at the end of the list (15 -> 1 and 15 -> 9)",
		input: "anchors 0->0, 15->1, 15->9",
		expected: "the LATER anchor (9) wins at frame 15 (the hold-the-ends branch reads the last anchor); rows: [0, 1/3, 2/3, 9]",
		observed: `rows x = ${JSON.stringify(xs(end))}`,
		verdict: closeAll(xs(end), [0, 1 / 3, 2 / 3, 9]) ? "PASS" : "WEAKNESS",
	});
	// duplicate pair at the START of the list — the documented "later wins for
	// that frame" promise. The module header: "Where two anchors share a
	// frameIndex the LATER one wins for that frame — that is what makes the
	// jump exact rather than sloped." A trimmed take whose first visible frame
	// is a stance boundary is exactly this shape: the operator marks both the
	// pre-boundary and post-boundary value at the first frame.
	const start = solve(track, {
		p0: [
			{ frameIndex: 0, world: [0, 0, 0] },
			{ frameIndex: 0, world: [5, 0, 0] },
			{ frameIndex: 15, world: [15, 0, 0] },
		],
	});
	const startLaterWins = closeAll(xs(start), [5, 5 + 10 * (5 / 15), 5 + 10 * (10 / 15), 15]);
	reg.record({
		id: "ANCH-dup-start-defect", category: "manual-anchor",
		attack: "duplicate anchor keys at the START of the list (0 -> 0 and 0 -> 5)",
		input: "anchors 0->0, 0->5, 15->15; the take's first frame is a stance boundary",
		expected: "documented contract (module header): the LATER anchor wins for the shared frame -> frame 0 reads 5; rows [5, 8.333, 11.667, 15]",
		observed: `rows x = ${JSON.stringify(xs(start))} — frame 0 reads the EARLIER anchor (0); the hold-the-ends branch (f <= list[0].frameIndex) fires before the zero-width pair is considered, so the jump is one frame late at the take start. Mid-list and end-list duplicate pairs (ANCH-dup-mid-later-wins, ANCH-dup-end-later-wins) DO resolve to the later anchor — the semantics are position-dependent.`,
		verdict: startLaterWins ? "PASS" : "DEFECT",
	});
	if (!startLaterWins) {
		reg.finding("high", "manual-anchor: a zero-width anchor pair at the list start resolves to the EARLIER anchor at the shared frame (documented 'later wins' violated)", ["ANCH-dup-start-defect"],
			"The module header promises 'Where two anchors share a frameIndex the LATER one wins for that frame — that is what makes the jump exact rather than sloped.' When the shared frame is list[0].frameIndex (a trimmed take starting exactly at a stance boundary), the `f <= list[0].frameIndex` hold-the-ends branch fires first and frame f* reads the pre-jump value; the same pair mid-list or at the list end reads the later value. The jump is exact except at the take's first frame, where it is one frame late.");
	}
}

// ---------------------------------------------------------------------------
// A single anchor
// ---------------------------------------------------------------------------
{
	// one anchor in the middle of the span: the whole take holds its value
	const track = mkTrack([0, 5, 10, 15, 20]);
	const mid = solve(track, {
		p0: [{ frameIndex: 10, world: [7, 0, 0] }],
	});
	reg.record({
		id: "ANCH-single-mid-hold", category: "manual-anchor",
		attack: "a single anchor in the middle of the span",
		input: "one anchor at frameIndex 10 -> x=7",
		expected: "no interval to interpolate: every row holds the anchor value (the ends hold on both sides)",
		observed: `rows x = ${JSON.stringify(xs(mid))}`,
		verdict: closeAll(xs(mid), [7, 7, 7, 7, 7]) ? "PASS" : "WEAKNESS",
	});
	// one anchor at the take's first key: same hold on every row
	const first = solve(track, {
		p0: [{ frameIndex: 0, world: [3, 0, 0] }],
	});
	reg.record({
		id: "ANCH-single-at-first-key", category: "manual-anchor",
		attack: "a single anchor at the take's first emitted key",
		input: "one anchor at frameIndex 0 -> x=3",
		expected: "every row holds x=3 (anchor at the span start is a degenerate end-hold, not an error)",
		observed: `rows x = ${JSON.stringify(xs(first))}`,
		verdict: closeAll(xs(first), [3, 3, 3, 3, 3]) ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Anchors that bracket no emitted row
// ---------------------------------------------------------------------------
{
	// keys [0, 2, 4]; anchors at 1 and 3 — neither is an emitted key. The
	// span rule blesses bracketed keys ("present in, or bracketed by, the
	// track's frameIndex"); the interpolant must run between the anchor keys
	// in SOURCE-KEY space.
	const track = mkTrack([0, 2, 4]);
	const rows = solve(track, {
		p0: [
			{ frameIndex: 1, world: [0, 0, 0] },
			{ frameIndex: 3, world: [4, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-bracket-none-midpoint", category: "manual-anchor",
		attack: "anchor pair brackets no emitted row (keys 1 and 3 on emitted keys [0,2,4])",
		input: "anchors at frameIndex 1 -> x=0 and 3 -> x=4",
		expected: "key 0 holds 0; key 2 (midway between the anchor keys) reads the key-space midpoint 2; key 4 holds 4 -> rows [0, 2, 4]",
		observed: `rows x = ${JSON.stringify(xs(rows))}`,
		verdict: closeAll(xs(rows), [0, 2, 4]) ? "PASS" : "WEAKNESS",
	});
	// asymmetric anchor gap: key-space fraction 1/4 vs row-position 1/2 — the
	// two disagree, so a row-space lerp cannot produce the same values.
	const track2 = mkTrack([0, 2, 6]);
	const rows2 = solve(track2, {
		p0: [
			{ frameIndex: 1, world: [0, 0, 0] },
			{ frameIndex: 5, world: [10, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-bracket-none-asymmetric", category: "manual-anchor",
		attack: "anchor pair brackets no emitted row with an ASYMMETRIC gap (keys 1 and 5 on emitted keys [0,2,6])",
		input: "anchors at frameIndex 1 -> x=0 and 5 -> x=10",
		expected: "key 0 holds 0; key 2 is 1/4 of the way from 1 to 5 in SOURCE-KEY space -> 2.5 (a row-position lerp would read 1/2 -> 5); key 6 holds 10 -> rows [0, 2.5, 10]",
		observed: `rows x = ${JSON.stringify(xs(rows2))}`,
		verdict: closeAll(xs(rows2), [0, 2.5, 10]) ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Anchor keys that exist in frameIndex vs keys between two emitted rows
// ---------------------------------------------------------------------------
{
	const track = mkTrack([10, 14, 18, 22, 26]);
	// all three anchor keys are emitted rows: 14, 18, 26
	const onRows = solve(track, {
		p0: [
			{ frameIndex: 14, world: [1, 0, 0] },
			{ frameIndex: 18, world: [2, 0, 0] },
			{ frameIndex: 26, world: [5, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-key-on-emitted-rows", category: "manual-anchor",
		attack: "every anchor key is an emitted row (14, 18, 26 on keys [10,14,18,22,26])",
		input: "anchors at 14 -> x=1, 18 -> x=2, 26 -> x=5",
		expected: "rows at anchor keys read their anchor values EXACTLY (14 -> 1, 18 -> 2, 26 -> 5); key 10 holds 1; key 22 lerps (22-18)/(26-18) = 1/2 -> 3.5; rows [1, 1, 2, 3.5, 5]",
		observed: `rows x = ${JSON.stringify(xs(onRows))}`,
		verdict: closeAll(xs(onRows), [1, 1, 2, 3.5, 5]) ? "PASS" : "WEAKNESS",
	});
	// neither anchor key is an emitted row (16 and 24 between 14/18 and 22/26)
	const between = solve(track, {
		p0: [
			{ frameIndex: 16, world: [1, 0, 0] },
			{ frameIndex: 24, world: [5, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-key-between-rows", category: "manual-anchor",
		attack: "neither anchor key is an emitted row (16 and 24 between emitted keys)",
		input: "anchors at frameIndex 16 -> x=1 and 24 -> x=5 on keys [10,14,18,22,26]",
		expected: "rows at keys <= 16 hold 1 (10, 14); key 18 is 1/4 of the way 16->24 -> 2; key 22 is 3/4 -> 4; key 26 holds 5; rows [1, 1, 2, 4, 5]",
		observed: `rows x = ${JSON.stringify(xs(between))}`,
		verdict: closeAll(xs(between), [1, 1, 2, 4, 5]) ? "PASS" : "WEAKNESS",
	});
	// mixed: one anchor on an emitted row (18), one between rows (24)
	const mixed = solve(track, {
		p0: [
			{ frameIndex: 18, world: [2, 0, 0] },
			{ frameIndex: 24, world: [6, 0, 0] },
		],
	});
	reg.record({
		id: "ANCH-key-mix", category: "manual-anchor",
		attack: "one anchor on an emitted row (18), one between rows (24)",
		input: "anchors at frameIndex 18 -> x=2 and 24 -> x=6",
		expected: "keys <= 18 hold 2 (10, 14, 18); key 22 is 2/3 of the way 18->24 -> 4.666...; key 26 holds 6; rows [2, 2, 2, 14/3, 6]",
		observed: `rows x = ${JSON.stringify(xs(mixed))}`,
		verdict: closeAll(xs(mixed), [2, 2, 2, 14 / 3, 6]) ? "PASS" : "WEAKNESS",
	});
}

// ---------------------------------------------------------------------------
// Malformed tracks: duplicate and unsorted frameIndex
// ---------------------------------------------------------------------------
{
	// duplicate track keys: the sync-key map must reject by name
	const dupTrack = mkTrack([0, 5, 5, 10]);
	let dupErr = null;
	try {
		solve(dupTrack, {
			p0: [
				{ frameIndex: 0, world: [0, 0, 0] },
				{ frameIndex: 10, world: [1, 0, 0] },
			],
		});
	} catch (e) { dupErr = e; }
	const namedDup = dupErr instanceof Error && /duplicate frameIndex 5/.test(dupErr.message);
	reg.record({
		id: "ANCH-track-dup-keys", category: "manual-anchor",
		attack: "track frameIndex contains a duplicate source key (5 twice)",
		input: "frameIndex [0, 5, 5, 10]",
		expected: "named rejection 'duplicate frameIndex 5' — a sync key names one row and one row only",
		observed: dupErr ? `${dupErr.name}: ${dupErr.message}` : "no throw — the duplicate key was accepted",
		verdict: namedDup ? "PASS" : "WEAKNESS",
	});
	// unsorted track keys: RAWTRACK-CONTRACT §4.1 and the schema validator
	// (SCH-unsorted-frameIndex) require frameIndex increasing; the runner
	// derives its span bounds from the FIRST and LAST emitted keys, so an
	// unsorted take silently mis-derives lo/hi and interpolates out of order.
	const unsortedTrack = mkTrack([10, 0, 20]);
	let unsortedErr = null;
	let unsortedRows = null;
	try {
		unsortedRows = solve(unsortedTrack, {
			p0: [
				{ frameIndex: 10, world: [0, 0, 0] },
				{ frameIndex: 15, world: [5, 0, 0] },
			],
		});
	} catch (e) { unsortedErr = e; }
	const unsortedAccepted = unsortedErr === null && Array.isArray(unsortedRows);
	reg.record({
		id: "ANCH-track-unsorted", category: "manual-anchor",
		attack: "track frameIndex is not sorted ([10, 0, 20])",
		input: "frameIndex [10, 0, 20]; anchors at 10 -> x=0 and 15 -> x=5 (15 IS inside the true key span [0, 20])",
		expected: "malformed take (RAWTRACK §4.1: rows align with frameIndex in footage order; validator SCH-unsorted-frameIndex rejects unsorted keys): the runner must reject by name, never silently derive span bounds from the first/last ROW keys",
		observed: unsortedErr
			? `${unsortedErr.name}: ${unsortedErr.message}`
			: `no throw — accepted; rows x = ${JSON.stringify(xs(unsortedRows))}; the span bounds were read as [10, 20] (first/last row keys), so an anchor at 5 — inside the true span [0, 20] — would be mis-rejected as ANCHOR-OUT-OF-SPAN while the take interpolates silently`,
		verdict: unsortedAccepted ? "WEAKNESS" : "PASS",
	});
	if (unsortedAccepted) {
		reg.finding("low", "manual-anchor accepts an unsorted frameIndex and derives span bounds from the first/last row keys", ["ANCH-track-unsorted"],
			"RAWTRACK-CONTRACT §4.1 and the schema validator require frameIndex increasing; the runner's ANCHOR-OUT-OF-SPAN bounds are frameIds[0]..frameIds[last], which are only the true span while the keys are sorted. An unsorted take is accepted and interpolated silently, and a valid anchor can be mis-rejected as out-of-span.");
	}
}

export const run = async () => {
	console.log("== rt-anchor: manual-anchor source-key attacks ==");
	return { cases: reg.cases, findings: reg.findings };
};

const isMain = process.argv[1] && process.argv[1].endsWith("rt-anchor.mjs");
if (isMain) {
	await run();
	for (const c of reg.cases) console.log(`${c.verdict.padEnd(9)} ${c.id.padEnd(28)} ${c.observed.slice(0, 110)}`);
	console.log(`\nrt-anchor: ${reg.cases.length} cases, ${reg.findings.length} findings`);
}

/**
 * C3: longest continuous take selection (plan §13 commit C3).
 *
 * Why this test exists: cuts are the only fatal flaw in found footage —
 * cut-spanning footage is explicitly out of v1 (plan §16) — so a take that
 * silently spans a cut mixes two shots and poisons every downstream solver:
 * the ring calibration, the ray→plane roots, the cskel27 chain, all of it
 * would be solving a scene that never existed. The plan's canonical RED is
 * "margin crossed a cut boundary at 41.2s": a naive selection applies the
 * safety margin outward from the chosen run (or from the source take's own
 * edges) and the window then spans the cut. The correct selection is the
 * longest cut-free run shrunk INWARD by the margin — transition frames at a
 * cut are garbage, so the margin trims them away — which makes a crossing
 * impossible by construction.
 *
 * What would be circular or wrong to assert: re-implementing the run scan
 * in the test (that asserts code against code); asserting only the fixture
 * window (a wrong implementation could pass the fixture and still cross a
 * cut elsewhere — hence the adversarial sweep); or testing the margin with
 * mid-range values only (a margin larger than half the run must REJECT,
 * never return an inverted window that silently spans the neighbour run).
 * The negative controls: an exact window assertion on the pinned fixture,
 * a cut-grid sweep where every window must contain zero cuts, a tie that
 * must resolve to the earliest run, a margin boundary that must reject by
 * name, and malformed inputs that must reject before any selection.
 */
import { readFileSync } from "node:fs";
import { selectLongestTake } from "../../src/ingest/take-selection.js";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const throwsCode = (label, fn, code) => {
	let err = null;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	ok(label, err !== null && err.message === code, err === null ? "no error thrown" : `got ${err.message}`);
	return err;
};

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/take-selection/longest-run.json", import.meta.url), "utf8")
);

// a window is clean iff no cut lies strictly inside it
const crossingCut = (sel, cutsS) => cutsS.find((c) => sel.startS < c && c < sel.endS);

// ---------------------------------------------------------------------------
// 1. The plan's RED: the margin must never cross a cut boundary
// ---------------------------------------------------------------------------
// Fixture runs: [0,10], [10,41.2], [41.2,63.5], [63.5,90] — the longest is
// [10,41.2] at 31.2 s. Margin 0.5 s trims INWARD: [10.5, 40.7]. The naive
// outward application yields [9.5, 41.7], which spans the cuts at 10.0 and
// 41.2 — "margin crossed a cut boundary at 41.2s".
let sel;
try {
	sel = selectLongestTake(fixture);
} catch (e) {
	// A thrown stub must read as a WORST-POSSIBLE window (spans everything),
	// so the RED assertion fails by name instead of vacuous-passing.
	sel = { startS: -Infinity, endS: Infinity, runStartS: NaN, runEndS: NaN };
}
ok("selection never crosses a cut", crossingCut(sel, fixture.cutsS) === undefined, `window [${sel.startS}, ${sel.endS}]`);
ok(
	"longest run minus margin is exact",
	sel.startS === fixture.expected.startS && sel.endS === fixture.expected.endS,
	`got [${sel.startS}, ${sel.endS}], expected [${fixture.expected.startS}, ${fixture.expected.endS}]`
);
ok(
	"the returned run is the longest run",
	sel.runStartS === fixture.expected.runStartS && sel.runEndS === fixture.expected.runEndS,
	`got run [${sel.runStartS}, ${sel.runEndS}], expected [${fixture.expected.runStartS}, ${fixture.expected.runEndS}]`
);
// The margin is INWARD from the run's own boundaries: the window is the run
// shrunk, never the run grown.
ok(
	"margin trims inward from the run boundaries",
	sel.startS - sel.runStartS === fixture.marginS && sel.runEndS - sel.endS === fixture.marginS,
	`start ${sel.startS}, run ${sel.runStartS}, end ${sel.endS}, runEnd ${sel.runEndS}, margin ${fixture.marginS}`
);

// ---------------------------------------------------------------------------
// 2. Adversarial sweep: no cut, anywhere, ever
// ---------------------------------------------------------------------------
// A 20-run grid with a tight margin is the hardest case for a crossing:
// every run is short, so any outward or mis-referenced margin lands in the
// neighbour run. Each window must contain zero cuts and stay inside its run.
const grid = { durationS: 60, marginS: 0.8, cutsS: Array.from({ length: 19 }, (_, i) => (i + 1) * 3) };
let swept = 0;
for (let margin = 0.2; margin <= 1.4; margin += 0.2) {
	const s = selectLongestTake({ ...grid, marginS: margin });
	swept++;
	if (crossingCut(s, grid.cutsS) !== undefined) ok("swept window contains no cut", false, `margin ${margin} window [${s.startS}, ${s.endS}]`);
	if (s.startS - margin < s.runStartS || s.endS + margin > s.runEndS) ok("swept window stays inside its run", false, `margin ${margin}`);
}
ok("adversarial cut-grid sweep: every window clean", swept === 7 && !crossingCut(selectLongestTake(grid), grid.cutsS), `${swept} margins swept`);
// margin 0: no margin to cross, the window IS the longest run.
const noMargin = selectLongestTake({ ...fixture, marginS: 0 });
ok(
	"margin 0 returns the longest run unchanged",
	noMargin.startS === 10 && noMargin.endS === 41.2 && crossingCut(noMargin, fixture.cutsS) === undefined,
	`window [${noMargin.startS}, ${noMargin.endS}]`
);

// ---------------------------------------------------------------------------
// 3. Ties resolve to the earliest run — determinism
// ---------------------------------------------------------------------------
// One cut at the exact centre: [0,45] and [45,90] tie at 45 s; the earliest
// must win, so the same input always selects the same run.
const tie = selectLongestTake({ durationS: 90, cutsS: [45], marginS: 0.5 });
ok("equal runs resolve to the earliest", tie.runStartS === 0 && tie.runEndS === 45, `run [${tie.runStartS}, ${tie.runEndS}]`);

// ---------------------------------------------------------------------------
// 4. A margin that cannot fit rejects by name
// ---------------------------------------------------------------------------
// marginS * 2 >= run length would produce a zero-length or inverted window;
// an inverted window would silently SPAN the neighbour run (start < cut <
// end), which is the exact poisoning C3 exists to prevent. Rejection, never
// a crossed window. The boundary itself (margin == half the run) must also
// reject — a zero-length take is not a take.
throwsCode(
	"margin exceeding half the longest run is rejected",
	() => selectLongestTake({ durationS: 60, cutsS: [30], marginS: 16 }),
	"take-margin-exceeds-run"
);
throwsCode(
	"margin equal to half the longest run is rejected",
	() => selectLongestTake({ durationS: 60, cutsS: [30], marginS: 15 }),
	"take-margin-exceeds-run"
);
// A margin that fits the longest run but not the runner-up is fine — the
// margin applies to the SELECTED run only.
ok(
	"margin fitting the longest run is accepted even when it exceeds runner-up length",
	selectLongestTake({ durationS: 60, cutsS: [30], marginS: 14.9 }).startS === 14.9,
	""
);

// ---------------------------------------------------------------------------
// 5. Input contract: malformed inputs reject before any selection
// ---------------------------------------------------------------------------
throwsCode("a cut at the take edge is rejected", () => selectLongestTake({ durationS: 90, cutsS: [0], marginS: 0.5 }), "take-selection-input");
throwsCode("a cut beyond the take is rejected", () => selectLongestTake({ durationS: 90, cutsS: [95], marginS: 0.5 }), "take-selection-input");
throwsCode("unsorted cuts are rejected", () => selectLongestTake({ durationS: 90, cutsS: [41.2, 10], marginS: 0.5 }), "take-selection-input");
throwsCode("duplicate cuts are rejected", () => selectLongestTake({ durationS: 90, cutsS: [10, 10], marginS: 0.5 }), "take-selection-input");
throwsCode("NaN cuts are rejected", () => selectLongestTake({ durationS: 90, cutsS: [NaN], marginS: 0.5 }), "take-selection-input");
throwsCode("a non-array cut list is rejected", () => selectLongestTake({ durationS: 90, cutsS: 41.2, marginS: 0.5 }), "take-selection-input");
throwsCode("a non-positive duration is rejected", () => selectLongestTake({ durationS: 0, cutsS: [], marginS: 0.5 }), "take-selection-input");
throwsCode("a negative margin is rejected", () => selectLongestTake({ durationS: 90, cutsS: [], marginS: -0.5 }), "take-selection-input");
throwsCode("a non-object input is rejected", () => selectLongestTake(null), "take-selection-input");

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

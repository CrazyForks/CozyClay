/**
 * M1-M6 measurement for the Phase-0 decision function (plan 10.2, 10.3).
 *
 * WHY: F3 may only select a mode whose runner AND measurement path are both green, and
 * F2r must be able to recompute every recorded metric from the pinned fixture set alone.
 * computeMetrics therefore reads ONLY the 10.2 solver-output fixture plus the
 * hand-annotation JSON it points to (provenance.annotationPath) -- never the RawTrack,
 * never a runner. The fixture's rootWorld is the SOLVED output; the annotation carries the
 * hand-labelled truth (100 contact labels for M2, foot world positions for M5).
 *
 * Metric definitions, exactly as pinned in the plan:
 *   M1 contact coverage   = fraction of frames with >= 1 contact above 0.5, mean over subjects
 *   M2 contact precision  = pooled per-foot TP/(TP+FP) vs the 100 hand-labelled frames
 *   M3 plant jitter       = per contact run (max contact > 0.5, planted side constant), mean
 *                           of the per-axis std of the solved root XZ within the run
 *   M4 identity swaps     = number of association.groundTruth entries whose matching
 *                           observations record disagrees on assignedSubjectId
 *   M5 solved-root RMS    = RMS over subjects x scored frames of |rootWorld - annotated foot|
 *   M6 separation error   = RMS over scored frames of | |rootA-rootB| - annotatedSeparationM |
 *
 * UNDEFINED-METRIC CONVENTION: a metric with no sample base is returned as undefined, with
 * a reason in the returned `reasons` object — never as a fabricated number. M1 with no
 * frames, M2 with no hand-labelled frames, M3 with no contact runs, M4 with no groundTruth
 * entries, and M5/M6 with no scored frames are all 0/0 (or vacuous) quantities; reading
 * them as 0 ("no jitter", "no swaps") or 1 ("perfect precision") would let a degenerate
 * fixture pass the gate as if it had been measured. Consumers must test `m.M4 === undefined`
 * and read `m.reasons.M4` explicitly; coercing undefined to a number is the bug this
 * convention exists to prevent. NaN input (e.g. a NaN rootWorld coordinate) still
 * propagates as NaN — garbage in stays loud at the gate, only the 0/0 cases are undefined.
 *
 * @feasibility-only -- disposable Phase-0 feasibility code (plan 10.2). NOT production:
 * no envelope integration, no HTTP route, no UI, no contract obligations, no provenance emission,
 * no error taxonomy. Mechanically fenced (6.2): nothing outside
 * tools/ingest/feasibility/** and test/ingest/** may import it. Removed in Stage B.
 */

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// maximal consecutive spans where max contact > 0.5; a span breaks where the planted
// side (argmax) changes, because a new plant is a new stance even without a contact gap
function contactRuns(s) {
	const runs = [];
	let cur = null;
	for (let f = 0; f < s.contactMask.length; f += 1) {
		const [l, r] = s.contactMask[f];
		const planted = l >= r ? 0 : 1;
		const active = Math.max(l, r) > 0.5;
		if (active && cur && cur.planted === planted) {
			cur.to = f;
		} else {
			if (cur) runs.push(cur);
			cur = active ? { planted, from: f, to: f } : null;
		}
	}
	if (cur) runs.push(cur);
	return runs;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// std of one axis over a run's frames; identical values give exactly 0
function runStd(axis, s, run) {
	const xs = [];
	for (let f = run.from; f <= run.to; f += 1) xs.push(s.rootWorld[f][axis]);
	const m = mean(xs);
	return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function computeMetrics(fixture, annotation) {
	const reasons = {};
	const scored = fixture.separation.scoredFrameIndex;
	const subjects = fixture.subjects;
	const byId = (id) => subjects.find((s) => s.subjectId === id);
	const A = byId("A");
	const B = byId("B");

	// M1: fraction of frames with >= 1 contact above 0.5, mean over the two subjects.
	// With no frames the fraction is 0/0 — undefined, never the 0 a degenerate
	// fixture would read as "no contact anywhere".
	const coverage = (s) =>
		s.contactMask.reduce((n, c) => n + (Math.max(c[0], c[1]) > 0.5 ? 1 : 0), 0) / fixture.frames;
	let M1;
	if (fixture.frames === 0) {
		M1 = undefined;
		reasons.M1 = "no frames: contact coverage is 0/0";
	} else {
		M1 = (coverage(A) + coverage(B)) / 2;
	}

	// Source frame IDs are NOT row offsets. `frameIndex` is the synchronization
	// key from the source footage; the emitted arrays are rows of a possibly
	// trimmed and decimated slice, so a fixture covering source frames
	// [6,8,...,26] has 11 rows and reading `contactMask[6]` returns row 6, not
	// the row for source frame 6. Contiguous zero-based synthetic fixtures hide
	// this because ID happens to equal row. F2r already maps correctly via
	// rowOf(); this is the same contract and must agree with it.
	const frameIds = Array.isArray(fixture.frameIndex) ? fixture.frameIndex : [];
	// A degenerate zero-frame fixture legitimately carries no frameIndex and must
	// still reach the undefined-with-reason path below rather than throwing. A
	// fixture that HAS rows but no matching index is malformed, not degenerate.
	if (fixture.frames > 0 && frameIds.length !== fixture.frames) {
		throw new Error(
			`measure: frameIndex has ${frameIds.length} entries for ${fixture.frames} frames in ${fixture.clipId}`,
		);
	}
	const rowByFrame = new Map();
	frameIds.forEach((f, row) => {
		if (rowByFrame.has(f)) throw new Error(`measure: duplicate frameIndex ${f} in ${fixture.clipId}`);
		rowByFrame.set(f, row);
	});
	const rowOf = (f, who) => {
		const row = rowByFrame.get(f);
		if (row === undefined) throw new Error(`measure: ${who} references source frame ${f}, absent from frameIndex`);
		return row;
	};

	// M2: pooled per-foot precision over the hand-labelled frames; the hand label is
	// per (frame, subject), so each subject's contacts are judged against its own labels.
	// The "1.0 when no predicted contacts" convention (FEASIBILITY.md §3) applies only
	// when there ARE label frames to judge; with zero label frames precision is 0/0 —
	// undefined, not the 1 that a degenerate fixture would read as a perfect M2.
	let tp = 0;
	let fp = 0;
	for (let i = 0; i < annotation.handContact.frameIndex.length; i += 1) {
		const f = annotation.handContact.frameIndex[i];
		for (const s of subjects) {
			const c = s.contactMask[rowOf(f, "handContact")];
			const label = annotation.handContact.label[s.subjectId][i];
			for (let side = 0; side < 2; side += 1) {
				if (c[side] > 0.5) {
					if (label[side]) tp += 1;
					else fp += 1;
				}
			}
		}
	}
	let M2;
	if (annotation.handContact.frameIndex.length === 0) {
		M2 = undefined;
		reasons.M2 = "no hand-labelled frames: precision is 0/0";
	} else {
		M2 = tp + fp === 0 ? 1 : tp / (tp + fp);
	}

	// M3: mean over subjects of mean over contact runs of the mean per-axis std of the
	// solved root XZ within the run -- the planted foot is the root, so this is the
	// planted-foot jitter the plan names. A subject with NO contact runs has no jitter
	// to measure; 0 would be a vacuous pass of the jitter budget, so the per-subject
	// jitter is undefined and the aggregate is undefined with it.
	const runJitter = (s) => {
		const runs = contactRuns(s);
		if (runs.length === 0) return undefined;
		return (
			runs.reduce((sum, run) => sum + (runStd(0, s, run) + runStd(2, s, run)) / 2, 0) /
			runs.length
		);
	};
	const jitterA = runJitter(A);
	const jitterB = runJitter(B);
	let M3;
	if (jitterA === undefined || jitterB === undefined) {
		M3 = undefined;
		reasons.M3 = "no contact runs: plant jitter is unmeasured";
	} else {
		M3 = (jitterA + jitterB) / 2;
	}

	// M4: groundTruth entries whose matching observations record disagrees on identity;
	// a missing observation counts as a disagreement (the operator checked a frame the
	// tracker has no record for -- that is a failure, not a pass). With NO groundTruth
	// entries the operator checked nothing, so identity is unmeasured: 0 would read as
	// "no swaps" and let the decision function's Step 0 pass vacuously.
	let M4;
	if (fixture.association.groundTruth.length === 0) {
		M4 = undefined;
		reasons.M4 = "no groundTruth entries: identity was never checked";
	} else {
		const obsBy = new Map();
		for (const o of fixture.association.observations) obsBy.set(`${o.frameIndex}:${o.trackId}`, o);
		M4 = 0;
		for (const g of fixture.association.groundTruth) {
			const o = obsBy.get(`${g.frameIndex}:${g.trackId}`);
			if (!o || o.assignedSubjectId !== g.subjectId) M4 += 1;
		}
	}


	// M5: RMS over subjects x scored frames of |solved root - annotated foot world|;
	// the annotation must cover every scored frame or the fixture set is broken.
	// With no scored frames the RMS is 0/0 — undefined, never the 0 that would
	// pass the 0.05 m budget on an unmeasured take.
	let M5;
	if (scored.length === 0) {
		M5 = undefined;
		reasons.M5 = "no scored frames: solved-root RMS is 0/0";
	} else {
		const annIndex = annotation.footWorld.frameIndex;
		const annPos = (id, f) => {
			const i = annIndex.indexOf(f);
			if (i < 0) throw new Error(`M5: no annotated foot world position for frame ${f}`);
			return annotation.footWorld[id][i];
		};
		let m5 = 0;
		for (const f of scored) {
			const row = rowOf(f, "separation.scoredFrameIndex");
			for (const s of subjects) {
				const d = dist(s.rootWorld[row], annPos(s.subjectId, f));
				m5 += d * d;
			}
		}
		M5 = Math.sqrt(m5 / (scored.length * subjects.length));
	}

	// M6: RMS over the scored frames of | |rootA - rootB| - annotatedSeparationM |;
	// same 0/0 guard as M5.
	let M6;
	if (scored.length === 0) {
		M6 = undefined;
		reasons.M6 = "no scored frames: separation RMS is 0/0";
	} else {
		let m6 = 0;
		for (let i = 0; i < scored.length; i += 1) {
			const row = rowOf(scored[i], "separation.scoredFrameIndex");
			const err = dist(A.rootWorld[row], B.rootWorld[row]) - fixture.separation.annotatedSeparationM[i];
			m6 += err * err;
		}
		M6 = Math.sqrt(m6 / scored.length);
	}

	return { M1, M2, M3, M4, M5, M6, reasons };
}

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
	const scored = fixture.separation.scoredFrameIndex;
	const subjects = fixture.subjects;
	const byId = (id) => subjects.find((s) => s.subjectId === id);
	const A = byId("A");
	const B = byId("B");

	// M1: fraction of frames with >= 1 contact above 0.5, mean over the two subjects
	const coverage = (s) =>
		s.contactMask.reduce((n, c) => n + (Math.max(c[0], c[1]) > 0.5 ? 1 : 0), 0) / fixture.frames;
	const M1 = (coverage(A) + coverage(B)) / 2;

	// M2: pooled per-foot precision over the 100 hand-labelled frames; the hand label is
	// per (frame, subject), so each subject's contacts are judged against its own labels
	let tp = 0;
	let fp = 0;
	for (let i = 0; i < annotation.handContact.frameIndex.length; i += 1) {
		const f = annotation.handContact.frameIndex[i];
		for (const s of subjects) {
			const c = s.contactMask[f];
			const label = annotation.handContact.label[s.subjectId][i];
			for (let side = 0; side < 2; side += 1) {
				if (c[side] > 0.5) {
					if (label[side]) tp += 1;
					else fp += 1;
				}
			}
		}
	}
	const M2 = tp + fp === 0 ? 1 : tp / (tp + fp);

	// M3: mean over subjects of mean over contact runs of the mean per-axis std of the
	// solved root XZ within the run -- the planted foot is the root, so this is the
	// planted-foot jitter the plan names
	const runJitter = (s) => {
		const runs = contactRuns(s);
		if (runs.length === 0) return 0;
		return (
			runs.reduce((sum, run) => sum + (runStd(0, s, run) + runStd(2, s, run)) / 2, 0) /
			runs.length
		);
	};
	const M3 = (runJitter(A) + runJitter(B)) / 2;

	// M4: groundTruth entries whose matching observations record disagrees on identity;
	// a missing observation counts as a disagreement (the operator checked a frame the
	// tracker has no record for -- that is a failure, not a pass)
	const obsBy = new Map();
	for (const o of fixture.association.observations) obsBy.set(`${o.frameIndex}:${o.trackId}`, o);
	let M4 = 0;
	for (const g of fixture.association.groundTruth) {
		const o = obsBy.get(`${g.frameIndex}:${g.trackId}`);
		if (!o || o.assignedSubjectId !== g.subjectId) M4 += 1;
	}

	// M5: RMS over subjects x scored frames of |solved root - annotated foot world|;
	// the annotation must cover every scored frame or the fixture set is broken
	const annIndex = annotation.footWorld.frameIndex;
	const annPos = (id, f) => {
		const i = annIndex.indexOf(f);
		if (i < 0) throw new Error(`M5: no annotated foot world position for frame ${f}`);
		return annotation.footWorld[id][i];
	};
	let m5 = 0;
	for (const f of scored) {
		for (const s of subjects) {
			const d = dist(s.rootWorld[f], annPos(s.subjectId, f));
			m5 += d * d;
		}
	}
	const M5 = Math.sqrt(m5 / (scored.length * subjects.length));

	// M6: RMS over the scored frames of | |rootA - rootB| - annotatedSeparationM |
	let m6 = 0;
	for (let i = 0; i < scored.length; i += 1) {
		const f = scored[i];
		const err = dist(A.rootWorld[f], B.rootWorld[f]) - fixture.separation.annotatedSeparationM[i];
		m6 += err * err;
	}
	const M6 = Math.sqrt(m6 / scored.length);

	return { M1, M2, M3, M4, M5, M6 };
}

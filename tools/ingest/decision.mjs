/**
 * Phase-0 feasibility decision function (plan §10.3).
 *
 * GVHMR's real-footage contact quality is unmeasured (driver D2), so Phase 0
 * decides GO/STOP from six metrics per candidate mode before any
 * feasibility-dependent code is written. The procedure is ordered, mutually
 * exclusive and exhaustive: the first satisfied branch wins, Step 4 is an
 * unconditional else, so no reachable metric tuple falls through.
 *
 * Threshold provenance (plan §10.3): contact budget 0.05 m (research 12 §5);
 * calibration may consume up to 0.03 m (plan §9), so a GO solver's root error
 * must be <= 0.05 m and separation error <= 0.08 m; degraded modes get
 * 0.08 / 0.12 m and must display "spacing may read soft" with separate
 * telemetry. STOP is a legitimate Stage-A-complete outcome.
 *
 * Green gate: plan §10.2 closes with "F3 cannot select a mode whose runner and
 * measurement path are not both green". Each mode therefore carries
 * runnerGreen/measurementGreen; a branch whose mode is not green on both paths
 * is unsatisfied and the procedure falls through to the next branch. A mode
 * that would otherwise GO but is not green can never be selected — the
 * consequence is either a lower branch or STOP:accuracy.
 *
 * The selected mode is a contract value carried in the take's provenance;
 * this function only computes it, it does not record it.
 */

/**
 * Decide the Phase-0 feasibility verdict.
 *
 * @param {object} metrics
 * @param {number} metrics.m1  contact coverage fraction, [0,1]        (M1)
 * @param {number} metrics.m2  contact precision on 100 label frames   (M2)
 * @param {number} metrics.m4  identity-swap count on 20 sampled frames (M4)
 * @param {object} metrics.modes  per-mode measurements:
 *   "contact-head"  { m3, m5, m6, runnerGreen, measurementGreen }
 *   "lowest-foot"   { m3, m5, m6, runnerGreen, measurementGreen }
 *   "manual-anchor" { m3, m5, m6, runnerGreen, measurementGreen }
 * @returns {{verdict:"GO"|"STOP", mode:"contact-head"|"lowest-foot"|"manual-anchor"|null,
 *            degraded:boolean, reason:string,
 *            display:{spacingMayReadSoft:boolean}}}
 *   GO carries the selected mode and its branch as reason; STOP carries
 *   reason "identity" (M4 > 0) or "accuracy" (no GO branch satisfied) and
 *   mode null — a STOP selects nothing.
 */
export function decideFeasibility(metrics) {
	// Step 0: identity failure is mode-independent and dominates every branch.
	if (metrics.m4 > 0) {
		return { verdict: "STOP", mode: null, degraded: false, reason: "identity", display: { spacingMayReadSoft: false } };
	}

	const ch = metrics.modes["contact-head"] ?? {};
	const lf = metrics.modes["lowest-foot"] ?? {};
	const ma = metrics.modes["manual-anchor"] ?? {};

	// The green gate (plan §10.2): a branch whose mode did not report both its
	// runner and its measurement green is unsatisfied, whatever the metrics —
	// the procedure falls through instead of selecting that mode.
	const green = (m) => m.runnerGreen === true && m.measurementGreen === true;

	// Step 1: contact-head. Rationale (plan §10.3): the contact budget is
	// 0.05 m (research 12 §5) and calibration may consume up to 0.03 m
	// (plan §9), so a GO solver's root error must be <= 0.05 m and its
	// separation error <= 0.08 m. M5 is thresholded at every GO branch.
	if (
		green(ch) &&
		metrics.m1 >= 0.6 && metrics.m2 >= 0.85 &&
		ch.m3 <= 0.03 && ch.m5 <= 0.05 && ch.m6 <= 0.08
	) {
		return { verdict: "GO", mode: "contact-head", degraded: false, reason: "contact-head", display: { spacingMayReadSoft: false } };
	}

	// Step 2: lowest-foot, degraded. Root/separation headroom widens to
	// 0.08 / 0.12 m; the looser spacing budget is why the display flag exists.
	if (green(lf) && lf.m3 <= 0.05 && lf.m5 <= 0.08 && lf.m6 <= 0.12) {
		return { verdict: "GO", mode: "lowest-foot", degraded: true, reason: "lowest-foot", display: { spacingMayReadSoft: true } };
	}

	// Step 3: manual-anchor, degraded — same widened budget as lowest-foot.
	if (green(ma) && ma.m3 <= 0.05 && ma.m5 <= 0.08 && ma.m6 <= 0.12) {
		return { verdict: "GO", mode: "manual-anchor", degraded: true, reason: "manual-anchor", display: { spacingMayReadSoft: true } };
	}

	// Step 4: the unconditional else — totality lives or dies here. STOP is a
	// legitimate Stage-A-complete outcome and escalates rather than guessing.
	return { verdict: "STOP", mode: null, degraded: false, reason: "accuracy", display: { spacingMayReadSoft: false } };
}

# Phase-0 Feasibility Record — CozyClay video→motion ingest

**Status: NO REAL-FOOTAGE DECISION HAS BEEN MADE.** Every number in §4 below is
recomputed from the **SYNTHETIC** solver-output fixtures (zero-error synthetic
ground truth produced by the F2a–c feasibility runners), not from GVHMR output on
real footage. Nothing in this file selects a production solver. **STOP is a
legitimate Stage-A-complete outcome**; a Phase-0 record that ends in
STOP:identity or STOP:accuracy is a finished Phase 0, not a failure.

The machine-readable record is the `json` block in §4 — `verify-feasibility-reproducible.mjs`
parses exactly that block and asserts every recorded metric equals a fresh
recomputation from the hashed fixtures. The markdown table below it is a human
mirror of the same numbers.

## 1. Pinned solver (UNRESOLVED — pending operator run)

| item | value | status |
|---|---|---|
| GVHMR commit | `0000000000000000000000000000000000000000` (placeholder) | **UNRESOLVED — pending operator run on the GPU box** |
| weights sha256 | `0000000000000000000000000000000000000000000000000000000000000000` (placeholder) | **UNRESOLVED — pending operator run on the GPU box** |

These two fields MUST be filled from the pinned GVHMR run before any
real-footage decision is recorded. A real-footage decision made against the
placeholders is void by construction: nobody has run GVHMR here. The synthetic
fixtures carry the same zero-hex sentinels in `provenance.gvhmrCommit` /
`provenance.weightsSha256` and `provenance.synthetic: true` for exactly this
reason.

## 2. Source material manifest (plan §10.1, research 13 §4)

The four Phase-0 sources live in the gitignored directory
`tools/ingest/fixtures-external/`, each with a `MANIFEST.json` row of
`{ "file": …, "url": …, "licence": …, "sha256": … }`. Footage never enters the
repo; `sha256` values are recorded at download time and are **UNRESOLVED until
the operator downloads the files**.

| file | source | licence | url |
|---|---|---|---|
| `Boxing_Match_Gunnar_Barlund_vs_Denis_Juliani_at_Helsinki_3.6.1947.webm` (9.3 MB) | Wikimedia Commons — Helsinki 1947 pro fight | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Boxing_Match_Gunnar_B%C3%A4rlund_vs_Denis_Juliani_at_Helsinki_3.6.1947.webm |
| `Boxing_Match_Yrjo_Piitulainen_vs_Jean_Wanes_at_Helsinki_30.9.1947.webm` (19.9 MB) | Wikimedia Commons — Helsinki 1947 pro fight | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Boxing_Match_Yrj%C3%B6_Piitulainen_vs_Jean_Wanes_at_Helsinki_30.9.1947.webm |
| `TheCorbettFitzsimmonsFight` (1897) | archive.org — public-domain fight film | Public domain | https://archive.org/details/TheCorbettFitzsimmonsFight |
| `JackDempseyVsGeneTunney` (1927) | archive.org — public-domain fight film | Public domain | https://archive.org/details/JackDempseyVsGeneTunney |

Research 13 §4 alternates from the same archive.org corpus if either primary
fails preflight: `the-corbett-fitzsimmons-fight-1897` (LoC copy),
`JackJohnsonVsJamesJJeffries` (1910), `JackDempseyVersusTommyGibbons` (1923).

## 3. The six metrics (plan §10.2)

Mode-independent: **M1** contact coverage = mean over the two subjects of the
fraction of that subject's frames with max(l,r) > 0.5; **M2** contact precision
vs the 100 hand-labelled frames (`annotation.json`), pooled per-foot
TP/(TP+FP) over (label frame, subject, foot side), 1.0 when no predicted
contacts; **M4** identity swaps on the 20 sampled frames = count of
`association.groundTruth` entries whose matching observation disagrees on
`assignedSubjectId` (a missing observation counts as disagreeing).
Mode-dependent: **M3** plant jitter = mean over subjects of the mean over
contact runs of (stdX + stdZ)/2 of the solved root within the run, where a run
is a maximal span with max(l,r) > 0.5 and a constant planted side (argmax of
l,r — a new plant is a new stance); **M5** solved-root RMS vs the hand-annotated
foot world positions (`footWorld`, in `annotation.json`) on the 20 scored
frames; **M6** inter-fighter separation error = RMS over the scored frames of
(|rootWorld_A[f] − rootWorld_B[f]|) − `annotatedSeparationM[k]`. These are the
runner-side conventions as implemented in
`tools/ingest/feasibility/measure.mjs`; the gate reimplements them
independently and must reproduce the same numbers.

## 4. Recorded results — SYNTHETIC ONLY, not a real-footage result

Fixtures: `test/ingest/fixtures/solver-output/synthetic-boxing-01/`
(`contact-head.json`, `lowest-foot.json`, `manual-anchor.json`, `annotation.json`),
each sha256-verified before replay. `synthetic: true` below is asserted by the
gate — if a real-footage run ever replaces these numbers, this flag and the
pinned-solver fields in §1 must change with them, or the gate fails.

```json
{
  "synthetic": true,
  "fixtureDir": "test/ingest/fixtures/solver-output/synthetic-boxing-01",
  "metrics": {
    "contact-head": { "m1": 1, "m2": 1, "m4": 0, "m3": 1.7671049808617076e-16, "m5": 0, "m6": 0 },
    "lowest-foot": { "m1": 1, "m2": 1, "m4": 0, "m3": 1.7671049808617076e-16, "m5": 0, "m6": 0 },
    "manual-anchor": { "m1": 1, "m2": 1, "m4": 0, "m3": 1.7671049808617076e-16, "m5": 0, "m6": 0 }
  },
  "decision": { "verdict": "GO", "mode": "contact-head", "degraded": false, "reason": "contact-head", "signOff": "", "syntheticOnly": true }
}
```

| mode | M1 | M2 | M4 | M3 (m) | M5 (m) | M6 (m) |
|---|---|---|---|---|---|---|
| contact-head | 1.000000 | 1.000000 | 0 | 0.000000 | 0.000000 | 0.000000 |
| lowest-foot | 1.000000 | 1.000000 | 0 | 0.000000 | 0.000000 | 0.000000 |
| manual-anchor | 1.000000 | 1.000000 | 0 | 0.000000 | 0.000000 | 0.000000 |

## 5. §10.3 decision record

Recomputed from §4's metrics with the §10.3 ordered procedure (first satisfied
branch wins; Step 4 otherwise). All three runner + measurement paths are taken
as green — the F2a–c synthetic-GT controls pass on these fixtures — so the
green gate does not alter the outcome.

- **Verdict / mode / reason:** GO — **contact-head** — contact-head
- **Why:** M4 = 0 (no identity swaps); M1 = 1 ≥ 0.60 and M2 = 1 ≥ 0.85;
  M3 ≈ 1.77e-16 ≤ 0.03 m, M5 = 0 ≤ 0.05 m and M6 = 0 ≤ 0.08 m, so Step 1 is
  the first satisfied branch. On synthetic data this records the *procedure*
  working end to end — it is not a verdict about any real footage.
- **Degraded display flag ("spacing may read soft"):** false — contact-head is
  the primary mode; no degraded mode was selected
- **Recomputed by:** `test/ingest/verify-feasibility-reproducible.mjs`
- **Operator sign-off: ____________________________________** (left blank — no
  real-footage decision has been made and none may be recorded until §1's
  pinned solver fields are filled)

The selected mode, once a signed real-footage decision exists, is a contract
value carried in the take's `provenance`.

## 6. Re-running the gate (GPU-free, forever)

```
node test/ingest/verify-feasibility-reproducible.mjs
node test/ingest/verify-decision-function.mjs
```

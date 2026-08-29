# ProjFlow line editing — work plan & frozen contracts (2026-08-29)

Goal: "draw a line on screen, the joint follows it EXACTLY" — adopt
ProjFlow (CVPR 2026, zero-shot projection sampler on the ACMDM flow
backbone) as CozyClay's line-editing engine, alongside Kimodo (text
generation + whole-take preservation, unchanged).

Paper: arXiv 2602.22742. Code: github.com/Akihisa-Watanabe/ProjFlow.
Checkpoints: huggingface.co/Akihisa-Watanabe/ProjFlow —
ACMDM_Raw_Flow_S_PatchSize22 (625 MB) is the target; XL (9.5 GB) does
not fit the 3070 and is out of scope.

## Why (measured claims from the paper, to be re-verified on our box)

- Trajectory/location/average control error: 0.0000 (exact, zero-shot),
  FID 0.097-0.107 — the only method with code that is both training-free
  and exact.
- 2D-to-3D lifting is native (reprojection error 0.000): the user draws
  in SCREEN SPACE and depth is the model's problem, not the UI's.
- Motion inpainting (preserve-while-editing) is built into the sampler:
  base-take frames become observations; no RePaint blending needed on
  this path.
- Known weaknesses (paper's own): foot skating up to 0.146 on 2D tasks;
  LINEAR constraints only (no "stay above the floor" inequalities);
  no speed numbers published; NO LICENSE file in the repo.

## How it runs in our stack (target architecture)

```
app: select frame range + track -> draw 2D polyline on the viewport
  -> { track, points2d, frameRange, camera{R,s}, sourceMotion, strength? }
bridge: validate -> route line edits to the projflow backend
box: ACMDM + ProjFlow sampler
  y_hard = drawn line (Sigma=0)  +  y_soft/hard = base-take frames
  outside the edit range (this IS the preservation)
  per ODE step: predict clean x1 -> closed-form projection under the
  kinematics-aware metric R (skeleton Laplacian) -> renoise
box out: HumanML3D 22-joint motion -> hml22->cskel27 -> npz
app: splice into the take (outside edit range = byte-identical source)
```

## Engine roles after adoption

| engine | job |
|---|---|
| Kimodo | text->motion generation, whole-take preserve regeneration (as shipped) |
| ProjFlow | line edits: exact trajectory following, 2D->3D |
| ARDY | unchanged |

## Parallelization topology

Phase 0 runs TWO agents in parallel because the two unknowns are
independent: S1's questions (does it run? how fast?) need the GPU and
nothing from S2; S2's questions (skeleton mapping, license) need no GPU
and nothing from S1. Phase 1 splits by file ownership exactly like
rounds 1-2: three wave-1 agents share zero files; wave-2 needs wave-1's
contracts only, not their code, so it launches on contract freeze; the
main session merges, registers tests, and runs every box gate itself.

```
Phase 0 (parallel 2): S1 box scouting | S2 skeleton+license study
  -> GO/NO-GO (main session decides)
Phase 1 wave 1 (parallel 3): M1 runner | M2 converter | M3 draw UI
Phase 1 wave 2 (parallel 2): M4 bridge routing | M5 splice-back
Phase 2 (main session, serial): gates GP1-GP5 on the box
```

## Phase 0 — scouting

### S1 (box, GPU) — SUCCESS CRITERIA (all measurable; report numbers)
1. Env builds on ubuntu-baremetal from environment.yml (or a minimal
   pip equivalent if conda solve fails — document deviations), S
   checkpoint downloaded, text->motion demo produces a motion file.
2. MEASURED: wall time for a ~5 s clip (3 runs, report each), VRAM peak
   (nvidia-smi), disk used. The single most important number of the
   phase — the paper publishes none.
3. Inpaint demo (demo/inpaint/run_inpaint.py) runs on a REAL prior
   motion: keep frames A..B fixed, regenerate the rest; verify kept
   frames match the input (numeric diff on kept joints < 1e-3) —
   proves preserve-while-editing works zero-shot.
4. Trajectory-control demo (demo/configs/*.yaml) runs; report which
   configs exist and what constraint shapes they accept (this becomes
   the C6 wire format ground truth).
5. Copy all produced motion files + exact commands + timings into the
   scratchpad scouting dir. NOTHING installed outside a dedicated
   directory on the box; no existing service touched.
FAIL = any of: env unbuildable in <= ~1h of effort, demo crashes
unresolvable, 5 s clip > 60 s wall. Report the blocker precisely.

### S2 (local, no GPU) — SUCCESS CRITERIA
1. A joint-mapping table hml22 (HumanML3D/SMPL 22) <-> cskel27 with an
   explicit rule for every unmatched joint on BOTH sides (cskel27 toes/
   ends have no hml22 source; document fill rule), written as a
   prototype module + round-trip test: cskel27 pose -> hml22 -> cskel27
   with positional error measured and reported (target < 5 cm per
   joint on a real fixture pose; report actuals).
2. License due diligence: ProjFlow repo license status, ACMDM backbone
   license, HumanML3D/AMASS terms — one paragraph each with links, and
   a draft author inquiry (EN) for productization permission.
3. Camera-model gap note: paper assumes orthographic with known R,s;
   CozyClay's shot camera is perspective — quantify when the
   approximation holds (focal length / distance rule of thumb).
FAIL = a joint with no defensible mapping rule, or license terms that
prohibit even evaluation (report and stop).

## GO/NO-GO after Phase 0 (main session)
GO requires: 5 s clip <= 10 s wall on the 3070 AND inpaint demo
verifiably preserves kept frames AND no license red flag for evaluation.
Speed 10-60 s => downgrade to "batch line editing" scope and reassess
MotionLCM for the interactive path. Inpaint failure => NO-GO (the whole
preserve story collapses).

## Phase 1 contracts (frozen NOW so wave 2 never waits on wave 1)

### C6 — line-edit request (bridge)
```json
"lineEdit": {
  "sourceMotion": "/ardy/motions/<run-id>",
  "track": "leftHand",              // one of the 15 ik track ids
  "frameRange": { "startFrame": 48, "endFrame": 72 },   // app clip frames
  "points2d": [[x, y], ...],        // viewport-normalized 0..1, >= 2 points
  "camera": { "rotation": [...], "scale": s },  // orthographic approx of the shot camera
  "prompt": "..."                   // optional text condition passthrough
}
```
- Exclusive with: waypoints, segments, regenerateSegments, preserve,
  motionEdit (v1: a line edit is its own run mode).
- Bridge routes lineEdit to the projflow backend regardless of
  CCLAY_MOTION_BACKEND (engine-per-task, not engine-per-session).

### C7 — box CLI wrapper (tools/projflow/)
Mirror tools/kimodo exactly: generate.mjs owns ssh/scp and the
generation clock; runner.mjs exposes the backend interface; env
CCLAY_PROJFLOW_HOST (defaults to CCLAY_KIMODO_HOST). Wire format to the
python side is whatever S1 finds the demos accept — S1's report is the
authority; M1 must not invent flags.

### C8 — converter (tools/projflow/hml22-to-cskel27.mjs)
`hml22ToCskel27Motion(raw) -> {frames, fps, rotMats, rootPos, posedJoints}`
(same output shape as soma77ToCskel27Motion so everything downstream —
npz writer, measure-preserve, playback — works unchanged). S2's mapping
table is the input; M2 productionizes it.

## Phase 1 file ownership (NO agent edits tools/run-tests.mjs)

| agent | files |
|---|---|
| M1 | tools/projflow/generate.mjs, tools/projflow/runner.mjs (new) |
| M2 | tools/projflow/hml22-to-cskel27.mjs, test/verify-projflow-cskel27.mjs (new) |
| M3 | src/App.jsx (line-draw mode), src/styles.css |
| M4 | tools/ardy/bridge.mjs, test/verify-projflow-bridge.mjs (new) |
| M5 | tools/projflow/splice.mjs (new; reuses src/ardy motion-edit splice), test additions in verify-projflow-bridge.mjs coordination via M4's file — if contention, M5 gets test/verify-projflow-splice.mjs |

## Phase 2 gates (main session, box, fixed seeds)

- GP1 exactness: drawn-line reprojection error < 1 px equivalent on a
  20-point polyline; include one close-up-camera case to expose the
  orthographic approximation.
- GP2 preservation: outside the edit range, L2P vs the source take at
  or below the Kimodo preserve level (~0.005) after splice-back
  (splice makes it 0 by construction outside the range — measure the
  BLEND SEAMS at range edges instead: no frame-to-frame pop > the
  take's own median frame delta).
- GP3 speed: full round trip (app request -> spliced take) <= 10 s
  (or the Phase-0-calibrated target).
- GP4 side effects: foot-skating delta vs the source take within
  +0.002 m/frame per joint after our post-processing; converter
  round-trip error < 5 cm/joint; full node suite green.
- GP5 eyeball: reproduce the paper's heart demo in OUR app — walk take,
  draw a heart with the left wrist, ship the before/after npz.

## Phase 0 RESULTS (2026-08-29) — GO

S1 (box): 5 s clip samples in 0.85 s (100 steps; 7.3 ms/step, 20-step
preview 0.145 s); VRAM 793 MiB beside the ardy service; preserve via
sample_projflow hard mask = 4.8e-7 m on kept frames; 2D reprojection
2.4e-7 under a tilted ortho camera. Install: python3.10 venv, pins
numpy==1.23.5, timm==1.0.9, preview renderer disabled (matplotlib API).
Env at box:/home/yun/projflow-scout/. Output format: motion_00_world.npy
(T,22,3) float32 world positions @20 fps — POSITIONS ONLY, no rotations.
S2 (skel): 3 direct/19 renamed/5 filled joints; all 15 line-edit tracks
round-trip <= 0.6 cm (gate 5 cm, 8x margin); only filled thumbs exceed
(4.7-6.1 cm, un-editable). Axial twist is unrecoverable from positions
(26-55 deg on arms/wrist) — positions are sub-mm, rotations approximate.
License: EVALUATION clear. PRODUCTIZATION blocked upstream by AMASS
non-commercial training clause (not by the missing repo LICENSE);
escape hatch = retrain the small ACMDM-S prior on a licensed corpus
(ProjFlow itself is training-free/prior-agnostic). Author email drafted.

## CONTRACT AMENDMENTS from Phase 0 (supersede the sections above)

- C6: camera field REPLACED by per-frame affine rows. Perspective is
  exactly linear after cancelling the depth division:
  [fx*R0 - (u-cx)*R2] x = -[fx*t0 - (u-cx)*t2] — two rows per
  constrained frame. No orthographic approximation, valid at every
  focal length. The app sends {points2d, frameRange, track} plus the
  shot camera intrinsics/extrinsics; the BOX-side driver builds the
  rows. (The demo CLI only accepts ortho (R,s) — irrelevant: M1 drives
  sample_linear_constraints directly with a general A, per S1.)
- C7: M1 does NOT shell to demo/run.py or run_inpaint.py. It ships a
  small python driver (box-side, under tools/projflow/) that fuses:
  identity rows for preserved source frames (subsampled — Cholesky is
  m x m, do not freeze 196 frames x 22 joints densely; every 2nd-3rd
  frame and/or non-edited joints only) + the per-frame affine 2D rows
  for the drawn line. ridge_lambda 1e-6. steps: 100 final / 20 preview.
- C8: input contract is POSITIONS (T,22,3), not rotations. The
  converter LIFTS rotations: aim-based bone frames + inherited twist
  (S2 prototype proto-hml22-cskel27.mjs is the reference; two-vector
  frames on hips/shoulders are exact). Output shape contract unchanged
  (same as soma77ToCskel27Motion).
- GP1: the <1 px gate now applies at ALL focal lengths (affine rows),
  including the close-up case.
- GP4 carve-out: "< 5 cm on every hml22-DRIVEN joint"; the 5 filled
  joints (Spine2, hand ends, thumbs) are accepted losses. Twist error
  on arms is expected — measure and report, don't gate on it v1.

## Kill criteria (standing)
- Phase 0 speed > 60 s / 5 s clip: stop, report, pivot to MotionLCM scout.
- Inpaint demo cannot preserve: stop (NO-GO).
- Converter round-trip > 15 cm/joint on real poses: stop before Phase 1
  wave 2 (the skeleton gap would poison every gate).

## Risks
- Speed unknown (paper silent) — Phase 0's first measurement.
- No repo LICENSE — evaluation fine; productization blocked on author
  reply (S2 drafts it).
- Perspective-vs-orthographic camera — GP1 close-up case.
- Foot skating (paper-admitted) — our postprocess + GP4.
- hml22 lacks toes/hand-ends that cskel27 has — S2 rule, M2 test.

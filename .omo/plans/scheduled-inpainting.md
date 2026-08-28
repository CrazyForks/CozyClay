# Scheduled Inpainting — frozen contracts (2026-08-28)

Goal: Kimodo generation that PRESERVES an existing take while regenerating only
what the user edited, via inference-time scheduled inpainting
(Disney "Interactive Generative Motion Editing via Scheduled Inpainting", 2026).

Core equation, applied inside the denoising loop (RePaint-style):
  x_blended = alpha_t * noise(base, t) + (1 - alpha_t) * x_gen
  alpha_t   = alpha_time(t; sigma_s, sigma_e) * alpha_mask(frame)
  alpha_time = 1            when t > sigma_s
             = (t-sigma_e)/(sigma_s-sigma_e)  when sigma_e <= t <= sigma_s
             = 0            when t < sigma_e
(t in diffusion-time units 0..1000. High noise -> preserve structure from base;
low noise -> model finishes freely.)

HARD RULE: `twostage_denoiser.py:102` (the binary observed_motion input channel)
is trained binary and MUST NOT be changed. All blending happens in the sampling
loop on the evolving sample, outside the denoiser's input contract.

## C1 — Preserve-mask JSON (per-frame, v1)

```json
{
  "version": 1,
  "genFps": 30,
  "genFrames": 180,
  "weights": [1.0, 1.0, "... genFrames floats in 0..1 ..."]
}
```
- `weights[f]` = alpha_mask for generation frame f. 1 = fully preserve base,
  0 = free generation. Dense array, length exactly `genFrames`.
- Built from edits with a Gaussian falloff (mu = influence radius in gen
  frames); edges must taper, never step (paper: square kernel = broken).
- Reserved for v2 (do NOT implement): `jointWeights`.

## C2 — Kimodo CLI flags (scripts/generate.py)

```
--base_motion <path.npz>     # a kimodo-native output npz (same format generate saves)
--preserve_start <int>       # sigma_s, 0..1000, default 500
--preserve_end <int>         # sigma_e, 0..1000, default 50, must be <= sigma_s
--preserve_mask <path.json>  # C1 file; optional, default = all ones
```
- `--base_motion` absent => behavior BIT-IDENTICAL to current code (same seed
  => same output). This is the non-negotiable regression invariant.
- `sigma_s = 0` => inpainting fully off even with a base motion.

## C2b — Base-motion prep API (kimodo/preserve_prep.py, new file)

```python
prepare_base_motion(npz_path, motion_rep, target_frames, target_fps=30)
  -> (base_normalized: Tensor[target_frames, motion_rep_dim], meta: dict)
```
- Loads a kimodo output npz, resamples to target_fps/target_frames (linear on
  positions, slerp-equivalent on rotations is NOT required v1 — nearest/linear
  on the rep is acceptable, document the choice), re-canonicalizes (smoothed
  root XZ at frame 0 -> origin), encodes via motion_rep, then
  motion_rep.normalize. Output is ready to noise-and-blend.
- meta records: source_fps, source_frames, resample_ratio, canonical_offset.

## C3 — Bridge request field (wave 2)

```json
"preserve": {
  "sourceMotion": "/ardy/motions/<run-id>",
  "strength": 0.5,
  "editRanges": [{ "startFrame": 40, "endFrame": 80 }]
}
```
- App frames (20 fps clip space); scaling to gen space happens in the mask
  builder, same rule as root2d constraints.
- strength s in [0,1]: s=0 => preserve off; else
  sigma_s = max(50, round(1000*(1-s))), sigma_e = min(50, sigma_s).
  Default 0.5 (= paper's recommended 500/50, unchanged by the inversion).
  AMENDED after gate G3: alpha_time is 1 ABOVE sigma_s, so a smaller sigma_s
  preserves MORE; the original round(1000*s) made the slider work backwards.
  Measured (all-ones mask, seed 5678): sigma_s 200/500/800/1000 ->
  L2P 0.00455/0.00467/0.00480/0.00487.
- Mutually REQUIRES posePin rules to stay valid; cannot combine with
  `regenerateSegments`.

## C4 — File ownership (agents must not touch files outside their row)

| Agent | Files |
|---|---|
| A | CozyClay: tools/kimodo/measure-preserve.mjs (new) |
| B | kimodo-custom: kimodo/model/kimodo_model.py, kimodo/scripts/generate.py |
| C | CozyClay: tools/kimodo/preserve-mask.mjs (new), test/verify-kimodo-preserve.mjs (new) |
| D | kimodo-custom: kimodo/preserve_prep.py (new), tests/test_preserve_prep.py (new) |
| E | CozyClay: tools/ardy/bridge.mjs, tools/kimodo/generate.mjs, tools/kimodo/runner.mjs, src/ardy/pose-pin.js |
| F | CozyClay: src/App.jsx (preserve slider region), src/styles.css |

NO agent commits. Files only; main session commits after merge review.

## Acceptance gates (wave 3, on the box, fixed seed)

- G1 reconstruction: no edits + strength 0.5 => L2P vs base >= 10x better than
  the no-preserve baseline. FAIL => STOP the project, report.
- G2 locality: one edited range; frames outside the Gaussian influence keep
  G1-level L2P; frames inside move toward the edit.
- G3 monotonicity: strength 0.2 / 0.5 / 0.8 => L2P-to-base strictly decreasing
  with strength, constraint error strictly increasing.
- G4 no side effects: foot sliding within +1mm/frame of baseline; 2-segment
  seam jump <= 0.4 m; all existing verify-* suites green.
- G5 eyeball: before/after render side by side.

## Gate results (2026-08-29, box run, Kimodo-SOMA-RP-v1.1, RTX 3070)

Prompt "a person walks forward, then turns left and keeps walking", 5 s,
150 gen frames @30 -> 120 @24. Take A seed 1234; everything else seed 5678.

- no-preserve baseline: L2P 0.072930 m
- G1 (500/50, all-ones): L2P 0.004670 -> 15.6x improvement. PASS
- sigma_s=0 control: bit-identical to no-preserve run. Regression invariant PASS
- G2 (edit [48,72) app frames): out-of-range 0.005104 (1.09x G1), in-range
  0.037644 (7.4x out). PASS
- G3: monotone but in the WRONG direction under the original mapping ->
  mapping inverted (see C3 amendment). With the inversion the measured curve
  is strictly tighter as strength rises. PASS after fix
- G4: preserve runs slide LESS than the base (delta negative); suite 97 files
  green. PASS
- Known follow-ups: preserve_prep device fix landed (arange needed device=);
  whole-clip-only base retention means edited takes have no base lineage yet
  (bridge logs `preserve SKIPPED`); influenceRadius 10 ramp covers 86 frames
  on a 120-frame clip — tune before shipping; every run 15-16 s wall.

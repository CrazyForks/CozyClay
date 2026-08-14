# RawTrack Contract (F1 deliverable)

**Status: ALL SEVEN SLOTS ARE UNRESOLVED.** No GVHMR output has been seen yet.
Every slot below becomes "resolved" only when an operator runs
`tools/ingest/dump-gvhmr.py` on real GVHMR output and the §8.4 acceptances are
checked on the pinned fixture. This document is the Stage B contract input
(plan stage-05 §8.4, §10.1); Stage B commits are written after the F1 review,
never before.

The GPU-free half of F1 is done and testable today:

- `tools/ingest/dump-gvhmr.py` — operator script (numpy-free `--selftest` for
  its slot-resolution logic; `python3 -m py_compile` clean).
- `test/ingest/verify-gvhmr-schema.mjs` — contract validator + the §8.4
  numeric acceptances on synthetic fixtures (exit 0 = green).
- `test/ingest/fixtures/rawtrack/*.json` — synthetic fixtures (one good, six
  deliberate negatives). Each carries `"synthetic": true` in provenance.

---

## 1. What RawTrack is

`RawTrack` is the S1 extract (plan §8.5): the decimated, hashed JSON slice of
one GVHMR run over one take, **in camera space, with no world roots**. It
supplies `K` (full-image intrinsics) only — `R_ring_from_cam`, `t_ring_from_cam`
come from `FloorFrame` (plan §8.1). Synchronization keys are `frameIndex`
(source frame numbers) and `timeS` (seconds from take start); decimation keeps
the source frame numbers, so the slice stays synchronized with the footage.

Every fixture is verified by sha256 before replay: the hash covers the whole
document in canonical form (`JSON.stringify(JSON.parse(...))` in Node —
insertion key order, integral floats written as integers) with the `sha256`
field itself excluded. `dump-gvhmr.py` computes the identical hash.

## 2. The F1 acceptance table (plan §8.4, copied verbatim)

Accepted only when, on the pinned fixture:

| id | slot | acceptance |
|---|---|---|
| F1-α | camera-frame global orientation | **named tensor + dtype/shape/units**; §8.3's yaw equation reproduces a hand-measured facing on 10 sampled frames within **5°** |
| F1-β | body-model canonical facing axis | **named**; the neutral rest pose yields `yawWorld = 0` within **2°** |
| F1-γ | camera-frame translation | **named + units**; §8.3's velocity integrates to the hand-annotated displacement on a 20-frame window within **5 cm** |
| F1-δ | full-image 2D foot observations | **named**, or the exact derivation from crop-space keypoints + the crop transform; reprojecting a known ankle lands within **3 px** |
| F1-ε | foot-contact values | **named**, with the logit/probability convention and threshold semantics stated |
| F1-ζ | body pose / joint ordering / rest basis | **named**; the cskel27 mapping reproduces the model's own joint positions within the existing FK parity tolerance (cf. `test/ardy/verify-fk.mjs`) |
| F1-η | handedness, up-axis, fps, crop transform | **named** and asserted by fixture round-trip |

Any slot that cannot be satisfied is **escalated, not guessed**.

## 3. What each slot means downstream

| id | feeds | consequence of a guess |
|---|---|---|
| F1-α | §8.3 `yawWorld[f] = atan2(...)`; S3 worldsolve | every fighter faces the wrong way |
| F1-β | the `e_forward` axis in §8.3 | yaw is garbage even with a correct α |
| F1-γ | §8.3 `v_ring[f]`; S3 root trajectories | punches land in the wrong place |
| F1-δ | §8.2 ray→plane foot rays (C4b, S3) | foot placement has no supplier (plan §16 S5) |
| F1-ε | contact mask → M1/M2 (Phase 0) | contact coverage is unmeasurable |
| F1-ζ | body-model → cskel27 mapping (C7) | the whole converter is built on an unverified joint order |
| F1-η | every coordinate readout | left/right or up/down flips in the scene |

## 4. Fixture shape

```jsonc
{ "schemaVersion": 1, "kind": "RawTrack", "clipId": "...", "fps": 29.97,
  "frames": 186, "frameIndex": [ ... ], "timeS": [ ... ],
  "slots": {
    "F1-α": { "status": "resolved"|"UNRESOLVED", "tensor": "...", "dtype": "...",
              "shape": [...], "units": "..." , ... },
    ... one record per slot; "UNRESOLVED" records carry "reason": "..." ...
  },
  "data": { "<named tensor>": [...], "K": [[...]], "crop": {...},
            "handedness": "...", "upAxis": "...", "bodyModel": "..." },
  "verification": { /* hand-measured references, §6 */ },
  "provenance": { "command": "...", "sourceUrl": "...", "licence": "...",
                  "sourceSha256": "...", "trimStartS": ..., "trimEndS": ...,
                  "gvhmrCommit": "<40-hex>", "weightsSha256": "<64-hex>",
                  "annotationPath": "..." },
  "sha256": "..." }
```

A resolved slot must name its tensor with dtype/shape/units (F1-δ may instead
supply `derivation: {from, via}`); an unresolved slot must carry a reason.
`verify-gvhmr-schema.mjs` rejects a fixture where F1-δ is neither named nor
derived with the named error `F1-DELTA-UNRESOLVED` ("no full-image foot
observation named and no derivation supplied").

## 5. The operator run (GPU box)

Prerequisites: a pinned GVHMR commit + weights sha256 (recorded in
`tools/ingest/FEASIBILITY.md`), the footage's url/licence/sha256 from the
`fixtures-external/MANIFEST.json` policy, and a GVHMR output directory holding
the per-take tensors (`.npz`/`.pkl`) plus a metadata json naming `fps`, `crop`
and `model` (the script reads those keys when present; absent metadata makes
the affected slots UNRESOLVED with the reason stated).

```bash
python3 tools/ingest/dump-gvhmr.py \
    --input <gvhmr-out-dir> \
    --output tools/ingest/fixtures-external/rawtrack/<clipId>.json \
    --clip-id <clipId> \
    --source-url <url> --licence <licence> --source-sha256 <sha256> \
    --gvhmr-commit <40-hex> --weights-sha256 <64-hex> \
    --trim-start 41.5 --trim-end 47.2 \
    --annotation-path <hand-annotation-file> \
    [--max-bytes 2097152]
```

The script: (a) enumerates the seven §8.4 slots and resolves each against what
is actually in the output — a slot is resolved only when its named tensor with
dtype/shape is present, or the model table can name the convention; everything
else is `UNRESOLVED` with a reason; (b) decimates per-frame tensors (stride
doubling) so the emitted slice is ≤ 2 MiB, keeping source frame numbers; (c)
writes provenance (command, gvhmr commit, weights sha256, source url/licence/
sha256, trim range, annotation path) and the document sha256. A nonexistent
input directory fails cleanly with `dump-gvhmr: input directory does not
exist: ...` and exit 1.

## 6. What evidence to return from the box

1. The fixture file itself (≤ 2 MB, sha256 pinned) — the Stage B contract
   input.
2. The printed slot table: for each of F1-α…F1-η, `resolved` (with tensor,
   dtype, shape, units) or `UNRESOLVED` (with reason).
3. The hand-measured `verification` block, filled per the protocol below:
   - **F1-α**: facing (yaw) of the fighter, hand-measured on **10 sampled
     frames**, in degrees — `handFacingFrameIndex` + `handFacingYawDeg`.
   - **F1-β**: which frame holds the neutral rest pose — `restFrameIndex`.
   - **F1-γ**: the hand-annotated displacement (metres, vector) over a
     **20-frame window** — `windowStartFrameIndex`, `windowEndFrameIndex`,
     `annotatedDisplacementM`.
   - **F1-δ**: hand-clicked full-image ankle positions per frame —
     `knownAnkleFullImagePx`.
4. The re-run of `node test/ingest/verify-gvhmr-schema.mjs` against the
   operator fixture (the same contract the synthetic fixtures already pass).

The §8.4 numeric acceptances (5°, 2°, 5 cm, 3 px) are then checked on the
pinned fixture exactly as `verify-gvhmr-schema.mjs` checks the synthetic ones.

## 7. Escalation rules

- A slot with no named tensor and no stateable convention is recorded
  `UNRESOLVED` with the reason — never filled in by hand, never skipped.
- F1-δ's derivation is the only allowed substitute for a named full-image
  observation, and it must state the exact recipe (crop-space keypoints +
  crop transform).
- F1-ζ's FK-parity acceptance needs the real body model; it is an
  operator-side check, not checkable on a synthetic fixture.
- STOP is a legitimate F1 outcome: if a slot cannot be satisfied, Stage B
  must not commit against it (plan §16 S5).

# Ingest contracts

Machine-checked copies of the plan clauses Stage A depends on. `W3`'s drift
gate (`test/ingest/verify-docs-drift.mjs`) asserts the numbers here still match
the plan, because a doc that quietly drifts from the code it describes is worse
than no doc: a reader trusts it.

## Contact-Gate

Copied verbatim from plan §17. Run: `node test/ingest/verify-contact-preservation.mjs`.

## 17. The contact-preservation gate, restated in full (A1–A8) — verified resolved in pass 4; untouched

Restated numerically so Stage A is self-contained. **This exact contract must be copied verbatim into
`tools/ingest/CONTRACT.md` §Contact-Gate**, with W3's drift gate asserting the plan's and CONTRACT.md's thresholds
agree. Derived from research 12 §5.

**Rigs.** `public/models/x-bot-tpose.fbx` (rig A) and `public/models/y-bot-tpose.fbx` (rig B), each
`scale.setScalar(0.01)` — the app-faithful centimetre→metre step, per `test/ardy/verify-playback-skinning.mjs:57-61`.

**Synthetic shared-world clips.** Both fighters on `CSKEL27_NEUTRAL` (`src/ardy/cskel27-neutral.js`). A's root at
`(0, 0.9544128, 0)`, B's at `(1.5, 0.9544128, 0)` — 1.5 m apart, real boxing range. 60 frames @ 20 fps, all rotations
identity. At contact frame **K = 30**, overwrite `posedA[RightHand]` and `posedA[LeftHand]` so
`posedA[hand]@30 == posedB[Head]@30` (`d_before = 0` exactly). Second contact at frame **45**: B's hand to A's `Spine3`.
Frames 31–60 hold a guard pose with hands within 25 cm of B's head, exercising the rotating `o` residuals.

**Placement under test.** `rigB.position.set(s · 1.5, 0, 0)`, both yaw 0, where `s = debugPrep(rigA).scale`
(`src/ardy/playback.js:188-189`; ≈ 1.0925 for x-bot, asserted at `test/ardy/verify-playback-skinning.mjs:83-88`).

**Metric.** Per frame: `d_before(f)` = min over A{`RightHand`,`LeftHand`} × B{`Head`,`Spine3`,`Spine2`,`Neck`,`Spine1`}
of `|posedA[h] − posedB[t]|` in ARDY metres; `d_after(f)` = the same minimum over **rendered bone world positions**
after `applyMotionFrame` + `updateMatrixWorld`, divided by `s` to return to ARDY metres. The symmetric A↔B direction is
included. Contact set `F = { f : d_before(f) ≤ 0.25 m }`.

| id | assertion |
|---|---|
| **A1** | ∀ f ∈ F: `|d_after(f) − d_before(f)| ≤ 0.05 m` |
| **A2** | `min_F d_after ≤ max_F d_before + 0.05 m` (no systematic whiff) |
| **A3** | **negative control — placement.** Repeat with `rigB.position.set(0,0,0)`; **A1 must FAIL** (`d_after ≈ 1.5·s`) |
| **A4** | **negative control — shared scale.** Repeat with `rigB.scale.setScalar(0.011)` (10% taller B); **A1 must FAIL** |
| **A5** | **report.** Print the measured systematic `max_F |d_after − d_before|`, the rig-predicted bound `(|o[A RightForeArm]| + |Δ wrist→fist| + |o[B Head]|)/s` from `debugPrep` plus bind lengths, and the worst frame — so a custom rig fails loudly with the cause |
| **A6** | `placeSecondActor` output equals the formula inlined in this test to **1e-6** |
| **A7** | A1 and A2 still hold when B's transform comes from `placeSecondActor` rather than the inlined value |
| **A8** | **app-faithful configuration.** Repeat A1/A2 with **both** rigs = `y-bot-tpose.fbx` — the model both characters actually render (`CHARACTER_MODEL_URL` at `src/App.jsx:302`, used at `:3055` and `:3065`) — where `s_A === s_B` exactly. Must pass. A1–A7 on x-bot + y-bot remain as the broader proportion test |

**Threshold rationale.** The differential form removes capture noise, present on both sides. The systematic term is the
un-driven wrist→fist segment plus the rotating bind residuals, ≈ 1–3 cm + 1–2 cm ≈ 2–6 cm worst case; 5 cm separates
"still connects" from "whiff" and sits far below the 25 cm contact radius, so A1 at 5 cm is a real check rather than a
tautology — A3 and A4 prove sensitivity. Run: `node test/ingest/verify-contact-preservation.mjs`.

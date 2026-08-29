# Recipe workflow — plan & frozen contracts (2026-08-29)

Goal: make the user's pipeline — Kimodo for blocking, ProjFlow for ALL
local refinement — order-free and fast. Four improvements, one principle:

> A take is a RECIPE (seed + prompt blocks + line edits), not a result.
> Determinism (measured: re-chain diff = 0 bitwise) makes the result
> reconstructible from the recipe at any time.

| # | improvement | fixes |
|---|---|---|
| 1 | resident ProjFlow service + preview steps exposed | 8 s round trip -> ~2 s; the detail loop IS ProjFlow now |
| 2 | recipe replay: regenerate/extend re-applies stored line edits | edit-then-extend no longer destroys refinements |
| 3 | take version strip (client-side checkpoints) | every attempt overwrites; no A/B, no revert |
| 4 | 2-mode edit surface (장면 vs 다듬기), inline disabled reasons | 4-way choice paralysis, buried features, post-hoc toasts |

DROPPED by user decision: part+prompt Kimodo regeneration — Kimodo is
blocking-only; local direction ("wave the hand here") is ProjFlow's job.

## Parallelization topology

```
Wave 1 (parallel 3, zero shared files):
  R  bridge replay + preview flag      | tools/ardy/bridge.mjs, tools/projflow/replay.mjs (new), test
  P  resident ProjFlow service         | tools/projflow/{driver.py,generate.mjs,runner.mjs,service...}, test
  U1 App: recipe state + versions + 2-mode UI | src/App.jsx, src/styles.css, src/take-recipe.js (new), test
Wave 2 (1):
  U2 App: preview-on-release wiring, boundary badge, gate fixes | src/App.jsx, src/styles.css
Main session: merges, registers tests in tools/run-tests.mjs (agents
NEVER touch it), runs gates on the box + CDP browser, commits, pushes main.
```

Wave 1 agents share ZERO files. U1 codes against C10/C11 as frozen here,
not against R/P's code. NOBODY touches tools/projflow/line-edit-job.mjs
(the composition layer is stable and both R and P call through it or
under it via existing signatures).

## Frozen contracts

### C9 — the recipe (client-side state, App.jsx / take-recipe.js)

```js
recipe = {
  seed: 1234,                       // ALWAYS a concrete integer (see rule)
  blocks: [{ prompt, duration }],   // ordered; single-block take = length 1
  lineEdits: [ <C6 lineEdit payload WITHOUT sourceMotion> ],  // application order
}
```

- SEED RULE: when the artist leaves the seed field empty, the App rolls
  one (`Math.floor(Math.random() * ARDY_SEED_MAX)`), SENDS it, and
  records it. A recipe with no seed cannot replay; therefore no request
  that creates a take may omit the seed.
- Lifecycle: successful generate -> fresh recipe {seed, blocks, lineEdits: []};
  successful line edit -> push the payload (minus sourceMotion) onto the
  CURRENT take's recipe. The recipe travels with the motionUrl (C12 versions).
- lineEdit payloads are stored EXACTLY as sent (camera, points2d,
  frameRange in app frames) — replay rebinds sourceMotion only.

### C10 — replay (bridge request field)

```json
"replay": [ { "track": "...", "frameRange": {...}, "points2d": [...],
              "camera": {...}, "prompt": "...", "seed": 7 }, ... ]
```

- Each entry = a C6 lineEdit payload WITHOUT sourceMotion (same field
  validation, reuse validateLineEdit's per-field rules). Optional
  per-entry integer seed. Cap: 16 entries.
- Allowed with: plain prompt generation, segments (chained blocks),
  preserve. REJECTED with: lineEdit, motionEdit, regenerateSegments
  (those splice/rewrite and the replay base would be ambiguous).
- Execution (bridge, after the generated take npz is written+verified):
  entries run SEQUENTIALLY via runLineEditJob; entry i's takePath is
  entry i-1's output (entry 0 reads the fresh take); the FINAL output is
  what gets registered and returned as motionUrl. Intermediate npz files
  stay in the artifact dir (replay-<i>.npz) but are not registered.
- Per-entry failure: mark it failed in the report, emit a loud status,
  CONTINUE from the last good take. A missing refinement beats a dead run.
- Report: `replay: [{ index, track, ok, boundaryWarning, seamStartDelta,
  seamEndDelta, error? }]` inside the final report event, plus one
  status line per entry.
- BOUNDARY RULE (the user's catch, verified in pf-chain): block N+1 is
  conditioned on block N's PRE-edit tail. An edit that does not touch a
  block tail leaves the tail byte-identical -> replay is exact. So:
  internal block boundaries = cumulative segment endFrames (exclusive
  clip end); an entry warns iff its half-open frameRange intersects
  [boundary - 5, boundary + 5]. Warning is NON-BLOCKING (`boundaryWarning:
  true` + status line). No segments field -> no internal boundaries.
- Preview flag (rides with this contract): `lineEdit.preview: true`
  (boolean, optional) is accepted and forwarded to runLineEditJob so the
  app can request a 20-step preview edit. Preview results register a
  motionUrl like any edit; the APP decides what to do with them.

### C11 — resident ProjFlow service (tools/projflow/)

- `lineEditOnBox(options)` PUBLIC SIGNATURE UNCHANGED. Resident routing
  is internal: try the warm service, fall back to the cold spawn path on
  ANY resident error (the cold path is the contract of record).
- Service = driver.py `--serve` mode on the box: loads the model ONCE,
  then loops on length-delimited NDJSON over stdin/stdout (arrays as
  base64 float32 blobs; source npy ~52 KB raw). Transport = one
  persistent `ssh <host> python driver.py --serve` child owned by
  runner.mjs; restarted on death with backoff; killed on process exit.
- Env: CCLAY_PROJFLOW_RESIDENT=0 disables (cold path only). Health probe
  reports `resident: true/false` so the bridge can surface it.
- No new ports, no tunnels, nothing listening on the box network.
- Targets (gate GS1): warm full edit round trip <= 3 s, warm preview
  <= 1.5 s, measured end-to-end through runLineEditJob; cold-path
  fallback verified by killing the service mid-session.

### C12 — versions + 2-mode surface (App.jsx)

- Versions: `takeVersions: [{ motionUrl, recipe, savedAt, label }]`,
  capped at 20 (oldest dropped; bridge allowlist holds 64 so 20 is safe).
  Auto-pushed on EVERY successful generate / line edit / replay. Strip UI
  above the timeline: numbered chips, current highlighted; click = load
  that motionUrl (the existing take-load path) AND restore its recipe.
- 2-mode surface: with a take loaded, exactly two primary edit entries:
  「장면」 (Kimodo — new/again/add block; preserve slider and part masks
  fold into a 고급 disclosure) and 「다듬기」 (ProjFlow drag mode,
  reachable in ONE click — not behind character-selection foldouts).
  Unavailable actions render greyed WITH an inline reason line
  (data-disabled-reason attribute for the CDP gate), never only a toast.
- Regenerate/add-block with a recipe that has lineEdits: the request
  carries `replay: recipe.lineEdits` (C10) and the report's
  boundaryWarning entries surface as a non-blocking inline notice.

## File ownership (NO agent edits tools/run-tests.mjs)

| agent | files |
|---|---|
| R  | tools/ardy/bridge.mjs, tools/projflow/replay.mjs (new), test/verify-projflow-replay.mjs (new) |
| P  | tools/projflow/driver.py, tools/projflow/generate.mjs, tools/projflow/runner.mjs, tools/projflow/service.mjs (new, optional), test/verify-projflow-service.mjs (new) |
| U1 | src/App.jsx, src/styles.css, src/take-recipe.js (new), test/verify-take-recipe.mjs (new) |
| U2 | src/App.jsx, src/styles.css (after U1 merges) |

Frozen APIs at the wave-1 boundary: lineEditOnBox options object,
runLineEditJob options/meta, C6 lineEdit wire format (all as shipped).

## Gates (main session; box + CDP on the 5280 instance; 5180 untouchable)

- GR1 replay exactness (box): fixed-seed 4s+4s chain -> line edit ->
  regenerate WITH replay -> edited range matches the direct-edit take
  (< 1e-4 m), outside the range byte-identical to a fresh chain.
- GR2 boundary warning (node, no GPU): entry near an internal boundary
  warns, entry far from it does not, single-block never warns.
- GS1 resident speed (box): warm full <= 3 s, preview <= 1.5 s (3 runs
  each); kill the service -> next edit succeeds via the cold path.
- GU1 surface (CDP): loaded take -> 다듬기 reachable in one click;
  disabled entries expose data-disabled-reason; no toast-only refusal.
- GV1 versions (CDP): generate then edit -> 2 chips; click v1 ->
  viewport swaps to v1's motionUrl; click v2 -> back, recipe restored.
- GALL: full node suite green (main session registers new files).

## Wave 1 GATE RESULTS (2026-08-29, real box + CDP runs)

- GR1 replay exactness: E2E through POST /ardy/generate (segments walk/run,
  seed 4242, replay of 2 head edits with pinned per-entry seeds). Outside
  the edited ranges vs the original chain: diff EXACTLY 0. Inside the
  edited range vs a direct runLineEditJob with the same seed: diff EXACTLY
  0 — ProjFlow is bit-deterministic per seed, so replay is a perfect
  re-application, not an approximation. Wall 30.0 s for chain generation +
  resident start (3.95 s) + 2 replays. PASS.
- GR2 boundary warning: the seam-straddling entry (88..104 vs boundary 96)
  warned; the interior entry (30..66) did not; single-block warns never
  (26-check node suite). PASS.
- GS1 resident speed (agent P's box measurements, re-observed in GR1):
  warm full 2.66-2.77 s (target <= 3), warm preview 0.80-0.85 s (target
  <= 1.5); warm/cold outputs byte-identical (same md5); kill-mid-session
  falls back cold (18.2 s) then the background restart serves the next
  edit warm (2.89 s). Today's cold baseline is 16.3 s (ssh RTT 0.73 s x7),
  so warm is ~6x. PASS.
- GU1 surface (CDP, boot-loaded take): both entries render; 장면 opens
  new/again/block; every disabled entry mirrors data-disabled-reason
  inline; preserve slider lives in the 고급 disclosure (exactly one in the
  DOM); 다듬기 enters drag mode in ONE click. PASS.
- GV1 versions: U1's smoke (2 real box runs): generate -> chip v1, edit ->
  chip v2, clicking v1 swaps the active take and restores its recipe
  (seed + block + refinement counts), list not truncated. PASS. Follow-up
  for wave 2: a ?motion= boot-loaded take starts with an EMPTY strip.
- GALL: full suite 104 node files green.

## CONTRACT AMENDMENTS accepted from wave 1 (supersede the text above)

- C9: a generate that carried `replay` keeps those lineEdits in the fresh
  recipe (literal "lineEdits: []" would drop them on the SECOND
  regenerate — the exact failure this plan exists to fix). Plain
  generates still reset to [].
- C9: when a recipe exceeds 16 lineEdits, replay sends the PREFIX (entry
  i was authored on entry i-1's result; the tail is what's dropped) and
  the app says so.
- C10: entries carrying sourceMotion or preview are REFUSED, not
  ignored; `replay: []` is a valid no-op needing no ProjFlow backend;
  non-empty replay without a ProjFlow runner is a 503 before the stream
  opens; report.replay seam deltas are null on failed entries.
- C11: line-delimited NDJSON (no length prefix — base64 payloads cannot
  contain newlines); meta.resident on both routes; envelope errors fall
  back cold WITHOUT restarting the healthy child; 6 consecutive failed
  starts -> idle until the next edit retries; first use WAITS for the
  resident (<= 45 s) instead of going cold; the generate.mjs CLI defaults
  CCLAY_PROJFLOW_RESIDENT=0 (one-shot processes cannot amortise a load —
  the bridge's in-process path is unaffected).
- C12: motionEdit runs push a version with recipeIntent "carry" (recipe
  travels forward unchanged; a splice has no recipe representation —
  inherent to the model, documented not fixed). data-disabled-reason is
  locale-following (English default / Korean under the toggle), so gates
  assert non-empty, not a language.

## Wave 2 RESULTS (2026-08-29, U2)

- Live preview on release: pointerup -> debounce 150 ms -> preview edit
  with the SESSION seed (rolled once, reused by every preview and by the
  confirm, released on confirm/mode-exit/drift/take-change). Draft is
  display-only (loadMotion {preview:true} — no toasts, no IK clearing,
  playhead kept); recipe/versions untouched until 생성 confirms.
  Supersede-not-queue (peak concurrent previews measured: 1). Measured:
  0.6-0.9 s server-side, 1.08-1.38 s release -> viewport swap.
- Boot-loaded takes seed the strip as v1 "불러옴" with a seed:null
  placeholder recipe; replay is never attached from a seedless recipe;
  a line edit from one adopts its own seed into the recipe.
- Preview timing surfaced in-panel (.line-preview-time).
- Browser verification 16/16 on the live box; full suite 104 files /
  1737 PASS; vite build clean.
- KNOWN TRAP, DEFUSED (2026-08-29, post-fe87937): camera drift after a
  COMMITTED edit no longer discards anything — the edit stores its own
  camera snapshot and stays valid; the overlay just ghosts (alpha .3,
  dashed, no handles) with an inline hint, and re-attaches when the view
  returns. New gestures are refused while drifted (two lenses cannot
  share one curve); Generate/undo/Reset work from anywhere. This also
  defuses the take-bar-resize variant (verified: a 26 px stage resize
  under a committed edit keeps edit + preview at 400 ms and 1.6 s).
  Scene-action draft-blocking reasons stay toast+runtime-guard anyway
  (inline lines are still a resize source mid-GESTURE).

## Kill criteria
- Resident protocol flaky (>1 unexplained fallback per 10 edits): ship
  cold path + preview flag only; resident becomes a follow-up.
- Replay nondeterminism on the box (GR1 outside-range diff != 0): STOP,
  re-verify chain determinism before shipping the recipe UI.

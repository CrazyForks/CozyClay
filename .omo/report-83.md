# Issue #83 implementation report

## Outcome

Implemented the scoped selection-settle fix and promoted the browser assertion to require both `past + 1` and `future === 0`. The change is committed on `fix/issue-83` as described below. No push or PR was performed.

## Root cause

The hierarchy selection handler used the render-captured `store` binding:

```js
store.settle();
```

Scene changes replace `storeRef.current` with a new scene-history coordinator in `openScene()`. A hierarchy click can be handled by a callback from a render that predates that replacement, so the handler can settle the coordinator for the scene that was left rather than the live coordinator owning the active producer. The active gizmo drag then remains applied in the live store without its transaction being committed, which explains the observed persistence with unchanged history depths.

The fix resolves the coordinator at event time:

```js
storeRef.current.settle();
```

This preserves the coordinator contract: the active transaction is retired, the producer teardown runs, the post-travel array is pushed once, and `pushHistory` clears the redo branch. A zero-travel settle still coalesces to no history entry.

## Files changed

- `src/App.jsx`: hierarchy selection settle call now uses the live store ref.
- `test/verify-object-gizmo.mjs`: the selection-change regression assertion is gating within the suite and checks `past === pastBeforeSwitch + 1 && future === 0`.

No `src/history.js` coordinator change was needed; its existing unit-tested settle implementation already commits post-travel state and truncates redo.

## Verification

### Required browser baseline (RED)

Command:

```text
QA_URL=http://127.0.0.1:5283/app/ CDP_PORT=9283 node tools/qa-browser.mjs -- node test/verify-object-gizmo.mjs
```

Artifact: `.omo/qa/83-before.log`

This workstation's headless Chrome could not reach the issue-83 lifecycle section. The first pre-existing gizmo movement check was already red and the suite then crashed before the selection-change case:

```text
PASS the X arrow is grabbable where it is drawn
FAIL dragging the X arrow slides the object along X — {"Position":[0.55,0,0.7],"Rotation":[0,0,0],"Scale":[1,1,1]}
PASS an X drag leaves the other axes alone
PASS E selects the rotate tool
PASS rotate mode shows one ring per axis plus the screen ring
FAIL the Y ring is grabbable on screen —
TypeError: Cannot read properties of null (reading 'x')
    at .../test/verify-object-gizmo.mjs:233:40
```

The log also records repeated macOS headless-render errors (`CVDisplayLinkCreateWithCGDisplay failed`, followed by GPU process exit). Therefore there is no evidence from this environment that the target selection assertion ran in the baseline; the issue's reported RED observation remains the motivating reproduction and must be rerun on the real-GPU browser QA surface.

### Required browser after run

Command:

```text
QA_URL=http://127.0.0.1:5283/app/ CDP_PORT=9283 node tools/qa-browser.mjs -- node test/verify-object-gizmo.mjs
```

Artifact: `.omo/qa/83-after.log`

The same pre-existing headless-render limitation stopped this run before the lifecycle section, with the same first movement failure and ring-probe crash. There is consequently no browser GREEN excerpt to claim from this workstation. The test assertion itself is strengthened and will fail if the redo branch is not truncated when the target case runs.

### GREEN results available in this environment

History unit suite:

```text
npm run test:history
...
PASS a streamed interaction is exactly one entry
PASS an interaction with no net change creates no entry
PASS undo mid-interaction commits then undoes that interaction
PASS an atomic mutation mid-interaction settles first
...
all history checks PASS
```

Build:

```text
npm run build
...
✓ 1030 modules transformed.
✓ built in 794ms
BUILD_STATUS=0
```

The build emitted only existing Vite warnings for the unresolved font reference and large chunks; it reported no source diagnostics or build errors.

Full runner:

```text
node tools/run-tests.mjs
...
PASS 118 Node verification files
FULL_STATUS=0
```

LSP diagnostics returned `No diagnostics found` for both changed files, and `git diff --check` passed.

## QA artifacts

- `.omo/qa/83-before.log` - required browser baseline.
- `.omo/qa/83-after.log` - required browser after run.
- `.omo/qa/83-vite.log` - Vite server output.
- `.omo/qa/83-build.log` - build output.
- `.omo/qa/83-full.log` - full Node runner output.

## Merge notes

- Commit: `fix(gizmo): settle hierarchy selection against the live scene coordinator (#83)` (created after verification).
- The browser matrix tier was not changed.
- Browser QA must be rerun on the lead's real-GPU surface to obtain the required target-case RED/GREEN excerpts; this macOS headless session cannot execute past the pre-existing ring-probe failure.
- Only `src/App.jsx` and `test/verify-object-gizmo.mjs` are intended to be part of the commit.

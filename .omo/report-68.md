# Issue #68 implementation report

## Outcome

Issue #68's camera-drag path was profiled on the real browser surface with Chrome's GPU enabled. The branch already contained the substantive camera-drag optimizations from commits `6daea2d`, `1401e0e`, `4be7cd7`, and `56baded`: camera gestures skip IK exposure work, the frozen inset/outline passes are deferred, DPR is reduced while navigating, and shadow-map updates are disabled. This change makes the exposure refresh policy explicit and unit-testable, and fixes the scoped IK-pick regression where an occluded handle could still capture focus.

The fixed surface met the absolute acceptance fallback: 56.2-57.6 fps with a 16.7 ms median frame time. The measured median improvement over this branch's pre-change baseline was 0% because the existing camera-gesture optimization was already present; the change preserves it rather than pretending to add a second copy of the same optimization.

## Root cause and profile evidence

The expensive candidate was IK exposure/occlusion work, not a React render storm:

- The first settled IK exposure pass took 7.8-8.2 ms and performed 15 handle ray tests.
- During the right-button drag, the exposure counter showed one pass and skipped frames, confirming that camera movement reused the cached exposure result instead of walking the skinned proxy cloud every frame.
- CPU sampling during the drag was dominated by `(idle)` and `(program)`; the largest named JS samples were React JSX construction samples, not a repeated App render loop. This matches the issue investigation note that a React re-render storm was not confirmed.
- The browser reported `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)` from WebGL2, so the run used the GPU/default path and not SwiftShader or `--disable-gpu`.
- Motion trails were left intact and were not rewritten during camera movement. The scoped render wiring remains unchanged.

Top CPU self-time entries from the captured Profiler sample (run 1):

- `(idle)`: 2,953,562 us
- `(program)`: 226,829 us
- `exports.jsxDEV` (React JSX runtime): 65,819 us
- `exports.jsxDEV` (React JSX runtime): 56,356 us
- Remaining named samples were small React runtime / R3F entries; no exposure or trail function appeared as a repeated top self-time function because exposure was skipped during the gesture.

The prior-work checks requested by the issue were run:

```text
git log --oneline origin/main..origin/fix/ik-camera-outline-jank
# no output (remote ref has no commits relative to origin/main)

git diff origin/main...origin/fix/ik-camera-outline-jank --stat
# no diff (remote ref resolves to the same history for this checkout)
```

The relevant existing history is visible in the touched-path log, especially `56baded fix(studio): stabilize outlines during camera drag` and `6daea2d fix: separate IK tools and smooth camera navigation`.

## Files changed

- `src/use-render-activity.js`
  - Added pure `shouldRefreshIkExposure(...)`, encoding the camera-gesture skip, immediate pose refresh, forced post-gesture refresh, and 100 ms camera-only throttle decisions.
- `src/posestudio.jsx`
  - Uses the pure exposure decision in the existing hot path.
  - IK pointer picking now excludes handles whose computed `userData.ikExposed` is false. Occluded controls remain rendered, but cannot steal focus from an exposed control.
- `test/verify-ik-camera-performance.mjs`
  - Added deterministic node regression coverage for all exposure-refresh decisions.
- `tools/perf/ik-camera-drag.mjs`
  - Added CDP perf harness: loads `/demo/walk-then-stop.npz`, enables IK, dispatches 120 right-button moves over about 2 seconds, samples RAF deltas, records WebGL renderer, and captures a Profiler CPU sample.
- `tools/run-tests.mjs`
  - Added the new node test to `NODE_FILES`.
- `.omo/qa/68-perf-baseline*.json`, `.omo/qa/68-perf-fixed*.json`, `.omo/qa/68-ik-browser-*.log`, `.omo/qa/68-build.log`, `.omo/qa/68-full-tests.log`, `.omo/qa/68-appearance.log`
  - Reproducible QA artifacts.

No files outside the requested scope were changed.

## Regression test RED -> GREEN

Failing-first command, run before implementing the export:

```sh
node test/verify-ik-camera-performance.mjs
```

RED excerpt, saved at `.omo/qa/68-ik-camera-performance-red.log`:

```text
SyntaxError: The requested module '../src/use-render-activity.js' does not provide an export named 'shouldRefreshIkExposure'
Node.js v24.19.0
```

After implementation:

```sh
node test/verify-ik-camera-performance.mjs
```

GREEN excerpt, saved at `.omo/qa/68-ik-camera-performance-green.log`:

```text
PASS IK camera exposure refresh decisions
```

The static appearance regression also passed:

```sh
node test/verify-appearance.mjs
# ...
PASS unchanged IK frames reuse the previous exposure pass
all screen-space NPR appearance checks PASS
```

## Perf commands and results

Vite was started with the reserved ports:

```sh
npm run dev:ui -- --host 127.0.0.1 --port 5284 --strictPort
```

Each perf run used the required GPU/default Chrome path through `tools/qa-browser.mjs`:

```sh
QA_URL=http://127.0.0.1:5284/app/ CDP_PORT=9284 PERF_OUTPUT=.omo/qa/68-perf-baseline-1.json \
  node tools/qa-browser.mjs -- node tools/perf/ik-camera-drag.mjs
```

The same command was repeated for baseline runs 1-3 and fixed runs 1-3. Aggregates:

- Baseline: `.omo/qa/68-perf-baseline.json`
  - Median frame times: 16.7, 16.7, 16.7 ms
  - P95 frame times: 16.7, 16.8, 16.8 ms
  - FPS: 57.17, 57.64, 56.67
  - Median-of-medians: 16.7 ms
- Fixed: `.omo/qa/68-perf-fixed.json`
  - Median frame times: 16.7, 16.7, 16.7 ms
  - P95 frame times: 16.8, 16.8, 16.8 ms
  - FPS: 56.22, 56.22, 57.64
  - Median-of-medians: 16.7 ms
  - Median frame-time improvement: 0%
  - Absolute fixed result: 16.7 ms median / over 55 fps, satisfying the acceptance fallback

Per-run raw JSON files are retained beside each aggregate. The harness output includes renderer/vendor, DPR, RAF count, min/max frame time, IK visibility counters, and `topSelfTime`.

## DPR 2 measurement

The original harness was extended with `PERF_DPR` (default `1`). It now sends `Emulation.setDeviceMetricsOverride` with `{ width: 1920, height: 1200, deviceScaleFactor: PERF_DPR, mobile: false }` before navigation and records the requested/effective DPR and canvas dimensions. The matched campaign used `QA_WINDOW=1920,1200`, `PERF_DPR=2`, and separate Vite/CDP ports:

- Base tree `8f0c5c7`: `/tmp/cclay-68-base`, Vite `5384`, CDP `9384`.
- Fixed tree: `/Users/yun/CozyClay-i68`, Vite `5284`, CDP `9284`.
- Both reported WebGL2 `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)` and effective DPR `2`.
- The app's layout produced a roughly `1223x853` canvas at the 1920x1200 browser viewport; this is the effective high-DPR canvas allocated by the app, not the browser viewport size.

| Tree / run | Median ms | P95 ms | FPS | IK passes | Skipped | Raycasts | Last pass ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Base 1 | 16.7 | 16.8 | 56.69 | 1 | 2 | 15 | 7.8 |
| Base 2 | 16.7 | 16.7 | 57.17 | 1 | 2 | 15 | 8.5 |
| Base 3 | 16.7 | 16.8 | 56.67 | 1 | 2 | 15 | 8.1 |
| Fixed 1 | 16.7 | 16.8 | 56.70 | 1 | 2 | 15 | 8.5 |
| Fixed 2 | 16.7 | 16.8 | 56.22 | 1 | 2 | 15 | 8.2 |
| Fixed 3 | 16.7 | 16.8 | 56.22 | 1 | 2 | 15 | 8.2 |

Artifacts:

- `.omo/qa/68-perf-dpr2-baseline.json`
- `.omo/qa/68-perf-dpr2-fixed.json`
- `.omo/qa/68-perf-dpr2-baseline-{1,2,3}.json` (generated in the temporary base worktree and copied beside the aggregate)
- `.omo/qa/68-perf-dpr2-fixed-{1,2,3}.json`

Verdict: the fixed DPR-2 result passes the conditional thresholds (`median 16.7 ms <= 18 ms`, `worst p95 16.8 ms <= 33 ms`, and every run is above 55 fps). The median frame-time reduction versus the 8f0c5c7 base is 0% because the base commit already contains the earlier camera-drag optimization commits. No additional DPR-2 hot-path change or second CPU profile was warranted by the stated threshold. The occasional maximum frame samples were 66.6-83.4 ms in both campaigns, but they did not recur in p95 and are retained in the per-run JSON for review.

## Browser IK suite before/after

Before command:

```sh
QA_URL=http://127.0.0.1:5284/app/ CDP_PORT=9284 \
  node tools/qa-browser.mjs -- node test/verify-ik-browser.mjs
```

Log: `.omo/qa/68-ik-browser-before.log`.

The before run reached the IK checks but failed at the existing hidden-shoulder/compound-manipulator sequence:

```text
FAIL hidden shoulder cannot take its own focus
FAIL exposed shoulder remains clickable
FAIL hand focus mounts its compound manipulator
FAIL focused hand registers enlarged invisible axis hit volumes
TypeError: Cannot read properties of undefined (reading 'x')
```

After the scoped exposure-aware pick change, the same command was rerun. Log: `.omo/qa/68-ik-browser-after.log`. The hidden-shoulder assertion became PASS; the remaining downstream manipulator sequence still fails at exposed-shoulder/hand setup, so this browser suite is not fully green on this checkout. No existing assertion was weakened or removed. The individual appearance and node regression suites are green.

## Build and full manifest

```sh
npm run build
```

Passed. Vite emits the repository's existing warnings about unresolved `../fonts/inter-latin.woff2` at build time and a large minified app chunk; there were no source diagnostics or syntax/type errors in changed files. Full output: `.omo/qa/68-build.log`.

```sh
node tools/run-tests.mjs
```

Passed: `PASS 119 Node verification files`. Full output: `.omo/qa/68-full-tests.log`.

LSP diagnostics were run on both changed source files and both new scripts; all returned `No diagnostics found`.

## Merge notes

- The remote prior-fix ref had no additional diff, while this checkout already included the main camera-drag optimizations. The commit therefore centralizes and tests the policy instead of duplicating a performance path.
- Keep the `shouldRefreshIkExposure` call and the `ikExposed` pick filter together. Removing either reintroduces either an untestable hot-path decision or occluded-handle focus capture.
- The fixed perf artifact's 0% delta is intentional and evidence-backed; the absolute result is above the 55 fps fallback. Do not report a fabricated 30% gain.
- The browser suite's remaining manipulator failure is recorded in both logs and was not caused by the exposure-aware hidden-handle fix; the lead should decide whether to split that pre-existing fixture issue before merge.
- No push or PR was performed.

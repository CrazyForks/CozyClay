# Ultrawork Notepad — Kimodo root-waypoint (2D path) support
Started: 2026-08-26T06:11Z
Goal thread: 01a03c3f-f76b-77e7-8893-f52c9932480d
ulw-loop session: kimodo-waypoints (.omo/ulw-loop/kimodo-waypoints/)

## Tier
HEAVY — new external-integration surface (Kimodo --constraints JSON protocol)
+ new coordinate-space mapping module. Justification recorded in goal.

## Skills surveyed
- ulw-loop: ACTIVE, this run's workflow.
- programming: NOT loaded body — repo is .mjs/JS, no .py/.rs/.ts/.go edits planned.
- git-master: WILL USE for commits (read history, atomic per increment).
- debugging: on standby if RED fails for wrong reason.
- ast-grep / lsp: discovery already done via rg+read; lsp_diagnostics after edits.

## Delegation topology
SOLO. Reason: one cohesive unit (one protocol mapping threaded through 4 files
in the same module dir). Scopes are not separable — constraints.mjs, generate.mjs,
run-sequence-on-box.mjs and runner.mjs all move together on one contract. A team
would add relay overhead with zero parallel gain. No planner child: the discovery
wave left no open design decision (Kimodo constraints schema is fully documented,
CozyClay waypoint shape read from bridge validateWaypoints).

## Plan (atomic)
1. RED: write test/verify-kimodo-waypoints.mjs against a not-yet-existing
   tools/kimodo/constraints.mjs -> capture RED (module not found / assertions fail).
2. GREEN: implement tools/kimodo/constraints.mjs buildRoot2dConstraints().
3. Thread constraints through generate.mjs (write JSON, scp, --constraints).
4. Add --root-2d parsing to run-sequence-on-box.mjs.
5. runner.mjs: drop waypoint refusal, forward waypoints. Keep pose/base/edit refusing.
6. Extend verify-kimodo-runner.mjs: waypoints no longer throw; pose/base/edit still do (C4).
7. C1 real surface: live bridge + POST with 3 waypoints, measure XZ error < 0.5m.
8. Cleanup receipts, full non-mcp suite, commits.

## Success criteria + QA scenarios
C1 HAPPY: bridge on free port, CCLAY_MOTION_BACKEND=kimodo, POST /ardy/generate
   with 2 segments + 3 waypoints -> decode npz, per-waypoint XZ error < 0.5 m.
C2 EDGE: unit — frames beyond clip, non-ascending, heading null, empty/single.
C3 REGRESSION: ARDY default selection; no-waypoint Kimodo path; all non-mcp green.
C4 ADVERSARIAL: pose pin / base clip / motion edit still refuse by name.

## Now
Step 1 — write failing test, capture RED.

## Todo
Steps 2-8 above.

## Findings
- bridge validateWaypoints (tools/ardy/bridge.mjs): waypoints must be 2..N,
  waypoints[0].frame MUST be 0, frames strictly ascending, x/z finite within
  +/-ROOT_2D_RANGE_M meters, heading present (null or number).
  => the bridge already rejects most malformed input BEFORE the runner sees it,
  so constraints.mjs edge handling is defense-in-depth for direct CLI use.
- Kimodo constraints schema (docs/user_guide/constraints.html):
  {"type":"root2d","frame_indices":[int],"smooth_root_2d":[[x,z]],
   "global_root_heading":[[cos,sin]]}
  Authored relative to CANONICAL ORIGIN: root XZ = (0,0) at frame 0. Y-up, meters.
  global_root_heading is a cos/sin PAIR, not radians. <- easy silent bug.
- Kimodo generates 30fps; run-sequence-on-box retimes to 20fps target.
  App waypoint frames are in 20fps clip space => must scale to 30fps gen space.
- runner.mjs:89 is the refusal to remove; :115/:116 (base/pose) must STAY.

## Learnings
(appended as discovered)

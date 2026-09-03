# Issue #86 — `frame_shot` places the shot camera but never aims it

Branch `fix/issue-86` in `/Users/yun/CozyClay-i86`, off `origin/main` @ `8f0c5c7`.
Commits: `d0839f5 fix(mcp): frame_shot aims the live camera it places (#86)` plus a
follow-up commit carrying only this report and the QA artifact.

## Root cause

`frame_shot` derives a camera **position** and lens from shot intent and sends
exactly that over the live protocol:

```js
const nextCamera = { x, z, y: camY, focalMm: lensMm };
await appliedLiveMutation("set_camera", nextCamera);
```

The editor's `set_camera` handler applied position + FOV and never touched
orientation. The whole shot vocabulary (`deriveShot`, `captureFraming`,
`aimAtSubject` in `mcp/server.mjs`) is derived from distance and focal length on
the assumption that the lens points at the framing pivot (subject x/z at
y = 1.3). The in-memory path satisfies that assumption for free — it has no
orientation at all. A live editor has one, and kept whatever the last human
gesture left, so every view except `front` orbited the lens away from the
subject: zero visible pixels, and `behindCameraPlane: true` from `profile`
round to `back`, while `describe_shot` still reported "98% of frame height".

Second surface, same root: `set_camera` ends in `live.commitManualCameraFraming()`
-> `syncActiveCameraFraming()`, which measures the framing it persists into
`shot.camera.followCam` from `look.current.pitch`. Since nothing wrote
`look.current`, the distance/height/pitchOffset/orbitOffset recorded for the Shot
were measured against a stale orientation. Writing the applied yaw/pitch into
`look.current` (not just `camera.lookAt`) fixes that too — and it is required
anyway, because `look.current` is the orientation of record: `FlyControls` and
the gizmo path both write `camera.rotation` from it.

Design call left alone (as the reporter suggested): whether an MCP-driven camera
move should commit manual framing at all. Unchanged here.

## Files changed

| file | change |
| --- | --- |
| `mcp/server.mjs` | `FRAMING_PIVOT_Y` named (was a bare `1.3` in three places); `frame_shot` always sends `lookAtX/lookAtY/lookAtZ` = the same pivot `s`/`aimAtSubject` use; `set_camera` MCP tool gained optional `look_at_x/look_at_y/look_at_z`, forwarded only when all three are present; `set_camera` description now says what actually aims a live lens. |
| `mcp/LIVE-PROTOCOL.md` | `set_camera` row documents the additive `lookAt*` triple: complete or absent, editors that ignore it degrade to the old behaviour. No version bump — `mcp/verify-protocol-version.mjs` asserts the MCP JSON-RPC track (`2025-11-25`), which is untouched. |
| `src/App.jsx` (live `set_camera` handler only, ~L3300) | when the triple is present: `aimAt(position, pivot)` (existing helper, already imported), write `look.current.yaw/pitch`, then `camera.rotation.set(pitch, yaw, 0)` with `rotation.order = "YXZ"` — the same sequence `frameWorldTarget` and the camera gizmo already use. Without the triple, orientation is untouched. |
| `mcp/verify-live.mjs` | new protocol-level assertion: for each of the 5 views, `frame_shot` must forward a complete, finite `lookAt*` that equals the framed character's pivot and is not the camera's own position. Node tier, gates in `npm test`. |
| `mcp/verify-live-editor-model.mjs` | new pixel-free real-editor assertion (CI **gating** tier): after `frame_shot view: "profile"` on a subject moved to (-2.5, 1.75), the editor's shot camera forward vector must point at the pivot within 2°. Waits on the editor's own `cozyclay:mcp-capture-ready` event and then on `window.__cozyclay.shotCam` via rAF — no sleeps. |
| `mcp/verify-live-capture.mjs` | new real-render assertion: for each of the 5 views, `frame_shot` then `capture_frame` must report `characters[0].visiblePixelCount > 0` and `behindCameraPlane === false`; the table is echoed in the suite's JSON summary. CI observation tier (SwiftShader), gating evidence is local. |

No new `verify-*.mjs` files, so `tools/run-tests.mjs` NODE_FILES/BROWSER_FILES needed no change (both edited suites were already classified).

## RED / GREEN

### 1. `node mcp/verify-live.mjs` (protocol level, CI gating node tier)

RED (assertion added, fix not yet applied):

```
Error: frame_shot (front) placed the camera without an aim target
    at assert (file:///Users/yun/CozyClay-i86/mcp/verify-live.mjs:127:25)
```

GREEN:

```
live status, forwarding, live describe, and disconnect fallback passed
```

### 2. `node mcp/verify-live-editor-model.mjs` (real Chrome editor, no pixels, CI **gating**)

RED (source files reverted to `8f0c5c7`, tests kept):

```
AssertionError [ERR_ASSERTION]: frame_shot left the shot camera pointing 86.4deg off the subject:
{"position":{"x":-5.374472778138313,"y":1.65,"z":3.0903886696039695},
 "forward":{"x":-0.37255445930144493,"y":-0.10452846326765343,"z":-0.9221046443986229}}
```

(the camera *moved* to the profile position and kept the default orientation — the defect exactly.)

GREEN:

```
{"vitePort":63047,"livePort":63048,"model":"x-bot-tpose","editorDescribeReportedModel":true,
 "mcpDescribeReportedModel":true,"frameShotProfileOffAxisDeg":0}
```

### 3. `node mcp/verify-live-capture.mjs` (real Chrome editor, real offscreen render)

RED:

```
AssertionError [ERR_ASSERTION]: frame_shot front three-quarter framed nothing:
{"visiblePixelCount":0,"behindCameraPlane":false}
```

GREEN (from the suite's own summary line):

```
"framed":{"front":{"visiblePixelCount":9216,"behindCameraPlane":false},
 "front three-quarter":{"visiblePixelCount":11264,"behindCameraPlane":false},
 "profile":{"visiblePixelCount":5120,"behindCameraPlane":false},
 "rear three-quarter":{"visiblePixelCount":6144,"behindCameraPlane":false},
 "back":{"visiblePixelCount":9216,"behindCameraPlane":false}}
```

Reproduced identically across two independent runs. Hardware GL (Apple M4 Pro),
not SwiftShader, per the reporter's measurement note.

### 5-view table, before vs after

| view | before: visiblePixelCount / behindCameraPlane | after |
| --- | --- | --- |
| front | 19 456 / false | 9 216 / false |
| front three-quarter | **0** / false | 11 264 / false |
| profile | **0** / **true** | 5 120 / false |
| rear three-quarter | **0** / **true** | 6 144 / false |
| back | **0** / **true** | 9 216 / false |

(Absolute counts differ from the issue's because the suite's scene and camera
history differ; the RED/GREEN contrast is the signal. `front` drops because the
aimed camera centres the pivot rather than inheriting a default framing that
happened to sit lower on the body.)

## Real-surface QA artifacts

- `/Users/yun/CozyClay-i86/.omo/qa/86-frame-shot.json` — before/after 5-view table
  (visiblePixelCount, behindCameraPlane), plus the pixel-free off-axis angle
  (86.4° -> 0.0°), with measurement conditions.
- Real surfaces exercised: real Vite + real headless Chrome editor + real MCP
  stdio server over the live WebSocket, in `mcp/verify-live-capture.mjs` and
  `mcp/verify-live-editor-model.mjs`.

## Full verification run

| command | result |
| --- | --- |
| `cd mcp && npm run verify` | PASS — `25 tools registered`, `420 framing combinations checked`, `all checks passed`, `MCP protocol 2025-11-25 only PASS`, HTTP origin guard PASS |
| `node mcp/verify-protocol-version.mjs` | `MCP protocol 2025-11-25 only PASS` |
| `node mcp/verify-live.mjs` | PASS |
| `node mcp/verify-live-batch.mjs` | PASS |
| `node mcp/verify-live-editor-model.mjs` | PASS (off-axis 0°) |
| `node mcp/verify-live-capture.mjs` | PASS (5-view table above) |
| `node mcp/verify-tool-annotations.mjs`, `node mcp/verify-prompts.mjs`, `node test/verify-mcp-invariants.mjs` | PASS (re-run after the tool-description edit) |
| `npm run build` | `✓ built in 632ms`, no warnings for the changed files (the pre-existing >500 kB chunk-size advisory is unchanged) |
| `node tools/run-tests.mjs` | `PASS 118 Node verification files` |

## What the lead must know for the merge

1. **Protocol is additive, no version bump.** `lookAt*` is optional on
   `set_camera`; older editors ignoring it behave exactly as before.
   `mcp/verify-protocol-version.mjs` only pins the MCP JSON-RPC track, which is
   untouched.
2. **`set_camera` (the MCP tool) still does not aim by default.** It only
   forwards `look_at_*` when the caller supplies all three. I kept the default
   unchanged deliberately: the issue is about `frame_shot`, and silently aiming
   every explicit-coordinate move would change `set_camera`'s contract. If you
   would rather `set_camera` also always aim at the subject (its description has
   always claimed "the camera always aims at the subject"), that is a one-line
   change in the same place — say the word.
3. **`commitManualCameraFraming` on an MCP camera move is unchanged.** The
   reporter flagged that as a design call; I left it. What did change is that it
   now measures the orientation the call applied instead of a stale one.
4. **CI gating**: the new pixel-free assertion lives in
   `mcp/verify-live-editor-model.mjs`, which the `mcp-live` job runs in its
   *gating* step — so CI now fails if the fix regresses, without depending on
   SwiftShader pixels. `verify-live-capture.mjs` stays in the observation step.
5. **Test hygiene**: the new waits are event- or rAF-driven (`cozyclay:mcp-capture-ready`,
   then `window.__cozyclay.shotCam`), bounded by the suites' existing
   `withTimeout`. No sleeps. `verify-live-editor-model.mjs` needed a
   `focus_character("A")` before framing, because the x-bot it adds earlier
   leaves the editor selecting that character.
6. **Cross-worktree incident, resolved, no data lost.** I briefly used
   `git stash` to run the RED case; `git stash` is shared across worktrees of the
   same repo, so my `stash pop` popped worker-88's entry into my worktree. I
   restored it immediately: worker-88's stash commit `63e03f8` went back to
   `stash@{0}` (verified identical — `src/App.jsx`, `src/scene-objects.js`,
   `src/styles.css`, 219 insertions), my own entry was dropped after re-applying
   it to my worktree, and `src/scene-objects.js` / `src/styles.css` here went
   back to HEAD. Confirmed afterwards that worker-88 shipped that exact content:
   `a97e5b2 feat(inspector): pick any object colour, not just the six presets
   (#88)` carries the same 81 / 92 / 49-line changes. Nothing was lost.
   Nothing of worker-88's is in my commits (`git show --stat d0839f5` touches
   only the six files listed above). Flagging it so nobody is surprised, and so
   the fleet knows: **do not use `git stash` in these worktrees.**

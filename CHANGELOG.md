# Changelog

## 1.6.0

The official npm package now records anonymous product usage so downloads can
be distinguished from real launches and returning use.

- `npx cozyclay`, `bunx cozyclay`, and global `cclay` launches get a
  signed-package-verified anonymous installation ID.
- The existing scene, edit, motion, export, and activation funnel is available
  for npm sessions with `distribution: npm` and `app_version` properties.
- Source checkouts, forks, CI, tests, malformed or unsigned packages, and
  opted-out launches remain untracked.
- `cclay telemetry status|on|off` controls the package-wide setting; the
  in-app toggle stays synchronized with it.
- URL/referrer/campaign-derived values are scrubbed before any event leaves the
  browser, and corrupted telemetry state fails closed.

## 1.5.0

The release where the camera can climb a shaped path, recordings leave the studio as
standard MP4 files, and generated falls finally reach the ground.

### Shape a crane move

Rail Follow now carries a persisted crane-height profile with two to eight points instead
of only a start and end height. The camera evaluates the profile with a monotone cubic
curve, so it passes through every authored height without overshooting. Purple handles in
the scene and matching markers in each Shot card stay synchronized: drag vertically to set
height, Shift-drag along the rail, double-click to add a point, and delete an interior point.
One undo reverses one complete gesture, and older `{start,end}` projects migrate to pinned
endpoints automatically.

### Record a real MP4

Record now downloads a fast-start H.264 MP4 at 24 fps instead of WebM. The exporter tries
High, Main, then Baseline AVC profiles, keeps frame-addressed deterministic rendering, and
fails by name when the browser has no compatible H.264 WebCodecs encoder rather than
producing a misleading MP4 that desktop editors cannot open. Mediabunny performs the
in-browser muxing and is documented in the third-party notices.

### Falls that read in previs

When generated motion walks off its support, CozyClay can stage a ballistic root drop with
horizontal drift, a readable fall clock, and an impact hold instead of leaving the character
suspended at the roof edge. Motion completion now means the editor acknowledged and
installed the take: explicit rejection fails visibly, reconnects do not duplicate the
installation, and an uncertain lost acknowledgement is never retried as though nothing
happened.

### ARDY bridge fixes

- Local runner options now reach the bridge instead of disappearing between processes.
- Camera-clause cleanup no longer mistakes ordinary object nouns for camera instructions.
- The prompt guide distinguishes measured upstream behavior from local authoring heuristics.
- Demo and operations documentation now use supported options and cite the four-second
  waypoint-history evidence honestly.

## 1.4.1

Gizmo drags survive past their first tick again. The split-camera work in 1.4.0 wrapped the
gizmo's change callback in a shot-camera dispatcher that dropped the drag-transaction token,
so every arrow, plane, knob, and ring drag was closed by its own first move — objects moved
one snap step and stopped. The token now round-trips, and the gizmo suite drives the ring
with a real arc and the plan puck in the Top-View inset, matching how the studio actually
works today.

## 1.4.0

The release where every edit can be taken back.

### Undo, everywhere

One Ctrl+Z history now covers the whole editor, not just character moves. Newly undoable:

- **Prompt blocks** — add, remove, drag, edge-resize, and text edits (one entry per editing
  session, not per keystroke).
- **Root waypoints** — floor-click placement, timeline removal, and Top-View drags.
- **Camera authoring** — camera keys (add / re-time / remove / clear), camera-block settings,
  rail schedule moves and resizes, rail removal, and viewport or plan framing commits.
- **Shots** — delete, add, split, duplicate, reorder, boundary resize, and rename.
- **The Full-Body take** — segment cuts, retimes, deletions, trims, and clearing the take
  (the cleared clip, IK keys, and stature all come back).
- **Poses and the cast** — pose apply / reset / save, model swap, tint, subject text, and
  inspector position scrubs.
- **IK keys** — add, remove, and drag-bake; undo snapshots now carry the key map itself.

Every continuous drag records exactly once at gesture start, so a long drag is one Ctrl+Z,
never a hundred.

### Cut the take like film

The Full-Body strip is now a cutting room: cut at the playhead, then grab a segment's amber
right-edge grip and stretch it — the width IS the playback rate (wider is slower, 0.1×–4× on
the same grid as the numeric editor). Right-click a segment to delete it outright. All of it
is non-destructive: the source frames stay whole, and a right-click on a trim handle still
restores the full take.

### Two cameras, one stage

The editing view and the recording camera are no longer the same eye. The main pane belongs
to a free editor camera — fly it, inspect the set, scrub playback — while the shot camera
records through a chrome-free 16:9 preview and stands in the scene as a selectable ghost you
block like any other body. Look-through hands you the old framing-by-flying when you want it,
and leaves your view alone when you don't.

### A hardened MCP

The server now enforces loopback-only hosting, rejects forged HTTP origins, refuses project
files with hard links, isolates live scene documents and generation artifacts per session,
and preserves motion-job ownership across reconnects. HTTP session children inherit the
parent's configuration (a configured bridge URL no longer silently vanishes), and a session
that cannot own the live editor port now says exactly why instead of pretending no editor
exists.

### Everything else

- **Selection** — clicking empty floor or sky reliably clears the selection; the selection
  cage's generous line hitbox no longer swallows the press.
- **Timeline** — the camera block's preview button plays its shot instead of throwing.
- **CI** — pull requests are gated on the node and browser suites.
- CozyClay now ships as an `AGPL-3.0-or-later` combined work. Modified versions offered over
  a network must offer their users the corresponding source, and the Studio footer carries
  that source offer.

## 1.3.0

The release where the studio stops being something only a person can drive.

### Direct it with an AI

CozyClay now ships an [MCP](https://modelcontextprotocol.io) server. Point Claude, Cursor, or any
MCP client at it and ask for a shot in plain language — it places the cast, frames "a low wide
profile", generates multi-phase motion, and **the viewport moves while you watch**.

```json
{ "mcpServers": { "cozyclay": { "command": "npx", "args": ["-y", "cozyclay", "mcp"] } } }
```

It computes nothing of its own. Every answer comes from the modules the studio already renders
with — `shot.js` for film vocabulary, `scenes.js` for the stage, `camera-move.js` for moves — so
the server and the UI cannot disagree about what a 35 mm medium shot is.

- **Live or headless.** With a studio tab open, tool calls drive the real viewport over a local
  socket. With no tab, scene/project tools still block scenes, derive framing, render prompts,
  and write `.cclayproject` files; capture, prompt-block installation, motion generation and
  atomic live batches remain editor-only.
- **Motion from plain beats.** `generate_motion` preserves composite physical wording while
  stripping camera, scenery and internal-state language ARDY cannot animate, splits only beats
  that exceed ARDY's duration bound, and lands each phase as a Prompt Block on the timeline.
- **24 tools**, all documented in [`mcp/README.md`](mcp/README.md).

### Cut a photograph out and stand it up

Drop an image on Props — or straight onto the shot — and it becomes a card you can place, turn and
block against. The background editor lives in the card's own inspector: paint or erase the
selection, zoom and pan with the wheel, and the picture sits on a stage rather than being framed
by one. Assets are stored once by content hash, so the same picture imported twice costs one copy.

### An open stage

The two-walled room corner is gone. The set is a 500 m open deck — far enough that no ordinary
blocking meets its edge — with a two-tier grid (quiet 1 m cells, assertive 10 m lines) and a
distance falloff that dissolves the floor into the background instead of ending at a horizon.
Movement clamps moved from ±11 m to ±240 m, so a run or a chase finally has room.

### Group props and move them as one

Scene objects now carry a parent. Build a rocket from ten primitives, group them, and the whole
thing drags as one body — through the gizmo, the inspector and the MCP tools alike. Deleting a
parent promotes its children rather than taking them with it.

### Everything else

- **Gizmo** — the cast rides the same gizmo as scene objects, with rotate and scale; an XZ pad for
  free ground drags; pick targets balanced so the pad no longer swallows every press.
- **Mocap** — a video capture panel, takes assigned to cast members, and take trimming.
- **Timeline** — authoring runs on a 24 fps production clock while ARDY is still spoken to at
  20 fps, and exports record at true motion speed.
- **Multi-character** — an unbounded cast with per-character motion layers.

### Fixes

- Props reported `1x1x1` regardless of how they were built: scale never crossed the live protocol,
  and the server reset whatever did arrive. Sizes are now real, and per-axis scale is exposed.
- A 6 m ceiling survived the walls it belonged to, silently decapitating anything tall.
- Generating four Prompt Blocks produced one. IK keys from a discarded take made a fresh run look
  like a local edit, and that path ships no schedule. Replacing a take now clears the corrections
  authored against it.
- A stale service worker served yesterday's bundle to the dev server, so edits appeared to do
  nothing. Dev now serves a self-destructing worker.
- Prompt blocks are capped at 4 s everywhere, not just in the UI — longer beats chain instead of
  being authored into something the timeline would refuse.

### Packaging

- `mcp/` ships with the package, so `npx cozyclay mcp` works without a clone.
- `exports` makes `cozyclay/src/*` a public contract instead of an accident.
- `three` is declared as an optional peer: the studio bundles its own copy, but anything importing
  `cozyclay/src/*` needs it, and now npm says so.

## 1.2.0

- `npx cozyclay` opens the studio again.
- Stopped shipping 26 MB of scratch files.

## 0.1.0

First public release.

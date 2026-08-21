# Changelog

## Unreleased

- CozyClay now ships as an `AGPL-3.0-or-later` combined work. Modified versions
  offered over a network must offer their users the corresponding source, and
  the Studio footer carries that source offer.

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

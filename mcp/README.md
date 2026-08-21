# CozyClay MCP server

Lets an AI assistant (Claude Desktop, Cursor, any MCP client) block a scene, place the camera,
generate character motion and read the shot back as film vocabulary — then turn it into an AI
image/video prompt.

Works two ways, with the same tools:

- **Editor open** — tool calls drive the visible viewport live: camera, cast, set, motion,
  prompt blocks on the timeline.
- **No editor** — everything runs headless: no browser, no GPU, no build step.

## Run it locally

```sh
cd mcp
npm install
npm start          # speaks MCP over stdio and hosts ws://127.0.0.1:5184/live
npm run verify     # drives the no-editor fallback as a client and checks results
npm run verify:live # drives a fake editor over the live WebSocket protocol
```

Then point a client at it. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cozyclay": {
      "command": "node",
      "args": ["/absolute/path/to/CozyClay/mcp/server.mjs"]
    }
  }
}
```

Restart the client; 20 tools appear.

Prefer a long-lived endpoint? `node server.mjs --http 5183` serves Streamable HTTP at
`http://127.0.0.1:5183/mcp` (one isolated session per client), with a plain status page at `/`.

## What it does

Describe the shot you want. The server does the trigonometry and answers the way a crew would.

> "Put a detective and a courier in an alley, then give me a low wide profile shot of the courier."

```
WIDE SHOT · RIGHT PROFILE · KNEE LEVEL · 24MM

size      wide shot — the subject fills 40% of frame height
view      a right-side profile view
level     a low knee-level angle looking up at the subject
distance  4.39m
```

`render_prompt` turns that same geometry into a prompt that carries the real framing, so the
generated frame matches the blocking instead of drifting off into a generic shot.

## Tools

| tool | what it does |
| --- | --- |
| `describe_scene` | the whole state: camera, framing, cast, set |
| `live_status` | whether an editor tab is connected for live control |
| `describe_shot` | current camera geometry as film vocabulary |
| `set_camera` | move the lens / change focal length directly |
| `frame_shot` | frame by intent — size, view, level, side |
| `add_character` / `place_character` / `remove_character` | the cast |
| `focus_character` | choose who the camera frames |
| `place_object` / `update_object` / `remove_object` | the set — `place_object` also accepts `name` and `parent`, so multi-part assets like "Building A" land as one named assembly |
| `group_objects` | attach children to a parent so they move as one |
| `ungroup_objects` | detach children from their parent (same as `group_objects` with `parent: null`) |
| `render_prompt` | the shot as an AI image or video prompt |
| `generate_motion` | multi-phase character motion through the ARDY bridge — phases land as prompt blocks |
| `mark_camera_move` / `describe_camera_move` | name a move between two camera positions |
| `add_scene` / `switch_scene` | multiple scenes per project |
| `open_project` / `save_project` | read and write `.cclayproject` files |

Coordinates are metres (`x` right, `z` toward the default camera, `y` height above the floor).
Rotations are degrees of yaw. Characters are addressed by letter (`"A"`), slot (`"2"`) or id
(`"char-a"`).

## Live editor control

The server hosts `ws://127.0.0.1:5184/live` by default (`COZYCLAY_LIVE_PORT` or
`--live-port <port>` to change it). Start the editor with that same `COZYCLAY_LIVE_PORT` so its
Vite build connects to the selected loopback endpoint; `npm run dev` preserves the environment
variable for the browser. A CozyClay editor tab then connects on its own; `live_status` tells you whether one is attached. With an editor connected, mutations
forward to it and reads report its real state — the screen you are looking at is the source of
truth. Without one, every tool keeps its in-memory behaviour. In `--http` mode each session
child attempts to bind the live port, so one session owns the editor and the others
intentionally run memory-only.

The wire protocol — one WebSocket, ten commands, editor-side rules — is specified in
[`LIVE-PROTOCOL.md`](LIVE-PROTOCOL.md).

## Motion generation

`generate_motion` takes plain-language beats and a length:

```
phases: ["seated on a chair, slowly stands up",
         "breaks into a sprint",
         "trips and falls hard to the ground"]
seconds: 10
```

It tiles them into contiguous ARDY segments, streams the generation through the local bridge
(`127.0.0.1:5181`, started by `npm run dev`), and — when an editor is connected — loads the
result onto the active character with one prompt block per phase on the timeline. Pass a
previous `motion_url` to reload a clip without generating again.

## Round-trips with the studio

`save_project` writes a real `.cclayproject` file, so a scene blocked here opens in the studio to
be posed, timed and generated — and a scene built in the studio opens here with `open_project`.

## Design

This server owns no geometry, no film vocabulary and no prompt text. Every answer is computed by
the same modules the studio renders with, imported straight from the working tree:

| module | responsibility |
| --- | --- |
| `../src/shot.js` | geometry → film vocabulary → prompt |
| `../src/scenes.js` | the scene document and its stage envelope |
| `../src/scene-objects.js` | the set: create / update / remove, clamped and snapped |
| `../src/camera-move.js` | two framings → a named camera move |
| `../src/project.js` | the `.cclayproject` envelope |

That is the whole design. Because the imports are relative, the server always speaks the working
tree's vocabulary: retune a band in `shot.js` and this server reports the new answer on its next
start, with nothing to publish or reinstall. The studio and the MCP server cannot disagree about
what a 35mm medium shot is, because there is only one implementation of it.

`frame_shot` is the one place that inverts `shot.js` rather than calling it — it solves for the
camera position that produces a requested size. `npm run verify` checks all 420 combinations the
schema accepts, so a retune in `shot.js` fails loudly here instead of quietly mis-framing.

### Framing conflicts

Shot size is treated as the stronger request. An extreme close-up from an overhead lens is
geometrically impossible on a wide lens — the camera would sit inside the subject — so the server
lengthens the lens until the requested angle fits and says so, the way a crew swaps glass rather
than abandoning the close-up.

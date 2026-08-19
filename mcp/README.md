# CozyClay MCP server

Lets an AI assistant (Claude Desktop, Cursor, any MCP client) block a scene, place the camera and
read the shot back as film vocabulary — then turn it into an AI image/video prompt.

Headless: no browser, no GPU, no build step.

## Run it locally

```sh
cd mcp
npm install
npm start          # speaks MCP over stdio
npm run verify     # drives the server as a client and checks the results
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

Restart the client; 18 tools appear.

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
| `describe_shot` | current camera geometry as film vocabulary |
| `set_camera` | move the lens / change focal length directly |
| `frame_shot` | frame by intent — size, view, level, side |
| `add_character` / `place_character` / `remove_character` | the cast |
| `focus_character` | choose who the camera frames |
| `place_object` / `update_object` / `remove_object` | the set |
| `render_prompt` | the shot as an AI image or video prompt |
| `mark_camera_move` / `describe_camera_move` | name a move between two camera positions |
| `add_scene` / `switch_scene` | multiple scenes per project |
| `open_project` / `save_project` | read and write `.cclayproject` files |

Coordinates are metres (`x` right, `z` toward the default camera, `y` height above the floor).
Rotations are degrees of yaw. Characters are addressed by letter (`"A"`), slot (`"2"`) or id
(`"char-a"`).

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

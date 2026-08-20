# CozyClay live-control protocol v1

One WebSocket, JSON text frames. The **MCP server hosts** the socket
(`ws://127.0.0.1:5184/live`); the **editor is the client** and reconnects
every 3 s while the page is open. Either side may be absent: the editor works
exactly as before when nothing is listening, and the MCP server falls back to
its in-memory scene when no editor is connected.

## Frames

editor -> server, once after connect:

    { "type": "hello", "role": "editor", "version": 1 }

server -> editor, one per command:

    { "type": "cmd", "id": "<opaque string>", "name": "<command>", "args": { ... } }

editor -> server, one per command, echoing `id`:

    { "type": "result", "id": "<same id>", "ok": true,  "value": { ... } }
    { "type": "result", "id": "<same id>", "ok": false, "error": "<human message>" }

Unknown `name` MUST answer `ok:false`, never silence. The server times a
command out after 5 s and treats it as failed.

## Commands (v1)

All coordinates are metres, rotations are degrees of yaw, ids are the ids the
scene document already uses.

| name | args | value | notes |
| --- | --- | --- | --- |
| `ping` | `{}` | `{ "pong": true }` | liveness |
| `describe` | `{}` | `{ sceneName, camera: { x, y, z, focalMm }, characters: [{ id, subject, x, z, rot, hidden }], objects: [{ id, name, x, y, z, rot, scaleX, scaleY, scaleZ, footprint, height, parent }] }` | read the live scene; object scale and footprint travel too, so sizes are reported from what was actually built; `parent` is null for a top-level object, or the id of another object it rides along with when that parent moves |
| `set_camera` | `{ x?, y?, z?, focalMm? }` | `{ camera }` | omitted fields keep their value; the **viewport must visibly move** |
| `add_character` | `{ subject, x?, z?, rot? }` | `{ id }` | |
| `update_character` | `{ ref, x?, z?, rot?, subject?, hidden? }` | `{ id }` | `ref` = id, letter (`"A"`) or 1-based slot |
| `remove_character` | `{ ref }` | `{ id }` | must refuse to empty the cast |
| `place_object` | `{ kind, x?, z?, y?, rot?, name?, parent? }` | `{ id }` | `kind` from OBJECT_LIBRARY; optional `name` labels the object and optional `parent` attaches it under another object |
| `update_object` | `{ id, x?, y?, z?, rot?, rotX?, rotZ?, scale?, scaleX?, scaleY?, scaleZ?, color?, name? }` | `{ id }` | `scale` sets all three axes; per-axis values override it; `name` renames the object |
| `remove_object` | `{ id }` | `{ id }` | |
| `load_scenes` | `{ document }` | `{ sceneName }` | replace the whole scene document (same shape `serializeSceneDocument` emits); the big hammer that guarantees parity |

## Hard rules for the editor side

- Every mutation MUST go through the same React state paths the UI itself
  uses (the setters/reducers the gizmo, inspector and panels call). Mutating
  three.js objects directly is forbidden: anything outside React state is
  overwritten on the next render.
- Every mutation MUST land in undo history exactly like the equivalent UI
  action would, or be explicitly documented as not undoable.
- The socket client MUST be a no-op in production builds unless explicitly
  enabled; in dev it may always try. A failed connection must never surface
  an error to the user - silence and retry.

## Hard rules for the server side

- When an editor is connected, live-capable tools forward to it and answer
  from its `describe`; when none is connected they fall back to the in-memory
  scene exactly as today. The tool surface does not change.
- One editor at a time: a second `hello` replaces the first (last write wins),
  and the displaced socket is closed.

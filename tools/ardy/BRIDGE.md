# ARDY dev bridge (`tools/ardy/bridge.mjs`)

A dependency-free Node (`node:http` only) sidecar that makes the full ARDY
loop drivable from the CozyClay UI without turning CozyClay into a backend
app.

CozyClay stays a static SPA: `vite build` emits a `dist/` that serves from
anywhere with no server. The box work — pose → npz conversion and the remote
constrained generation — cannot run in a browser, so the bridge exposes it as
four HTTP endpoints on **127.0.0.1:5181** and the Vite dev server proxies
`/ardy` to it. The bridge is **optional and dev-only**: when it is not
running, the app works exactly as before with the generate affordance visibly
unavailable, and the production build never depends on it.

## Start / stop

```sh
node tools/ardy/bridge.mjs                 # listens on 127.0.0.1:5181
node tools/ardy/bridge.mjs --port 5182     # or COZYCLAY_BRIDGE_PORT=5182
```

On startup it logs the bound address. Ctrl-C kills any in-flight generation
process group (the ssh session is closed, so nothing is orphaned on the box).

The bridge reads the same env vars `run-on-box.sh` reads. The remote SSH host
has no public default and must be configured by the operator:

| env | default | meaning |
| --- | --- | --- |
| `COZYCLAY_BRIDGE_PORT` | `5181` | listen port (loopback only) |
| `CCLAY_ARDY_HOST` | required | ssh destination for the ARDY host |
| `CCLAY_ARDY_REPO` | `$HOME/ardy` | ARDY checkout on the box |
| `CCLAY_ARDY_VENV` | `~/ardy/.venv-cuda/bin/python` | generator venv python on the box |
| `CCLAY_ARDY_ENCODER_URL` | `http://127.0.0.1:9550/` | text-encoder service |

The box carries two venvs and they are **not interchangeable**: the CPU
`.venv` runs the text-encoder service and is used for the numpy-only read
steps (frame counts, reference dumps); the `.venv-cuda` venv runs the motion
generator and is what the device probe and generation use.

## Endpoints

### `GET /ardy/health`

Probes the box in one ssh round trip: the host answering, the encoder URL's
HTTP status, and the device the generator venv would pick (the exact probe
line `run-on-box.sh` uses, under the same env).

```json
200 {"ok":true,"host":"user@ardy-host","encoder":200,"device":"cuda:0"}
503 {"ok":false,"reason":"<human readable>"}
```

Successes and failures are cached for 5 s so the UI's health polling does not
hammer ssh.

### `GET /ardy/bases`

Lists `~/ardy/outputs/*.npz` and `~/ardy/outputs/omb/*.npz` on the box with
real frame counts, read in a single ssh call (one `np.load(...)['posed_joints'].shape[0]`
per file, via a python heredoc on the box — never one ssh call per file).
Files that fail to load are skipped with a note on the bridge's stderr.

```json
200 {"bases":[{"id":"...","path":"outputs/omb/....npz","frames":80}, ...]}
```

Cached for 120 s; the list changes rarely. If the same name exists under both
`outputs/` and `outputs/omb/`, both entries are listed and generation picks
the first — the same lookup order `run-on-box.sh` uses.

### `POST /ardy/generate`

Multi-block autoregressive request:

```json
{
  "prompt": "a person walking",
  "duration": 4,
  "posePin": false,
  "segments": [
    {"startFrame": 0, "endFrame": 40, "prompt": "a person walking"},
    {"startFrame": 40, "endFrame": 80, "prompt": "the person stops"}
  ],
  "seed": 2
}
```

For a single-prompt refinement request, `poses` is the source of truth. Each entry carries an authored
full-body pose plus ARDY-space root XYZ in metres. Frames must be strictly
ascending and are converted independently with the floor-aligned canonical
CoreSkeleton27 reference. No user-selected motion supplies root height.
`run-on-box.sh` passes every entry as a repeated
`--pose-from <npz> 0 <frame>` constraint. The remote
`FullBodyConstraintSet` pins joint positions, root X/Y/Z, and heading at that
frame.

`segments` is optional. When present it must contain 2..64 contiguous,
non-overlapping ranges covering frame 0 through `duration * 20`; each range
has its own non-empty prompt. The bridge passes the complete schedule to
`cclay_sequence_generate.py` in one remote process. ARDY stays loaded and
each block receives the previous block's normalized motion tail through
`init_history_sequence`; no per-block process restart, NPZ concatenation, or
crossfade occurs. Segment mode requires `posePin:false` and cannot be combined
with `waypoints`.

A single-prompt rough generation sends `posePin:false` and no `segments`; it
remains a plain text-to-motion run. Once that motion is loaded, CozyClay can
send the composite motion+IK poses and roots as `poses` for constrained
single-prompt regeneration.
The legacy single `pose` + `dstFrame` form remains accepted and is normalized
to one `poses` entry.

For a loaded multi-block motion with authored IK keys, CozyClay sends
`motionEdit` instead of replaying the whole prompt schedule. The edit owns a
source motion URL, an editable interval, history/future context lengths, and
sparse authored keys. Each key names only the IK tracks actually changed.
`cclay_motion_edit.py` supplies the preceding source frames through ARDY's
`init_history_sequence`, supplies following source frames as observed future
context, and creates position/rotation masks only for the named joints.
Root position/heading use a separate track: body-only edits preserve the
source root exactly, while hips edits author a smooth root offset. Contact
arrays stay source-owned unless a foot/leg track was edited.

Pending browser IK keys remain a non-destructive layer until this call
finishes and the returned motion loads. On success they are recorded as
committed edit metadata and removed from the pending IK map, preventing the
same correction from being applied again over the generated motion.

`regenerateSegments` remains accepted as a legacy bridge payload; the
CozyClay UI no longer uses it. This task intentionally does not remove that
old route.

`base` is optional legacy/debug input only. The CozyClay UI does not expose
it. Pose conversion uses the canonical neutral skeleton, while the shell uses
a hidden upright NPZ only to satisfy the current remote script's parser and
baseline report. That NPZ does not supply the authored pose root.

On success the response is NDJSON:

```json
{"event":"status","message":"..."}
{"event":"report","report":{}}
{"event":"done","output":"<absolute path>","bytes":123,"motionUrl":"/ardy/motions/<run-id>"}
```

Validation rejects malformed roots, duplicate/out-of-range pose frames,
non-contiguous segments, empty prompts, invalid durations/seeds, and mixed
segment+waypoint requests with a 400 naming the offending field. Child process
groups are killed on disconnect. A `done` event is emitted only after the
requested output exists and its byte count matches the shell marker.

### `GET /ardy/motions/<run-id>`

Serves the exact npz produced by a successful generation. `<run-id>` is the
id embedded in the `done` event's `motionUrl` — it is a lookup key, never a
path. On success the response is `200` with
`Content-Type: application/octet-stream` and
`Content-Disposition: attachment; filename="gen-<ts>-<rand>-constrained.npz"`
(pose runs) or `"gen-<ts>-<rand>-generated.npz"` (`posePin: false` runs).

The bridge keeps an in-memory run-id → absolute path allowlist that is
populated **only after this process generated the file and verified it on
disk** (see the `done` verification above). Unknown, expired, or
never-this-process ids return `404` JSON; a path is never accepted from the
URL, query, or body. Served files are always under `tools/ardy/out/` — the
allowlist only ever holds paths the bridge itself joined there, and the
check is re-applied at serve time.

## Root coordinate convention (`--root-2d`)

ARDY is **Y-up**: the character stands on the X/Z ground plane, and root
positions are horizontal X and Z in **meters** relative to the ARDY origin
(Y is not constrained by root guidance). A path request carries **2..32
sparse keys** beginning at frame **0**, with strictly ascending frame
indices. CozyClay converts authored scene positions into clip-local X/Z and
uses `heading:null`, leaving facing free. Each key is forwarded to
`run-on-box.sh` as `--root-2d FRAME X Z none`; ARDY generates every
intermediate frame. The script `%q`-quotes every value into the remote
generator invocation.

## Failure semantics

- Before the stream starts (bad fields, unreachable box): plain JSON
  `400`/`503` responses.
- After the stream starts: failures arrive as an `error` event, then the
  stream ends.
- A client disconnect kills the detached child process group (SIGTERM, then
  SIGKILL after 3 s) — the bash script and the ssh session die together, so
  no remote generation is orphaned.
- `OPTIONS` preflight is answered with `204` and **no CORS headers**, so a
  cross-origin browser preflight always fails; unknown paths return `404`
  JSON; wrong methods on known paths return `405`.

## Security posture

- **Loopback only.** The server binds `127.0.0.1`; the host is not
  configurable. This process shells out to a machine that can run GPU work,
  so it must never be reachable from the network.
- **Browser access is same-origin proxy-only; there is no CORS.** The bridge
  never sends `Access-Control-Allow-*` headers on any response (JSON, NDJSON,
  binary, or `OPTIONS`), so the browser's same-origin policy is the
  enforcement boundary: a page from any other origin — including an arbitrary
  website the operator happens to have open — cannot read a response, and the
  `POST /ardy/generate` preflight (JSON bodies are never "simple" requests)
  is refused before it reaches the bridge. Loopback alone is insufficient:
  binding `127.0.0.1` only keeps other *hosts* out, while a request from the
  operator's own browser arrives from the operator's machine, on the loopback
interface, indistinguishable from a legitimate local call. The CozyClay UI
  always talks to the bridge through the Vite dev server's same-origin
  `/ardy` proxy (server-side forwarding, no browser CORS involved); direct
  browser access from another origin is unsupported by design. `curl` and
  other non-browser clients are unaffected — they do not enforce
  same-origin policy.
- **argv arrays, never shell strings.** Request data (prompt, base, frames,
  waypoints) is passed to `spawn` as separate argv entries; no request value
  is ever interpolated into a shell string. The only remote shell strings are
  built from the box's own listing (regex-whitelisted to
  `outputs/(omb/)?[A-Za-z0-9._-]+\.npz`) or from operator env vars.
- **Everything is validated**: prompt length, duration/dstFrame ranges, base
  whitelist, frame-zero root start bounds, body size cap, `seed`/`cpu` types.
- **ssh hardening**: `BatchMode` (never a password prompt), `ConnectTimeout`,
  `ServerAlive*` — the same options `run-on-box.sh` uses.
- **No writes to `~/ardy`**: the dump script is copied to `/tmp` on the box
  and removed afterwards; all artifacts land under the gitignored
  `tools/ardy/out/`.
- **Served npz files are allowlisted, not addressed.** `GET /ardy/motions/<run-id>`
  resolves the id against an in-memory map populated only after this process
  generated and verified the file; a path never comes from the URL, query, or
  body, and nothing outside `tools/ardy/out/` is ever served.

## Caching

| data | cache | why |
| --- | --- | --- |
| health | 5 s (success and failure) | the UI polls it; a dead box must not become an ssh stampede |
| bases | 120 s | the list changes rarely |
| reference dumps | on disk under `tools/ardy/out/refs/` | same base, reused across requests |

## Relationship to the rest of the repo

- `tools/ardy/pose-to-npz.mjs`, `tools/ardy/run-on-box.sh`,
  `tools/ardy/dump-npz.py`, `src/ardy/*` and `test/ardy/*` are the verified,
  reusable pieces; the bridge calls them, never reimplements them.
- The Vite dev server (`vite.config.js`) proxies `/ardy` to
  `127.0.0.1:5181`; the production `dist/` build contains no proxy, no
  server code, and no dependency on the bridge.

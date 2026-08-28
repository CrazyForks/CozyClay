# Motion bridge support files

The local Studio uses Kimodo as its only motion-generation backend. The bridge
entry point remains at `tools/ardy/bridge.mjs` for compatibility with the
existing `/ardy/*` browser protocol and stored motion URLs; the name is a
wire-format path, not a selectable backend.

## Local development

```bash
CCLAY_KIMODO_HOST=user@gpu-box npm run dev
```

Install the Kimodo host once with `npm run kimodo:setup`. To run the UI without
any sidecar, use `npm run dev:ui`; the seeded motion and all staging, camera,
IK, and playback features still work.

The bridge accepts `COZYCLAY_BRIDGE_PORT` (or `--port`) and binds loopback
only. Kimodo connection settings are `CCLAY_KIMODO_HOST`,
`CCLAY_KIMODO_REPO`, and `CCLAY_KIMODO_MODEL`.

## Shared utilities

`npz.mjs`, `artifacts.mjs`, `footage.mjs`, `extract.mjs`, and the files under
`src/ardy/` provide the common motion archive, ingest, conversion, IK, and
playback contracts used by both generated and imported takes. They are not an
ARDY runtime installation.

The hosted demo worker still has a separately managed local runner for its
queue jobs; that deployment path is intentionally independent of the local
Studio selector.

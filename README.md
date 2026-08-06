# CozyClay

CozyClay is a browser-based 3D staging and ARDY motion studio. It combines scene blocking, character posing, prompt-block sequencing, waypoint planning, IK editing, and generated-motion preview in one local workspace.

## Requirements

- Node.js 22 or newer
- npm
- A Chromium-based browser
- Optional: an SSH-accessible NVIDIA machine with ARDY for motion generation

## Install

```bash
git clone https://github.com/HaD0Yun/CozyClay.git
cd CozyClay
npm install
```

## Run locally

Start the standalone studio:

```bash
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`.

Start the studio together with the local ARDY bridge:

```bash
npm run dev:full
```

The bridge listens on loopback only. Configure the remote ARDY machine through the environment variables documented in `tools/ardy/BRIDGE.md`.

## Main features

- Browser-based 3D scene staging
- Character pose editing and pose export
- Prompt Block timeline for multi-phase motion
- ARDY motion generation and playback
- Sparse IK motion correction
- 2D root waypoints and Bird's-eye planning
- Resizable production workspace
- Browser-driven visual QA

## Validate

```bash
npm run test:hierarchy
npm run test:scene-objects
npm run test:theme
npm run test:appearance
npm run test:layout
npm run test:ardy
npm run build
```

Run browser QA while the development server is available:

```bash
npm run qa:browser -- <qa-script>
```

## Repository hygiene

Generated motion archives, QA output, build output, logs, and local runtime artifacts are not source files and must not be committed. In particular, keep `tools/ardy/out/`, `artifacts/`, `dist/`, `.gjc/`, and `.npz` files local.

## License

CozyClay is licensed under the GNU General Public License v3.0 or later. See `LICENSE`.

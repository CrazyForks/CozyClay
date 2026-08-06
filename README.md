# CozyClay

CozyClay is an independent, browser-based 3D staging studio built with Three.js and React Three Fiber. It combines scene blocking, character posing, prompt-block sequencing, waypoint planning, IK editing, and generated-motion preview in one local workspace.

CozyClay can connect to [NVIDIA ARDY](https://github.com/nv-tlabs/ardy) for motion generation. ARDY is a separate third-party project owned and maintained by NVIDIA; it is not included in this repository, and CozyClay is not affiliated with or endorsed by NVIDIA.

![CozyClay browser-based 3D staging studio](docs/images/cozyclay-studio.png)

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

Start the studio and its local ARDY bridge:

```bash
npm run dev
```

Open `http://127.0.0.1:5180`.

To run only the browser UI without Block Generation:

```bash
npm run dev:ui
```

The ARDY bridge listens on loopback only. Configure the remote ARDY machine through the environment variables documented in `tools/ardy/BRIDGE.md`.

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

Third-party projects retain their own licenses and copyright. See `THIRD_PARTY_NOTICES.md`.

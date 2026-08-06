# CozyClay -> ARDY pose bridge

`run-on-box.sh` pushes a synthetic pose `.npz` produced from a CozyClay pose
into the ARDY text-to-motion pipeline on the remote box, runs a constrained
generation pass that honours that pose, and pulls the resulting motion back.
This is the "long tail" of the bridge: the pose is authored in CozyClay,
converted to an ARDY motion npz locally, and this script is what actually
gets the box to generate with it.

## The box

- Identity: `100.90.2.101` over Tailscale (hostname `ubuntu-baremetal`,
  user `yun`). 12 cores, 94 GB RAM, RTX 3070 with 8.2 GB VRAM.
- Access: `ssh -o BatchMode=yes 100.90.2.101` — key-based only, no
  password prompts. The host and repo are overridable with the same env
  names `sync-to-box` (CozyClay `scripts/ardy/sync-to-box`) uses:
  - `CCLAY_ARDY_HOST` — default `100.90.2.101`
  - `CCLAY_ARDY_REPO` — default `$HOME/ardy` on the box (expanded remotely)
  - `CCLAY_ARDY_VENV` — default `~/ardy/.venv/bin/python`
- Python: `~/ardy/.venv/bin/python` (torch 2.13.0+cu130). The box's system
  python3 has no torch, so the venv is used explicitly everywhere.
- The constrained generator lives at `~/ardy/scripts/cclay_constrained_generate.py`,
  deployed from CozyClay `scripts/ardy/cclay_constrained_generate.py`
  (source of truth; the deployed copy must not be edited by hand).

## Why CPU — and the NVML trap

The box runs this pipeline on CPU **on purpose**, and `run-on-box.sh` forces
it with `CUDA_VISIBLE_DEVICES=""`. The reason is two-part:

1. The RTX 3070 has only 8.2 GB VRAM; the box has 94 GB RAM. The model does
   not fit on the GPU, and diffusion sampling on 12 CPU cores is the
   intended configuration.
2. `nvidia-smi` on the box fails with `Failed to initialize NVML: Driver/
   library version mismatch` (a stale kernel module vs. userspace driver),
   yet `torch.cuda.is_available()` still returns `True` — the generator's
   `device = "cuda:0" if torch.cuda.is_available() else "cpu"` line would
   otherwise pick a GPU that cannot hold the model and crash (or worse,
   silently swap).

Because of the trap, "just check with nvidia-smi" is NOT a valid probe.
The preflight in `run-on-box.sh` therefore mirrors the generator's exact
device expression under the same env and prints what the run will actually
use — with `CUDA_VISIBLE_DEVICES=""` it always reports `cpu`.

## Where the motions live on the box

- Base (first-pass, unconstrained) motions: `~/ardy/outputs/*.npz` and
  `~/ardy/outputs/omb/*.npz`. `run-on-box.sh` resolves a bare `--base` id
  against `outputs/<id>.npz` first, then `outputs/omb/<id>.npz`; a bare
  `<name>.npz` is treated the same with the suffix stripped; anything with a
  `/` is used as a repo-relative or absolute path.
- The base npz must be at least as long as the requested clip — the
  generator rejects a shorter base (`--base npz has N frames but the
  requested clip is M`), so pick a base that covers `--duration`.
- Nothing is ever written into the checkout: the pose npz and the generated
  output live under a fresh `mktemp -d` dir on the box (usually `/tmp`),
  which an `EXIT` trap removes even on failure.

## The pose npz contract

`<pose.npz>` is an ARDY motion npz — the same format as a base motion — that
must carry `local_rot_mats` and `posed_joints`. One frame is enough: the
CozyClay pose is baked into `local_rot_mats[src_frame]` (the cskel27
per-joint local rotations, built from the CozyClay basis quaternions via
`basis = Rb^T @ L @ Rb` / `L = Rb @ basis @ Rb^T`, where `Rb` is the bone's
armature-space rest rotation — see CozyClay `motion_retarget.py` /
`motion_constraints.py`). The src-frame is range-checked against the npz by
the generator remotely, so an out-of-range `--src-frame` dies on the box
with a clear message rather than silently.

## The generation grammar

The raw generator flag for a full-body pose constraint is:

```
--pose-from <src-npz> <src-frame> <dst-frame>
```

It copies **every joint's** pose from `<src-npz>` at `<src-frame>` and pins
it at `<dst-frame>` of the new clip. It is repeatable, requires `--base`,
and works for poses no end-effector constraint can express (sitting, lying,
reaching). The clip is `int(duration * 20)` frames at ARDY's 20 fps, and
`dst-frame` must satisfy `0 <= dst-frame < duration * 20`; the generator
also rejects clips under 3 frames.

`run-on-box.sh` maps its arguments onto the generator one-to-one:

```
run-on-box.sh <pose.npz> --base <motion-id|npz-path> --prompt "<prompt>" \
  --duration <seconds> --dst-frame <N> [--src-frame <N>] [--seed <S>] \
  [--output <local.npz>] [--dry-run]
```

which becomes, on the box (modulo the temp dir):

```
cd $HOME/ardy && CUDA_VISIBLE_DEVICES="" ~/ardy/.venv/bin/python \
  scripts/cclay_constrained_generate.py \
  --prompt "<prompt>" --duration <seconds> \
  --base <resolved-base> --output <tmp>/out \
  --pose-from <tmp>/pose.npz <src-frame> <dst-frame> [--seed <S>]
```

The CozyClay wrapper `cclay-ardy-generate` exposes the same feature through
its own grammar — `--constrain-pose <src-motion-id> <src-frame> <dst-frame>`
— where `<src-motion-id>` is a motion already staged in the CozyClay
project (`.cclay/motions/<id>.npz`) rather than a raw npz path. `run-on-box.sh`
exists for the CozyClay flow, where the pose source is a synthetic npz
produced by the conversion module and the base motion is a pre-existing
`~/ardy/outputs/*.npz`; both paths drive the same `--pose-from` mechanism.

## Preflight, safety, idempotence

Before anything is pushed, `run-on-box.sh` fails fast, cheapest check
first:

1. SSH reachability (`BatchMode` + `ConnectTimeout`, so a dead host or a
   missing key errors in seconds, not minutes).
2. `~/ardy/.venv/bin/python` and `scripts/cclay_constrained_generate.py`
   exist on the box (points at `sync-to-box --apply` when missing).
3. The base motion resolves to a file that exists on the box.
4. The device probe: the one-line torch check mirroring the generator's
   device expression, under the same `CUDA_VISIBLE_DEVICES=""` env, printed
   before launching. It reports `cpu`; if it ever reports `cuda:0`, the
   forcing is not working and the run must not start.

`--dry-run` runs all of the above (they are reads only), prints the exact
push / remote-command / pull / cleanup steps, and exits without connecting
for the generation step.

Every expansion is quoted; `set -euo pipefail` is on; prompts and paths are
shell-quoted with `printf %q` so they survive the remote shell. The remote
temp dir is created with `mktemp -d`, removed by an `EXIT` trap (cleanup
failure never masks the real result), and guarded to be absolute before it
can reach `rm -rf`. Re-running the same command with the same `--output`
overwrites it — no state accumulates anywhere.

## Example

```
tools/ardy/run-on-box.sh /tmp/pose-shooting.npz \
  --base a-person-runs-forward-0722151659 \
  --prompt "a person sprints forward and raises both arms" \
  --duration 5 --dst-frame 60 --seed 7 \
  --output tools/ardy/out/sprint-pose.npz
```

The generator's stdout passes through (device line, loaded model, per-frame
constraint lines, final JSON result), and the pulled npz lands at
`--output` (default `tools/ardy/out/<pose>-constrained.npz`, gitignored).
The result is a full ARDY motion npz and can be used like any other
generated motion.

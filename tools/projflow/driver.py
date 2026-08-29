#!/usr/bin/env python3
"""driver.py — ProjFlow line-edit driver, shipped to the GPU box per run.

CozyClay ships THIS file to the box the same way tools/kimodo/generate.mjs
ships its constraint JSONs: nothing is installed on the box, the scout venv is
the only python, and a run leaves a mkdtemp behind that the wrapper deletes.

WHY A DRIVER AND NOT `demo/run.py`. Contract C7: the two ProjFlow samplers each
carry exactly half of a CozyClay line edit and neither CLI exposes the other
half.

  * `sample_projflow(A=(B,3,T,J) mask, y=values)` preserves source frames
    exactly (S1 measured 4.8e-7 m), but its targets are 3D WORLD points — it has
    no camera, so a drawn screen-space line cannot be expressed at all.
  * `sample_linear_constraints(operator A=(m, 3*T*J), measurement y=(m,))` takes
    a GENERAL dense operator, so a camera row is just another row — but
    `demo/run.py` only ever builds projection rows plus a frame-0 keyframe, so
    "keep the rest of the take" does not exist on that path.

`sample_linear_constraints` is the general one and the cheaper one (S1: ~2.7x
faster per step than the projflow inpainting sampler), and demo/run.py ALREADY
stacks two kinds of row into one operator (projection rows for the lifted joint
+ identity-ish keyframe rows at frame 0). So preserved frames are nothing more
exotic than more rows: one identity row per kept (frame, joint, axis) whose
measurement is the source coordinate. One operator, one pass, both halves.

WHY THE ROWS ARE EXACTLY LINEAR UNDER A PERSPECTIVE CAMERA (contract C6, as
amended after Phase 0). The paper's demo only accepts an orthographic camera and
the plan originally carried an orthographic approximation of CozyClay's shot
camera as a known risk. It is not needed. With

    X_cam = R @ x + t          (R world->camera, t in camera space)
    u = fx * X_cam[0]/X_cam[2] + cx
    v = fy * X_cam[1]/X_cam[2] + cy

the depth division is the only nonlinearity, and multiplying it out cancels it:

    (u - cx) * (R2.x + t2) = fx * (R0.x + t0)
  =>  [fx*R0 - (u-cx)*R2] . x  =  -[fx*t0 - (u-cx)*t2]
  and [fy*R1 - (v-cy)*R2] . x  =  -[fy*t1 - (v-cy)*t2]

Two rows per constrained frame, each with exactly THREE nonzero entries (the
x/y/z columns of the target joint at that frame). u and v are KNOWN — they are
what the artist drew — so nothing here depends on the unknown depth. This is
exact at every focal length, which is why gate GP1's "<1 px" now applies to the
close-up case too.

UNITS. `points2d` and the intrinsics must share ONE unit system; the algebra
above is unit-agnostic as long as they agree. CozyClay sends viewport-normalised
0..1 for both (fx/fy/cx/cy pre-divided by the viewport size), so the reprojection
errors reported in the metadata are in normalised viewport units.

THE COST OF A ROW, AND WHY PRESERVE ROWS ARE SUBSAMPLED. The caller precomputes
a Cholesky of `A A^T + lambda I`, which is m x m — the ROW count, not the column
count, is what has to stay bounded. Freezing a 196-frame take densely would be
196 * 22 * 3 = 12936 rows and a 12936^2 factorisation (670 MB fp32) for
information that is 90% redundant: adjacent frames of a real take are nearly the
same pose. The subsampling policy is documented at `build_preserve_rows`.

OUTPUT. `<out>.npy` (T,22,3) float32 world metres @ 20 fps, HumanML3D 22-joint
order, plus `<out>.meta.json`. POSITIONS ONLY — ACMDM's "Raw" family generates
absolute coordinates and has no rotation channel. Converting to cskel27 (which
must LIFT rotations) is a separate module and deliberately not done here; see
the seam comment in generate.mjs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np


# --- the hml22 skeleton ------------------------------------------------------
#
# HumanML3D / T2M 22-joint order, from `utils.motion_process.t2m_kinematic_chain`
# and SMPL_JOINT_NAMES[0:22]. S2's mapping table is the citation; this is the
# subset the driver actually needs.
HML22_PARENT = (
    -1,  # 0  pelvis
    0,   # 1  left_hip
    0,   # 2  right_hip
    0,   # 3  spine1
    1,   # 4  left_knee
    2,   # 5  right_knee
    3,   # 6  spine2
    4,   # 7  left_ankle
    5,   # 8  right_ankle
    6,   # 9  spine3
    7,   # 10 left_foot   (TOE BASE, not the foot — S2's naming trap)
    8,   # 11 right_foot  (toe base)
    9,   # 12 neck
    9,   # 13 left_collar    (the CLAVICLE — cskel27 LeftShoulder)
    9,   # 14 right_collar
    12,  # 15 head
    13,  # 16 left_shoulder  (the UPPER-ARM ROOT — cskel27 LeftArm)
    14,  # 17 right_shoulder
    16,  # 18 left_elbow
    17,  # 19 right_elbow
    18,  # 20 left_wrist
    19,  # 21 right_wrist
)

NUM_JOINTS = 22

# The joints where independent limbs branch: the pelvis and the spine3 junction
# that carries the neck and both clavicles. An edit frees its limb UP TO its
# anchor and no further, so the body cannot drift while one arm is redrawn.
LIMB_ANCHORS = frozenset({0, 9})

# CozyClay IK track id -> hml22 joint index.
#
# THE JS SIDE IS THE AUTHORING SOURCE (generate.mjs exports the same table and
# writes the resolved `jointId` into line.json); this copy is a GUARD, re-checked
# below, so a stale wrapper shipping the wrong joint fails loudly on the box
# instead of silently editing the wrong limb.
#
# Derived from S2's mapping table by composing the two hops it documents:
# track -> cskel27 target (the pose studio's own table, ik.js) -> hml22 source.
# Two of those hops look like typos and are not:
#   * `leftElbow` is cskel27 LeftForeArm, whose hml22 source is left_elbow (18).
#     A mid-joint track therefore constrains its OWN joint, not its chain's
#     effector: the artist dragged the elbow handle and drew the ELBOW's path,
#     and pinning joint 20 instead would move the wrist along the drawn line and
#     leave the elbow wherever the model liked.
#   * `spine` is cskel27 Spine1, whose hml22 source is spine2 (6) — cskel27 has
#     three spine links between the anchors where hml22 has two.
TRACK_TO_JOINT = {
    # IK effectors
    "leftHand": 20,   # cskel27 LeftHand  <- left_wrist
    "rightHand": 21,  # cskel27 RightHand <- right_wrist
    "leftFoot": 7,    # cskel27 LeftFoot  <- left_ANKLE (10 is the toe base)
    "rightFoot": 8,   # cskel27 RightFoot <- right_ankle
    # mid-chain handles
    "leftElbow": 18,  # cskel27 LeftForeArm  <- left_elbow
    "rightElbow": 19,
    "leftKnee": 4,    # cskel27 LeftLeg <- left_knee
    "rightKnee": 5,
    # FK handles
    "hips": 0,        # cskel27 Hips <- pelvis
    "spine": 6,       # cskel27 Spine1 <- spine2
    "neck": 12,
    "head": 15,
    "leftShoulder": 13,   # cskel27 LeftShoulder is the CLAVICLE <- left_collar
    "rightShoulder": 14,
}

# `chest` is cskel27 Spine2, and Spine2 is one of S2's five FILLED joints: hml22
# has no source for it at all (three cskel27 spine links between Hips and Spine3
# against hml22's two). There is no joint to constrain, so a chest line edit is
# refused by name rather than silently retargeted onto a neighbouring spine
# joint, which would put the drawn line on a curve the artist did not draw.
UNMAPPABLE_TRACKS = {
    "chest": "cskel27 Spine2 has no hml22 source joint (S2: a FILLED joint)",
}


def limb_chain(joint: int) -> frozenset:
    """Joints the edit is allowed to move: `joint`, its descendants, and its
    ancestors up to (not including) the nearest limb anchor.

    For joint 20 (left wrist) this is {13, 16, 18, 20} — the whole left arm from
    the clavicle out. For joint 0 (pelvis) it is the whole body, which is right:
    a hips line edit drags the figure.
    """
    out = {int(joint)}
    # descendants
    changed = True
    while changed:
        changed = False
        for child, parent in enumerate(HML22_PARENT):
            if parent in out and child not in out:
                out.add(child)
                changed = True
    # ancestors, up to the anchor
    node = HML22_PARENT[int(joint)]
    while node is not None and node >= 0 and node not in LIMB_ANCHORS:
        out.add(node)
        node = HML22_PARENT[node]
    return frozenset(out)


def resample_polyline(points, count):
    """Resample an (P,2) polyline to `count` points, arc-index-linearly.

    Deliberately the SAME convention as the repo's own
    `demo/lift/trajectory_io._resample_xy`: uniform parameter over the point
    INDEX (not arc length), linear interpolation. Matching it means a polyline
    that the demo would place at frame t lands on frame t here too, so S1's
    measured 2.4e-7 reprojection number transfers.
    """
    pts = np.asarray(points, dtype=np.float32)
    if pts.ndim != 2 or pts.shape[1] != 2:
        raise ValueError(f"points2d must be (P,2), got {pts.shape}")
    if pts.shape[0] < 2:
        raise ValueError("points2d needs at least 2 points")
    if pts.shape[0] == int(count):
        return pts
    t_src = np.linspace(0.0, 1.0, num=pts.shape[0], dtype=np.float32)
    t_dst = np.linspace(0.0, 1.0, num=int(count), dtype=np.float32)
    out = np.empty((int(count), 2), dtype=np.float32)
    out[:, 0] = np.interp(t_dst, t_src, pts[:, 0])
    out[:, 1] = np.interp(t_dst, t_src, pts[:, 1])
    return out.astype(np.float32)


def column_index(axis: int, frame: int, joint: int, *, num_frames: int, num_joints: int) -> int:
    """Column of x[axis, frame, joint] in the flattened (3, L, J) operand.

    Copied from `demo/lift/projection_operator.column_index` rather than
    imported so this file states the layout it depends on; the two are asserted
    equal at startup (see `_assert_column_layout`).
    """
    return (axis * num_frames + frame) * num_joints + joint


def _assert_column_layout(num_frames: int) -> None:
    from demo.lift.projection_operator import column_index as repo_column_index

    for axis, frame, joint in ((0, 0, 0), (1, 3, 7), (2, num_frames - 1, NUM_JOINTS - 1)):
        mine = column_index(axis, frame, joint, num_frames=num_frames, num_joints=NUM_JOINTS)
        theirs = repo_column_index(axis, frame, joint, num_frames=num_frames, num_joints=NUM_JOINTS)
        if mine != theirs:
            raise RuntimeError(
                "column layout drifted from demo/lift/projection_operator.column_index "
                f"({mine} != {theirs}); every row this driver builds would be scrambled"
            )


# --- constraint construction -------------------------------------------------

def build_line_rows(line, *, frames, joint_id):
    """Per-frame affine perspective rows for the drawn polyline.

    Returns (rows, values, frame_indices, uv) where `rows` is a list of
    (col, coefficient) triples-per-row. See the module docstring for the algebra.
    """
    cam = line["camera"]
    fx = float(cam["fx"])
    fy = float(cam["fy"])
    cx = float(cam["cx"])
    cy = float(cam["cy"])
    R = np.asarray(cam["R"], dtype=np.float64)
    t = np.asarray(cam["t"], dtype=np.float64).reshape(3)
    if R.shape != (3, 3):
        raise ValueError(f"camera.R must be 3x3, got {R.shape}")
    if fx == 0.0 or fy == 0.0:
        raise ValueError("camera.fx and camera.fy must be non-zero")

    start = int(line["frameRange"]["start"])
    end = int(line["frameRange"]["end"])
    if not (0 <= start <= end < frames):
        raise ValueError(
            f"frameRange {start}..{end} is outside the source motion's 0..{frames - 1}"
        )
    span = end - start + 1
    uv = resample_polyline(line["points2d"], span)

    R0, R1, R2 = R[0], R[1], R[2]
    rows = []
    values = []
    frame_indices = list(range(start, end + 1))
    for k, frame in enumerate(frame_indices):
        u = float(uv[k, 0])
        v = float(uv[k, 1])
        cols = [
            column_index(axis, frame, joint_id, num_frames=frames, num_joints=NUM_JOINTS)
            for axis in range(3)
        ]
        # u row
        coef_u = fx * R0 - (u - cx) * R2
        rows.append(list(zip(cols, coef_u.tolist())))
        values.append(-(fx * t[0] - (u - cx) * t[2]))
        # v row
        coef_v = fy * R1 - (v - cy) * R2
        rows.append(list(zip(cols, coef_v.tolist())))
        values.append(-(fy * t[1] - (v - cy) * t[2]))
    return rows, values, frame_indices, uv


def build_preserve_rows(source, *, edit_start, edit_end, chain, stride, margin):
    """Identity rows pinning the SOURCE take outside the edited range.

    SUBSAMPLING POLICY — stated in full because it is the one place this driver
    trades exactness for a tractable Cholesky (`A A^T + lambda I` is m x m):

    1. FRAME STRIDE. Only every `stride`-th frame outside the edit range carries
       rows (default 2 => half the rows). Adjacent frames of a real take are
       nearly the same pose, so a pinned frame constrains its neighbour almost
       as hard as pinning it directly would; the flow prior supplies the rest.
       The stride is phase-locked to frame 0 (`range(0, T, stride)`) so two runs
       over the same take pin the same frames.

    2. THE SEAM IS ALWAYS PINNED. The frames immediately either side of the edit
       range are added regardless of stride. That is where a pop would show
       (gate GP2 measures the blend seams, not the preserved interior), so it is
       the one place a missed frame is expensive.

    3. CHAIN EXCLUSION INSIDE A MARGIN. Within `margin` frames of the edit range
       the EDITED LIMB's joints (`chain`) carry no rows, while the rest of the
       body still does. The limb has to travel from where the source take left
       it to the drawn line; pinning it hard right up to the boundary would ask
       for an instantaneous jump and the sampler would split the difference,
       missing the line at its start. Outside the margin every joint is pinned.

    Order of the emitted rows is (frame, joint, axis), ascending, so a run is
    reproducible and `preservedFrames` in the metadata reads in time order.
    """
    frames = int(source.shape[0])
    lo = max(0, int(edit_start) - int(margin))
    hi = min(frames - 1, int(edit_end) + int(margin))

    candidates = set(range(0, frames, max(1, int(stride))))
    for seam in (int(edit_start) - 1, int(edit_end) + 1):
        if 0 <= seam < frames:
            candidates.add(seam)
    kept_frames = sorted(f for f in candidates if f < int(edit_start) or f > int(edit_end))

    rows = []
    values = []
    pinned = []  # (frame, joint) pairs, for the self-check below
    for frame in kept_frames:
        in_margin = lo <= frame <= hi
        for joint in range(NUM_JOINTS):
            if in_margin and joint in chain:
                continue
            for axis in range(3):
                col = column_index(axis, frame, joint, num_frames=frames, num_joints=NUM_JOINTS)
                rows.append([(col, 1.0)])
                values.append(float(source[frame, joint, axis]))
            pinned.append((frame, joint))
    return rows, values, kept_frames, pinned


def densify(rows, values, *, frames):
    """Materialise the sparse row list into the dense (m, 3*T*J) operator the
    sampler wants. Every row has at most 3 nonzeros, but
    `sample_linear_constraints` takes a dense tensor, so this is where the
    memory goes: m * 3*T*J * 4 bytes."""
    m = len(rows)
    n = 3 * int(frames) * NUM_JOINTS
    A = np.zeros((m, n), dtype=np.float32)
    for index, row in enumerate(rows):
        for col, coefficient in row:
            A[index, col] = coefficient
    return A, np.asarray(values, dtype=np.float32)


def project(points_world, cam):
    """Perspective-project (N,3) world points with the request's camera, in the
    same units the request used. The self-check reprojection number is computed
    with THIS, independently of the rows, so a sign error in the row algebra
    shows up as a large error rather than cancelling itself out."""
    R = np.asarray(cam["R"], dtype=np.float64)
    t = np.asarray(cam["t"], dtype=np.float64).reshape(1, 3)
    cam_pts = points_world.astype(np.float64) @ R.T + t
    z = cam_pts[:, 2]
    u = float(cam["fx"]) * cam_pts[:, 0] / z + float(cam["cx"])
    v = float(cam["fy"]) * cam_pts[:, 1] / z + float(cam["cy"])
    return np.stack([u, v], axis=1)


# --- request validation ------------------------------------------------------

def resolve_joint(line):
    track = line.get("track")
    if not isinstance(track, str) or not track:
        raise ValueError("line.track is required and must be a non-empty string")
    if track in UNMAPPABLE_TRACKS:
        raise ValueError(f"track {track!r} cannot be line-edited: {UNMAPPABLE_TRACKS[track]}")
    if track not in TRACK_TO_JOINT:
        known = ", ".join(sorted(TRACK_TO_JOINT))
        raise ValueError(f"unknown track {track!r}; known line-edit tracks: {known}")
    expected = TRACK_TO_JOINT[track]
    declared = line.get("jointId")
    if declared is not None and int(declared) != expected:
        # See TRACK_TO_JOINT's header: the JS side resolves the joint and this is
        # the guard against a wrapper that has drifted from the driver.
        raise ValueError(
            f"line.jointId {declared} disagrees with track {track!r} -> joint {expected}; "
            "the wrapper and the driver disagree about the skeleton"
        )
    return expected


def main() -> int:
    ap = argparse.ArgumentParser("ProjFlow line-edit driver")
    ap.add_argument("--source", required=True, help="source motion .npy, (T,22,3) float32 world metres")
    ap.add_argument("--line", required=True, help="line-edit request .json (contract C6)")
    ap.add_argument("--out", required=True, help="output .npy; metadata goes to <out stem>.meta.json")
    ap.add_argument("--steps", type=int, default=100, help="ODE steps (S1: ~7.3 ms/step at 100 frames)")
    ap.add_argument("--ridge", type=float, default=1e-6,
                    help="ridge_lambda. S1: THIS is the exactness knob, not steps — 1e-3 lands at "
                         "2.6e-5 while 1e-6 gives 2.4e-7 at half the steps")
    ap.add_argument("--preview", action="store_true",
                    help="20 steps instead of --steps (S1 measured 0.145 s for a 100-frame preview)")
    ap.add_argument("--preserve-stride", type=int, default=2, help="pin every Nth frame outside the edit range")
    ap.add_argument("--preserve-margin", type=int, default=20,
                    help="frames either side of the edit range where the edited limb is left free (20 = 1 s)")
    ap.add_argument("--seed", type=int, default=0, help="matches demo/run.py's default")
    ap.add_argument("--cfg", type=float, default=3.0, help="classifier-free guidance scale")
    ap.add_argument("--repo", default=os.environ.get("CCLAY_PROJFLOW_REPO", "/home/yun/projflow-scout/repo"))
    ap.add_argument("--model-id", default="ACMDM-Raw-Flow-S-PatchSize22")
    ap.add_argument("--model-name", default="ACMDM_Raw_Flow_S_PatchSize22")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    # Resolve every caller-supplied path BEFORE the chdir below, or a relative
    # --source silently resolves against the ProjFlow clone instead of the
    # caller's cwd. generate.mjs always passes absolute paths; a human running
    # this by hand should not have to.
    args.source = str(Path(args.source).expanduser().resolve())
    args.line = str(Path(args.line).expanduser().resolve())
    args.out = str(Path(args.out).expanduser().absolute())

    repo = Path(args.repo).expanduser().resolve()
    if not (repo / "demo").is_dir():
        raise SystemExit(f"--repo {repo} does not look like a ProjFlow clone (no demo/)")
    # The repo's own modules are imported by package path and its model loader
    # resolves checkpoints relative to the repo root, so both the path and the
    # cwd have to be the clone.
    sys.path.insert(0, str(repo))
    os.chdir(str(repo))

    import torch  # after sys.path, so the venv's torch is the one that loads
    from demo.common.model_loader import load_acmdm_from_config, resolve_device
    from demo.common.motion_stats import load_22x3_stats, denormalize_world
    from demo.common.normal_equations import precompute_normal_cholesky
    from demo.common.sampling import sample_with_linear_constraints
    from demo.lift.projection_operator import convert_linear_measurement_to_normalized_space

    source = np.load(args.source).astype(np.float32)
    if source.ndim != 3 or source.shape[1] != NUM_JOINTS or source.shape[2] != 3:
        raise SystemExit(f"--source must be (T,22,3); got {source.shape}")
    frames = int(source.shape[0])
    _assert_column_layout(frames)

    with open(args.line, "r", encoding="utf-8") as handle:
        line = json.load(handle)
    joint_id = resolve_joint(line)
    prompt = str(line.get("prompt") or "")

    steps = 20 if args.preview else int(args.steps)

    # --- fuse the operator ---------------------------------------------------
    line_rows, line_values, line_frames, uv = build_line_rows(line, frames=frames, joint_id=joint_id)
    chain = limb_chain(joint_id)
    keep_rows, keep_values, kept_frames, pinned = build_preserve_rows(
        source,
        edit_start=int(line["frameRange"]["start"]),
        edit_end=int(line["frameRange"]["end"]),
        chain=chain,
        stride=int(args.preserve_stride),
        margin=int(args.preserve_margin),
    )
    A_world_np, y_world_np = densify(line_rows + keep_rows, line_values + keep_values, frames=frames)
    m = int(A_world_np.shape[0])

    device = resolve_device(str(args.device))
    loaded = load_acmdm_from_config(
        {"id": args.model_id, "name": args.model_name, "dataset": "t2m"},
        repo_root=repo,
        device=device,
    )
    mean_np, std_np = load_22x3_stats("t2m", repo)

    A_world = torch.from_numpy(A_world_np).to(device=device)
    y_world = torch.from_numpy(y_world_np).to(device=device)
    # THE normalisation convention, taken from the repo so there is one spelling
    # of it: x_world = x_norm*std + mean  =>  A' = A diag(std), y' = y - A mean.
    # It is applied to the line rows and the preserve rows TOGETHER, which is the
    # whole point of fusing them into one operator.
    A_norm, y_norm = convert_linear_measurement_to_normalized_space(
        operator_world=A_world,
        measurement_world=y_world,
        mean=torch.from_numpy(np.asarray(mean_np, dtype=np.float32)).to(device=device),
        std=torch.from_numpy(np.asarray(std_np, dtype=np.float32)).to(device=device),
        num_frames=frames,
        num_joints=NUM_JOINTS,
    )

    factor = precompute_normal_cholesky(A_norm, ridge_lambda=float(args.ridge))

    # An empty prompt with cfg != 1 duplicates the batch to guide toward nothing;
    # on a line edit the constraints carry the intent, so guidance is switched off
    # rather than paid for. A prompt that IS given keeps the demos' cfg.
    cfg_scale = float(args.cfg) if prompt else 1.0

    if device.type == "cuda":
        torch.cuda.synchronize()
    started = time.time()
    result = sample_with_linear_constraints(
        loaded.model,
        prompt=prompt,
        operator=A_norm,
        measurement=y_norm.view(1, -1),
        normal_cholesky=factor.normal_cholesky.to(device=device),
        frames=frames,
        num_joints=NUM_JOINTS,
        num_samples=1,
        seed=int(args.seed),
        steps=steps,
        cfg=cfg_scale,
        device=device,
    )
    if device.type == "cuda":
        torch.cuda.synchronize()
    sampling_seconds = time.time() - started

    out_norm = result.samples_norm[0].permute(1, 2, 0).detach().cpu().numpy()  # (T,J,3)
    out_world = denormalize_world(out_norm, mean_np, std_np).astype(np.float32)

    out_path = Path(args.out).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(str(out_path), out_world)

    # --- self-check ----------------------------------------------------------
    # Both numbers are computed from the SAVED motion, not from the sampler's
    # internals, and the reprojection uses `project()` rather than the rows, so a
    # sign error cannot hide inside its own operator.
    if pinned:
        pin_f = np.asarray([f for f, _ in pinned])
        pin_j = np.asarray([j for _, j in pinned])
        preserved_err = np.abs(out_world[pin_f, pin_j] - source[pin_f, pin_j])
        preserved_max = float(preserved_err.max())
        preserved_mean = float(preserved_err.mean())
    else:
        preserved_max = preserved_mean = 0.0
    reproj = project(out_world[line_frames, joint_id], line["camera"])
    line_err = np.abs(reproj - uv.astype(np.float64))
    edited = np.abs(out_world[line_frames[0]:line_frames[-1] + 1] - source[line_frames[0]:line_frames[-1] + 1])

    meta = {
        "m": m,
        "steps": steps,
        "ridge": float(args.ridge),
        "sampling_seconds": round(sampling_seconds, 4),
        "frames": frames,
        "fps": 20,
        "joints": NUM_JOINTS,
        "track": line["track"],
        "jointId": joint_id,
        "prompt": prompt,
        "cfg": cfg_scale,
        "seed": int(args.seed),
        "preview": bool(args.preview),
        "rows": {
            "line": len(line_rows),
            "preserve": len(keep_rows),
            "operatorCols": 3 * frames * NUM_JOINTS,
        },
        "preserve": {
            "stride": int(args.preserve_stride),
            "margin": int(args.preserve_margin),
            "frames": [int(f) for f in kept_frames],
            "pinnedJointFrames": len(pinned),
            "freeChain": sorted(int(j) for j in chain),
        },
        "editRange": [int(line["frameRange"]["start"]), int(line["frameRange"]["end"])],
        "checks": {
            # Success criterion (i): pinned source frames come back unchanged.
            "preservedMaxAbsDiffM": preserved_max,
            "preservedMeanAbsDiffM": preserved_mean,
            # Success criterion (ii): the drawn line is followed, in the request's
            # own 2D units.
            "lineMaxReprojErr": float(line_err.max()),
            "lineMeanReprojErr": float(line_err.mean()),
            # Proof the edit is not a no-op: the range genuinely moved.
            "editedMaxAbsDiffM": float(edited.max()),
        },
        "device": str(device),
        "checkpoint": str(loaded.checkpoint_path),
    }
    if device.type == "cuda":
        meta["vramPeakAllocMiB"] = round(torch.cuda.max_memory_allocated() / 2 ** 20, 1)

    # `<stem>.meta.json` beside the motion: --out foo.npy => foo.meta.json. The
    # wrapper builds the same name on the JS side, so this spelling is a contract.
    stem = str(out_path)[:-4] if str(out_path).endswith(".npy") else str(out_path)
    meta_path = Path(stem + ".meta.json")
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)

    # The wrapper greps this line, the same way bridge.mjs greps Kimodo's.
    print(f"projflow-line-edit: done - {out_path} (m={m} steps={steps} sample={sampling_seconds:.3f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""dump-gvhmr.py — F1 discovery dump from a GVHMR output directory (plan §8.4, §10.1).

The GPU box runs GVHMR and leaves an output directory: per-take npz/pickle
tensors plus whatever metadata json the run wrote. This script loads that
directory, resolves the seven §8.4 slots against what is ACTUALLY present, and
writes the pinned RawTrack fixture — a decimated JSON slice of <= 2 MiB whose
sha256 covers the whole document (canonical form, sha256 field excluded).

Slot resolution is deliberately conservative. A slot is resolved only when a
named tensor (with dtype/shape/units) is present in the output, or when the
output metadata names a body model whose conventions this script can state.
Everything else is recorded as "UNRESOLVED" with the reason. Nothing is
guessed, because F1 is the evidence gate for all of Stage B: a guessed slot
would let Stage B commit against a supplier that does not exist (plan §16 S5).

Usage::

    python3 tools/ingest/dump-gvhmr.py --input <gvhmr-out-dir> --output <rawtrack.json> \
        --clip-id <clipId> --source-url <url> --licence <licence> \
        --source-sha256 <sha256> --gvhmr-commit <40-hex> \
        --weights-sha256 <64-hex> [--trim-start S] [--trim-end S] \
        [--annotation-path P] [--max-bytes 2097152]

Emitted document (schema "RawTrack.v1"; full contract in RAWTRACK-CONTRACT.md):

    { "schemaVersion": 1, "kind": "RawTrack", "clipId": ..., "fps": ...,
      "frames": ..., "frameIndex": [...], "timeS": [...],
      "slots": { "F1-α": {...}, ..., "F1-η": {...} },
      "data": { "<named tensor>": [...], "K": [...], "crop": {...}, ... },
      "provenance": { "command": ..., "gvhmrCommit": ..., "weightsSha256": ...,
                      "sourceUrl": ..., "licence": ..., "sourceSha256": ...,
                      "trimStartS": ..., "trimEndS": ..., "annotationPath": ... },
      "sha256": "..." }

`--selftest` runs the GPU-free unit tests for the slot-resolution logic against
synthetic manifests and the pinned fixture; it needs no numpy. The canonical
serialization is exactly what `JSON.stringify(JSON.parse(...))` produces in
Node (key order = insertion order, integral floats written as integers), so
`test/ingest/verify-gvhmr-schema.mjs` verifies the same sha256 from JavaScript.
"""

import argparse
import glob
import hashlib
import json
import math
import os
import sys

# --- contract tables ---------------------------------------------------------

SLOT_ORDER = ["F1-α", "F1-β", "F1-γ", "F1-δ", "F1-ε", "F1-ζ", "F1-η"]

# Candidate tensor names per slot. These are SEARCH HINTS from the GVHMR demo
# save format as of the F1 spike (mkocabas/GVHMR lineage: pred_cam/pred_pose/
# pred_orient-style keys) and the SMPL-family conventions. They are not claims:
# a slot resolves only when one of its candidates is actually present in the
# output, and the resolution record cites the found tensor verbatim.
CANDIDATES = {
    "F1-α": ["global_orient_cam", "pred_orient", "global_orient"],
    "F1-γ": ["translation_cam", "pred_cam", "cam_t"],
    "F1-δ-full": ["foot_2d_full", "foot_keypoints_full", "keypoints_2d_full", "joints_2d_full"],
    "F1-δ-crop": ["foot_keypoints_crop", "keypoints_2d_crop", "joints_2d_crop", "pred_keypoints_2d"],
    "F1-ε": ["foot_contact_logits", "contact_logits", "foot_contact"],
    "F1-ζ": ["body_pose_smpl", "pred_pose", "body_pose"],
}

# Conventions this script can NAME from the tensor name alone. "foot_contact"
# is deliberately absent: its name does not state whether the values are
# logits or probabilities, so the convention cannot be named without guessing.
CONTACT_CONVENTIONS = {
    "foot_contact_logits": {"convention": "logit", "threshold": "sigmoid(logit) > 0.5 means contact"},
    "contact_logits": {"convention": "logit", "threshold": "sigmoid(logit) > 0.5 means contact"},
}

# Body-model conventions, keyed by the model name the output metadata must
# carry. A model outside the table is UNRESOLVED: its joint order, rest basis
# and facing axis cannot be named.
MODEL_TABLE = {
    "smpl": {
        "facing_axis": [0, 0, 1],
        "joints": 24,
        "joint_order": "SMPL 24-joint order",
        "rest_basis": "SMPL neutral rest",
        "handedness": "right-handed",
        "up_axis": "Y",
    },
}

# The units a rotation tensor carries depend on its actual shape: matrix
# entries are dimensionless by construction, axis-angle carries radians.
def _units_alpha(shape):
    if shape[1:] == [3, 3]:
        return "dimensionless rotation matrix entries; R_cam_body per frame (camera frame)"
    if shape[1:] == [3]:
        return "radians (axis-angle)"
    return None


# --- canonical serialization (JSON.stringify-compatible) ---------------------

def _canonical_number(value):
    """Normalize a float to what JSON.stringify emits for the same double.

    Integral floats become integers (2.0 -> 2) and -0.0 folds to 0; both
    stringify differently in Node. Values stay floats otherwise; the shortest
    round-trip repr of Python and ECMAScript agree for the magnitudes this
    script emits (no exponent-range values).
    """
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise ValueError("non-finite number in RawTrack document")
        if value == 0.0:
            return 0
        integer = int(value)
        if integer == value and abs(value) < 1e15:
            return integer
    return value


def _normalize_numbers(obj):
    if isinstance(obj, float):
        return _canonical_number(obj)
    if isinstance(obj, dict):
        return {key: _normalize_numbers(value) for key, value in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_normalize_numbers(value) for value in obj]
    return obj


def canonical_json(obj):
    """The canonical compact JSON: insertion key order, normalized numbers."""
    return json.dumps(_normalize_numbers(obj), ensure_ascii=False, separators=(",", ":"))


def document_sha256(document):
    """sha256 over the canonical document with the sha256 field itself excluded."""
    body = {key: value for key, value in document.items() if key != "sha256"}
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


# --- slot resolution ---------------------------------------------------------

def _unresolved(reason):
    return {"status": "UNRESOLVED", "reason": reason}


def _first_present(candidates, artifacts):
    for name in candidates:
        if name in artifacts:
            return name
    return None


def resolve_slots(artifacts, meta=None):
    """Return the seven §8.4 slot records for a GVHMR output manifest.

    artifacts: {name: {"dtype": str, "shape": [int, ...]}} — what the output
        directory actually contains.
    meta: {"fps": float, "crop": {...}, "model": str} — scalars from the
        output metadata, when present.

    A slot resolves only when its named candidate is present (or the model
    table can name the convention); otherwise the record is
    {"status": "UNRESOLVED", "reason": "..."}. No slot is ever guessed.
    """
    artifacts = artifacts or {}
    meta = meta or {}
    model = (meta.get("model") or "").lower()
    slots = {}

    # F1-α: camera-frame global orientation. The units depend on the actual
    # shape of the tensor found (matrix entries vs axis-angle), so a wrong
    # shape is escalated rather than annotated with guessed units.
    name = _first_present(CANDIDATES["F1-α"], artifacts)
    if name is None:
        slots["F1-α"] = _unresolved(
            f"no camera-frame orientation tensor among probed candidates "
            f"{CANDIDATES['F1-α']} is present in the output"
        )
    else:
        units = _units_alpha(artifacts[name]["shape"])
        if units is None:
            slots["F1-α"] = _unresolved(
                f"{name} has shape {artifacts[name]['shape']}; expected (F,3,3) or (F,3)"
            )
        else:
            slots["F1-α"] = {
                "status": "resolved",
                "tensor": name,
                "dtype": artifacts[name]["dtype"],
                "shape": artifacts[name]["shape"],
                "units": units,
            }

    # F1-β: the body-model canonical facing axis. This is a convention of the
    # named model, not an observed tensor — the dump emits it into the slice
    # so downstream yaw code never has to guess the axis.
    if model in MODEL_TABLE:
        slots["F1-β"] = {
            "status": "resolved",
            "tensor": "facing_axis",
            "dtype": "float32",
            "shape": [3],
            "units": "dimensionless unit vector in body-model space",
            "model": model,
        }
    else:
        slots["F1-β"] = _unresolved(
            f"output metadata names no known body model (got {model!r}); "
            "the canonical facing axis cannot be named"
        )

    # F1-γ: camera-frame translation, in metres per the GVHMR convention —
    # the operator acceptance (velocity integrates to a measured displacement)
    # verifies the unit rather than trusting it.
    name = _first_present(CANDIDATES["F1-γ"], artifacts)
    if name is None:
        slots["F1-γ"] = _unresolved(
            f"no camera-frame translation tensor among probed candidates "
            f"{CANDIDATES['F1-γ']} is present in the output"
        )
    elif artifacts[name]["shape"][1:] != [3]:
        slots["F1-γ"] = _unresolved(
            f"{name} has shape {artifacts[name]['shape']}; expected (F,3)"
        )
    else:
        slots["F1-γ"] = {
            "status": "resolved",
            "tensor": name,
            "dtype": artifacts[name]["dtype"],
            "shape": artifacts[name]["shape"],
            "units": "metres",
        }

    # F1-δ: full-image 2D foot observations — either named outright, or the
    # exact derivation from crop-space keypoints plus the crop transform.
    # Neither present is the plan's canonical escalation (stage-05 §13).
    full = _first_present(CANDIDATES["F1-δ-full"], artifacts)
    crop_keypoints = _first_present(CANDIDATES["F1-δ-crop"], artifacts)
    crop = meta.get("crop")
    if full is not None:
        if artifacts[full]["shape"][1:] not in ([2], [2, 2], [2, 3]):
            slots["F1-δ"] = _unresolved(
                f"{full} has shape {artifacts[full]['shape']}; expected (F,2), (F,2,2) or (F,2,3)"
            )
        else:
            slots["F1-δ"] = {
                "status": "resolved",
                "tensor": full,
                "dtype": artifacts[full]["dtype"],
                "shape": artifacts[full]["shape"],
                "units": "pixels (full image)",
            }
    elif crop_keypoints is not None and crop is not None and all(
        key in crop for key in ("offsetX", "offsetY", "scale")
    ):
        if artifacts[crop_keypoints]["shape"][1:] != [2, 3]:
            slots["F1-δ"] = _unresolved(
                f"{crop_keypoints} has shape {artifacts[crop_keypoints]['shape']}; expected (F,2,3)"
            )
        else:
            slots["F1-δ"] = {
                "status": "resolved",
                "tensor": crop_keypoints,
                "dtype": artifacts[crop_keypoints]["dtype"],
                "shape": artifacts[crop_keypoints]["shape"],
                "units": "pixels (crop space)",
                "derivation": {
                    "from": "crop-space 2D foot keypoints",
                    "via": "full = crop / scale + offset (data.crop)",
                    "crop": "data.crop",
                },
            }
    else:
        reason = (
            f"no full-image foot observation named and no derivation supplied: probed "
            f"full-image candidates {CANDIDATES['F1-δ-full']} are absent; "
        )
        if crop_keypoints is not None:
            reason += "crop-space foot keypoints are present but the crop transform is missing from the output metadata"
        else:
            reason += f"crop-space foot keypoints ({CANDIDATES['F1-δ-crop']}) are absent too"
        slots["F1-δ"] = _unresolved(reason)

    # F1-ε: foot-contact values. The convention is stated only when the tensor
    # name itself says logits or probability — otherwise the slot is escalated
    # rather than annotated with a guessed convention.
    name = _first_present(CANDIDATES["F1-ε"], artifacts)
    if name is None:
        slots["F1-ε"] = _unresolved(
            f"no foot-contact tensor among probed candidates {CANDIDATES['F1-ε']} is present in the output"
        )
    elif name not in CONTACT_CONVENTIONS:
        slots["F1-ε"] = _unresolved(
            f"{name} is present but its name does not state whether values are "
            "logits or probabilities; the convention cannot be named"
        )
    elif artifacts[name]["shape"][1:] != [2]:
        slots["F1-ε"] = _unresolved(
            f"{name} has shape {artifacts[name]['shape']}; expected (F,2)"
        )
    else:
        convention = CONTACT_CONVENTIONS[name]
        slots["F1-ε"] = {
            "status": "resolved",
            "tensor": name,
            "dtype": artifacts[name]["dtype"],
            "shape": artifacts[name]["shape"],
            "units": "logits (pre-sigmoid)",
            "convention": convention["convention"],
            "threshold": convention["threshold"],
        }

    # F1-ζ: body pose with joint ordering and rest basis. Both come from the
    # named model's table; a model outside the table cannot be mapped.
    name = _first_present(CANDIDATES["F1-ζ"], artifacts)
    if name is None:
        slots["F1-ζ"] = _unresolved(
            f"no body-pose tensor among probed candidates {CANDIDATES['F1-ζ']} is present in the output"
        )
    elif model not in MODEL_TABLE:
        slots["F1-ζ"] = _unresolved(
            f"{name} is present but the output metadata names no known body model "
            f"(got {model!r}); joint ordering and rest basis cannot be named"
        )
    elif artifacts[name]["shape"][1:] != [MODEL_TABLE[model]["joints"], 3]:
        slots["F1-ζ"] = _unresolved(
            f"{name} has shape {artifacts[name]['shape']}; expected "
            f"(F,{MODEL_TABLE[model]['joints']},3) for {model}"
        )
    else:
        slots["F1-ζ"] = {
            "status": "resolved",
            "tensor": name,
            "dtype": artifacts[name]["dtype"],
            "shape": artifacts[name]["shape"],
            "units": "radians (axis-angle per joint)",
            "jointOrder": MODEL_TABLE[model]["joint_order"],
            "restBasis": MODEL_TABLE[model]["rest_basis"],
        }

    # F1-η: handedness, up-axis, fps and the crop transform. fps and crop must
    # come from the output metadata; handedness/up-axis from the model table.
    crop_fields = ("offsetX", "offsetY", "scale", "cropW", "cropH", "fullW", "fullH")
    missing_crop = [key for key in crop_fields if not crop or key not in crop]
    fps = meta.get("fps")
    if fps is None or missing_crop:
        slots["F1-η"] = _unresolved(
            f"output metadata lacks the crop transform ({missing_crop or 'no crop record'}) "
            f"or fps ({fps!r}); the round-trip cannot be named"
        )
    elif model not in MODEL_TABLE:
        slots["F1-η"] = _unresolved(
            f"output metadata names no known body model (got {model!r}); "
            "handedness and up-axis cannot be named"
        )
    else:
        slots["F1-η"] = {
            "status": "resolved",
            "handedness": MODEL_TABLE[model]["handedness"],
            "upAxis": MODEL_TABLE[model]["up_axis"],
            "fps": fps,
            "crop": crop,
        }

    return slots


# --- decimation --------------------------------------------------------------

def _choose_stride(frame_count, descriptors, max_bytes):
    """Return (stride, estimated_bytes) for decimating per-frame tensors.

    Doubles the stride until the decimated per-frame tensors fit max_bytes
    (non-per-frame tensors are emitted whole). The caller fails if even one
    frame is over budget. descriptors are {"shape": [...], "itemsize": int}
    so the logic is testable without numpy.
    """
    def estimate(stride):
        total = 0
        for desc in descriptors:
            shape = list(desc["shape"])
            if shape and shape[0] == frame_count:
                shape[0] = math.ceil(shape[0] / stride)
            size = 1
            for dim in shape:
                size *= dim
            total += size * desc["itemsize"]
        return total

    stride = 1
    while estimate(stride) > max_bytes and stride < frame_count:
        stride = min(stride * 2, frame_count)
    return stride, estimate(stride)


# --- loader ------------------------------------------------------------------

def _fail(message):
    """Report a fatal error on stderr and exit 1 without emitting a fixture."""
    print(f"dump-gvhmr: {message}", file=sys.stderr)
    sys.exit(1)


def _load_artifacts(input_dir):
    """Return (artifacts, meta) from a GVHMR output directory.

    Fails cleanly when the directory does not exist or holds no tensors.
    numpy is imported lazily so --selftest runs without it.
    """
    if not os.path.isdir(input_dir):
        _fail(f"input directory does not exist: {input_dir}")
    npz_files = sorted(glob.glob(os.path.join(input_dir, "*.npz")))
    pkl_files = sorted(
        glob.glob(os.path.join(input_dir, "*.pkl"))
        + glob.glob(os.path.join(input_dir, "*.pickle"))
    )
    json_files = sorted(glob.glob(os.path.join(input_dir, "*.json")))
    if not npz_files and not pkl_files:
        _fail(f"no *.npz or *.pkl GVHMR output found in {input_dir}")

    try:
        import numpy as np
    except ImportError as exc:
        _fail(f"numpy is required to read GVHMR output (install it on the GPU box): {exc}")

    artifacts = {}
    for path in npz_files:
        data = np.load(path, allow_pickle=False)
        try:
            for name in data.files:
                member = data[name]
                artifacts[str(name)] = {
                    "dtype": str(member.dtype),
                    "shape": [int(size) for size in member.shape],
                    "itemsize": int(member.itemsize),
                    "array": member,
                }
        finally:
            data.close()
    for path in pkl_files:
        import pickle
        with open(path, "rb") as handle:
            payload = pickle.load(handle)
        for name, member in payload.items():
            if isinstance(member, np.ndarray):
                artifacts[str(name)] = {
                    "dtype": str(member.dtype),
                    "shape": [int(size) for size in member.shape],
                    "itemsize": int(member.itemsize),
                    "array": member,
                }

    meta = {}
    for path in json_files:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        for key in ("fps", "crop", "model", "K"):
            if key in payload and key not in meta:
                meta[key] = payload[key]
    return artifacts, meta


# --- document emission -------------------------------------------------------

def _shape_of_list(value):
    if isinstance(value, list) and value and isinstance(value[0], list):
        return [len(value)] + _shape_of_list(value[0])
    if isinstance(value, list):
        return [len(value)]
    return None


def _build_document(args, artifacts, meta):
    """Assemble the RawTrack document from the loaded output (no sha256 yet)."""
    slots = resolve_slots(artifacts, meta)
    fps = meta.get("fps")
    if not fps or fps <= 0:
        _fail("output metadata names no fps; add fps to the metadata json (frameIndex/timeS need it)")

    frame_count = 0
    resolved_tensors = {}
    for slot in SLOT_ORDER:
        record = slots.get(slot)
        if record and record["status"] == "resolved" and "tensor" in record:
            name = record["tensor"]
            resolved_tensors[name] = artifacts[name]
            shape = artifacts[name]["shape"]
            if len(shape) >= 1 and shape[0] > frame_count:
                frame_count = shape[0]
    if frame_count == 0:
        _fail("no per-frame tensor resolved; nothing to decimate (see the slot table above)")

    start = int(round((args.trim_start or 0.0) * fps))
    end = int(round((args.trim_end if args.trim_end is not None else frame_count / fps) * fps))
    start = max(0, min(start, frame_count))
    end = max(start, min(end, frame_count))

    per_frame = [info for name, info in resolved_tensors.items() if info["shape"][0] == frame_count]
    stride, _ = _choose_stride(frame_count, per_frame, args.max_bytes)

    frame_index = list(range(start, end, stride))
    if not frame_index:
        _fail(f"trim [{args.trim_start}, {args.trim_end}] selects no frames")
    time_seconds = [index / fps for index in frame_index]

    data = {}
    for name in resolved_tensors:
        member = artifacts[name]["array"]
        if artifacts[name]["shape"][0] == frame_count:
            data[name] = member[start:end:stride].tolist()
        else:
            data[name] = member.tolist()
    for key in ("K", "crop"):
        if meta.get(key) is not None:
            data[key] = meta[key]
    model = (meta.get("model") or "").lower()
    if model in MODEL_TABLE:
        data["bodyModel"] = model
        data["handedness"] = MODEL_TABLE[model]["handedness"]
        data["upAxis"] = MODEL_TABLE[model]["up_axis"]

    document = {
        "schemaVersion": 1,
        "kind": "RawTrack",
        "clipId": args.clip_id,
        "fps": fps,
        "frames": len(frame_index),
        "frameIndex": frame_index,
        "timeS": time_seconds,
        "slots": slots,
        "data": data,
        "provenance": {
            "command": " ".join(sys.argv),
            "sourceUrl": args.source_url,
            "licence": args.licence,
            "sourceSha256": args.source_sha256,
            "trimStartS": args.trim_start if args.trim_start is not None else 0.0,
            "trimEndS": args.trim_end if args.trim_end is not None else round(frame_count / fps, 6),
            "gvhmrCommit": args.gvhmr_commit,
            "weightsSha256": args.weights_sha256,
            "annotationPath": args.annotation_path,
        },
    }

    size = len(canonical_json(document).encode("utf-8"))
    if size > args.max_bytes:
        _fail(
            f"decimated slice is {size} bytes, over the {args.max_bytes}-byte cap; "
            "narrow --trim-start/--trim-end or raise --max-bytes"
        )
    document["sha256"] = document_sha256(document)
    return document, size


def _print_slot_table(slots):
    print("slot   status     resolution")
    for slot in SLOT_ORDER:
        record = slots[slot]
        if record["status"] == "resolved":
            detail = record.get("tensor", record.get("crop", "conventions"))
            dtype = record.get("dtype", "")
            shape = json.dumps(record.get("shape", []))
            print(f"{slot}  resolved   {detail} {dtype} {shape}".rstrip())
        else:
            print(f"{slot}  UNRESOLVED {record['reason']}")


def _run(args):
    artifacts, meta = _load_artifacts(args.input)
    document, size = _build_document(args, artifacts, meta)
    parent = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(parent, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(_normalize_numbers(document), indent=2, ensure_ascii=False))
        handle.write("\n")
    _print_slot_table(document["slots"])
    print(
        f"wrote {args.output}: {size} bytes (cap {args.max_bytes}), "
        f"frames {document['frameIndex'][0]}..{document['frameIndex'][-1]}, "
        f"sha256 {document['sha256'][:16]}..."
    )


# --- selftest (GPU-free unit tests for resolve_slots and friends) ------------

def _selftest():
    failures = []

    def check(label, cond, detail=""):
        print(f"{'PASS' if cond else 'FAIL'} selftest: {label}" + (f"  {detail}" if detail else ""))
        if not cond:
            failures.append(label)

    def try_resolve(artifacts, meta):
        try:
            return resolve_slots(artifacts, meta), None
        except Exception as exc:  # a stub or a bug must fail the check, not the run
            return None, exc

    # The canonical F1-δ analogue: an output with no foot observation at all
    # must be escalated, never resolved or skipped.
    empty, exc = try_resolve({}, {})
    check(
        "F1-δ UNRESOLVED on empty output (no full-image foot observation named, no derivation supplied)",
        exc is None
        and empty["F1-δ"]["status"] == "UNRESOLVED"
        and "no full-image foot observation named" in empty["F1-δ"]["reason"],
        "resolve_slots raised" if exc else empty["F1-δ"].get("reason", "")[:120],
    )
    for slot in SLOT_ORDER:
        record = empty[slot] if exc is None else {}
        check(
            f"{slot} UNRESOLVED on empty output with a reason",
            exc is None and record["status"] == "UNRESOLVED" and record.get("reason"),
            record.get("reason", "")[:120],
        )

    # A complete manifest resolves every slot, each citing the tensor found.
    manifest = {
        "global_orient_cam": {"dtype": "float32", "shape": [30, 3, 3]},
        "translation_cam": {"dtype": "float32", "shape": [30, 3]},
        "foot_keypoints_crop": {"dtype": "float32", "shape": [30, 2, 3]},
        "foot_contact_logits": {"dtype": "float32", "shape": [30, 2]},
        "body_pose_smpl": {"dtype": "float32", "shape": [30, 24, 3]},
    }
    crop = {"offsetX": 800, "offsetY": 400, "scale": 2, "cropW": 640, "cropH": 360, "fullW": 1920, "fullH": 1080}
    meta = {"fps": 29.97, "crop": crop, "model": "smpl"}
    full, exc = try_resolve(manifest, meta)
    check(
        "all seven slots resolve on a complete manifest",
        exc is None and all(full[s]["status"] == "resolved" for s in SLOT_ORDER),
        "resolve_slots raised" if exc else "",
    )
    if exc is None:
        check("F1-α cites the found orientation tensor", full["F1-α"]["tensor"] == "global_orient_cam")
        check("F1-γ states metres as units", full["F1-γ"]["units"] == "metres")
        check(
            "F1-δ names the crop-space derivation",
            full["F1-δ"]["tensor"] == "foot_keypoints_crop"
            and full["F1-δ"]["derivation"]["via"].find("scale") >= 0,
        )
        check("F1-ε states the logit convention", full["F1-ε"]["convention"] == "logit")
        check("F1-ζ names the SMPL joint order", full["F1-ζ"]["jointOrder"] == "SMPL 24-joint order")
        check("F1-η names handedness/up-axis/fps/crop", full["F1-η"]["handedness"] == "right-handed"
              and full["F1-η"]["upAxis"] == "Y" and full["F1-η"]["crop"]["scale"] == 2)

    # Derivation needs BOTH crop-space keypoints and the crop transform.
    partial, exc = try_resolve({"foot_keypoints_crop": manifest["foot_keypoints_crop"]}, {"model": "smpl"})
    check(
        "F1-δ UNRESOLVED when the crop transform is missing",
        exc is None and partial["F1-δ"]["status"] == "UNRESOLVED"
        and "crop transform is missing" in partial["F1-δ"]["reason"],
        partial["F1-δ"].get("reason", "")[:120] if exc is None else "resolve_slots raised",
    )

    # A candidate with an impossible shape must not be resolved with a lie.
    bad_shape, exc = try_resolve({"translation_cam": {"dtype": "float32", "shape": [30, 1, 3]}}, {})
    check(
        "F1-γ UNRESOLVED on a shape-mismatched candidate",
        exc is None and bad_shape["F1-γ"]["status"] == "UNRESOLVED"
        and "shape" in bad_shape["F1-γ"]["reason"],
        bad_shape["F1-γ"].get("reason", "")[:120] if exc is None else "resolve_slots raised",
    )

    # Unknown tensors never resolve a slot (no guessing).
    unknown, exc = try_resolve({"pred_foo": {"dtype": "float32", "shape": [30, 3]}}, {})
    check(
        "an unknown tensor resolves nothing",
        exc is None and all(unknown[s]["status"] == "UNRESOLVED" for s in SLOT_ORDER),
        "resolve_slots raised" if exc else "",
    )

    # A contact tensor whose name does not state logits vs probability is
    # escalated rather than assigned a guessed convention.
    ambiguous, exc = try_resolve({"foot_contact": {"dtype": "float32", "shape": [30, 2]}}, {})
    check(
        "F1-ε UNRESOLVED when the convention cannot be named",
        exc is None and ambiguous["F1-ε"]["status"] == "UNRESOLVED"
        and "logits or probabilities" in ambiguous["F1-ε"]["reason"],
        ambiguous["F1-ε"].get("reason", "")[:120] if exc is None else "resolve_slots raised",
    )

    # Decimation: stride must grow until the slice fits the budget.
    stride, estimate = _choose_stride(
        100000,
        [{"shape": [100000, 24, 3], "itemsize": 8}],
        2 * 1024 * 1024,
    )
    check("decimation stride grows to fit the byte cap", stride > 1 and estimate <= 2 * 1024 * 1024,
          f"stride={stride}, estimate={estimate}")
    stride_small, _ = _choose_stride(30, [{"shape": [30, 3, 3], "itemsize": 4}], 2 * 1024 * 1024)
    check("tiny outputs are not decimated", stride_small == 1, f"stride={stride_small}")

    # The pinned fixture is the drift guard: the resolver must reproduce its
    # slot records from the fixture's own data manifest, and the fixture must
    # hash under the same canonical form the Node test verifies.
    fixture_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "test", "ingest",
        "fixtures", "rawtrack", "rawtrack-good.json",
    )
    if os.path.isfile(fixture_path):
        with open(fixture_path, "r", encoding="utf-8") as handle:
            fixture = json.load(handle)
        check("pinned fixture hashes to its sha256 (canonical form)", document_sha256(fixture) == fixture["sha256"],
              f"got {document_sha256(fixture)[:16]}...")
        manifest_from_data = {}
        for name, value in fixture["data"].items():
            if isinstance(value, list):
                manifest_from_data[name] = {"dtype": "float32", "shape": _shape_of_list(value)}
        meta_from_fixture = {
            "fps": fixture["fps"],
            "crop": fixture["data"].get("crop"),
            "model": fixture["data"].get("bodyModel"),
        }
        reproduced, exc = try_resolve(manifest_from_data, meta_from_fixture)
        check(
            "resolver reproduces the pinned fixture's slot records",
            exc is None and reproduced == fixture["slots"],
            "" if (exc is None and reproduced == fixture["slots"])
            else ("resolve_slots raised" if exc else "slot records drifted from the fixture"),
        )
    else:
        check("pinned fixture present for the drift guard", False, f"missing {fixture_path}")

    print(f"selftest: {len(failures)} failed")
    return len(failures) == 0


def main(argv):
    parser = argparse.ArgumentParser(
        description="Dump a decimated RawTrack fixture from a GVHMR output directory (plan §8.4)."
    )
    parser.add_argument("--selftest", action="store_true", help="run the GPU-free unit tests and exit")
    parser.add_argument("--input", metavar="DIR", help="GVHMR output directory (npz/pkl + metadata json)")
    parser.add_argument("--output", metavar="FILE", help="path for the RawTrack JSON fixture")
    parser.add_argument("--clip-id", metavar="ID", help="stable clip identifier (take id)")
    parser.add_argument("--trim-start", type=float, metavar="S", help="trim window start, seconds from take start")
    parser.add_argument("--trim-end", type=float, metavar="S", help="trim window end, seconds from take start")
    parser.add_argument("--source-url", metavar="URL", help="source footage URL")
    parser.add_argument("--licence", metavar="LIC", help="source footage licence")
    parser.add_argument("--source-sha256", metavar="HEX", help="source footage sha256")
    parser.add_argument("--gvhmr-commit", metavar="HEX", help="pinned GVHMR commit (40 hex)")
    parser.add_argument("--weights-sha256", metavar="HEX", help="pinned GVHMR weights sha256 (64 hex)")
    parser.add_argument("--annotation-path", metavar="PATH", help="hand-annotation file path (may be added later)")
    parser.add_argument("--max-bytes", type=int, default=2 * 1024 * 1024, metavar="N",
                        help="decimated slice cap in bytes (default 2097152)")
    args = parser.parse_args(argv[1:])

    if args.selftest:
        sys.exit(0 if _selftest() else 1)

    required = ["input", "output", "clip_id", "source_url", "licence", "source_sha256",
                "gvhmr_commit", "weights_sha256"]
    missing = [name for name in required if getattr(args, name) is None]
    if missing:
        parser.error(f"missing required option(s): {', '.join('--' + name.replace('_', '-') for name in missing)}")
    if args.trim_start is not None and args.trim_end is not None and args.trim_start > args.trim_end:
        parser.error("--trim-start must be <= --trim-end")
    _run(args)


if __name__ == "__main__":
    main(sys.argv)

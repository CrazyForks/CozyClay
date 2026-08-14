#!/usr/bin/env python3
"""rt-dump-stub.py — numpy-free driver for dump-gvhmr.py's slot resolution and
document emission, used by the red-team suite (rt-dump.mjs).

numpy is absent on this workstation, so _load_artifacts (the npz/pkl reader)
cannot run; the stub substitutes a FakeArray that satisfies the slice/tolist
surface _build_document uses, and drives the REAL resolve_slots/_build_document/
canonical_json/document_sha256 code paths. Only the tensor reader is stubbed;
the slot-resolution and emission logic under attack is the shipped code.

Usage: rt-dump-stub.py <scenario> <manifest.json> [<meta.json>]
Scenarios:
  emit      run resolve_slots + _build_document; print {"ok":true,"doc":...}
            or {"ok":false,"phase":...,"error":...} (SystemExit captured)
  slots     run resolve_slots only; print {"ok":true,"slots":{...}}
Output is a single JSON document on stdout; nothing else is printed.
"""

import argparse
import importlib.util
import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))


def load_dump():
    spec = importlib.util.spec_from_file_location(
        "dump_gvhmr", os.path.join(REPO, "tools", "ingest", "dump-gvhmr.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def build_rows(shape, fill=0.0):
    if len(shape) == 1:
        return [fill] * shape[0]
    return [build_rows(shape[1:], fill) for _ in range(shape[0])]


class FakeArray:
    """Minimal numpy-array stand-in: sliceable first dimension, .tolist().

    dtype/itemsize are fixed attributes matching the manifest's declared
    dtype (float32 assumed); the emitted JSON values are the fill value.
    """

    def __init__(self, shape, fill=0.0):
        self.shape = list(shape)
        self.dtype = "float32"
        self.itemsize = 4
        self._rows = build_rows(shape, fill)

    def __getitem__(self, key):
        rows = self._rows[key]
        out = FakeArray.__new__(FakeArray)
        out.shape = [len(rows)] + self.shape[1:]
        out.dtype = self.dtype
        out.itemsize = self.itemsize
        out._rows = rows
        return out

    def tolist(self):
        return json.loads(json.dumps(self._rows))


def artifacts_from_manifest(manifest):
    out = {}
    for name, shape in manifest.items():
        out[name] = {
            "dtype": "float32",
            "shape": list(shape),
            "itemsize": 4,
            "array": FakeArray(shape),
        }
    return out


def make_args():
    trim_start = float(os.environ.get("RT_TRIM_START", "0.0"))
    trim_end = os.environ.get("RT_TRIM_END")
    return argparse.Namespace(
        clip_id="rt-redteam-clip",
        source_url="https://example.invalid/rt-redteam.webm",
        licence="CC0-1.0",
        source_sha256="0" * 64,
        trim_start=trim_start,
        trim_end=float(trim_end) if trim_end is not None else None,
        gvhmr_commit="0" * 40,
        weights_sha256="0" * 64,
        annotation_path="",
        max_bytes=int(os.environ.get("RT_MAX_BYTES", str(2 * 1024 * 1024))),
    )


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: rt-dump-stub.py <scenario> <manifest.json> [<meta.json>]"}))
        return 2
    scenario, manifest_path = argv[1], argv[2]
    meta = json.load(open(argv[3], "r", encoding="utf-8")) if len(argv) > 3 else {}
    manifest = json.load(open(manifest_path, "r", encoding="utf-8"))
    m = load_dump()
    try:
        artifacts = artifacts_from_manifest(manifest)
        if scenario == "slots":
            slots = m.resolve_slots(artifacts, meta)
            print(json.dumps({"ok": True, "slots": slots}, ensure_ascii=False))
            return 0
        if scenario == "emit":
            args = make_args()
            doc, size = m._build_document(args, artifacts, meta)
            print(json.dumps({"ok": True, "size": size, "doc": doc}, ensure_ascii=False))
            return 0
        print(json.dumps({"ok": False, "error": f"unknown scenario {scenario}"}))
        return 2
    except SystemExit as exc:
        # _fail() path: the real message stays on stderr; report the exit code
        print(json.dumps({"ok": False, "phase": "fail", "exit": exc.code}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "phase": "exception", "error": f"{type(exc).__name__}: {exc}"}))
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

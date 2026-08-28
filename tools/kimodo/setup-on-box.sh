#!/usr/bin/env bash
# Provision Kimodo on a Linux/NVIDIA host used by CozyClay.
# Run directly on the host, or through setup-local.mjs.
set -euo pipefail

KIMODO_DIR="${CCLAY_KIMODO_REMOTE_DIR:-$HOME/.cozyclay/kimodo}"
VENV_DIR="${CCLAY_KIMODO_VENV_DIR:-$HOME/.cozyclay/kimodo-venv}"
MODEL="${CCLAY_KIMODO_MODEL:-Kimodo-SOMA-RP-v1.1}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: setup-on-box.sh [--kimodo-dir DIR] [--venv DIR] [--model NAME] [--dry-run]

Installs the Kimodo runtime and prefetches its motion and text-encoder models.
HF_TOKEN may be present in the environment for Hugging Face access; it is never
printed by this script.
EOF
}
log() { printf 'setup-kimodo: %s\n' "$*"; }
die() { printf 'setup-kimodo: error: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '+ '; printf '%q ' "$@"; printf '\n'; return 0; fi
  "$@"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kimodo-dir) [ "$#" -ge 2 ] || die "--kimodo-dir needs a value"; KIMODO_DIR="$2"; shift 2 ;;
    --venv) [ "$#" -ge 2 ] || die "--venv needs a value"; VENV_DIR="$2"; shift 2 ;;
    --model) [ "$#" -ge 2 ] || die "--model needs a value"; MODEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run; no files, packages, or models will be changed"
else
  command -v git >/dev/null 2>&1 || die "git is required"
  command -v python3 >/dev/null 2>&1 || die "python3 is required"
  command -v nvidia-smi >/dev/null 2>&1 || die "an NVIDIA CUDA host is required (nvidia-smi not found)"
  nvidia-smi >/dev/null 2>&1 || die "nvidia-smi cannot access the GPU"
fi

if [ ! -e "$KIMODO_DIR/.git" ]; then
  mkdir -p "$(dirname "$KIMODO_DIR")"
  run git clone --depth 1 https://github.com/nv-tlabs/kimodo.git "$KIMODO_DIR"
else
  log "Kimodo checkout already exists at $KIMODO_DIR"
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
  run python3 -m venv "$VENV_DIR"
else
  log "Python environment already exists at $VENV_DIR"
fi

PY="$VENV_DIR/bin/python"
run "$PY" -m pip install --upgrade pip
run "$PY" -m pip install torch
run "$PY" -m pip install -e "$KIMODO_DIR" llm2vec

if [ "$DRY_RUN" -eq 1 ]; then
  log "would prefetch model $MODEL and LLM2Vec encoder assets"
else
  "$PY" - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
model = sys.argv[1]
snapshot_download(repo_id=f"nvidia/{model}")
snapshot_download(repo_id="meta-llama/Meta-Llama-3-8B-Instruct")
snapshot_download(repo_id="McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp")
snapshot_download(repo_id="McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised")
print("model and encoder assets ready")
PY
fi

log "ready"
log "export CCLAY_MOTION_BACKEND=kimodo"
log "export CCLAY_KIMODO_HOST=<this host>"
log "Kimodo model: $MODEL"

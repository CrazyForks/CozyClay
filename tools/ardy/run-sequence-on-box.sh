#!/usr/bin/env bash
# Run a multi-prompt ARDY rollout in one remote process. The remote
# cclay_sequence_generate.py keeps the model loaded and feeds each segment
# the previous segment's motion tail through init_history_sequence.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${CCLAY_ARDY_HOST:-}"
REMOTE="${CCLAY_ARDY_REPO:-\$HOME/ardy}"
VENV_PY="${CCLAY_ARDY_VENV:-~/ardy/.venv-cuda/bin/python}"
ENCODER_URL="${CCLAY_ARDY_ENCODER_URL:-http://127.0.0.1:9550/}"
FORCE_CPU=0

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=240)
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

usage() {
  cat >&2 <<'EOF'
usage: run-sequence-on-box.sh \
       --segment "<prompt>" <seconds> [--segment "<prompt>" <seconds> ...] \
       [--seed <N>] [--cpu] [--output <local.npz>] [--dry-run]
EOF
  exit 2
}

SEGMENTS=()
SEED=""
OUTPUT=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --segment)
      [[ $# -ge 3 ]] || { echo "run-sequence-on-box: --segment needs PROMPT SECONDS" >&2; usage; }
      [[ -n "${2//[[:space:]]/}" ]] || { echo "run-sequence-on-box: segment prompt must not be empty" >&2; exit 1; }
      [[ "$3" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "run-sequence-on-box: segment duration must be a number, got '$3'" >&2; exit 1; }
      SEGMENTS+=("$2" "$3")
      shift 3 ;;
    --seed)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "run-sequence-on-box: --seed needs a non-negative integer" >&2; usage; }
      SEED="$2"; shift 2 ;;
    --cpu)
      FORCE_CPU=1; shift ;;
    --output)
      [[ $# -ge 2 ]] || { echo "run-sequence-on-box: --output needs a path" >&2; usage; }
      OUTPUT="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage ;;
    *)
      echo "run-sequence-on-box: unknown option '$1'" >&2
      usage ;;
  esac
done

[[ -n "$HOST" ]] || {
  echo "run-sequence-on-box: CCLAY_ARDY_HOST is required (for example: user@ardy-host)" >&2
  exit 2
}

[[ ${#SEGMENTS[@]} -ge 4 ]] || {
  echo "run-sequence-on-box: at least two --segment entries are required" >&2
  exit 1
}

for ((i = 1; i < ${#SEGMENTS[@]}; i += 2)); do
  awk -v d="${SEGMENTS[$i]}" 'BEGIN { exit !(d > 0 && d <= 1200) }' || {
    echo "run-sequence-on-box: segment duration must be > 0 and <= 1200 seconds, got '${SEGMENTS[$i]}'" >&2
    exit 1
  }
done

OUTPUT="${OUTPUT:-$HERE/out/$(date +%s)-sequence.npz}"

if ! ssh "${SSH_OPTS[@]}" "$HOST" ":" </dev/null; then
  echo "run-sequence-on-box: cannot ssh to ${HOST}" >&2
  exit 1
fi
echo "run-sequence-on-box: ssh to ${HOST} ok"

if ! ssh "${SSH_OPTS[@]}" "$HOST" \
  "test -x ${VENV_PY} && test -f ${REMOTE}/scripts/cclay_sequence_generate.py" </dev/null; then
  echo "run-sequence-on-box: missing ${VENV_PY} or ${REMOTE}/scripts/cclay_sequence_generate.py on ${HOST}" >&2
  exit 1
fi
echo "run-sequence-on-box: sequence generator present on ${HOST}"

if ! ENCODER_CODE="$(ssh "${SSH_OPTS[@]}" "$HOST" \
  "curl -s -o /dev/null -w '%{http_code}' -m 10 ${ENCODER_URL}" </dev/null)"; then
  echo "run-sequence-on-box: could not probe the text encoder" >&2
  exit 1
fi
[[ "$ENCODER_CODE" == "200" ]] || {
  echo "run-sequence-on-box: text encoder at ${ENCODER_URL} answered '${ENCODER_CODE}', not 200" >&2
  exit 1
}
echo "run-sequence-on-box: text encoder ${ENCODER_URL} responding"

CUDA_ENV=""
[[ "$FORCE_CPU" -eq 1 ]] && CUDA_ENV='CUDA_VISIBLE_DEVICES="" '

build_remote_cmd() {
  local tmp_dir="$1" cmd i
  cmd="cd ${REMOTE} && ${CUDA_ENV}${VENV_PY} scripts/cclay_sequence_generate.py"
  for ((i = 0; i < ${#SEGMENTS[@]}; i += 2)); do
    cmd+=" --segment $(printf '%q' "${SEGMENTS[$i]}") $(printf '%q' "${SEGMENTS[$((i + 1))]}")"
  done
  cmd+=" --output $(printf '%q' "${tmp_dir}/out")"
  [[ -z "$SEED" ]] || cmd+=" --seed $(printf '%q' "$SEED")"
  printf '%s' "$cmd"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "run-sequence-on-box: DRY RUN - $(( ${#SEGMENTS[@]} / 2 )) segments in one ARDY process"
  echo "run-sequence-on-box: would run ssh ${HOST} \"$(build_remote_cmd "<mktemp-dir-on-box>")\""
  echo "run-sequence-on-box: would pull <mktemp-dir-on-box>/out.npz -> ${OUTPUT}"
  exit 0
fi

mkdir -p "$(dirname "$OUTPUT")"
REMOTE_TMP="$(ssh "${SSH_OPTS[@]}" "$HOST" "mktemp -d" </dev/null)"
[[ "$REMOTE_TMP" == /* ]] || {
  echo "run-sequence-on-box: remote mktemp returned unsafe path '${REMOTE_TMP}'" >&2
  exit 1
}
trap 'ssh "${SSH_OPTS[@]}" "$HOST" "rm -rf ${REMOTE_TMP}" </dev/null >/dev/null 2>&1 || true' EXIT

REMOTE_CMD="$(build_remote_cmd "$REMOTE_TMP")"
echo "run-sequence-on-box: generating $(( ${#SEGMENTS[@]} / 2 )) prompt blocks in one ARDY process ..."
ssh "${SSH_OPTS[@]}" "$HOST" "$REMOTE_CMD" </dev/null

scp -q "${SCP_OPTS[@]}" "$HOST:${REMOTE_TMP}/out.npz" "$OUTPUT"
[[ -s "$OUTPUT" ]] || {
  echo "run-sequence-on-box: pulled ${OUTPUT} is empty" >&2
  exit 1
}
echo "run-sequence-on-box: done - ${OUTPUT} ($(wc -c < "$OUTPUT" | tr -d ' ') bytes)"

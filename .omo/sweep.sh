#!/bin/bash
# Research sweep: kimodo-segment-continuity. Serial on the GPU box.
cd /tmp/kimodo-research
RES=results.tsv
echo -e "label\tstall\tseam_min\tseam_max\tcruise\tmax_jump" > "$RES"

run() {
  local label="$1"; shift
  out=$(node /tmp/kimodo-research/harness.mjs "$@" 2>&1)
  if [ $? -ne 0 ]; then
    echo -e "${label}\tCRASH\t\t\t\t" >> "$RES"
    echo "CRASH $label"; echo "$out" | tail -3
    return
  fi
  local stall=$(echo "$out" | sed -n 's/^METRIC stall_ratio=//p')
  local smin=$(echo "$out" | sed -n 's/^METRIC seam_min_mps=//p')
  local smax=$(echo "$out" | sed -n 's/^METRIC seam_max_mps=//p')
  local cruise=$(echo "$out" | sed -n 's/^METRIC cruise_mps=//p')
  local jump=$(echo "$out" | sed -n 's/^METRIC max_jump_m=//p')
  echo -e "${label}\t${stall}\t${smin}\t${smax}\t${cruise}\t${jump}" >> "$RES"
  echo "DONE $label stall=$stall seam_min=$smin max_jump=$jump"
}

W="A person walks forward"
R="A person runs forward"

# E1: segment length sweep (walk->run, transition 5, two seeds)
for S in 7 21; do
  run "E1-d1-s$S"  --seg "$W" 1 --seg "$R" 1 --seed $S --out e1-d1-s$S.npz
  run "E1-d2-s$S"  --seg "$W" 2 --seg "$R" 2 --seed $S --out e1-d2-s$S.npz
  run "E1-d3-s$S"  --seg "$W" 3 --seg "$R" 3 --seed $S --out e1-d3-s$S.npz
  run "E1-d5-s$S"  --seg "$W" 5 --seg "$R" 5 --seed $S --out e1-d5-s$S.npz
  run "E1-d8-s$S"  --seg "$W" 8 --seg "$R" 8 --seed $S --out e1-d8-s$S.npz
done

# E0: single-segment reference (no seam at all), same total length as d3
run "E0-single6" --seg "A person walks forward then breaks into a run" 6 --seed 7 --out e0-single.npz

# E2: transition-frame sweep at 3+3 (5 is covered by E1-d3-s7)
run "E2-t2"  --seg "$W" 3 --seg "$R" 3 --seed 7 --transition 2  --out e2-t2.npz
run "E2-t10" --seg "$W" 3 --seg "$R" 3 --seed 7 --transition 10 --out e2-t10.npz
run "E2-t15" --seg "$W" 3 --seg "$R" 3 --seed 7 --transition 15 --out e2-t15.npz

# E3: transition difficulty at 3+3
run "E3-walk-jump" --seg "$W" 3 --seg "A person jumps forward" 3 --seed 7 --out e3-jump.npz
run "E3-idle-run"  --seg "A person stands still" 3 --seg "$R" 3 --seed 7 --out e3-idle.npz
run "E3-walk-back" --seg "$W" 3 --seg "A person walks backward" 3 --seed 7 --out e3-back.npz

# E4: prompt style at 3+3 (medium baseline = E1-d3-s7)
run "E4-terse"    --seg "A person walks" 3 --seg "A person runs" 3 --seed 7 --out e4-terse.npz
run "E4-verbose"  --seg "A person walks forward at a steady pace swinging both arms naturally while keeping the head level and shoulders relaxed" 3 --seg "A person runs forward quickly pumping both arms with a strong push off each foot and a forward lean of the torso" 3 --seed 7 --out e4-verbose.npz
run "E4-context"  --seg "$W" 3 --seg "Then he speeds up" 3 --seed 7 --out e4-context.npz
run "E4-nosubject" --seg "walking forward" 3 --seg "running forward" 3 --seed 7 --out e4-nosubject.npz

echo "SWEEP COMPLETE"

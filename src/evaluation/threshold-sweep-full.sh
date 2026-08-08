#!/bin/bash
# Sweep MATCH_THRESHOLD across 0..100 (step 1) in parallel.
# Builds sweep-full.csv from each threshold's metrics.json.
#
# Env:
#   PAR            parallelism (default 8)
#   SKIP_DONE=1    keep existing t<N>/metrics.json (default reuses if present)

set -e
ROOT=$(dirname "$0")/../..
cd "$ROOT"

SWEEP_DIR=src/data/threshold-sweep
mkdir -p "$SWEEP_DIR"

PAR=${PAR:-8}
THRESHOLDS=$(seq 0 1 100)

run_one() {
  local t=$1
  local out="$SWEEP_DIR/t${t}"
  if [ -f "$out/metrics.json" ]; then
    echo "[skip] t=$t already done"
    return
  fi
  echo "[start] t=$t"
  MATCH_THRESHOLD=$t EVAL_OUTPUT_DIR=$out \
    NODE_OPTIONS='--max-old-space-size=12288' \
    npx ts-node --transpile-only src/evaluation/web-detect-eval.ts \
    >"$out.log" 2>&1
  echo "[done] t=$t"
}

export -f run_one
export SWEEP_DIR

echo "$THRESHOLDS" | xargs -n 1 -P "$PAR" -I {} bash -c 'run_one {}'

# Combine 0-100 into sweep-full.csv (regenerate from all metrics.json)
echo "threshold,precision,recall,f1,tp,fp,fn,tn" > "$SWEEP_DIR/sweep-full.csv"
for t in $(seq 0 1 100); do
  if [ -f "$SWEEP_DIR/t${t}/metrics.json" ]; then
    node -e "const m=require('./$SWEEP_DIR/t${t}/metrics.json').overall; console.log([$t,m.precision,m.recall,m.f1,m.tp,m.fp,m.fn,m.tn].join(','));" >> "$SWEEP_DIR/sweep-full.csv"
  fi
done

# Also produce sweep.csv (60-100 subset, for back-compat with figure scripts that read it)
echo "threshold,precision,recall,f1,tp,fp,fn,tn" > "$SWEEP_DIR/sweep.csv"
for t in $(seq 60 1 100); do
  if [ -f "$SWEEP_DIR/t${t}/metrics.json" ]; then
    node -e "const m=require('./$SWEEP_DIR/t${t}/metrics.json').overall; console.log([$t,m.precision,m.recall,m.f1,m.tp,m.fp,m.fn,m.tn].join(','));" >> "$SWEEP_DIR/sweep.csv"
  fi
done

echo "[done] $SWEEP_DIR/sweep-full.csv + $SWEEP_DIR/sweep.csv"

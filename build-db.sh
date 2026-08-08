#!/bin/bash
#
# build-db.sh — construct DEBUN's fingerprint (hash) databases from the raw
# library/website corpora under src/data/. Constructed here (not downloaded) so
# they can be regenerated and re-published to Zenodo.
#
# Prerequisites: ./corpora-files.sh (src/data/{data-never-remove,original,swc,terser}) and
# ./cdn-files.sh (src/data/cdn, from cdnjs); for the module-dependency-aware step also
# ./npm-files.sh (src/data/npm, from the npm registry).
# Run from the repo root. Each step is skipped if its output exists (REBUILD=1
# forces a rebuild). Heavy steps need ~12 GB RAM.
#
# Models for the "detection across POG models" ablation (RQ3): each model gets its
# own fingerprint-cache dir. Override the set with MODELS="pog cnt" (pog = full).
# ABLATION=0 builds only the full model (pog) — enough for RQ1/RQ2 and detect.
#
set -euo pipefail
cd "$(dirname "$0")"

export NODE_OPTIONS="--max-old-space-size=12288"
TS="npx ts-node --transpile-only"
REBUILD="${REBUILD:-}"

HASHES=src/data/debun-hashes
CACHE=src/data/fingerprint-cache
WEBHASH=src/data/allWebHashes
SWEEP=src/data/threshold-sweep
MODELDET=src/data/model-detect

if [ "${ABLATION:-1}" = "0" ]; then MODELS="${MODELS:-pog}"; else MODELS="${MODELS:-pog cnt cfg f fb fbc}"; fi

have() { [ -z "$REBUILD" ] && [ -e "$1" ]; }
banner() { echo; echo "──────────── $1 ────────────"; }
cache_of() { [ "$1" = "pog" ] && echo "$CACHE" || echo "src/data/fingerprint-cache-$1"; }
scorem_of() { [ "$1" = "pog" ] && echo "$SWEEP/t84" || echo "$MODELDET/$1"; }

mkdir -p "$HASHES" "$CACHE" "$WEBHASH" "$SWEEP/t84"

# ─────────────────────────────────────────────────────────────────────────────
# A. Flat DB (debun-hashes) — powers `detect` (uniform per-submodule scorer).
#    Full (pog) model only; the ablation uses the per-model caches in section B.
# ─────────────────────────────────────────────────────────────────────────────
banner "A1. Library database (all-hash / all-libs) from src/data/cdn"
if have "$HASHES/all-hash.json"; then echo "skip (exists)"; else
  MODEL=pog $TS src/debun/phase1/lib-database.ts
fi
banner "A2. Code segmentation — birth-date dup filter (dups-0.3-*)"
if have "$HASHES/dups-0.3-hash.json"; then echo "skip (exists)"; else
  MODEL=pog $TS src/debun/phase1/extract-dups.ts
fi

# Website fingerprints. pog (full) built if missing; the ablation models are
# (re)built to stay consistent with the current pog-models definitions.
banner "A3a. Website fingerprints — full model (allWebHashes/<site>.json)"
if have "$WEBHASH/wikipedia.org.json"; then echo "skip (exists)"; else
  $TS src/cmd/gen-web-hashes.ts pog
fi
ABLATION_METHODS=$(echo "$MODELS" | tr ' ' '\n' | grep -v '^pog$' | paste -sd, -)
if [ -n "$ABLATION_METHODS" ]; then
  banner "A3b. Website fingerprints — ablation models: $ABLATION_METHODS"
  LAST_M=$(echo "$ABLATION_METHODS" | sed 's/.*,//')
  if have "$WEBHASH/wikipedia.org-${LAST_M}.json"; then
    echo "skip (exists)"
  else
    $TS src/cmd/gen-web-hashes.ts "$ABLATION_METHODS"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# B. Per-model pipeline — each model built fully before the next, so the RQ3
#    "detection across POG models" columns fill in one model at a time.
#    Per model: fingerprint cache (cdn→score_u, npm→score_m) + blacklist +
#    score_m detection summary (web-detect-eval @ ψ=84%).
# ─────────────────────────────────────────────────────────────────────────────
for M in $MODELS; do
  MC=$(cache_of "$M")
  OUT=$(scorem_of "$M")
  mkdir -p "$MC" "$OUT"

  banner "B[$M]. Fingerprint cache → $MC (npm import graph + cdn bundles)"
  if have "$MC/cdn-allhash.json" && have "$MC/allhash.json"; then echo "skip (exists)"; else
    MODEL=$M FP_CACHE_DIR="$MC" $TS src/cmd/populate-fingerprint-cache.ts
  fi

  banner "B[$M]. Ubiquitous-function blacklist → $MC/web-blacklist-0.6.json"
  if have "$MC/web-blacklist-0.6.json"; then echo "skip (exists)"; else
    MODEL=$M FP_CACHE_DIR="$MC" $TS src/cmd/gen-web-blacklist.ts
  fi

  # DETECT_RULE: the full model is called with the strict rule, the five ablation models with
  # the Beta-posterior one, which is how the paper's Table 3 columns were produced. Reproducing
  # the table requires reproducing that split — under one rule for all six, half its cells move.
  RULE=$([ "$M" = "pog" ] && echo strict || echo posterior)
  banner "B[$M]. score_m detections @ ψ=84% ($RULE rule) → $OUT/summary.csv"
  if have "$OUT/summary.csv"; then echo "skip (exists)"; else
    DETECT_RULE=$RULE MODEL=$M MATCH_THRESHOLD=84 FP_CACHE_DIR="$MC" EVAL_OUTPUT_DIR="$OUT" \
      $TS src/evaluation/web-detect-eval.ts
  fi
done
# Stage the full-model blacklist into the flat DB for `detect`'s scorer.
cp -f "$CACHE/web-blacklist-0.6.json" "$HASHES/blacklist-0.6.json" 2>/dev/null || true

echo
echo "[build-db] done. Per-model caches: src/data/fingerprint-cache[-<model>]."
echo "[build-db] Run: ./debun.sh run RQ1 | RQ2 | RQ3"

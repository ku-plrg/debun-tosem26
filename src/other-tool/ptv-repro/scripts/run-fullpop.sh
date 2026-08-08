#!/bin/bash
# FULL-POPULATION PTV vs Debun (2 tools, no ablation): all common versions, A-deps, D/E excluded.
# Self-contained: all paths derive from this script's location inside the artifact.
# Override with env: DEBUN_ROOT (repo), WORK (scratch dir), CHROME (browser), K, LIBS, and
# PTV's budget POOL / SETTLE_MS — left alone these are 1 and 3000 ms, the fair setting the
# paper compares against; see the note above stage 4 for the tight-budget pair.
# Prereqs: the module-aware index, i.e. ./download-files.sh (or build-db.sh); Chrome installed;
#          internet (cdnjs) reachable. The npm corpus is NOT needed — only its package names,
#          which are committed. Heavy: ~1-2h over ~2,100 (lib,version).

set -o pipefail

# Each stage feeds the next, and without a check a failed one used to cascade: a corpus that
# did not build left stage 3 with an empty SITE_FILTER, which is not "nothing to do" but
# "score every site", so a broken 4-entry smoke test silently re-ran the full 68-site
# evaluation. Stop at the first stage that produces nothing.
need() {  # need <file> <what failed> <hint>
  [ -s "$1" ] && return 0
  echo ""
  echo "[stop] $2 produced no $1"
  echo "       $3"
  exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # .../ptv-repro/scripts
RP="$(cd "$HERE/.." && pwd)"                                # ptv-repro
D="${DEBUN_ROOT:-$(cd "$RP/../../.." && pwd)}"              # debun-tosem26 repo root
WORK="${WORK:-$D/tmp/ptv-repro}"
CORPUS="$WORK/corpus"
TSOPT='{"module":"CommonJS","moduleResolution":"Node"}'
mkdir -p "$WORK"

echo "[paths] D=$D  RP=$RP  WORK=$WORK"

echo ""
echo "===== [1/5] BUILD CORPUS (every version, EXCLUDE velocity/modernizr/yepnope, DEP_OVERRIDE, vendored libs_data) ====="
# K is not set here: build-corpus.js takes every version unless the caller asks for a cap,
# and K in this script's environment reaches it on its own.
OUT="$CORPUS" node "$HERE/build-corpus.js" 2>&1 | tail -55
need "$CORPUS/corpus-manifest.json" "[1/5] corpus build" \
  "Needs ./download-files.sh for the version universe, plus internet to fetch each (library, version) from cdnjs."
N=$(node -e "console.log(require('$CORPUS/corpus-manifest.json').length)")
echo "corpus entries: $N"

echo ""
echo "===== [2/5] gen webhashes -> allWebHashes (injected as ptvc* sites) ====="
cd "$D" && TS_NODE_COMPILER_OPTIONS="$TSOPT" npx ts-node --transpile-only \
  "$HERE/gen-webhashes.ts" "$CORPUS/corpus-manifest.json" "$D/src/data/allWebHashes" "$WORK/mapping.json" 2>&1 | grep -E "hashed" || true

need "$WORK/mapping.json" "[2/5] webhash generation" \
  "gen-webhashes.ts writes the corpus into src/data/allWebHashes as ptvc* sites."

echo ""
echo "===== [3/5] DEBUN real scorer (strictVersions, MODEL=pog, psi=84%) ====="
SF=$(node -e "console.log(require('$WORK/mapping.json').filter(x=>!x.error).map(x=>x.site).join(','))")
NL=$(node -e "console.log([...new Set(require('$WORK/mapping.json').filter(x=>x.npmName).map(x=>x.npmName))].join(','))")
# web-detect-eval joins EVAL_OUTPUT_DIR onto the repo root (cwd=$D), so pass a path relative to $D.
DEBUN_OUT="$WORK/debun-out"
DEBUN_OUT_REL="$(node -e "console.log(require('path').relative('$D','$DEBUN_OUT'))")"
MODEL=pog MATCH_THRESHOLD=84 FP_CACHE_DIR=src/data/fingerprint-cache \
  SITE_FILTER="$SF" NPM_FILTER_LIB="$NL" EVAL_OUTPUT_DIR="$DEBUN_OUT_REL" \
  TS_NODE_COMPILER_OPTIONS="$TSOPT" npx ts-node --transpile-only src/evaluation/web-detect-eval.ts > "$WORK/debun.log" 2>&1
echo "debun exit=$? | summary rows: $(wc -l < "$DEBUN_OUT/summary.csv" 2>/dev/null)"
need "$DEBUN_OUT/summary.csv" "[3/5] DEBUN scorer" \
  "Needs the module-aware index: ./download-files.sh. See $WORK/debun.log."

echo ""
# Default = fair/generous budget (POOL=1, SETTLE_MS=3000) so PTV isn't penalized by premature
# window snapshots — matches the reported 73.9/65.8/63.8. Slow (~2.5-3 h). For the fast
# tight-budget variant (64.6/57.6/55.8, ~15 min) set POOL=5 SETTLE_MS=900.
echo "===== [4/5] PTV (as-shipped only, headless Chrome, pool${POOL:-1}, settle${SETTLE_MS:-3000}ms) ====="
MANIFEST="$CORPUS/corpus-manifest.json" OUT="$WORK/ptv-results.json" ONLY_ASSHIPPED=1 \
  POOL="${POOL:-1}" SETTLE_MS="${SETTLE_MS:-3000}" RECYCLE_EVERY="${RECYCLE_EVERY:-150}" \
  node "$HERE/ptv-detect-corpus.js" > "$WORK/ptv.log" 2>&1
echo "ptv exit=$? | $(tail -1 "$WORK/ptv.log")"
need "$WORK/ptv-results.json" "[4/5] PTV detection" \
  "Needs Chrome and internet. See $WORK/ptv.log."

echo ""
echo "===== [5/5] SCORE (Debun vs PTV: major/minor/patch + range) ====="
MAPPING="$WORK/mapping.json" DEBUN_SUMMARY="$DEBUN_OUT/summary.csv" PTV="$WORK/ptv-results.json" \
  node "$HERE/score-final.js" 2>&1

echo ""
echo "===== cleanup (remove injected ptvc* sites, preserve originals) ====="
rm -f $D/src/data/allWebHashes/ptvc*.json
echo "ptvc remaining: $(ls $D/src/data/allWebHashes/ptvc*.json 2>/dev/null | wc -l)"
echo "DONE"

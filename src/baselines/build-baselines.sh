#!/usr/bin/env bash
# build-baselines.sh — regenerate the D-Bundlr and Aletheia fixtures from source.
#
# The DEBUN numbers in RQ1-RQ3 are reproduced by build-db.sh + `run RQ*`. This script
# covers the two external baselines, which were previously shipped as opaque JSON.
#
# Inputs (fetched by ../../baseline-files.sh into $BASELINE_DATA):
#   dataset.json             192 evaluation bundles with their JS source
#   debun-model/             D-Bundlr's trained checkpoint + labelMap.pkl
#   dbundlr-debun-dataset/   the 22 training corpora (defines trained_libs)
#   aletheia-debun-index/    227 prebuilt Aletheia package indices
#
# Outputs (into src/data/other-tool/):
#   dbundlr_results_debun.json
#   aletheia_results_debun.json
#
# Two Python environments are required and are NOT interchangeable:
#   server venv  tree-sitter 0.21.3 — codepredict/utils.py uses Language(path, name),
#                                     removed in tree-sitter 0.22
#   client venv  tree-sitter 0.26   — dbundlr_eval.py uses Language(ptr), added in 0.22
# They communicate over HTTP, so the split costs nothing.
#
# PINNED, DO NOT BUMP: tree-sitter-javascript 0.23.1.
#   dolospy tokenizes with raw ts_node_symbol() numeric IDs, so the grammar version is
#   baked into every fingerprint in the prebuilt Aletheia indices. Any other version
#   silently produces near-zero overlap (0.23.0 gives covered=1 where 0.23.1 gives 428)
#   and the version table collapses without any error being raised.
set -euo pipefail

# This script lives at src/baselines/, so the repo root is two levels up. Everything below
# is written relative to the root, not to the script — resolving ROOT to the script's own
# directory sent all four paths into src/baselines/src/data/… and src/baselines/baselines/.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE_DATA="${BASELINE_DATA:-$ROOT/src/data/baselines}"
WORK="${WORK:-$ROOT/.baselines-build}"
# Both checkouts come from ./baseline-repos.sh, which pins them; either variable overrides
# that if you keep your own clone elsewhere.
UPSTREAM_REPOS="${UPSTREAM_REPOS:-$ROOT/src/baselines/upstream-repos}"
DBUNDLR_REPO="${DBUNDLR_REPO:-$UPSTREAM_REPOS/D-Bundlr}"
DOLOSPY_SRC="${DOLOSPY_SRC:-$UPSTREAM_REPOS/AletheiaJSVersionDetection/dolospy}"
for p in "$DBUNDLR_REPO/codepredict/predictServer.py" "$DOLOSPY_SRC/CMakeLists.txt"; do
  [ -f "$p" ] || { echo "missing: $p — run ./baseline-repos.sh first" >&2; exit 1; }
done
EVAL_SCRIPTS="${EVAL_SCRIPTS:-$ROOT/src/baselines}"
GRAMMAR_VERSION=0.23.1
PORT="${PORT:-3446}"
DEVICE="${DBUNDLR_DEVICE:-cpu}"
WORKERS="${WORKERS:-8}"
OUT_DIR="$ROOT/src/data/other-tool"

mkdir -p "$WORK" "$OUT_DIR"

echo "==> [1/6] Python environments"
if [ ! -x "$WORK/venv-server/bin/python" ]; then
  python3 -m venv "$WORK/venv-server"
  "$WORK/venv-server/bin/pip" install -q --upgrade pip
  "$WORK/venv-server/bin/pip" install -q \
    torch "transformers==4.45.2" sentencepiece flask gunicorn numpy tqdm "tree-sitter==0.21.3"
fi
if [ ! -x "$WORK/venv-client/bin/python" ]; then
  python3 -m venv "$WORK/venv-client"
  "$WORK/venv-client/bin/pip" install -q --upgrade pip
  "$WORK/venv-client/bin/pip" install -q \
    tree-sitter tree-sitter-javascript requests pybind11
fi

echo "==> [2/6] tree-sitter-javascript $GRAMMAR_VERSION (pinned)"
GDIR="$WORK/grammar-$GRAMMAR_VERSION"
if [ ! -f "$GDIR/lib/libtree-sitter-javascript.a" ]; then
  mkdir -p "$GDIR/lib"
  "$WORK/venv-client/bin/pip" download "tree-sitter-javascript==$GRAMMAR_VERSION" \
    --no-binary :all: --no-deps -d "$GDIR" -q
  tar xzf "$GDIR"/tree_sitter_javascript-*.tar.gz -C "$GDIR"
  GSRC=$(echo "$GDIR"/tree_sitter_javascript-*/)
  # This grammar is LANGUAGE_VERSION 14 and its sdist ships no tree_sitter/ headers.
  # tree-sitter >=0.25 headers are ABI 15 and will not compile it, so take the
  # matching set out of the tree-sitter 0.23.2 core sdist.
  HDR="$WORK/ts-core-hdr"
  if [ ! -f "$HDR/tree_sitter/parser.h" ]; then
    mkdir -p "$HDR/tree_sitter"
    "$WORK/venv-client/bin/pip" download "tree-sitter==0.23.2" --no-binary :all: \
      --no-deps -d "$WORK/ts-core" -q
    tar xzf "$WORK/ts-core"/tree-sitter-0.23.2.tar.gz -C "$WORK/ts-core"
    cp "$WORK/ts-core/tree-sitter-0.23.2/tree_sitter/core/lib/src/"{parser.h,alloc.h,array.h} \
       "$HDR/tree_sitter/"
    cp "$WORK/ts-core/tree-sitter-0.23.2/tree_sitter/core/lib/include/tree_sitter/api.h" \
       "$HDR/tree_sitter/"
  fi
  clang -c -O2 -fPIC -I"$GSRC/src" -I"$HDR" "$GSRC/src/parser.c"  -o "$GDIR/parser.o"
  clang -c -O2 -fPIC -I"$GSRC/src" -I"$HDR" "$GSRC/src/scanner.c" -o "$GDIR/scanner.o"
  ar rcs "$GDIR/lib/libtree-sitter-javascript.a" "$GDIR/parser.o" "$GDIR/scanner.o"
fi

echo "==> [3/6] dolospy"
DBUILD="$WORK/dolospy-build"
if [ ! -f "$DBUILD/dolospy"*.so ]; then
  # dolospy includes <tree_sitter/tree-sitter-javascript.h>, which no distribution
  # ships; it is just the grammar entry-point declaration.
  mkdir -p "$WORK/tsinc/tree_sitter"
  cat > "$WORK/tsinc/tree_sitter/tree-sitter-javascript.h" <<'HDR'
#ifndef TREE_SITTER_JAVASCRIPT_H_
#define TREE_SITTER_JAVASCRIPT_H_
#include <tree_sitter/api.h>
#ifdef __cplusplus
extern "C" {
#endif
const TSLanguage *tree_sitter_javascript(void);
#ifdef __cplusplus
}
#endif
#endif
HDR
  PB=$("$WORK/venv-client/bin/python" -c "import pybind11;print(pybind11.get_cmake_dir())")
  cmake -S "$DOLOSPY_SRC" -B "$DBUILD" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="/opt/homebrew;$PB" \
    -DPython_EXECUTABLE="$WORK/venv-client/bin/python" \
    -DCMAKE_CXX_FLAGS="-I$WORK/tsinc -I/opt/homebrew/include" \
    -DCMAKE_SHARED_LINKER_FLAGS="-L$GDIR/lib -L/opt/homebrew/lib" \
    -DCMAKE_MODULE_LINKER_FLAGS="-L$GDIR/lib -L/opt/homebrew/lib"
  cmake --build "$DBUILD" --target dolospy -j8
fi

echo "==> [4/6] Aletheia"
PYTHONPATH="$DBUILD" INDEX_DIR="$BASELINE_DATA/aletheia-debun-index" \
  "$WORK/venv-client/bin/python" "$EVAL_SCRIPTS/run_aletheia.py" \
  --dataset "$BASELINE_DATA/dataset.json" \
  -o "$OUT_DIR/aletheia_results_debun.json"

echo "==> [5/6] D-Bundlr prediction server (device=$DEVICE, port=$PORT)"
DBUNDLR_DEVICE="$DEVICE" MODEL_DIR="$BASELINE_DATA/debun-model" \
CODEPREDICT="$DBUNDLR_REPO/codepredict" OMP_NUM_THREADS=4 \
  "$WORK/venv-server/bin/gunicorn" -w 4 -b "127.0.0.1:$PORT" --timeout 900 \
  --log-level warning --chdir "$EVAL_SCRIPTS" serve:app &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  curl -sf -m 5 -X POST "http://127.0.0.1:$PORT/predict" \
    -H 'Content-Type: application/json' -d '{"code":"function f(){}"}' >/dev/null 2>&1 && break
  sleep 5
done

echo "==> [6/6] D-Bundlr (~55,856 predictions; ~35 min on an M4 Max CPU)"
"$WORK/venv-client/bin/python" "$EVAL_SCRIPTS/run_dbundlr.py" \
  --dataset "$BASELINE_DATA/dataset.json" \
  --trained-dir "$BASELINE_DATA/dbundlr-debun-dataset" \
  --server "http://127.0.0.1:$PORT/predict" --workers "$WORKERS" \
  -o "$OUT_DIR/dbundlr_results_debun.json"

echo
echo "Done. Regenerated:"
echo "  $OUT_DIR/dbundlr_results_debun.json"
echo "  $OUT_DIR/aletheia_results_debun.json"
echo "Now run ./debun.sh run RQ2 and RQ3 to confirm the tables are unchanged."

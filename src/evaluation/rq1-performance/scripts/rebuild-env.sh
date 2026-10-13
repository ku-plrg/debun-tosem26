#!/usr/bin/env bash
# Rebuild the two Python environments and the dolospy extension for the RQ1 pilot.
#
# Everything lives under rq1-performance/env/ rather than the session scratchpad, which was
# cleared twice mid-session and took the measurement data with it.
#
# System-level deps (cmake, boost, libtree-sitter) are installed via brew and survive;
# only the venvs and the compiled dolospy module need recreating.
set -euo pipefail

ART=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
ENVD="$ART/src/evaluation/rq1-performance/env"
# Aletheia checkout; not vendored here (no licence). ./baseline-repos.sh clones it pinned;
# DOLOSPY_SRC overrides that if you keep your own checkout elsewhere.
DOLOSPY_SRC=${DOLOSPY_SRC:-$ART/src/baselines/upstream-repos/AletheiaJSVersionDetection/dolospy}
[ -f "$DOLOSPY_SRC/CMakeLists.txt" ] || {
  echo "dolospy source not found at $DOLOSPY_SRC — run ./baseline-repos.sh first" >&2; exit 1; }
GRAMMAR=0.23.1     # pinned: dolospy tokenises with raw ts_node_symbol() ids
TSCORE=0.23.2      # matching ABI-14 parser.h for that grammar

# The versions Table 1 was measured at. The two client pins are not housekeeping: D-Bundlr's
# own dbundlr_eval.py parses each bundle with this tree-sitter to split it into modules, and
# the module count is what it then runs the model over, so an unpinned upgrade moves the
# Detection column without touching any code here. The static GRAMMAR above is a separate
# thing — it is linked into dolospy, not used by this venv.
TORCH=${TORCH:-2.13.0}
TS_CLIENT=${TS_CLIENT:-0.26.0}
TSJS_CLIENT=${TSJS_CLIENT:-0.25.0}

# Pin the interpreter explicitly. The interactive shell aliases python3 to 3.12, but a
# non-interactive bash script does not see that alias and picks up the system default,
# which is now 3.14 — and transformers' `tokenizers` has no 3.14 wheel, so pip falls
# back to a source build that dies in PyO3 (supports <=3.13).
PY=${PY:-/opt/homebrew/bin/python3.12}
"$PY" -V

mkdir -p "$ENVD"

echo "==> [1/4] server venv (tree-sitter 0.21.3 for codepredict's old Language API)"
if [ ! -x "$ENVD/venv-server/bin/gunicorn" ]; then
  "$PY" -m venv --clear "$ENVD/venv-server"
  "$ENVD/venv-server/bin/pip" install -q --upgrade pip
  # torch is installed on its own so the index below applies to it alone. D-Bundlr runs on
  # CPU here (DBUNDLR_DEVICE=cpu, OMP_NUM_THREADS=1, gunicorn -w 1) so that its column is
  # comparable with DEBUN's, and on Linux the default PyPI wheel is the CUDA build: ~2.5 GB
  # of nvidia-* dependencies for a device this never touches, which also initialises CUDA on
  # a machine that has a GPU. The CPU index gives the same version without any of that.
  TORCH_ARGS=("torch==$TORCH")
  if [ "$(uname -s)" = "Linux" ]; then   # not && — set -e would take the false branch as failure
    TORCH_ARGS+=(--index-url https://download.pytorch.org/whl/cpu)
  fi
  "$ENVD/venv-server/bin/pip" install -q "${TORCH_ARGS[@]}"
  "$ENVD/venv-server/bin/pip" install -q \
    "transformers==4.45.2" sentencepiece flask gunicorn numpy tqdm "tree-sitter==0.21.3"
fi

echo "==> [2/4] client venv (tree-sitter 0.26 for dbundlr_eval's new Language API)"
if [ ! -x "$ENVD/venv-client/bin/pip" ]; then
  "$PY" -m venv --clear "$ENVD/venv-client"
  "$ENVD/venv-client/bin/pip" install -q --upgrade pip
  "$ENVD/venv-client/bin/pip" install -q \
    "tree-sitter==$TS_CLIENT" "tree-sitter-javascript==$TSJS_CLIENT" requests pybind11
fi

echo "==> [3/4] tree-sitter-javascript $GRAMMAR static lib"
GDIR="$ENVD/grammar-$GRAMMAR"
if [ ! -f "$GDIR/lib/libtree-sitter-javascript.a" ]; then
  mkdir -p "$GDIR/lib"
  "$ENVD/venv-client/bin/pip" download "tree-sitter-javascript==$GRAMMAR" \
    --no-binary :all: --no-deps -d "$GDIR" -q
  tar xzf "$GDIR"/tree_sitter_javascript-*.tar.gz -C "$GDIR"
  GSRC=$(echo "$GDIR"/tree_sitter_javascript-*/)
  # This grammar is LANGUAGE_VERSION 14 and ships no src/tree_sitter/ headers; the
  # >=0.25 headers are ABI 15 (no TSFieldMapSlice) and will not compile it.
  HDR="$ENVD/ts-core-hdr"
  if [ ! -f "$HDR/tree_sitter/parser.h" ]; then
    mkdir -p "$HDR/tree_sitter" "$ENVD/ts-core"
    "$ENVD/venv-client/bin/pip" download "tree-sitter==$TSCORE" --no-binary :all: \
      --no-deps -d "$ENVD/ts-core" -q
    tar xzf "$ENVD/ts-core/tree-sitter-$TSCORE.tar.gz" -C "$ENVD/ts-core"
    cp "$ENVD/ts-core/tree-sitter-$TSCORE/tree_sitter/core/lib/src/"{parser.h,alloc.h,array.h} "$HDR/tree_sitter/"
    cp "$ENVD/ts-core/tree-sitter-$TSCORE/tree_sitter/core/lib/include/tree_sitter/api.h" "$HDR/tree_sitter/"
  fi
  clang -c -O2 -fPIC -I"$GSRC/src" -I"$HDR" "$GSRC/src/parser.c"  -o "$GDIR/parser.o"
  clang -c -O2 -fPIC -I"$GSRC/src" -I"$HDR" "$GSRC/src/scanner.c" -o "$GDIR/scanner.o"
  ar rcs "$GDIR/lib/libtree-sitter-javascript.a" "$GDIR/parser.o" "$GDIR/scanner.o"
fi

echo "==> [4/4] dolospy"
DBUILD="$ENVD/dolospy-build"
if ! ls "$DBUILD"/dolospy*.so >/dev/null 2>&1; then
  # dolospy includes <tree_sitter/tree-sitter-javascript.h>, which nothing ships.
  mkdir -p "$ENVD/tsinc/tree_sitter"
  cat > "$ENVD/tsinc/tree_sitter/tree-sitter-javascript.h" <<'HDR'
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
  PB=$("$ENVD/venv-client/bin/python" -c "import pybind11;print(pybind11.get_cmake_dir())")
  cmake -S "$DOLOSPY_SRC" -B "$DBUILD" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="/opt/homebrew;$PB" \
    -DPython_EXECUTABLE="$ENVD/venv-client/bin/python" \
    -DCMAKE_CXX_FLAGS="-I$ENVD/tsinc -I/opt/homebrew/include" \
    -DCMAKE_SHARED_LINKER_FLAGS="-L$GDIR/lib -L/opt/homebrew/lib" \
    -DCMAKE_MODULE_LINKER_FLAGS="-L$GDIR/lib -L/opt/homebrew/lib" > "$ENVD/cmake.log" 2>&1
  cmake --build "$DBUILD" --target dolospy -j8 >> "$ENVD/cmake.log" 2>&1
fi

echo
echo "verification:"
"$ENVD/venv-server/bin/python" -c "import torch,transformers,importlib.metadata as m; print('  server: torch',torch.__version__,'tree-sitter',m.version('tree-sitter'))"
"$ENVD/venv-client/bin/python" -c "import importlib.metadata as m; print('  client: tree-sitter',m.version('tree-sitter'),'ts-javascript',m.version('tree-sitter-javascript'))"
PYTHONPATH="$DBUILD" "$ENVD/venv-client/bin/python" -c "import dolospy; print('  dolospy: OK')"
echo "done"

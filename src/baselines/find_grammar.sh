#!/bin/bash
# Search for the tree-sitter-javascript grammar version that reproduces the
# Aletheia fixture. dolospy tokenizes with raw ts_node_symbol() numeric IDs, so
# the grammar version is baked into every fingerprint in the prebuilt indices.
#
# Oracle (bundle aldi.us, package moment):  leftTotal == 9225 and covered == 428 for 2.15.0
set -u
# SP is this directory, which holds probe_grammar.py. The venv and the scratch trees live in
# the build work dir instead — build-baselines.sh creates them in .baselines-build/ — so
# looking for them beside this script found nothing.
SP="$(cd "$(dirname "$0")" && pwd)"
ENVD="${BASELINE_WORK:-$(cd "$SP/../.." && pwd)/.baselines-build}"
DOLOS="${DOLOSPY_SRC:?set DOLOSPY_SRC to AletheiaJsVersionDetection/dolospy}"
if [ ! -x "$ENVD/venv-client/bin/python" ]; then
  echo "no client venv at $ENVD/venv-client — run src/baselines/build-baselines.sh first," >&2
  echo "or set BASELINE_WORK to the directory holding venv-client." >&2
  exit 1
fi
PB=$("$ENVD/venv-client/bin/python" -c "import pybind11;print(pybind11.get_cmake_dir())")

for VER in "$@"; do
  echo "================ tree-sitter-javascript $VER ================"
  WORK="$ENVD/gsearch/$VER"
  rm -rf "$WORK"; mkdir -p "$WORK"
  if ! "$ENVD/venv-client/bin/pip" download "tree-sitter-javascript==$VER" --no-binary :all: \
        --no-deps -d "$WORK" -q 2>"$WORK/pip.err"; then
    echo "  sdist download failed"; tail -2 "$WORK/pip.err"; continue
  fi
  tar xzf "$WORK"/tree_sitter_javascript-*.tar.gz -C "$WORK"
  SRC=$(echo "$WORK"/tree_sitter_javascript-*/)
  mkdir -p "$WORK/lib"
  # Grammar sdists before 0.25 ship no src/tree_sitter/ headers, and 0.25's parser.h
  # is ABI 15 (no TSFieldMapSlice) so it cannot compile these ABI-14 grammars.
  # Supply the era-matched header set extracted from the tree-sitter core sdist.
  case "$VER" in
    0.23.*) HDR="$ENVD/ts-core/hdr-0.23.2" ;;
    *)      HDR="$ENVD/ts-core/hdr-0.21.3" ;;
  esac
  INC="-I$SRC/src"
  [ -f "$SRC/src/tree_sitter/parser.h" ] || INC="$INC -I$HDR"
  clang -c -O2 -fPIC $INC "$SRC/src/parser.c"  -o "$WORK/parser.o"  2>>"$WORK/cc.err" || {
    echo "  parser.c compile failed"; tail -3 "$WORK/cc.err"; continue; }
  if [ -f "$SRC/src/scanner.c" ]; then
    clang -c -O2 -fPIC $INC "$SRC/src/scanner.c" -o "$WORK/scanner.o" 2>>"$WORK/cc.err" || {
      echo "  scanner.c compile failed"; tail -3 "$WORK/cc.err"; continue; }
    ar rcs "$WORK/lib/libtree-sitter-javascript.a" "$WORK/parser.o" "$WORK/scanner.o"
  else
    ar rcs "$WORK/lib/libtree-sitter-javascript.a" "$WORK/parser.o"
  fi
  [ -f "$WORK/lib/libtree-sitter-javascript.a" ] || { echo "  grammar build failed"; continue; }

  BUILD="$WORK/build"
  cmake -S "$DOLOS" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="/opt/homebrew;$PB" \
    -DPython_EXECUTABLE="$ENVD/venv-client/bin/python" \
    -DCMAKE_CXX_FLAGS="-I$ENVD/tslib/include -I/opt/homebrew/include" \
    -DCMAKE_SHARED_LINKER_FLAGS="-L$WORK/lib -L/opt/homebrew/lib" \
    -DCMAKE_MODULE_LINKER_FLAGS="-L$WORK/lib -L/opt/homebrew/lib" > "$WORK/cmake.log" 2>&1
  cmake --build "$BUILD" --target dolospy -j8 >> "$WORK/cmake.log" 2>&1 \
    || { echo "  dolospy build failed"; tail -5 "$WORK/cmake.log"; continue; }

  PYTHONPATH="$BUILD" "$ENVD/venv-client/bin/python" "$SP/probe_grammar.py"
done

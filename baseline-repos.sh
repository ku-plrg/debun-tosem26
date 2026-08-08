#!/usr/bin/env bash
#
# baseline-repos.sh — fetch the two upstream baseline checkouts Table 1 needs.
#
# D-Bundlr's model server and Aletheia's dolospy are not vendored here: both repositories
# are public but neither carries a licence, so this artifact has no right to redistribute
# them. Cloning is the substitute, and it is pinned — every number in Table 1 was measured
# at the commits below, and neither tool versions its model or index format, so a later
# upstream commit can break the checkpoint load or shift dolospy's fingerprints silently.
#
#   ./baseline-repos.sh              clone (or verify) into src/baselines/upstream-repos/
#   REPOS_DIR=/somewhere ./baseline-repos.sh
#
# rebuild-env.sh and build-baselines.sh default DOLOSPY_SRC / DBUNDLR_REPO here, so after
# this runs neither needs an environment variable. Re-running is safe: an existing checkout
# is left alone once its HEAD matches the pin.
#
set -euo pipefail
cd "$(dirname "$0")"

REPOS_DIR="${REPOS_DIR:-src/baselines/upstream-repos}"

# name|url|pinned commit
REPOS="
D-Bundlr|https://github.com/Anemone95/D-Bundlr|c28a5d62efeecc46cc146c3548c71b8071ba2e89
AletheiaJSVersionDetection|https://github.com/BlobbyBob/AletheiaJSVersionDetection|9c70e0557e952497665a2faeaf20e9cc1e0f3018
"

mkdir -p "$REPOS_DIR"

for entry in $REPOS; do
  name=${entry%%|*}; rest=${entry#*|}
  url=${rest%%|*}; sha=${rest#*|}
  dir="$REPOS_DIR/$name"

  if [ -d "$dir/.git" ]; then
    have=$(git -C "$dir" rev-parse HEAD)
    if [ "$have" = "$sha" ]; then
      echo "[ok]    $name @ ${sha:0:7} (already checked out)"
      continue
    fi
    echo "[fix]   $name is at ${have:0:7}, want ${sha:0:7}"
    git -C "$dir" fetch --quiet origin "$sha" || git -C "$dir" fetch --quiet origin
  else
    echo "[clone] $name -> $dir"
    git clone --quiet "$url" "$dir"
  fi

  git -C "$dir" checkout --quiet --detach "$sha"
  echo "[ok]    $name @ ${sha:0:7}"
done

# Fail loudly here rather than three stages into a build: these are the only two paths the
# rest of the pipeline actually reads out of the checkouts.
for p in "$REPOS_DIR/D-Bundlr/codepredict/predictServer.py" \
         "$REPOS_DIR/AletheiaJSVersionDetection/dolospy/CMakeLists.txt"; do
  [ -f "$p" ] || { echo "missing after checkout: $p" >&2; exit 1; }
done

cat <<EOF

Both checkouts are in $REPOS_DIR.
  D-Bundlr/codepredict                    GraphCodeBERT server (fine-tuned weights come
                                          from ./baseline-files.sh, not from this clone)
  AletheiaJSVersionDetection/dolospy       compiled by rq1-performance/scripts/rebuild-env.sh

Next: bash src/evaluation/rq1-performance/scripts/rebuild-env.sh
EOF

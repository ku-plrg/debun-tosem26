#!/bin/bash
# npm-files.sh — the npm package corpus (src/data/npm), fetched from the npm registry.
#
# Not a Zenodo download: registry tarballs are immutable, so the corpus is rebuilt from its
# origin rather than redistributed. ~5,500 (package, version) tarballs over 72 packages,
# 54 GB extracted, and a while to fetch. Resumable — re-run to fill gaps.
#
# Needs ./download-files.sh first, for the fingerprint-cache manifest that says which
# versions to fetch. Needed only to rebuild the module-dependency-aware cache (build-db.sh
# step B) from source; every table and figure is reproducible without it.
#
#   ./npm-files.sh                     everything
#   LIBS=lodash.js,d3 ./npm-files.sh   just those directories
#   CONCURRENCY=4 ./npm-files.sh       gentler on the registry
set -euo pipefail
cd "$(dirname "$0")"

exec npx ts-node --transpile-only src/cmd/fetch-npm-corpus.ts

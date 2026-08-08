#!/bin/bash
# cdn-files.sh — the library corpus (src/data/cdn), fetched from cdnjs.
#
# Not a Zenodo download: the manifest that defines the corpus is committed
# (fingerprint-cache/cdn-alllibs.json), and cdnjs serves the same
# <library>/<version>/<file> layout, so the corpus is rebuilt from its origin instead of
# being redistributed. 77 libraries, ~319k files, ~29 GB. Resumable — re-run to fill gaps.
#
#   ./cdn-files.sh                  everything
#   LIBS=jquery,d3 ./cdn-files.sh   just those libraries
#   CONCURRENCY=8 ./cdn-files.sh    gentler on the CDN
#
# Only needed to rebuild the hash databases from source; ./download-files.sh already
# provides them built.
set -euo pipefail
cd "$(dirname "$0")"

exec npx ts-node --transpile-only src/cmd/fetch-cdn-corpus.ts

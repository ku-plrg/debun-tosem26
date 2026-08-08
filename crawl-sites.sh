#!/bin/bash
#
# crawl-sites.sh — fetch the websites Table 1 (paper RQ1) is measured on.
#
# Table 1 times DEBUN over the 56 websites in
# src/evaluation/rq1-performance/results/common_set.json. Third-party website code is not
# redistributed with this artifact, so `run RQ1` reports DEBUN's stored measurement
# until those scripts are present locally. This script crawls them into
# src/data/crawled/, after which `./debun.sh run RQ1` measures DEBUN live.
#
#   ./crawl-sites.sh          # all 56 sites (~15 min, one headless Chrome per site)
#   ./crawl-sites.sh 5        # first 5 only, to check the plumbing
#
# Sites already under src/data/crawled/ are skipped, so an interrupted run resumes and
# a repeat run costs nothing. Requires internet; Chrome is fetched by `npm install`
# (puppeteer). Some sites block crawlers — a failure is recorded and the run continues.
#
# A fresh crawl is not a replay: what a site serves today is not what it served on
# 2026-01-04, so the number of scripts and the timings will differ from the paper's.
# Table 1's Setup column is a live-network measurement and moves with the network.
#
# To re-derive the site set from the top of the Tranco list instead of using the stored
# 56 (this is what produced common_set.json: top 100 → the 56 where all six tools run):
#
#   TRANCO_CSV=/path/to/tranco.csv \
#     npx ts-node --transpile-only src/evaluation/rq1-performance/scripts/crawl_sites.ts --sites 100
#
set -euo pipefail
cd "$(dirname "$0")"

SET=src/evaluation/rq1-performance/results/common_set.json
N="${1:-9999}"
OUT=src/evaluation/rq1-performance/work/crawl.json

echo "[crawl] $(node -e "console.log(Math.min($N, require('./$SET').length))") of \
$(node -e "console.log(require('./$SET').length)") Table 1 sites -> src/data/crawled/"

TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","moduleResolution":"Node","esModuleInterop":true,"target":"ES2020"}' \
  npx ts-node --transpile-only src/evaluation/rq1-performance/scripts/crawl_sites.ts \
    --from "$SET" --sites "$N" --out "$OUT"

echo
echo "[crawl] per-site crawl times: $OUT"
echo "[crawl] next: ./debun.sh run RQ1   (measures DEBUN live once all 56 are present)"

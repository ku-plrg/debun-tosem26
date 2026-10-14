#!/bin/bash
# Table 1, measured N times instead of once.
#
# The stored results/ are a single pass: one measurement per site per tool, and Table 1 is the
# mean over the 56 sites. This driver repeats every cell N times so the table can also carry a
# spread. It changes no measurement code — it runs the same four harnesses, N times each, into
# separate outputs, and aggregate-repeats.py rolls them up.
#
#   bash src/evaluation/rq1-performance/scripts/repeat-rq1.sh
#   N=1 SITES=digicert.com,wordpress.org STAGES=crawl,debun ... # a smoke test
#
# Run it alone. These are timings: a browser, a build or a second measurement sharing the
# machine moves them by an order of magnitude, and the harnesses already spend effort on
# isolation (a fresh browser per measurement, a seeded tool-order shuffle, D-Bundlr pinned to
# one worker and one thread) that sharing the machine would throw away.
#
# Three things the run is built around:
#
#   Warm-up.    A cold process inflates its first site — D-Bundlr's first inference after a
#               server boot took 19,377 ms against 2,471 ms warm, and the bench's first site
#               pays the worker's ts-node compile. Every stage therefore measures a warm-up
#               site first and the aggregator drops it; the prediction server is started once
#               and kept up across all N passes.
#   Corpus.     Pass 1 of the crawl is kept and every Detection pass reads it, so Setup and
#               Detection describe the same crawl. Later crawl passes are timed and deleted.
#               Nothing touches src/data/crawled (the stored run's corpus) or
#               src/data/data-never-remove (the archived corpus RQ3/RQ4 are computed on).
#   Resume.     A pass whose output already exists is skipped, so an interrupted run continues
#               where it stopped. Delete the file to force that pass again.
set -u

ART="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ART" || exit 1

N="${N:-3}"
# The crawl is measured once by default: it is a network cost, the Detection stages all read
# the corpus it produces, and repeating it would re-download the same 56 sites for a Setup
# column that already carries 56 per-site measurements. Raise it to repeat Setup as well.
CRAWL_N="${CRAWL_N:-1}"
OUTDIR="${OUTDIR:-src/evaluation/rq1-performance/work/repeat-n$N}"
STAGES="${STAGES:-crawl,debun,runtime,static}"
RESULTS=src/evaluation/rq1-performance/results
PERF=src/evaluation/rq1-performance
PORT="${PORT:-3446}"
# Smallest site in the set: a warm-up that costs ~0.3 s of DEBUN and ~2 s of D-Bundlr.
WARM_MEASURED="${WARM_MEASURED:-digicert.com}"
# Outside the measured set, so prepending it to the runtime stage cannot collide with a row
# the aggregator keeps.
WARM_OUTSIDE="${WARM_OUTSIDE:-wikipedia.org}"

mkdir -p "$OUTDIR/logs" || exit 1

# One browser for the whole run. Two stages drive one: the crawl (Setup for the static tools)
# and stage3c (Setup for the runtime ones). The crawler asks for /usr/bin/chromium — the
# Docker image's browser — and falls back to puppeteer's own when that launch throws, while
# stage3c always takes puppeteer's. On a machine carrying both, the two halves of the Setup
# column would be measured against different browsers, and which one the crawl got would
# depend on whether a distribution package happened to be installed. Pin both, and stop here
# rather than 25 hours in if the browser is missing.
if [ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
  CHROME="$(node -p "try{require('puppeteer').executablePath()}catch(e){''}" 2>/dev/null)"
  if [ -n "$CHROME" ] && [ -x "$CHROME" ]; then
    export PUPPETEER_EXECUTABLE_PATH="$CHROME"
  else
    echo "puppeteer's Chrome is not installed${CHROME:+ at $CHROME}."
    echo "  npx puppeteer browsers install chrome"
    exit 1
  fi
fi
echo "browser: $PUPPETEER_EXECUTABLE_PATH"

stage_wanted() { case ",$STAGES," in *",$1,"*) return 0;; *) return 1;; esac; }
say() { printf '\n=== %s ===\n' "$1"; }

# ── site list ────────────────────────────────────────────────────────────────────────────────
# SITES overrides the 56 for a smoke test. The stage1 files keep results/stage1_100.json's
# order, which is Tranco rank order — the order every stored measurement used.
SITES="${SITES:-}" python3 - "$OUTDIR" "$WARM_OUTSIDE" <<'PY' || exit 1
import json, os, sys
outdir, warm_outside = sys.argv[1], sys.argv[2]
R = 'src/evaluation/rq1-performance/results'
common = json.load(open(f'{R}/common_set.json'))
env = os.environ.get('SITES') or ''
if env:
    common = [s.strip() for s in env.split(',') if s.strip()]
stage1 = json.load(open(f'{R}/stage1_100.json'))['rows']
by_site = {r['site']: r for r in stage1}
rows = [{'rank': by_site[s]['rank'], 'site': s} for s in common if s in by_site]
missing = [s for s in common if s not in by_site]
if missing:
    sys.exit(f'not in stage1_100.json: {missing}')
json.dump(common, open(f'{outdir}/sites.json', 'w'))
json.dump({'rows': rows}, open(f'{outdir}/stage1.json', 'w'), indent=1)
warm = by_site.get(warm_outside)
if not warm:
    sys.exit(f'warm-up site {warm_outside} is not in stage1_100.json')
json.dump({'rows': [{'rank': warm['rank'], 'site': warm['site']}] + rows},
          open(f'{outdir}/stage1-warm.json', 'w'), indent=1)
print(f'{len(rows)} sites; runtime stage prepends {warm_outside} as warm-up')
PY

SITE_LIST="$(python3 -c "import json;print(','.join(json.load(open('$OUTDIR/sites.json'))))")"
NSITES="$(python3 -c "import json;print(len(json.load(open('$OUTDIR/sites.json'))))")"

# A pass is done when its output holds every site, not when the file exists. The crawl and the
# static stage write after each site, so an interrupted pass leaves a partial file behind, and
# skipping on existence alone would fold a half-measured pass into the table as a whole one.
# Both of those stages resume from their own output, so re-entering them costs only what is
# missing; the other two rewrite their output from scratch.
count_rows() {
  python3 - "$1" <<'PYEOF'
import csv, json, sys
try:
    p = sys.argv[1]
    print(len(list(csv.DictReader(open(p)))) if p.endswith('.csv')
          else len(json.load(open(p))['rows']))
except Exception:
    print(0)
PYEOF
}
pass_done() {  # pass_done <output file> <rows it must hold>
  [ -f "$1" ] || return 1
  [ "$(count_rows "$1")" -ge "$2" ]
}

# ── 1. Setup, static tools: the crawl ────────────────────────────────────────────────────────
# Pass 1's corpus is kept for the Detection stages; any further pass is timed and thrown away,
# so the disk cost stays at one crawl however many times Setup is measured.
#
# The corpus sits beside the pass outputs rather than at a path of its own, so a run given its
# own OUTDIR — a smoke test, a pre-flight check of how much a new machine's IP gets blocked —
# crawls into its own tree instead of overwriting the real run's.
CORPUS_REL="$OUTDIR/crawl-root-r1"
# crawl_timing.ts passes --root to crawler.ts, which resolves it against src/, not the repo
# root. Everything else here is repo-relative, so the one place that needs the other form
# derives it; an OUTDIR outside src/ has no such form and is refused rather than silently
# crawling somewhere else.
case "$OUTDIR" in
  src/*) CORPUS_SRC_REL="${OUTDIR#src/}/crawl-root" ;;
  *) echo "OUTDIR must be under src/ (the crawler resolves its root there): $OUTDIR"; exit 1 ;;
esac
if stage_wanted crawl; then
  for r in $(seq 1 "$CRAWL_N"); do
    out="$OUTDIR/crawl-r$r.json"
    if pass_done "$out" "$NSITES"; then say "crawl pass $r/$CRAWL_N — already complete, skipping"; continue; fi
    [ -f "$out" ] && say "crawl pass $r/$CRAWL_N — resuming a partial pass ($(count_rows "$out")/$NSITES)"
    say "crawl pass $r/$CRAWL_N"
    npx ts-node --transpile-only "$PERF/scripts/crawl_timing.ts" \
      --all --sites "$OUTDIR/sites.json" \
      --root "$CORPUS_SRC_REL-r$r" \
      --out "$out" 2>&1 | tee "$OUTDIR/logs/crawl-r$r.log"
    [ -f "$out" ] || { echo "crawl pass $r produced no output — stopping"; exit 1; }
    if [ "$r" != "1" ]; then rm -rf "$OUTDIR/crawl-root-r$r"; fi
  done
fi

# ── 2. Detection, DEBUN ──────────────────────────────────────────────────────────────────────
# SITE_FILTER carries the warm-up site twice over: once at the head, which the aggregator
# drops, and once in its own place in rank order.
if stage_wanted debun; then
  [ -d "$CORPUS_REL" ] || { echo "no corpus at $CORPUS_REL — run the crawl stage first"; exit 1; }
  for r in $(seq 1 "$N"); do
    out="$OUTDIR/debun-r$r.csv"
    if pass_done "$out" "$((NSITES + 1))"; then say "DEBUN pass $r/$N — already complete, skipping"; continue; fi
    say "DEBUN pass $r/$N"
    # --expose-gc but NOT BENCH_FORCE_GC: the flag's collections run inside the two timed
    # windows, so they land in hashTotalMs and detectTotalMs. results/bench-56.csv was
    # measured without it and reproduces here (detectTotalMs minus its three sub-phases is
    # 1.4 / 6.5 / 7.5 ms stored against 1.6 / 6.3 / 10.4 ms off, and 218 / 359 / 185 ms on).
    # --expose-gc on its own only lets the bench collect once before reading the index's
    # resident baseline, which is what `run RQ1` passes too.
    SITE_SRC_DIR="$CORPUS_REL" SITE_FILTER="$WARM_MEASURED,$SITE_LIST" \
    FP_CACHE_DIR=src/data/fingerprint-cache MATCH_THRESHOLD=84 \
    BENCH_OUTPUT="$out" \
    NODE_OPTIONS='--max-old-space-size=12288 --expose-gc' \
      node -r ts-node/register/transpile-only src/evaluation/web-detect-bench.ts \
      2>&1 | tee "$OUTDIR/logs/debun-r$r.log"
    [ -f "$out" ] || { echo "DEBUN pass $r produced no output — stopping"; exit 1; }
  done
fi

# ── 3. Setup + Detection, runtime tools ──────────────────────────────────────────────────────
# The seed is fixed across passes on purpose: the shuffle exists to cancel tool ordering, and
# holding it constant keeps the passes comparable site by site.
if stage_wanted runtime; then
  for r in $(seq 1 "$N"); do
    out="$OUTDIR/stage3c-r$r.json"
    if pass_done "$out" "$((NSITES + 1))"; then say "runtime-tools pass $r/$N — already complete, skipping"; continue; fi
    say "runtime-tools pass $r/$N"
    node "$PERF/scripts/stage3c_runtime_tools.mjs" \
      --stage1 "$OUTDIR/stage1-warm.json" --out "$out" \
      2>&1 | tee "$OUTDIR/logs/stage3c-r$r.log"
    [ -f "$out" ] || { echo "runtime pass $r produced no output — stopping"; exit 1; }
  done
fi

# ── 4. Detection, D-Bundlr + Aletheia ────────────────────────────────────────────────────────
# One server for the whole stage. Booting it per pass would hand pass 1 of each a cold model,
# which is the 8x first-site penalty this driver exists to keep out of the numbers.
if stage_wanted static; then
  [ -d "$CORPUS_REL" ] || { echo "no corpus at $CORPUS_REL — run the crawl stage first"; exit 1; }
  say "starting the D-Bundlr prediction server on port $PORT"
  DBUNDLR_DEVICE=cpu MODEL_DIR=src/data/baselines/debun-model \
  CODEPREDICT=src/baselines/upstream-repos/D-Bundlr/codepredict OMP_NUM_THREADS=1 \
    "$PERF/env/venv-server/bin/gunicorn" -w 1 -b "127.0.0.1:$PORT" --timeout 900 \
    --log-level warning --chdir src/baselines serve:app > "$OUTDIR/logs/server.log" 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  if ! curl -s --retry 90 --retry-delay 5 --retry-connrefused --max-time 900 \
       -X POST "http://127.0.0.1:$PORT/predict" -H 'Content-Type: application/json' \
       -d '{"code":"function f(){}"}' > /dev/null; then
    echo "the prediction server never answered — see $OUTDIR/logs/server.log"; exit 1
  fi
  echo "server up (pid $SERVER_PID)"

  # A discarded pass over the warm-up site alone: the model's first real inference costs ~8x
  # what the steady state does, and the tiny warm request above does not pay it.
  if [ ! -f "$OUTDIR/stage2-warmup.json" ]; then
    say "static-tools warm-up (discarded)"
    python3 -c "import json;json.dump(['$WARM_MEASURED'],open('$OUTDIR/sites-warm.json','w'))"
    SITE_SRC_DIR="$CORPUS_REL" INDEX_DIR=src/data/baselines/aletheia-debun-index \
    PYTHONPATH="$PERF/env/dolospy-build" \
      "$PERF/env/venv-client/bin/python" "$PERF/scripts/stage2_full.py" \
      --stage1 "$OUTDIR/stage1.json" --sites "$OUTDIR/sites-warm.json" \
      --server "http://127.0.0.1:$PORT/predict" --out "$OUTDIR/stage2-warmup.json" \
      2>&1 | tee "$OUTDIR/logs/stage2-warmup.log"
  fi

  for r in $(seq 1 "$N"); do
    out="$OUTDIR/stage2-r$r.json"
    if pass_done "$out" "$NSITES"; then say "static-tools pass $r/$N — already complete, skipping"; continue; fi
    [ -f "$out" ] && say "static-tools pass $r/$N — resuming a partial pass ($(count_rows "$out")/$NSITES)"
    say "static-tools pass $r/$N  (the long one — D-Bundlr runs a model on every module)"
    SITE_SRC_DIR="$CORPUS_REL" INDEX_DIR=src/data/baselines/aletheia-debun-index \
    PYTHONPATH="$PERF/env/dolospy-build" \
      "$PERF/env/venv-client/bin/python" "$PERF/scripts/stage2_full.py" \
      --stage1 "$OUTDIR/stage1.json" --sites "$OUTDIR/sites.json" \
      --server "http://127.0.0.1:$PORT/predict" --out "$out" \
      2>&1 | tee "$OUTDIR/logs/stage2-r$r.log"
    [ -f "$out" ] || { echo "static pass $r produced no output — stopping"; exit 1; }
  done

  kill $SERVER_PID 2>/dev/null
  trap - EXIT
fi

say "done — aggregating"
python3 "$PERF/scripts/aggregate-repeats.py" --dir "$OUTDIR" --repeats "$N" --crawl-repeats "$CRAWL_N" \
  | tee "$OUTDIR/table1-repeats.txt"

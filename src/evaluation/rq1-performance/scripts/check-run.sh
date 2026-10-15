#!/bin/bash
# Is the measurement that is currently running going to be usable?
#
# Strictly read-only and free: it reads the outputs and logs repeat-rq1.sh has already
# written, plus /proc. It starts no process, loads no model and does no arithmetic worth
# a timer, so it is safe to run while the measurement is in flight -- which probe-cpu.sh
# is NOT, because that one boots its own server and competes for the CPU being measured.
#
#   bash src/evaluation/rq1-performance/scripts/check-run.sh
#
# Safe to run against a checkout pinned to an older commit without disturbing it:
#   git fetch origin main && git show origin/main:src/evaluation/rq1-performance/scripts/check-run.sh | bash
#
# It answers the three questions that decide whether a 25-hour run has to be repeated,
# and it answers them from partial output, so they do not have to wait for the end.
set -u

ART="$(cd "$(dirname "$0")/../../../.." 2>/dev/null && pwd)" || ART="$PWD"
cd "$ART" 2>/dev/null || true
OUTDIR="${OUTDIR:-src/evaluation/rq1-performance/work/repeat-n3}"

echo "=== commit ==="
git rev-parse HEAD 2>/dev/null
git log --oneline -1 2>/dev/null
# e6ef593 is the commit that stopped BENCH_FORCE_GC from running inside the timed windows
# and pinned the browser. A run started before it has a DEBUN column inflated 4-5x and a
# Setup column whose two halves may have used different browsers.
if git merge-base --is-ancestor e6ef59359129c0142fa70e8941d28625e00869dc HEAD 2>/dev/null; then
  echo "  includes e6ef593 (GC + browser fixes): YES"
else
  echo "  includes e6ef593 (GC + browser fixes): NO  <-- see the DEBUN check below"
fi
echo "  OUTDIR: $OUTDIR"
[ -d "$OUTDIR" ] || { echo "  (no such directory -- set OUTDIR to the run's output tree)"; exit 1; }

echo
echo "=== progress ==="
ls -1 "$OUTDIR"/*.json "$OUTDIR"/*.csv 2>/dev/null | while read -r f; do
  n=$(python3 - "$f" <<'PYEOF' 2>/dev/null
import csv, json, sys
p = sys.argv[1]
try:
    print(len(list(csv.DictReader(open(p)))) if p.endswith('.csv') else len(json.load(open(p))['rows']))
except Exception:
    print('?')
PYEOF
)
  printf '  %-34s %6s rows  %s\n' "$(basename "$f")" "$n" "$(date -r "$f" '+%m-%d %H:%M' 2>/dev/null)"
done

python3 - "$OUTDIR" <<'PYEOF'
import csv, glob, json, os, statistics as st, sys
out = sys.argv[1]

print("\n=== 1. DEBUN: was BENCH_FORCE_GC left on? ===")
# forceGc() sits inside both timed windows (web-detect-bench.ts:650,655), so when the flag
# is set its collections land in hashTotalMs and detectTotalMs. The tell is detectTotalMs
# minus its own three sub-phases: ~7 ms with the flag off, 200-400 ms with it on. The stored
# results/bench-56.csv has a median of 7.7 ms, i.e. it was measured with the flag off, so a
# run that shows hundreds here is not comparable with the published table and its DEBUN
# passes have to be measured again.
rows = []
for p in sorted(glob.glob(os.path.join(out, "debun-r*.csv"))):
    r = list(csv.DictReader(open(p)))
    if r:
        rows.append((os.path.basename(p), r))
if not rows:
    print("  no DEBUN pass has written rows yet")
for name, r in rows:
    gaps = []
    for x in r:
        try:
            gaps.append(float(x["detectTotalMs"]) - sum(float(x[k]) for k in ("lookupMs", "assembleMs", "filterMs")))
        except (KeyError, ValueError):
            pass
    if not gaps:
        continue
    med = st.median(gaps)
    verdict = "GC OFF - good, comparable with the stored table" if med < 40 else \
              "GC ON  - this pass is unusable, measure it again"
    print(f"  {name:20} {len(r):3} sites  detect gap median {med:7.1f} ms   {verdict}")
    print(f"  {'':20} (stored results/bench-56.csv: 7.7 ms)")

print("\n=== 2. D-Bundlr: how slow is this machine, really? ===")
# The 6x question, answered from the run's own output instead of a probe. Every request is
# padded to 320 tokens (codepredict/utils.py:147), so per-prediction latency is the machine,
# not the input, and the Mac's stored median is 64.1 ms.
MAC = 64.1
found = False
for p in sorted(set(glob.glob(os.path.join(out, "stage2*.json")))):
    try:
        rr = json.load(open(p))["rows"]
    except Exception:
        continue
    per = [r["dbundlrInferMs"] / r["dbundlrModules"] for r in rr if r.get("dbundlrModules")]
    if not per:
        continue
    found = True
    med = st.median(per)
    gflops = 58.1 / (med / 1000)
    print(f"  {os.path.basename(p):20} {len(per):3} sites  {med:6.1f} ms/prediction  = {med/MAC:4.1f}x the Mac  ({gflops:.0f} GFLOPS effective)")
    if med / MAC > 8:
        print(f"  {'':20} SLOWER than a single x86 core's ceiling explains -- report this")
    elif med / MAC >= 4.5:
        print(f"  {'':20} within the 5-6x a core without AMX is expected to give")
if not found:
    print("  the static stage has not written rows yet")

print("\n=== 3. the crawl: did this IP get blocked? ===")
# The 56 sites are the set where all six tools worked. A datacenter IP that gets bot-blocked
# silently changes Table 1's population rather than failing, so count the sites that came
# back with no files at all.
corpus = os.path.join(out, "crawl-root-r1")
if not os.path.isdir(corpus):
    print(f"  no corpus at {corpus} yet")
else:
    counts = {}
    for s in sorted(os.listdir(corpus)):
        d = os.path.join(corpus, s)
        if os.path.isdir(d):
            counts[s] = sum(len(f) for _, _, f in os.walk(d))
    zero = [s for s, n in counts.items() if n == 0]
    print(f"  {len(counts)} sites, {sum(counts.values())} files")
    print(f"  empty: {len(zero)}" + (f"  <-- {', '.join(zero[:12])}" if zero else "  (good)"))
    for s in ("cloudflare.com", "workers.dev"):
        if s in counts:
            # These two ended the stored crawl with zero files because of the WriteStream
            # crash fixed in 253c7a9; a non-zero count here confirms the fix is in effect.
            print(f"  {s:18} {counts[s]:5} files" + ("  <-- still zero, the 253c7a9 fix is not in effect" if not counts[s] else ""))
    small = sorted((n, s) for s, n in counts.items() if 0 < n < 5)
    if small:
        print("  suspiciously small: " + ", ".join(f"{s}({n})" for n, s in small[:10]))
PYEOF

echo
echo "=== 4. browser the crawl used ==="
# Two stages drive a browser and both halves land in the same Setup column. Before e6ef593
# the crawl took /usr/bin/chromium when it existed while stage3c always took puppeteer's.
if [ -x /usr/bin/chromium ]; then
  echo "  /usr/bin/chromium EXISTS: $(/usr/bin/chromium --version 2>/dev/null | head -1)"
  echo "  -> without e6ef593, the crawl used this while stage3c used puppeteer's Chrome"
else
  echo "  /usr/bin/chromium: absent (so the crawl fell back to puppeteer's Chrome)"
fi
ls -d ~/.cache/puppeteer/chrome*/ 2>/dev/null | sed 's/^/  puppeteer: /' || echo "  puppeteer Chrome: NOT INSTALLED"

echo
echo "=== 5. machine (free reads only) ==="
if command -v lscpu > /dev/null; then
  lscpu | grep -Ei 'model name|^architecture|^cpu\(s\)|thread.*per|core.*per|mhz' | cut -c1-120 | sed 's/^/  /'
  echo "  governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo 'n/a')"
fi
echo "  load: $(uptime | sed 's/.*load/load/')"
echo "  (anything other than the measurement running here moves every number in Table 1)"

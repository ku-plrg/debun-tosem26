#!/bin/bash
# RQ1 — is the D-Bundlr column measuring the CPU, or is something misconfigured?
#
# D-Bundlr spends its time on one GraphCodeBERT forward pass per module, and utils.py:147
# pads every input to code_length + data_flow_length = 320 tokens, so the work per request
# is a constant ~58 GFLOP whatever the module looks like. That makes the column a pure
# single-core GEMM benchmark, and it moves with the BLAS backend rather than with the code:
# the stored Table 1 was measured on a Mac, whose torch is built against Accelerate
# (BLAS_INFO=accelerate, USE_MKL=OFF), at 64.1 ms per prediction. That is 906 GFLOPS
# effective -- 6.3x more than the same core's NEON units can reach, so it is the AMX
# coprocessor doing the GEMM. An x86 core has no AMX equivalent and tops out at 32 FLOP per
# cycle, which puts the same pass at 330-400 ms: 5-6x slower with nothing wrong.
#
# This probe decides which it is, in about a minute, without the corpus -- so it can run
# before the crawl rather than 25 hours into the measurement.
#
#   bash src/evaluation/rq1-performance/scripts/probe-cpu.sh
#
# Reports per-prediction latency at OMP_NUM_THREADS=1 and =4. The 4-thread number is the
# test: a pass that is compute-bound in BLAS scales nearly linearly with threads, so if 4
# threads does NOT speed it up, the bottleneck is somewhere other than the CPU's GEMM
# throughput and the hardware explanation is wrong. The 4-thread figure is a diagnostic
# only -- Table 1 is measured at 1 thread so the tools stay comparable.
set -u

ART="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ART" || exit 1

PERF=src/evaluation/rq1-performance
PORT="${PORT:-3447}"          # not repeat-rq1.sh's 3446, so a probe cannot disturb a run
REQS="${REQS:-40}"            # after a discarded warm-up; 40 x ~0.4 s is ~16 s per setting
THREADS="${THREADS:-1 4}"
MAC_BASELINE_MS=64.1          # stored results/stage2_full.json, median over 56 sites

PY="$PERF/env/venv-client/bin/python"
PY_SERVER="$PERF/env/venv-server/bin/python"
GUNICORN="$PERF/env/venv-server/bin/gunicorn"
for f in "$PY" "$PY_SERVER" "$GUNICORN"; do
  [ -x "$f" ] && continue
  echo "missing $f — run: bash $PERF/scripts/rebuild-env.sh"; exit 1
done
[ -d src/data/baselines/debun-model ] || {
  echo "missing src/data/baselines/debun-model — run: ./baseline-files.sh"; exit 1; }

echo "=============================================================="
echo " 1. machine"
echo "=============================================================="
if command -v lscpu > /dev/null; then
  lscpu | grep -Ei 'model name|^architecture|^cpu\(s\)|thread|core|socket|mhz|cache|flags' |
    cut -c1-200
  # A core parked at its base clock by the governor measures slower than the same core at
  # boost, and the ratio this probe reports is read as a property of the chip.
  echo "--- governor / boost ---"
  cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null ||
    echo "(no cpufreq governor exposed)"
  grep . /sys/devices/system/cpu/cpufreq/boost 2>/dev/null ||
    echo "(no cpufreq boost knob)"
  echo "--- load before the probe (must be idle: these are timings) ---"
  uptime
else
  sysctl -n machdep.cpu.brand_string 2>/dev/null
  echo "cores: $(sysctl -n hw.physicalcpu 2>/dev/null)p / $(sysctl -n hw.logicalcpu 2>/dev/null)l"
  uptime
fi

echo
echo "=============================================================="
echo " 2. torch build"
echo "=============================================================="
# USE_MKL/USE_MKLDNN and the thread counts are what decide the GEMM path. OMP_NUM_THREADS
# alone does not always pin MKL, which is why the thread counts are printed rather than
# assumed: if either is not 1 under OMP_NUM_THREADS=1, Table 1's "one core" is not one core
# and repeat-rq1.sh needs MKL_NUM_THREADS=1 as well.
OMP_NUM_THREADS=1 "$PY_SERVER" -I - <<'PYEOF'
import torch
print("torch              ", torch.__version__)
cfg = torch.__config__.show()
for k in ("BLAS_INFO", "LAPACK_INFO", "USE_MKL=", "USE_MKLDNN=", "USE_OPENMP=", "CPU capability"):
    for part in cfg.replace("\n", ", ").split(", "):
        if k in part:
            print(f"  {part.strip()}")
print("cuda.is_available  ", torch.cuda.is_available(), "  <- must be False: a True here means")
print("                       predictServer.py:28 loads the checkpoint onto the GPU")
print("get_num_threads    ", torch.get_num_threads(), "  <- must be 1 under OMP_NUM_THREADS=1")
try:
    print("interop threads    ", torch.get_num_interop_threads())
except Exception:
    pass
PYEOF

echo
echo "=============================================================="
echo " 3. per-prediction latency"
echo "=============================================================="
printf '%-10s %10s %10s %10s %10s %12s\n' threads median_ms mean_ms min_ms max_ms "vs_mac"

for T in $THREADS; do
  DBUNDLR_DEVICE=cpu MODEL_DIR=src/data/baselines/debun-model \
  CODEPREDICT=src/baselines/upstream-repos/D-Bundlr/codepredict OMP_NUM_THREADS="$T" \
    "$GUNICORN" -w 1 -b "127.0.0.1:$PORT" --timeout 900 --log-level warning \
    --chdir src/baselines serve:app > "/tmp/probe-server-$T.log" 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT

  if ! curl -s --retry 90 --retry-delay 2 --retry-connrefused --max-time 600 \
       -X POST "http://127.0.0.1:$PORT/predict" -H 'Content-Type: application/json' \
       -d '{"code":"function f(){}"}' > /dev/null; then
    echo "server never answered at OMP_NUM_THREADS=$T — see /tmp/probe-server-$T.log"
    kill $SERVER_PID 2>/dev/null; exit 1
  fi

  OMP_NUM_THREADS="$T" MAC_MS="$MAC_BASELINE_MS" PORT="$PORT" REQS="$REQS" T="$T" \
    "$PY" -I - <<'PYEOF'
import json, os, statistics as st, time, urllib.request

port, reqs, mac, T = os.environ["PORT"], int(os.environ["REQS"]), float(os.environ["MAC_MS"]), os.environ["T"]
url = f"http://127.0.0.1:{port}/predict"

# Two module sizes from opposite ends of the real distribution (results/stage2_full.json
# records a median of 74 characters and a p90 of 281). Both are padded to 320 tokens, so the
# forward pass is identical and only tokenisation and the dataflow parse differ: the two
# should land within ~20% of each other. A large gap would mean the probe is measuring
# parsing rather than the GEMM the column is actually made of.
small = "function(e,t,n){var r=e.exports;return t&&(r=t(r)),n?n(r):r}"
large = ("function(e,t,n){" +
         "".join(f"var v{i}=e[{i}]*t[{i}]+n;if(v{i}>0){{t[{i}]=v{i}}}else{{n=v{i}}}" for i in range(40)) +
         "return t}")

def once(code):
    body = json.dumps({"code": code}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    urllib.request.urlopen(req, timeout=900).read()
    return (time.perf_counter() - t0) * 1000

# D-Bundlr's first real inference after a boot costs ~8x the steady state; the tiny warm
# request the shell already sent does not pay it.
for _ in range(8):
    once(large)

out = {}
for name, code in (("small", small), ("large", large)):
    out[name] = sorted(once(code) for _ in range(reqs))

ms = out["large"]
med = st.median(ms)
print(f'{T:<10} {med:10.1f} {st.mean(ms):10.1f} {ms[0]:10.1f} {ms[-1]:10.1f} {med/mac:11.1f}x')
print(f'{"":10} {"(small module: median " + format(st.median(out["small"]), ".1f") + " ms — padding puts both through the same 320-token pass)":>60}')
PYEOF

  kill $SERVER_PID 2>/dev/null
  wait $SERVER_PID 2>/dev/null
  trap - EXIT
done

echo
echo "=============================================================="
echo " how to read it"
echo "=============================================================="
cat <<'EOF'
Mac baseline: 64.1 ms per prediction (median over 56 sites, 304,663 modules).
One prediction is ~58 GFLOP, so 64.1 ms is 906 GFLOPS effective.

  1 thread at 5-7x the Mac      the x86 core is at its SIMD ceiling. Nothing to fix:
                                151 GFLOPS at 6x is 86-100% of a Zen 4 core's peak,
                                and the gap is the Mac's AMX coprocessor.
  1 thread at >8x the Mac       slower than the ceiling explains. Check cuda.is_available,
                                the thread counts above, and the CPU model in section 1.
  4 threads >= 2x faster        compute-bound in BLAS, which confirms the reading above.
                                Do not expect 4x: each GEMM is small enough that threading
                                it costs synchronisation. The Mac reaches only 1.4x here,
                                because one thread already saturates its single AMX unit --
                                an x86 core has no shared unit, so it should scale better.
  4 threads ~= 1 thread         NOT compute-bound. The hardware explanation is wrong and
                                something else is the bottleneck -- report this.

Table 1 stays at OMP_NUM_THREADS=1; the 4-thread row is a diagnostic, not a measurement.
EOF

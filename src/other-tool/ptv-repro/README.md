# PTV vs. DEBUN — reproducible version-detection comparison

Reproduces the **DEBUN vs. PTV** version-detection comparison reported in RQ3 (README Table
after Table 4). **PTV** (ICSE'26, *"PTV: Scalable Version Detection of Web Libraries"*) is a
runtime pTree-based detector shipped as a Chrome extension. Its detection is *offline*: a
library bundle is loaded into a blank HTML page, PTV walks the runtime `window` property tree,
and reports the library + candidate version list. DEBUN scores the **same byte-identical file**
statically. Both are evaluated over a shared corpus of `(lib, version)` cdnjs files.

This directory is **self-contained** — every script defaults to paths inside the artifact; only
a browser and internet access must be provided by the host.

## Layout

```
ptv-repro/
├── corpus-intersect.json      # PTV DB ∩ DEBUN version-DB = 61 libs (input; regenerable)
├── libs_data/                 # vendored PTVgen data: per-lib {version → cdnjs url/file/deps} (1,125 libs)
└── scripts/
    ├── run-fullpop.sh         # one-shot orchestration (stages 1–5)
    ├── corpus-intersect.js    # (stage 0) recompute corpus-intersect.json
    ├── build-corpus.js        # (stage 1) download shared corpus from cdnjs
    ├── gen-webhashes.ts       # (stage 2) fingerprint each file → allWebHashes site
    ├── ptv-detect-corpus.js   # (stage 4) run PTV over the corpus (headless Chrome)
    ├── score-final.js         # (stage 5) score Major/Minor/Patch + candidate-range
    ├── detect-asshipped-ORIGINAL.js  # PTV as-shipped detect.js (used by stage 4)
    ├── detect-bugfix.js       # PTV variant (ablation; not used by the 2-tool run)
    └── debun-detect-file.ts   # (reference only) single-file legacy detect — NOT used
```

The PTV extension itself is vendored one level up at `../ptv/` (served to the browser in stage 4).

## Requirements

- `build-db.sh` already run → `src/data/{fingerprint-cache,debun-hashes}` present, plus the npm
  corpus (`src/data/npm`). Stage 3 uses DEBUN's real module-aware scorer at ψ = 84%.
- **Google Chrome** installed (default macOS path; override with `CHROME=/path/to/chrome`).
- **Internet** (cdnjs): stage 1 downloads the corpus; stage 4 loads crypto-js + each lib's
  runtime dependencies; a fully-offline run needs them localized first.
- Node 18+ and the artifact's `node_modules` (puppeteer).

## Run

```bash
# full population, fair budget (default POOL=1 SETTLE_MS=3000) — reproduces 73.9/65.8/63.8 (~2.5-3 h)
bash src/other-tool/ptv-repro/scripts/run-fullpop.sh

# fast tight-budget variant — reproduces 64.6/57.6/55.8 (~15 min)
POOL=5 SETTLE_MS=900 bash src/other-tool/ptv-repro/scripts/run-fullpop.sh

# quick wiring smoke (one library, 3 versions)
LIBS="fabric.js" K=3 WORK=/tmp/ptv-smoke bash src/other-tool/ptv-repro/scripts/run-fullpop.sh
```

Knobs (env): `POOL` (parallel PTV pages, default **1** = fair), `SETTLE_MS` (post-load settle
before the window snapshot, default **3000**), `RECYCLE_EVERY` (relaunch the browser every N
pages, default 150 — keeps long POOL=1 runs from dropping the CDP connection), `K` (versions/lib
cap), `WORK` (scratch dir, default `tmp/ptv-repro`), `CHROME`, `DEBUN_ROOT`, `LIBS` (comma filter).
Outputs land in `$WORK/` (`corpus/`, `debun-out/summary.csv`, `ptv-results.json`,
`score-final-summary.json`) and the score table is printed at the end.

## Expected result (full population, 45 libs / 2,113 instances)

Reported under a **generous detection budget** (`POOL=1 SETTLE_MS=3000`) — PTV waits long
enough that heavy / dependency-loading libraries finish initializing on `window` before it
snapshots, its most favorable and deployment-realistic setting:

| Level | PTV *(fair)* | DEBUN |
| :---- | :----------: | :---: |
| Major | 73.9% (±1.06) | **86.7% (±1.08)** |
| Minor | 65.8% (±1.26) | **81.3% (±1.27)** |
| Patch | 63.8% (±2.23) | **76.5% (±2.13)** |

Version-report rate 75.7% (PTV) vs 87.7% (DEBUN); ~15% of instances are genuine PTV misses
(no label + no pTree, or ESM/module-only bundles that cannot run as a classic `<script>`).

**Detection budget matters for PTV** (not for DEBUN, which is static/deterministic). Under a
tight `POOL=5 SETTLE_MS=900` budget PTV drops to **64.6 / 57.6 / 55.8** because heavy libs are
snapshotted before they finish loading — this is a fixed-time-budget artifact, not PTV's ceiling.
DEBUN leads at every level under both budgets.

> **Scorer note:** stage 3 must use DEBUN's `strictVersions` (module-aware `web-detect-eval.ts`,
> ψ = 84%, the paper's Table 4 path) — **not** the legacy `detect` CLI scorer, which overestimates
> DEBUN. `run-fullpop.sh` already wires the correct path.

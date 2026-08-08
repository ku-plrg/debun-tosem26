> [!warning]
> This repository is the TOSEM 2026 (ACM Transactions on Software Engineering and
> Methodology) submission archive for reproducing the paper results. For the latest
> version and updates, please refer to: https://github.com/ku-plrg/debun

# DEBUN: Detecting JavaScript Libraries on the Web using Property-Order Graphs

This artifact evaluates **DEBUN**, a scalable technique for detecting JavaScript libraries and
their versions using function-level fingerprints based on **Property-Order Graphs (POGs)**.

Extensions over the ASE'25 conference paper, all reflected in this artifact: function inlining
preprocessing (§4, the `POG+FBCI` model), a module-dependency-aware scoring function (§6.2,
`score_m`), and an extended evaluation (§7) adding the **D-Bundlr**, **Aletheia**, and **PTV**
baselines, three-level version metrics, and a library-scorer ablation.

## Requirements

- Docker (recommended), or Node.js 18+ for local installation
- ~16 GB RAM (the fingerprint-cache build peaks around 12 GB)
- Disk space for the raw corpora (tens of GB) if reproducing the full evaluation

## Getting Started

### Quick start with Docker

```bash
docker build -t debun .
docker run -it --rm debun ./debun.sh run RQ3        # any of RQ1..RQ4, straight away
```

The image carries the summaries and hash files every table reads, but not the raw corpora or
the full databases, so downloads and `build-db.sh` output would be lost when the container
exits. To keep them, mount a host directory over `src/data` — but **seed it from the image
first**, otherwise the mount hides the fixtures that are baked in and every RQ command fails
on a missing `cdn-alllibs.json`:

```bash
docker create --name debun-seed debun
docker cp debun-seed:/usr/src/app/src/data ./data   # ~79 MB of shipped fixtures
docker rm debun-seed

docker run -it --rm -v "$PWD/data:/usr/src/app/src/data" debun bash
#   ./download-files.sh                             # now persists on the host
```

Reuse the same `-v` on later runs; `build-db.sh` skips whatever it already finds.

### Local installation

```bash
npm install
chmod +x debun.sh build-db.sh *-files.sh
```

## Artifact Structure

```
.
├── Dockerfile
├── README.md
├── debun.sh                     # main CLI entrypoint (ts-node)
├── zenodo-record.env            # the Zenodo record the four download scripts pull from
├── download-files.sh            # Zenodo: hash DBs + GT evidence (start here, ~117 MB)
├── baseline-files.sh            # Zenodo: D-Bundlr / Aletheia inputs (~526 MB)
├── corpora-files.sh             # Zenodo: crawled website code + RQ2 bundles (~350 MB)
├── cdn-files.sh                 # cdnjs: the library corpus (~29 GB)
├── ablation-files.sh            # Zenodo: per-model caches for Table 3 (~300 MB)
├── npm-files.sh                 # npm registry: the package corpus (~54 GB)
├── baseline-repos.sh            # git: the two upstream baseline checkouts, pinned
├── build-db.sh                  # CONSTRUCT the fingerprint hash databases
├── crawl-sites.sh               # crawl the 56 websites Table 1 is timed on
├── package.json / tsconfig.json
└── src
    ├── dist/index.ts            # CLI: detect | fingerprint-collector | run RQ1..RQ4
    ├── fingerprint-collector    # POG-based fingerprinting
    │   ├── function-collector.ts        # extract functions from JS
    │   ├── single-use-finder-defuse.ts  # function-inlining preprocessing (§4)
    │   ├── pog-generator.ts             # Property-Order Graph generation (§5)
    │   ├── hash-function.ts             # POG hashing
    │   └── dep-extractor / depgraph-builder / entry-finder / module-filter / lib-scoring
    │                                    # module-dependency-aware scorer (§6.2)
    ├── debun
    │   ├── phase1/lib-database.ts       # library database construction
    │   ├── phase1/extract-dups.ts       # birth-date code segmentation
    │   └── phase2/lib-scorer.ts         # uniform scorer (score_u)
    ├── evaluation
    │   ├── rq1-performance/             # run RQ1 → Table 1, Fig. 14
    │   │   ├── index.ts                 #   measures DEBUN, reads the baselines' measurements
    │   │   ├── results/                 #   per-site measurements for all six tools
    │   │   └── scripts/                 #   the harness that produced them (see its README)
    │   ├── rq2-ablation/                # run RQ2 → Tables 2-4, Fig. 15-16
    │   │   └── scorer-sweep-score_u.csv #   Fig. 16's score_u curve; regenerate with
    │   │                                #   OUT=<this file> src/cmd/rq1-old-sweep.ts
    │   ├── rq3-library-detection/       # run RQ3 → Table 5, Fig. 17-18
    │   │   ├── threshold-sweep.csv
    │   │   └── venn-libraries.csv
    │   ├── rq4-version-detection/       # run RQ4 → Table 6, Fig. 19
    │   │   └── venn-versions.csv
    │   ├── figures.ts                   # prints the numbers behind Fig. 14-19
    │   └── web-detect-eval.ts           # module-aware detector (score_m)
    ├── baselines                        # regenerate the D-Bundlr / Aletheia fixtures
    │   ├── build-baselines.sh
    │   └── upstream                     # the baselines' own scripts, vendored verbatim
    ├── cmd                              # database-build + baseline-comparison helpers
    ├── ground/ground-truth.csv          # manual ground truth (+ LDC / PTDetector columns)
    ├── example/{example.js, example.json}
    └── data                             # datasets (see “Data” below)
```

## Basic Usage

### Fingerprint collection

```bash
$ ./debun.sh fingerprint-collector src/example/example.js
```

`src/example/example.json` is the expected output.

### Detecting libraries in a live website

```bash
$ ./debun.sh detect https://example.com
```

**Note**: Some websites block crawling attempts.

## Data

A bare `git clone` prints every table but Table 7, and every column but Table 3's five
non-full POG models — no download. The ~45 MB those numbers are read or computed from is
committed here. Downloads only add what the tables are *re-derived* from.

| script | size | time | what it lets you rebuild |
| :----- | ---: | :--- | :----------------------- |
| `download-files.sh` | ~117 MB | minutes | the full hash databases: DEBUN's live timing (Table 1), `detect` on any URL, the ψ=84% detection |
| `ablation-files.sh` | ~300 MB | minutes | Table 3's five non-full POG models, recomputed from their own caches |
| `baseline-files.sh` | ~526 MB | ~10 min | the D-Bundlr / Aletheia fixtures, from those models and indices |
| `corpora-files.sh` | ~350 MB | minutes | the website fingerprints and the RQ2 bundle corpora, with `build-db.sh` |
| `cdn-files.sh` | ~29 GB | **an hour or more** | the cdn hash databases from raw library code — fetched from cdnjs, not Zenodo |
| `npm-files.sh` | ~54 GB | **hours** | the module-dependency-aware cache — fetched from the npm registry, not Zenodo |

`build-db.sh` reconstructs what those hand you pre-built: `debun-hashes/` (flat DB, for
`score_u`), `fingerprint-cache/` (module-dependency-aware, for `score_m`), `allWebHashes/`
(website fingerprints), `threshold-sweep/t84/` and `model-detect/` (detections at ψ=84%).
Steps whose output exists are skipped; `REBUILD=1` forces a rebuild.

Re-deriving a committed summary reproduces it byte for byte — the website fingerprints from the
sites' own scripts, the ψ=84% detection summary from those fingerprints, and the POG-ablation
summary from the `original` / `swc` / `terser` corpora. A difference is a real one. Table 1 is
the exception, since Setup is a live-network measurement.

Figures are reported as the numbers behind them — no plotting step and no image files. Fig. 14
is the exception, left as the per-site CSV that `run RQ1` names on its last line.

## Evaluation — Research Questions

```bash
$ ./debun.sh run RQ1     # Performance         → paper Table 1,   Fig. 14
$ ./debun.sh run RQ2     # Ablation study      → paper Tables 2-4, Fig. 15-16
$ ./debun.sh run RQ3     # Library detection   → paper Table 5,    Fig. 17-18
$ ./debun.sh run RQ4     # Version detection   → paper Table 6,    Fig. 19
```

Subcommand numbers match the paper, as do the directories under `src/evaluation/`.

### Performance (paper RQ1, Table 1)

Per-website cost on the **56 websites among the Tranco top 100 on which all six tools run**.
**Setup** makes a website analyzable — crawling its scripts for the static tools (DEBUN,
D-Bundlr, Aletheia), loading the page in a browser for the runtime tools (LDC, PTDetector, PTV).
**Detection** analyzes the prepared input. Single core, means over the 56 sites.

| Metric | \[runtime\] LDC | PTdetector | PTV | \[static\] D-Bundlr | Aletheia | DEBUN |
| :----- | ---: | ---: | ---: | ---: | ---: | ---: |
| Setup (s) | 1.86 | 1.73 | 1.72 | 16.68 | 16.68 | 16.68 |
| Detection (s) | 0.02 | 0.06 | 0.21 | 353.94 | 167.98 | **1.69** |
| Total (s) | 1.88 | 1.79 | 1.93 | 370.62 | 184.66 | **18.37** |

The three static tools share one crawl, so their Setup is a single measurement — and paid once,
whereas the runtime tools pay theirs on every run.

`run RQ1` reads the five baseline columns from
`src/evaluation/rq1-performance/results/` rather than re-running them — the full set is about
nine hours — but the harness that produced them ships, and its two halves cost very
differently to re-run:

| | needs | command |
| :-- | :---- | :------ |
| LDC, PTdetector, PTV | internet, nothing else — all three are vendored and PTDetector's pattern data self-fetches | `scripts/stage3c_runtime_tools.mjs` |
| D-Bundlr, Aletheia | `./baseline-files.sh` and `./baseline-repos.sh`, then two Python venvs and a compiled dolospy (`scripts/rebuild-env.sh`), and a running prediction server | `scripts/stage2_full.py` |

Both take `--stage1` (any `{rows:[{rank,site}]}` file, so cut it to a few sites) and
`stage2_full.py` is resumable. `src/evaluation/rq1-performance/README.md` gives the exact
invocations, the environment pins, and the site-set derivation (top 100 → 56).

DEBUN's column is read from the same stored measurement unless both of its inputs are local,
in which case `run RQ1` re-measures it and says so:

```bash
$ ./download-files.sh     # the fingerprint index
$ ./crawl-sites.sh        # the 56 websites' scripts (~15 min; not redistributable)
$ ./debun.sh run RQ1      # now measures DEBUN live
```

A live run will not reproduce the table. Setup is a network measurement, and these sites do
not serve today what they served on 2025-02-27 — the number of scripts differs, so Detection
moves with it. This is the one table in the paper that is not deterministic.

### Ablation Study (`run RQ2`; paper RQ2, Tables 2-4)

**Paper Table 2 — POG ablation** (consistency & accuracy at LOC ≥ 6). `POG+FBCI` is the full DEBUN
(branch flipping + bypassing + path cloning + function inlining).

| Metric        |     Count |     POG |   POG+F |  POG+FB | POG+FBC |   POG+FBCI |
| :------------ | --------: | ------: | ------: | ------: | ------: | ---------: |
| # Consistent  |    52,469 |  39,387 |  48,354 |  50,985 |  51,121 |     48,643 |
| # Functions   |    55,517 |  55,517 |  55,517 |  55,517 |  55,517 |     51,091 |
| Consistency   |    94.51% |  70.95% |  87.10% |  91.84% |  92.08% | **95.21%** |
| # Duplicated  | 1,812,355 | 279,897 | 278,871 | 278,911 | 278,917 |    201,245 |
| Accuracy      |     3.06% |  19.83% |  19.91% |  19.90% |  19.90% | **25.39%** |

**Paper Table 4 — Library-scorer ablation**: uniform score (`score_u`, best-F1 at ψ=15%) vs.
module-dependency-aware score (`score_m`, ψ=84%).

| (4a) Library detection | score_u | score_m |
| :--------------------- | :-----: | :-----: |
| TP                     | 202     | **203** |
| FP                     | 16      | **3**   |
| FN                     | 21      | **20**  |
| Precision              | 92.66%  | **98.54%** |
| Recall                 | 90.58%  | **91.03%** |
| F1-score               | 91.61%  | **94.64%** |

| (4b) Version detection | score_u    | score_m        |
| :--------------------- | :--------: | :------------: |
| Major                  | 94 (±1.01) | 94 (±1.02)     |
| Minor                  | 89 (±1.45) | **91 (±1.73)** |
| Patch                  | 84 (±2.18) | **88 (±3.25)** |

| (4c) Detected libraries | score_u | score_m | Ground |
| :---------------------- | ------: | ------: | -----: |
| React                   |      35 |      34 |     35 |
| core-js                 |      26 |      37 |     37 |
| Lodash.js               |      27 |      32 |     34 |
| jQuery                  |      30 |      30 |     30 |
| Preact                  |      10 |       5 |     10 |
| Zepto                   |      10 |      10 |     10 |
| **Total**               | **202** | **203** | **223** |

**Paper Table 3 — end-to-end detection across POG models** (`score_m`, ψ = 84%).

| Library detection | Count  | POG    | POG+F  | POG+FB | POG+FBC | POG+FBCI |
| :---------------- | :----: | :----: | :----: | :----: | :-----: | :------: |
| TP                | 203    | 170    | 205    | 206    | 206     | 203      |
| FP                | 11     | 5      | 8      | 8      | 8       | **3**    |
| FN                | 20     | 53     | 18     | 17     | 17      | 20       |
| Precision         | 94.86% | 97.14% | 96.24% | 96.26% | 96.26%  | **98.54%** |
| Recall            | 91.03% | 76.23% | 91.93% | 92.38% | 92.38%  | **91.03%** |
| F1-score          | 92.91% | 85.43% | 94.04% | 94.28% | 94.28%  | **94.64%** |

Version detection, correctly detected versions (out of 98) with the average candidate-range
size in parentheses:

| Level | Count       | POG        | POG+F      | POG+FB     | POG+FBC    | POG+FBCI     |
| :---- | :---------: | :--------: | :--------: | :--------: | :--------: | :----------: |
| Major | 91 (±1.06)  | 73 (±1.05) | 92 (±1.01) | 92 (±1.01) | 92 (±1.01) | **94 (±1.02)** |
| Minor | 89 (±1.77)  | 65 (±1.86) | 87 (±1.57) | 88 (±1.56) | 88 (±1.56) | **91 (±1.73)** |
| Patch | 82 (±3.55)  | 57 (±3.35) | 80 (±2.96) | 82 (±2.94) | 82 (±2.95) | **88 (±3.25)** |

Both of the Table 3 grids read one detection summary per model, all six committed: the full
model's at `src/data/threshold-sweep/t84/summary.csv`, the other five at
`src/data/model-detect/<model>/summary.csv`. Recomputing them instead of reading them needs each
model's own cache `src/data/fingerprint-cache[-<model>]`, from `./ablation-files.sh` (~300 MB) or
from the corpora — the latter is hours per model, most of it fingerprinting the npm corpus, so
restrict with `MODELS="pog cnt"`, or set `ABLATION=0` for the full model only.

Table 2 likewise reads the shipped summary `src/results/rq2-ablation/score.csv`;
`REBUILD=1 ./debun.sh run RQ2` regenerates it from the raw `original`/`swc`/`terser` corpora
in about a minute, and the result is byte-identical.

### Library Detection (`run RQ3`; paper RQ3, Table 5, ψ = 84%)

DEBUN vs. LDC, PTDetector, and D-Bundlr.

| Metric    | PTDetector |   LDC   | D-Bundlr\* |   DEBUN    |
| :-------- | :--------: | :-----: | :--------: | :--------: |
| TP        |     82     |   113   |    100     |  **203**   |
| FP        |     8      |    2    |    401     |   **3**    |
| FN        |    141     |   110   |     59     |   **20**   |
| Precision |   91.11%   | 98.26%  |   19.96%   | **98.54%** |
| Recall    |   36.77%   | 50.67%  |   62.89%   | **91.03%** |
| F1-score  |   52.40%   | 66.86%  |   30.30%   | **94.64%** |

\* **D-Bundlr is scored over a restricted library scope.** Being supervised, it can only emit a
library from its training set, so its column covers the 21 trained libraries present in the CDN
universe — **159 of the 223** ground-truth instances, where the other three columns use all 223.
The restriction raises recall and leaves precision unchanged:

| D-Bundlr scoring scope | TP | FP | FN | Precision | Recall | F1 |
| :--------------------- | -: | -: | -: | --------: | -----: | -: |
| 21 trained libs (table above) | 100 | 401 | 59 | 19.96% | 62.89% | 30.30% |
| full universe | 100 | 401 | 123 | 19.96% | 44.84% | 27.62% |
| 21 trained libs, monorepo submodules (`d3-*`, `@vue/*`, …) rolled up | 105 | 479 | 54 | 17.98% | 66.04% | 28.26% |

`run RQ3` prints the first row; `src/cmd/compare-detectors.ts` standalone prints the first two.

### Version Detection (`run RQ4`; paper RQ4, Table 6, ψ = 84%)

DEBUN vs. LDC and Aletheia. Correctly detected versions (out of 98) with the average
candidate-range size in parentheses.

| Level |     LDC     |  Aletheia   |    DEBUN     |
| :---- | :---------: | :---------: | :----------: |
| Major | 41 (±1.00)  | 88 (±1.03)  | **94 (±1.02)** |
| Minor | 41 (±1.61)  | 75 (±1.31)  | **91 (±1.73)** |
| Patch | 41 (±3.56)  | 67 (±2.74)  | **88 (±3.25)** |

**Paper Table 7 — DEBUN vs. PTV** (ICSE'26, runtime pTree-based). Fraction of pairs whose
reported candidate versions contain the ground-truth version, over a controlled single-library
corpus of cdnjs files (45 libraries / 2,113 library–version pairs), each loaded into a blank
page for PTV and fingerprinted statically for DEBUN.

| Level | PTV (3 s settle) | PTV (900 ms, parallel) | DEBUN |
| :---- | :--------------: | :--------------------: | :---: |
| Major | 73.9% (±1.06) | 64.6% | **86.7% (±1.08)** |
| Minor | 65.8% (±1.26) | 57.6% | **81.3% (±1.27)** |
| Patch | 63.8% (±2.23) | 55.8% | **76.5% (±2.13)** |

The 3 s-settle column is PTV's most favorable setting, the one compared in the paper, and what
the run below uses; `run-fullpop.sh` documents the parallel column's two knobs in its header.

**This is the one table with no `run RQ*` command** — it ships no summary, only the pipeline
that computes it, so every number above comes from a live run:

```bash
$ ./download-files.sh                                         # the databases DEBUN scores against
$ bash src/other-tool/ptv-repro/scripts/run-fullpop.sh        # ~3 h; Chrome + internet
$ LIBS="fabric.js" K=3 WORK=/tmp/ptv-smoke \
    bash src/other-tool/ptv-repro/scripts/run-fullpop.sh      # smoke test: all five stages, minutes
```

It injects its corpus into `src/data/allWebHashes` as `ptvc*` sites and removes them on
completion. `src/other-tool/ptv-repro/README.md` documents the pipeline, the corpus
intersection, and why DEBUN is scored with the real `score_m` scorer rather than the
`detect` CLI.

## Baselines & Reproducibility

| tool | in the RQ tables | re-runnable |
| :--- | :--------------- | :---------- |
| DEBUN | end-to-end from the raw corpora | `build-db.sh` + `run RQ*` |
| LDC, PTDetector | precomputed `ldc` / `ldc_version` / `ptdetector` columns of `src/ground/ground-truth.csv` | `node src/baselines/run_ldc_ptd.mjs <url>...` (runtime detectors: need a URL, not a file; `--versions` for LDC versions) |
| D-Bundlr, Aletheia | JSON fixtures in `src/data/other-tool/` | `./src/baselines/build-baselines.sh` |
| PTV | table above | `bash src/other-tool/ptv-repro/scripts/run-fullpop.sh` |

`src/baselines/build-baselines.sh` rebuilds the D-Bundlr and Aletheia fixtures from their original
models and indices; it needs the extra inputs from `./baseline-files.sh` plus the two upstream
checkouts, which `./baseline-repos.sh` clones at their pinned commits. Details, including the two
required Python environments, are in `src/baselines/README.md`.

> #### ⚠️ Pinned: `tree-sitter-javascript==0.23.1`
>
> **Do not bump this.** Aletheia's `dolospy` tokenizes into raw `ts_node_symbol()` numeric IDs,
> so the grammar version is baked into the prebuilt indices, and a mismatch destroys all k-gram
> overlap **silently** — with 0.25.0 the Aletheia version row collapses from 88 / 75 / 67 to
> 47 / 22 / 19 while every structural check still passes. `src/baselines/README.md` has the grammar
> comparison and the ABI-14 header requirement that follows from the pin.

Regeneration reproduces the shipped fixtures rather than replacing them; `src/baselines/README.md`
has the comparison, checked by `compare_dbundlr.py` and `compare_aletheia.py`.

> **D-Bundlr's FP count may differ by one on other hardware.** Its confidences feed a single
> `max(confidence) > 0.6` gate, and CPU-vs-CUDA drift reaches 3.9e-06 while the closest module
> (`clevelandclinic.org`, knockout, 0.599994838) clears the gate by only 5.2e-06 — a 1.3× margin.
> A flip moves FP 401 → 402 and leaves precision 19.96%. The DEBUN, LDC, and PTDetector columns
> are deterministic and must match exactly.

To run the baselines on a site outside the 192-bundle corpus, use
`src/baselines/newsite_probe.py` — the upstream Aletheia driver is oracle-guided
(`aletheia_eval.py:111` iterates the bundle's `groundTruth`), so it detects nothing without
ground truth; `newsite_probe.py` scans all 225 package indices instead. DEBUN needs nothing
extra: `./debun.sh detect <url>`.

## Notes

- `download-files.sh` also fetches `ground-truth-evidence/`: one Markdown note per evaluated
  website recording how each library instance in `src/ground/ground-truth.csv` was confirmed,
  so the manual labelling is auditable rather than asserted.
- All datasets were collected on **2025-02-27**. The evaluation set is **68** high-traffic
  websites (selected from the top 100); ground truth holds **223** verified library instances,
  98 with explicit version annotations, spread over 62 of the 68 sites.
- The CLI runs via `ts-node --transpile-only`; there is no separate build step.

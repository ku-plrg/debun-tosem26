# Paper Table 1 (RQ1 Performance) — measurement harness

```bash
$ ./debun.sh run RQ1        # prints Table 1
```

`run RQ1` measures DEBUN and reads the five baseline columns from `results/`. Re-measuring a
baseline means reproducing its own environment — a browser with three extensions for LDC /
PTdetector / PTV, a GraphCodeBERT server for D-Bundlr, a built dolospy for Aletheia — and
about nine hours, so those columns ship as the per-site numbers this harness recorded.

| directory | committed | contents |
| :-------- | :-------- | :------- |
| `scripts/` | yes | what produced the baseline columns |
| `results/` | yes | per-site measurements, ~124 KB |
| `work/` | no | raw logs, re-crawled scripts |
| `env/` | no | the two Python venvs, pinned grammar, built dolospy |

## What the paper asks for

> **Table 1.** Detection cost per website, measured on the 56 websites among the top 100
> on which all six tools run. **Setup** is the time to make one website analyzable, that is,
> crawling its scripts for the static tools and loading the page in a browser for the runtime
> tools. **Detection** is the time to analyze the prepared input.

## Site set: 100 → 56

| step | left | dropped because |
| :--- | ---: | :--- |
| Tranco top 100 (`tranco20260104.csv`) | 100 | — |
| crawl yielded any script | 90 | DNS failure / 403 / navigation timeout |
| has ≥1 **external** script | 58 | 32 sites served only an inline script |
| all three runtime tools returned | **56** | `samsung.com` (LDC + PTdetector no output), `nginx.com` (PTV timeout) |

The 32-site drop is the one that needs justifying. Tranco's top ranks are mostly CDN and
infrastructure domains (`akamaiedge.net`, `akadns.net`, `gvt1.com`, `ytimg.com`,
`cloudfront.net`, `windowsupdate.com`, `microsoftonline.com`, `t-msedge.net`, ...). Opening
one in a browser gives an access-denied page, not a service, and the crawl captures only that
page's inline script — **byte-identical across all 32** (`browser-script-0.js`, md5
`82b799a79330318c197b648f843f7e88`, 149 KB). Keeping them would measure the same file 32
times and let it occupy a third of the sample, and by the paper's own "make one website
analyzable" wording the static tools have no input there.

Cost of the criterion: it also drops `wikipedia.org` (a 1.6 KB portal redirect, almost no
script) and `adobe.com` (crawl blocked). Both are real sites. The rule is consistent but the
loss is not zero.

## Harness

| Table 1 row | script | notes |
| :---------- | :----- | :---- |
| Setup, static 3 | `scripts/crawl_sites.ts` → `crawl_one.ts` | one child process per site, so one bad site cannot end the run |
| Setup, runtime 3 | `scripts/stage3c_runtime_tools.mjs` (`pageLoadMs`) | fresh browser per measurement, tool order shuffled with a fixed seed |
| Detection, DEBUN | `src/evaluation/web-detect-bench.ts`, driven by `run RQ1` | `hashTotalMs` + `detectTotalMs` |
| Detection, runtime 3 | `scripts/stage3c_runtime_tools.mjs` (`computeMs`) | common 5 s settle before triggering |
| Detection, D-Bundlr + Aletheia | `scripts/stage2_full.py` | 1 core, **every** module really executed |

An earlier pilot predicted D-Bundlr from a size→latency curve and corrected it with a
120-module sample per site; on two sites that was out by 46% and 123%, so `stage2_full.py`
runs every one of the 304,663 modules instead.

Fairness defects found and fixed while building this (each one changed the numbers):

1. Stripping LDC's internal 2 s wait measured an unready window (youtube LDC 8 ms, n=0).
   Fixed with a common 5 s settle → 107 ms, PTdetector n=0 → n=2.
2. PTdetector's pattern fetch was CSP-blocked on 12/20 sites. Fixed by inlining the data as
   `window.__PTD_DATA__` (grants no privilege) → 17/20; common set 4 → 12.
3. Running all tools in one browser gave later tools a warm cache (microsoft.com
   3420 → 338 → 300 ms same browser vs 3495 / 4507 ms fresh). Fixed with a fresh browser per
   measurement plus a seeded shuffle.
4. Per-module inference is **not** constant (60.6 → 163.8 ms, max 844 ms); a single global
   mean was off by −50.9% on instagram. That is why `stage2_full.py` measures every module.

## Re-running the harness

The three runtime tools need nothing but internet — `ldc.js`, `PTdetector.js` and the PTV
extension are vendored under `src/baselines/upstream/` and `src/other-tool/ptv/`, and
PTDetector's pattern data is fetched and cached on first use. `--stage1` takes any
`{rows:[{rank,site}]}` file, so cut it down to a few sites to try it:

```bash
node src/evaluation/rq1-performance/scripts/stage3c_runtime_tools.mjs \
  --stage1 src/evaluation/rq1-performance/results/stage1_100.json \
  --out src/evaluation/rq1-performance/work/stage3c.json
```

The two static tools need more: `./baseline-files.sh` for the model and the indices, both
upstream checkouts, and the two Python environments. Neither repository is licensed, so this
artifact does not carry them — `./baseline-repos.sh` clones both at the commits these numbers
were measured with (D-Bundlr `c28a5d6`, Aletheia `9c70e05`) into
`src/baselines/upstream-repos/`. Then `scripts/rebuild-env.sh` builds `env/` — both venvs, the
pinned grammar, the compiled dolospy:

```bash
./baseline-repos.sh
bash src/evaluation/rq1-performance/scripts/rebuild-env.sh
```

Set `DOLOSPY_SRC` only if you keep your own Aletheia checkout somewhere else.

Set `PY=` if `/opt/homebrew/bin/python3.12` is not your interpreter; the pin exists because
3.14 has no `tokenizers` wheel and the source build dies in PyO3. `tree-sitter-javascript` is
pinned to **0.23.1** — dolospy tokenizes with raw `ts_node_symbol()` ids, so the grammar
version is baked into the prebuilt Aletheia indices, and any other version silently produces
near-zero overlap. `src/baselines/README.md` has the evidence for that pin.

Then the D-Bundlr server, single-threaded so its column is comparable:

```bash
DBUNDLR_DEVICE=cpu MODEL_DIR=src/data/baselines/debun-model \
CODEPREDICT=src/baselines/upstream-repos/D-Bundlr/codepredict OMP_NUM_THREADS=1 \
  src/evaluation/rq1-performance/env/venv-server/bin/gunicorn -w 1 -b 127.0.0.1:3446 \
  --timeout 900 --log-level warning --chdir src/baselines serve:app
```

and, against it, the measurement — `--sites` restricts it, and it is resumable:

```bash
INDEX_DIR=src/data/baselines/aletheia-debun-index \
PYTHONPATH=src/evaluation/rq1-performance/env/dolospy-build \
  src/evaluation/rq1-performance/env/venv-client/bin/python \
  src/evaluation/rq1-performance/scripts/stage2_full.py \
  --stage1 src/evaluation/rq1-performance/results/stage1_100.json \
  --out src/evaluation/rq1-performance/work/stage2.json
```

## Results

Means over the 56 sites unless noted.

| Metric | LDC | PTdetector | PTV | D-Bundlr | Aletheia | Debun |
| :----- | --: | --: | --: | --: | --: | --: |
| Setup (s) | 1.86 † | 1.73 | 1.72 | 16.68 † | 16.68 † | 16.68 † |
| Detection (s) | 0.02 | 0.06 | 0.21 | 353.94 | 167.98 | **1.69** |
| Total (s) | 1.88 | 1.79 | 1.93 | 370.62 | 184.66 | **18.37** |

Complete — every cell is a measurement over all 56 sites (`run RQ1` flags any column that
is not). Aletheia additionally deserializes its 225 indices in 8.1 s, once per process, which
is setup and outside the Detection cell.

Debun's cell comes from `src/evaluation/web-detect-bench.ts`, the code path behind the paper's
own figure. An earlier harness that called `lib-scorer.evaluate` instead of the
module-dependency-aware filter reported hash 921.8 + scorer 204.6 ms on the *same* 56 sites,
which is a different code path and not the number the paper reports.

Debun detail, means over the 56 sites:

| | total | hash | detect | peak RSS mean / max | peak heap mean | live index |
| :-- | --: | --: | --: | --: | --: | --: |
| current | **1688.8 ms** | 1366.4 | 322.4 | 1221 / 2203 MB | 618 MB | **684 MB** |
| before the memory fix | 1828.9 ms | 1405.6 | 423.3 | 3090 / 3379 MB | 2278 MB | — |

The memory fix (see *Index memory* below) is why both columns moved: detection got 24% faster
because the heap it works against shrank by 73%. Detection output is identical on all 56 sites
across both. Reproduce with:

```
SITE_FILTER=<68 GT urls> FP_CACHE_DIR=src/data/fingerprint-cache \
MATCH_THRESHOLD=84 BENCH_OUTPUT=src/evaluation/rq1-performance/work/bench-rerun.csv BENCH_FORCE_GC=1 \
NODE_OPTIONS='--max-old-space-size=12288 --expose-gc' \
  npx ts-node --transpile-only src/evaluation/web-detect-bench.ts

SITE_SRC_DIR=src/src/data/crawled SITE_FILTER=<56 common urls> ... \
  BENCH_OUTPUT=src/evaluation/rq1-performance/work/bench-56.csv ...
```

Medians: Setup 1.22 / 1.24 / 1.22 / 8.54 / 8.54 / 8.54 s; Detection 16.0 / 34.0 / 158.5 ms
and 251.1 / 125.8 / 1.54 s. Debun's body figure is **1.7 s**.

† The 14 top-20 pilot sites had no recorded crawl time (lost with the scratchpad), so they were
re-crawled by `crawl_timing.ts` into `work/crawl-timing/`, leaving the analysis corpus alone.
Two caveats on this column:

- **Two crawls are excluded**: `cloudflare.com` and `workers.dev` each spent ~94 s and returned
  zero files, so their duration measures the failure, not the cost. `run RQ1` drops any crawl
  with no file and prints which ones it dropped.

  Both were a crawler crash, not the sites: a WriteStream error was handled by an
  `unlinkSync` that itself threw ENOTDIR inside the event handler, which no caller could
  catch. That is fixed in `src/cmd/crawler.ts`, and `cloudflare.com` now completes with 91
  files in 208 s. This column is still the measurement taken before the fix, so re-measuring
  Setup would recover both sites and raise the static mean — neither it nor Table 1 has been
  re-run.
- **The re-crawled content is not the content that was analyzed.** google.com returned 8 files
  where the measured corpus holds 18; twitter.com returned 427. Setup is therefore a
  representative crawl cost for the same site, not the crawl that produced the Detection input.
  That matches the paper's definition ("time to make one website analyzable") and the 42 sites
  whose times were already recorded are no different. Making it strictly consistent would mean
  re-crawling all 56 and re-running the 8 h measurement on the new corpus — not worth it when
  Setup is 16.7 s against D-Bundlr's 354 s of detection.

D-Bundlr scale, from `results/modcount.json`: 304,663 modules over the 56 sites (mean 5,440/site;
`youtube.com` and `youtu.be` share a corpus at 28,196 each). Extraction of all of them takes
38 s; inference is ~60 ms/module regardless of size, because GraphCodeBERT pads to a fixed
320 tokens. The full run took **8.12 h** (projection was 7.6 h).

`stage2_full.py` is resumable — sites already in `--out` are skipped — so an interrupted run
does not lose measured sites.

## Outputs in `results/`

| file | contents |
| :--- | :--- |
| `crawl100.json` | per-site crawl time, top 100 (14 of the 56 absent, filled by `crawl_timing.json`) |
| `crawl_timing.json` | Setup re-measurement of those 14, crawled into `work/crawl-timing/` |
| `bench-56.csv` / `bench-rerun.csv` | `web-detect-bench.ts` over the 56-site subset / the 68 evaluation sites |
| `stage1_100.json` | DEBUN fingerprint + score per site, 90 sites with scripts |
| `candidates.json` | the 58 sites with ≥1 external script |
| `common_set.json` | **the 56** |
| `stage3c_100.json` | LDC / PTdetector / PTV load + compute over the 58 |
| `modcount.json` | D-Bundlr module counts and extraction time per site |
| `stage2_full.json` | D-Bundlr + Aletheia full measurement, all 56 sites |

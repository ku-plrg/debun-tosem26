# Regenerating the D-Bundlr and Aletheia baselines

The two external baselines in RQ2/RQ3 ship as JSON fixtures under
`src/data/other-tool/`. This directory regenerates them from the original models
and indices, so they are auditable rather than opaque.

```
./src/baselines/build-baselines.sh
```

Prerequisites, both of which default to where their fetch script puts them — set the
variable only to point somewhere else:

| what | fetched by | override |
| :--- | :--------- | :------- |
| the two upstream checkouts | `./baseline-repos.sh` | `DBUNDLR_REPO`, `DOLOSPY_SRC` |
| the model, indices and dataset | `./baseline-files.sh` | `BASELINE_DATA` |

## The two checkouts

Both are public and both are **unlicensed**, so they are cloned rather than redistributed
with this artifact:

```bash
./baseline-repos.sh      # -> src/baselines/upstream-repos/
```

That pins them to the commits every number here was produced with — D-Bundlr `c28a5d6`
(github.com/Anemone95/D-Bundlr), Aletheia `9c70e05`
(github.com/BlobbyBob/AletheiaJSVersionDetection) — because neither tool versions its model
or index format, so a later commit can break the checkpoint load or shift dolospy's
fingerprints with nothing raised. `DBUNDLR_REPO` and `DOLOSPY_SRC` still override, for your
own checkouts.

Only `D-Bundlr/codepredict/` and `AletheiaJSVersionDetection/dolospy/` are used. The
Aletheia clone is 1.2 MB — the authors' `datasets/` tree (a 1.2 GB `.bson` crawl and an
object-storage sample, distributed separately at doi.org/10.60507/FK2/F4VQRH) feeds
nothing here.

D-Bundlr's server pulls `microsoft/graphcodebert-base` from HuggingFace at startup for its
config and tokenizer — only the fine-tuned weights are ours — so the first run needs
network access. `BASELINE_DATA/debun-model` supplies `labelMap.pkl` and
`checkpoint-best-f1/model.bin` on top of it. Aletheia needs no model at all: it scores
against the prebuilt indices, which is why the grammar pin below is load-bearing.

## ⚠️ `tree-sitter-javascript` is pinned to 0.23.1

`dolospy` tokenizes into raw `ts_node_symbol()` numeric IDs, so the grammar version
is baked into every fingerprint of the prebuilt Aletheia indices. Fingerprints are
27-token k-grams, so any shift in symbol numbering destroys all overlap — and it
does so **silently**, with every structural check still passing:

| grammar | `leftTotal` | `covered` (moment 2.15.0) | scores matching the fixture |
| :------ | ----------: | ------------------------: | --------------------------: |
| 0.25.0 | 9214 | 2 | 0/76 |
| 0.23.0 | 9274 | 1 | 0/76 |
| **0.23.1** | **9225** | **428** | **76/76** |

`find_grammar.sh` + `probe_grammar.py` are the search that established this; keep
them for when the indices are ever rebuilt.

## Layout

| file | role |
| :--- | :--- |
| `build-baselines.sh` | end-to-end: environments → grammar → dolospy → both tools |
| `upstream/` | the authors' scripts, **vendored verbatim** — see `upstream/README.md` |
| `run_dbundlr.py` | D-Bundlr driver: fixes upstream's 4 blocking bugs, adds resume + concurrency |
| `run_aletheia.py` | Aletheia driver: fixes the path placeholder, memoizes index loads |
| `serve.py` | gunicorn entrypoint wrapping `codepredict/predictServer.py` without editing it |
| `compare_dbundlr.py` / `compare_aletheia.py` | three-tier fixture comparison (structural → per-item → RQ table) |
| `extract_only.py` | module extraction alone, no model — fastest check that the env is right |
| `sample_modules.py` + `calibrate.py` | per-call latency and CPU-vs-MPS agreement |
| `newsite_probe.py` | run both tools on an arbitrary JS file (outside the 192-bundle corpus) |

## Two Python environments

The tools sit on opposite sides of the tree-sitter 0.22 API break and cannot share
an interpreter. They communicate over HTTP, so the split costs nothing.

| env | tree-sitter | why |
| :-- | :---------- | :-- |
| server | `0.21.3` | `codepredict/utils.py` calls `Language(path, name)`, removed in 0.22 |
| client | `0.26` | `dbundlr_eval.py` calls `Language(ptr)`, added in 0.22 |

## Expected results

| | runtime (M4 Max) | agreement with the fixture |
| :--- | :--- | :--- |
| Aletheia | 19 s | bit-identical; RQ3 98 / 88 / 75 / 67 |
| D-Bundlr | 25.9 min (55,856 model calls) | 55,855/55,856 identical top-3, 0 gate crossings; RQ2 TP 100 / FP 401 / FN 59 |

D-Bundlr is not bit-identical because the published fixture was produced on the
authors' CUDA machine and this run used an Apple Silicon CPU — same weights, same
inputs, different floating-point accumulation order. 55.7% of the 167,565 confidence
values match exactly; the rest drift by at most 3.9e-06. The one module with a
different top-3 order (nytimes.com) is a 0.50696 tie for *third* place, which the
scorer never reads.

> **Expect possible ±1 differences in D-Bundlr's TP/FP/FN on other hardware.**
> The confidences feed exactly one decision, `max(confidence) > 0.6`. No module
> crossed that gate here, but the margin is thin: **91 modules sit within 1e-4 of
> 0.6**, and the closest — `clevelandclinic.org`, knockout, 0.599994838 — clears it
> by 5.2e-06 against a 3.9e-06 worst-case drift, a factor of 1.3. If it flips
> elsewhere, FP goes 401 → 402 and precision stays 19.96% to two decimals.
> The DEBUN, LDC, and PTDetector columns are deterministic and must match exactly.

To see the margin for yourself, `compare_dbundlr.py` prints the per-value delta
distribution and the closest approach to the gate.

## LDC and PTDetector

Both are vendored under `upstream/{ldc,PTdetector}.js` (verbatim from
`debun-playground/misc/evaluation/scripts/`) and driven by `run_ldc_ptd.mjs`:

```
node baselines/run_ldc_ptd.mjs example.com another.com -o results.json
node baselines/run_ldc_ptd.mjs --urls-file sites.txt --tools ldc --versions
```

Unlike DEBUN / D-Bundlr / Aletheia these are **runtime** detectors — they inspect
`window` in a live page, so they need a URL and cannot be pointed at a saved `.js`
file. The driver loads the page with puppeteer, injects the detector, and captures
the single JSON array each one `console.log`s.

Options that matter:

| flag | effect |
| :--- | :----- |
| `--versions` | LDC only. The vendored script ends with `libs.map(lib => lib.name)`, discarding versions; this rewrites that one expression in the injected source so `{name, version}` objects come back. The file on disk stays verbatim. |
| `--wait-until` | `networkidle2` (default) never settles on ad-heavy sites — use `domcontentloaded` there. |
| `--settle` | how long to wait for the detector's output line after injection. |
| `--bypass-csp` | Puppeteer's `page.setBypassCSP`. Off by default, matching the original harness. |
| `--ptd-cache` | where PTDetector's pattern data is cached. |

### PTDetector fetches its pattern data at run time

`PTdetector.js` fetches `blacklist.json`, `pts.json` and `DetectFile.json` from
`refs/heads/main` of its GitHub repo *while the page is open*, so results drift
whenever that branch changes. The driver caches the three files on first run and
serves them from disk afterwards, which keeps runs stable and lets them work
offline. Delete `.ptd-cache` to refresh.

If a site's CSP restricts `connect-src`, that fetch is refused and the detector
returns nothing — so an empty PTDetector result can mean either "no libraries" or
"could not load its data". If you need to tell the two apart while debugging, run
with `--bypass-csp`.

# Upstream evaluation scripts (vendored verbatim)

These are the authors' original D-Bundlr / Aletheia evaluation scripts, copied here
**unmodified** so the extraction and scoring logic is auditable against what produced
the shipped fixtures. Do not edit them.

The drivers one directory up (`../run_dbundlr.py`, `../run_aletheia.py`) import from
these modules and reimplement only `main()`, because the upstream `main()` cannot run
as shipped:

| file | line | problem |
| :--- | ---: | :------ |
| `dbundlr_eval.py` | 459 | `args.mode` — never added to the argparse parser (`AttributeError`) |
| `dbundlr_eval.py` | 463 | `os.listdir("path", "to", "...")` — `listdir` takes 1 argument (`TypeError`) |
| `dbundlr_eval.py` | 462 | `DATASET_PATH` is a `path/to/...` placeholder |
| `dbundlr_eval.py` | 468 | branches on `HOSTNAME == "ruidoso"`, the authors' debug machine |
| `aletheia_eval.py` | 100 | `DATASET_PATH` is a `path/to/...` placeholder |
| `aletheia_eval.py` | 129 | reloads the package index for every (bundle, gt-package) pair |
| `dbundlr_preprocessing.py` | 66 | `PATH_TO_DBUNDLR_REPO` placeholder (only needed to rebuild the training corpora) |
| `debun_process_dataset.py` | 282 | `path/to/data-never-remove` placeholder (builds `dataset.json`) |

`ldc.js` and `PTdetector.js` come from `debun-playground/misc/evaluation/scripts/`
and are injected into a live page by `../run_ldc_ptd.mjs`. Two things about them are
easy to miss:

- `ldc.js` ends with `libs.map(lib => lib.name)`, discarding the versions its tests
  already computed. `run_ldc_ptd.mjs --versions` rewrites that one expression in the
  injected copy; the file here stays verbatim.
- `PTdetector.js:293-295` fetches its pattern data from `refs/heads/main` on GitHub
  at run time, which makes it a moving target. `../run_ldc_ptd.mjs` caches those files
  so runs stay stable.

Everything that affects results — `extract_modules`, `PKG_MAPPING`, the scoring
formulas — is imported from here rather than reimplemented.

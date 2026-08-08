#!/usr/bin/env python3
"""RQ1 — D-Bundlr and Aletheia detection cost, every module really executed, 1 core.

Supersedes stage2_dbundlr_aletheia.py, which predicted D-Bundlr's inference from a
size->latency curve and corrected it with a 120-module sample per site. That was a
compromise made for a 20-site pilot; for the paper's Table 1 every module is run, so
the D-Bundlr column is a measurement rather than an extrapolation.

Both tools are single-threaded so their columns are comparable with each other and
with DEBUN: start the prediction server with -w 1 and OMP_NUM_THREADS=1; dolospy is
single-threaded by construction.

Detection is split from setup the way the paper defines it:
  setup     Aletheia deserialises 225 package indices; D-Bundlr loads the model
            (paid once by the server, reported separately)
  detection D-Bundlr = module extraction + inference over every module
            Aletheia = matchExternal of every crawled file against every index

Resumable: sites already present in --out are skipped, so a long run can be stopped
and restarted without losing measured sites.
"""
import argparse
import glob
import json
import os
import statistics as st
import sys
import time

import requests

UPSTREAM = os.environ.get(
    "UPSTREAM_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "baselines/upstream"),
)
# Default to where ./baseline-files.sh puts the indices, so the common case needs no env var,
# and say what is missing rather than raising KeyError on the environment lookup.
INDEX_DIR = os.environ.get(
    "INDEX_DIR",
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))),
        "src/data/baselines/aletheia-debun-index",
    ),
)
if not os.path.isdir(INDEX_DIR):
    sys.exit(
        f"Aletheia package indices not found at {INDEX_DIR}.\n"
        "Run ./baseline-files.sh, or set INDEX_DIR to the aletheia-debun-index directory."
    )
sys.path.insert(0, UPSTREAM)
try:
    import dbundlr_eval  # noqa: E402
except ModuleNotFoundError as e:
    sys.exit(
        f"D-Bundlr's evaluation script needs {e.name}, which lives in the client venv rather "
        "than the system interpreter.\nBuild it with:  ./baseline-repos.sh && \\\n"
        "                  bash src/evaluation/rq1-performance/scripts/rebuild-env.sh\n"
        "then run this script with that env's venv-client/bin/python. "
        "See src/evaluation/rq1-performance/README.md."
    )

ap = argparse.ArgumentParser()
ap.add_argument("--stage1", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--sites", help="optional JSON list of site names to restrict to")
ap.add_argument("--server", default="http://127.0.0.1:3446/predict")
args = ap.parse_args()

# work/ is not in the repository, so --out into it fails on a fresh checkout unless created.
os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

# The site's crawled scripts. The original run passed them in as a "filePaths" field, but no
# stage1 file in results/ carries one — crawl_sites.ts keeps only the count — so requiring it
# meant this script silently measured zero sites for anyone but its author. Read the corpus
# ./crawl-sites.sh produces instead, and still honour filePaths when a caller supplies it.
CRAWL_DIR = os.environ.get(
    "SITE_SRC_DIR",
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))),
        "src/data/crawled",
    ),
)


def site_files(row):
    if row.get("filePaths"):
        return list(row["filePaths"])
    found = []
    for base, _dirs, names in os.walk(os.path.join(CRAWL_DIR, row["site"])):
        found += [os.path.join(base, n) for n in names]
    return found


rows_in = []
for _r in json.load(open(args.stage1))["rows"]:
    _r = dict(_r, filePaths=site_files(_r))
    if _r["filePaths"]:
        rows_in.append(_r)
if not rows_in:
    sys.exit(
        f"No crawled scripts found under {CRAWL_DIR} for any site in {args.stage1}.\n"
        "Run ./crawl-sites.sh first, or set SITE_SRC_DIR to a crawl root."
    )
if args.sites:
    keep = set(json.load(open(args.sites)))
    rows_in = [r for r in rows_in if r["site"] in keep]
print(f"sites to measure: {len(rows_in)}", flush=True)

done = {}
ale_setup_ms = None
if os.path.exists(args.out):
    prev = json.load(open(args.out))
    done = {r["site"]: r for r in prev["rows"]}
    ale_setup_ms = prev.get("aletheiaSetupMs")
    print(f"resuming: {len(done)} sites already measured", flush=True)

try:
    import dolospy  # noqa: E402
except ModuleNotFoundError:
    sys.exit(
        "dolospy is not importable — Aletheia's tokenizer is a compiled extension, not a wheel.\n"
        "Build it with:  ./baseline-repos.sh && \\\n"
        "                  bash src/evaluation/rq1-performance/scripts/rebuild-env.sh\n"
        "then run this script with PYTHONPATH=src/evaluation/rq1-performance/env/dolospy-build\n"
        "and that env's venv-client/bin/python. See src/evaluation/rq1-performance/README.md."
    )
files = sorted(glob.glob(os.path.join(INDEX_DIR, "*.index.json")))
t0 = time.time()
ale_indices = []
for p in files:
    with open(p) as f:
        ale_indices.append(dolospy.Index.deserialize(f.read()))
measured_setup = (time.time() - t0) * 1000
ale_setup_ms = ale_setup_ms or measured_setup
print(f"[aletheia] setup {len(ale_indices)} indices in {measured_setup/1000:.1f}s (one-time)", flush=True)

session = requests.Session()
t0 = time.time()
session.post(args.server, json={"code": "function f(){}"}, timeout=600)
print(f"[dbundlr] server warm in {(time.time()-t0)*1000:.0f}ms", flush=True)

out = list(done.values())
for i, r in enumerate(rows_in):
    site = r["site"]
    if site in done:
        print(f"[{i+1}/{len(rows_in)}] {site:22} (cached)", flush=True)
        continue
    row = {"rank": r["rank"], "site": site, "bytes": r.get("bytes")}
    sources = []
    for fp in r["filePaths"]:
        try:
            sources.append(open(fp, encoding="utf-8", errors="replace").read())
        except OSError:
            pass

    t0 = time.time()
    mods = []
    for src in sources:
        try:
            mods.extend(fn for fn, _ in (dbundlr_eval.extract_modules(src.encode()) or []))
        except Exception:
            pass
    row["dbundlrExtractMs"] = round((time.time() - t0) * 1000)
    row["dbundlrModules"] = len(mods)
    if mods:
        sizes = [len(m) for m in mods]
        row["moduleSizeMedian"] = st.median(sizes)
        row["moduleSizeP90"] = sorted(sizes)[int(len(sizes) * 0.9)]

    t0 = time.time()
    for m in mods:
        session.post(args.server, json={"code": m}, timeout=600)
    row["dbundlrInferMs"] = round((time.time() - t0) * 1000)
    row["dbundlrMs"] = row["dbundlrExtractMs"] + row["dbundlrInferMs"]

    t0 = time.time()
    for src in sources:
        for index in ale_indices:
            index.matchExternal(src)
    row["aletheiaMs"] = round((time.time() - t0) * 1000)

    out.append(row)
    print(f"[{i+1}/{len(rows_in)}] {site:22} mods={row['dbundlrModules']:6} "
          f"ext={row['dbundlrExtractMs']:6}ms infer={row['dbundlrInferMs']:9}ms "
          f"aletheia={row['aletheiaMs']:7}ms", flush=True)
    out.sort(key=lambda x: x["rank"])
    json.dump({"aletheiaSetupMs": ale_setup_ms, "mode": "full", "rows": out},
              open(args.out, "w"), indent=1)

print(f"\nwrote {args.out}", flush=True)

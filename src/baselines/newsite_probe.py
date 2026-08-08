#!/usr/bin/env python3
"""Can D-Bundlr and Aletheia run on an ARBITRARY new site (no ground truth)?

Both shipped evaluation drivers assume the 192-bundle dataset. This probes what
changes for an unseen bundle:

  D-Bundlr  - nothing. extract_modules + /predict are ground-truth-free.
  Aletheia  - the upstream driver is oracle-guided (it only scores packages listed
              in the bundle's groundTruth), so with no GT it emits nothing. To use
              it as a real detector every package index must be scanned.
"""
import argparse
import glob
import os
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = os.environ.get("UPSTREAM_DIR", os.path.join(HERE, "upstream"))
INDEX_DIR = os.environ["INDEX_DIR"]
sys.path.insert(0, UPSTREAM)

ap = argparse.ArgumentParser()
ap.add_argument("jsfile")
ap.add_argument("--server", default="http://127.0.0.1:3446/predict")
ap.add_argument("--min-conf", type=float, default=0.6)
ap.add_argument("--tool", default="both", choices=["dbundlr", "aletheia", "both"])
ap.add_argument("--max-indices", type=int, default=0, help="0 = all")
args = ap.parse_args()

source = open(args.jsfile, encoding="utf-8", errors="replace").read()
print(f"input: {args.jsfile}  ({len(source)} bytes)\n")

if args.tool in ("dbundlr", "both"):
    import dbundlr_eval
    t0 = time.time()
    functions = dbundlr_eval.extract_modules(source.encode()) or []
    t_ext = time.time() - t0
    cov = 100 * sum(len(f) for f, _ in functions) / len(source) if source else 0
    print(f"[D-Bundlr] {len(functions)} modules, {cov:.1f}% coverage, {t_ext:.1f}s extract")
    t0 = time.time()
    hits = {}
    for fn, _ in functions:
        r = requests.post(args.server, json={"code": fn}, timeout=600).json()
        if not r:
            continue
        mc = max(e["confidence"] for e in r)
        if mc <= args.min_conf:
            continue
        for e in r:
            if e["confidence"] == mc:
                pkg = e["function"]["packageName"]
                hits[pkg] = max(hits.get(pkg, 0), mc)
    print(f"[D-Bundlr] {time.time()-t0:.1f}s inference")
    print(f"[D-Bundlr] detected (conf > {args.min_conf}):")
    for p, c in sorted(hits.items(), key=lambda x: -x[1]):
        print(f"    {p:28} {c:.4f}")
    print()

if args.tool in ("aletheia", "both"):
    import dolospy
    files = sorted(glob.glob(os.path.join(INDEX_DIR, "*.index.json")))
    if args.max_indices:
        files = files[: args.max_indices]
    print(f"[Aletheia] scanning {len(files)} package indices (no ground truth to narrow by)")
    t0 = time.time()
    best = []
    for i, path in enumerate(files):
        pkg = os.path.basename(path)[: -len(".index.json")].replace("+", "/")
        with open(path) as f:
            index = dolospy.Index.deserialize(f.read())
        for p in index.matchExternal(source):
            if p.leftTotal:
                best.append((p.covered / p.leftTotal, pkg, p.right, p.covered))
    el = time.time() - t0
    best.sort(reverse=True)
    print(f"[Aletheia] {el:.1f}s for {len(files)} indices "
          f"({el/max(len(files),1)*1000:.0f} ms each)")
    print("[Aletheia] top matches (score = covered/leftTotal):")
    for s, pkg, ver, cov in best[:10]:
        print(f"    {pkg:24} {ver:12} {s:.5f}  (covered={cov})")

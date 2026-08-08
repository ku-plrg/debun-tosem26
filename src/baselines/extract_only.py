#!/usr/bin/env python3
"""Phase 1 step 1: run ONLY D-Bundlr's module-extraction stage (no model).

Imports `extract_modules` from the untouched upstream dbundlr_eval.py and
replays it over dataset.json, to answer two questions before we spend any
GPU/CPU time on inference:

  1. Does this environment reproduce the fixture's 55,856 modules / 87.3% coverage?
  2. How many of those modules are textually UNIQUE? (= the real inference cost
     if we memoize predictions by module hash)
"""
import hashlib
import json
import os
import sys
import time
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = os.environ.get("UPSTREAM_DIR", os.path.join(HERE, "upstream"))
DATA = os.environ.get("BASELINE_DATA", os.path.join(HERE, "..", "src", "data", "baselines"))
ARTIFACT = os.environ.get("ARTIFACT_ROOT", os.path.join(HERE, ".."))
OUT = HERE

sys.path.insert(0, UPSTREAM)
import dbundlr_eval  # noqa: E402  (module-level code is import-safe; main() is guarded)

extract_modules = dbundlr_eval.extract_modules

with open(os.path.join(DATA, "dataset.json")) as f:
    data = json.load(f)
print(f"dataset.json: {len(data)} bundles", flush=True)

fixture = json.load(
    open(os.path.join(ARTIFACT, "src", "data", "other-tool", "dbundlr_results_debun.json"))
)["result"]
fx_by_url = {tuple(r["urls"]): r for r in fixture}

rows = []
uniq = Counter()
methods = Counter()
t0 = time.time()
for i, b in enumerate(data):
    src = b["source"].encode()
    try:
        funcs = extract_modules(src)
    except Exception as e:  # keep going; record the failure
        rows.append({"urls": b["urls"], "error": f"{type(e).__name__}: {e}"})
        print(f"[{i+1}/{len(data)}] EXTRACT FAILED {b['urls'][0]}: {e}", flush=True)
        continue
    funcs = funcs or []
    cov = 100 * sum(len(f) for f, _ in funcs) / len(b["source"]) if b["source"] else 0
    for fn, method in funcs:
        uniq[hashlib.sha256(fn.encode()).hexdigest()] += 1
        methods[str(method)] += 1
    fx = fx_by_url.get(tuple(b["urls"]))
    rows.append({
        "urls": b["urls"],
        "numberOfModules": len(funcs),
        "coverage": cov,
        "fixtureModules": fx.get("numberOfModules") if fx else None,
        "fixtureCoverage": fx.get("coverage") if fx else None,
    })
    if (i + 1) % 20 == 0:
        print(f"[{i+1}/{len(data)}] {time.time()-t0:.0f}s elapsed", flush=True)

total = sum(r.get("numberOfModules", 0) for r in rows)
fx_total = sum(r.get("fixtureModules") or 0 for r in rows)
matched = [r for r in rows if r.get("fixtureModules") is not None]
exact = [r for r in matched if r["numberOfModules"] == r["fixtureModules"]]

print("\n" + "=" * 66)
print(f"elapsed              : {time.time()-t0:.0f}s")
print(f"modules extracted    : {total}")
print(f"modules in fixture   : {fx_total}  (target 55856)")
print(f"bundles matched to fixture: {len(matched)}/{len(rows)}")
print(f"bundles with EXACT module count match: {len(exact)}/{len(matched)}")
print(f"unique module texts  : {len(uniq)}  "
      f"({100*len(uniq)/total:.1f}% of {total} -> {total/max(len(uniq),1):.2f}x dedup factor)")
print(f"detection methods    : {dict(methods)}")
cov = [r["coverage"] for r in rows if "coverage" in r]
if cov:
    print(f"coverage mean        : {sum(cov)/len(cov):.1f}%  (fixture 87.3%)")

mism = [r for r in matched if r["numberOfModules"] != r["fixtureModules"]]
if mism:
    print(f"\nfirst mismatches (ours vs fixture):")
    for r in mism[:10]:
        print(f"  {r['urls'][0][:48]:48} {r['numberOfModules']:>6} vs {r['fixtureModules']:>6}")

with open(os.path.join(OUT, "extract_report.json"), "w") as f:
    json.dump({"rows": rows, "uniqueModules": len(uniq), "totalModules": total,
               "methods": dict(methods)}, f, indent=1)
print(f"\nwrote {OUT}/extract_report.json")

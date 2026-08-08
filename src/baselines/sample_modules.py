#!/usr/bin/env python3
"""Dump a sample of extracted modules to JSON (runs in venv-client, tree-sitter >=0.22).

calibrate.py needs real module texts but must run in the server venv, which pins
tree-sitter 0.21.3 for codepredict's old Language(path, name) API. The two APIs
cannot coexist in one interpreter, so the sample is passed as a file.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = os.environ.get("UPSTREAM_DIR", os.path.join(HERE, "upstream"))
DATA = os.environ.get("BASELINE_DATA", os.path.join(HERE, "..", "src", "data", "baselines"))
sys.path.insert(0, UPSTREAM)
import dbundlr_eval  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("-n", "--num", type=int, default=200)
ap.add_argument("-o", "--output", default="modules_sample.json")
args = ap.parse_args()

data = json.load(open(os.path.join(DATA, "dataset.json")))
data.sort(key=lambda b: len(b["source"]))  # smallest bundles first: quick to gather

mods: list[str] = []
for b in data:
    for fn, _ in dbundlr_eval.extract_modules(b["source"].encode()) or []:
        mods.append(fn)
        if len(mods) >= args.num:
            break
    if len(mods) >= args.num:
        break

with open(args.output, "w") as f:
    json.dump(mods, f)
print(f"wrote {len(mods)} modules to {args.output} "
      f"(len min={min(map(len,mods))} max={max(map(len,mods))} "
      f"mean={sum(map(len,mods))//len(mods)})")

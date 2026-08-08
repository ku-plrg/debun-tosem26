#!/usr/bin/env python3
"""Oracle probe for find_grammar.sh: does the currently-built dolospy match the fixture?

Target (aldi.us bundle vs the moment index, derived from the fixture scores):
    leftTotal == 9225  and  covered == 428 for moment 2.15.0
"""
import json
import os
import sys

import dolospy

TOSEM = os.environ.get("BASELINE_DATA", "")
IDX = os.path.join(TOSEM, "aletheia-debun-index")
ART = os.environ.get("ARTIFACT_ROOT",
                     os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

data = json.load(open(os.path.join(TOSEM, "dataset.json")))
bundle = next(b for b in data if b["urls"][0] == "aldi.us")
fx = {tuple(r["urls"]): r for r in json.load(
    open(f"{ART}/src/data/other-tool/aletheia_results_debun.json"))}
fxvm = fx[tuple(bundle["urls"])]["detections"]["moment"]

index = dolospy.Index.deserialize(open(os.path.join(IDX, "moment.index.json")).read())
pairs = {p.right: p for p in index.matchExternal(bundle["source"])}

lt = {p.leftTotal for p in pairs.values()}
p215 = pairs.get("2.15.0")
covered = p215.covered if p215 else None
exact = 0
for v, s in fxvm.items():
    p = pairs.get(v)
    if p and p.leftTotal and abs(p.covered / p.leftTotal - s) < 1e-12:
        exact += 1

verdict = "*** MATCH ***" if (lt == {9225} and covered == 428) else "no"
print(f"  leftTotal={lt}  covered(2.15.0)={covered}  "
      f"exact score matches={exact}/{len(fxvm)}   {verdict}")
sys.exit(0 if verdict.startswith("***") else 1)

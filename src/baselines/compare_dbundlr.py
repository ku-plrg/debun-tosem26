#!/usr/bin/env python3
"""Phase 3: compare a regenerated D-Bundlr result against the shipped fixture.

Three tiers, weakest evidence to strongest:
  1. structural  - same bundles, same module counts, same coverage
  2. prediction  - same top-3 package lists / confidence deltas per module
  3. metric      - same TP/FP/FN in RQ2, which is the only thing the paper claims

Tier 3 is the one that must hold. Tiers 1-2 explain any tier-3 drift.
"""
import argparse
import csv
import json
import os

ART = os.environ.get("ARTIFACT_ROOT",
                     os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DBUNDLR_MIN = 0.6

ALIAS = {
    'react-dom': 'react', 'angularjs': 'angular.js', 'backbone': 'backbone.js',
    'handlebars': 'handlebars.js', 'hammerjs': 'hammer.js', 'ifvisible.js': 'ifvisible',
    'jquery-ui': 'jqueryui', 'jquery.ui': 'jqueryui', 'lodash': 'lodash.js',
    'moment': 'moment.js', 'requirejs': 'require.js', 'underscore': 'underscore.js',
    'three': 'three.js', 'isotope-layout': 'jquery.isotope',
}
canon = lambda s: ALIAS.get(s, s)  # noqa: E731


def load(path):
    raw = json.load(open(path))
    return (raw["result"], raw.get("trained_libs", [])) if isinstance(raw, dict) else (raw, [])


def det_by_site(records):
    out = {}
    for r in records:
        site = (r.get("urls") or [""])[0].strip()
        if not site:
            continue
        s = out.setdefault(site, set())
        for det in r.get("detections") or []:
            entries = det.get("dbundlr") or []
            if not entries:
                continue
            mc = max(e["confidence"] for e in entries)
            if mc <= DBUNDLR_MIN:
                continue
            for e in entries:
                if e["confidence"] == mc:
                    lib = canon((e.get("function", {}).get("packageName") or "").lower())
                    if lib:
                        s.add(lib)
    return out


def load_gt():
    universe = {k.split("____")[0].lower()
                for k in json.load(open(f"{ART}/src/data/fingerprint-cache/cdn-alllibs.json"))}
    eval_sites = {f[:-5] for f in os.listdir(f"{ART}/src/data/allWebHashes")
                  if f.endswith(".json") and "-cnt" not in f and "-cfg" not in f}
    gt = {}
    with open(f"{ART}/src/ground/ground-truth.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            site = (r.get("url") or "").strip()
            if not site or site not in eval_sites:
                continue
            libs = {}
            for tok in [t.strip() for t in (r.get("ground truth") or "").split(",") if t.strip()]:
                at = tok.find("@")
                lib = canon((tok if at < 0 else tok[:at]).strip().lower())
                if lib:
                    libs[lib] = "" if at < 0 else tok[at + 1:]
            gt[site] = libs
    return universe, {s: g for s, g in gt.items() if g}


def metrics(detected, sites, gt, scope):
    tp = fp = fn = 0
    for s in sites:
        d = detected.get(s, set())
        for lib in scope:
            if lib in gt[s] and lib in d:
                tp += 1
            elif lib in d:
                fp += 1
            elif lib in gt[s]:
                fn += 1
    P = tp / (tp + fp) if tp + fp else 0
    R = tp / (tp + fn) if tp + fn else 0
    F = 2 * P * R / (P + R) if P + R else 0
    return tp, fp, fn, P * 100, R * 100, F * 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=f"{ART}/src/data/other-tool/dbundlr_results_debun.json")
    ap.add_argument("--repro", required=True)
    args = ap.parse_args()

    fx, fx_tl = load(args.fixture)
    rp, rp_tl = load(args.repro)

    print("=" * 70)
    print("TIER 1 — structural")
    print("=" * 70)
    print(f"records        fixture={len(fx)}  repro={len(rp)}")
    print(f"trained_libs   fixture={len(fx_tl)}  repro={len(rp_tl)}  "
          f"same set={set(fx_tl)==set(rp_tl)}")
    fxi = {tuple(r.get("urls", [])): r for r in fx}
    rpi = {tuple(r.get("urls", [])): r for r in rp}
    common = sorted(set(fxi) & set(rpi))
    print(f"common bundles {len(common)}  (fixture-only={len(set(fxi)-set(rpi))}, "
          f"repro-only={len(set(rpi)-set(fxi))})")
    modmatch = sum(1 for k in common
                   if fxi[k].get("numberOfModules") == rpi[k].get("numberOfModules"))
    print(f"module count identical: {modmatch}/{len(common)}")

    print("\n" + "=" * 70)
    print("TIER 2 — per-module predictions")
    print("=" * 70)
    tot = same_top = 0
    deltas = []
    gate_flips = 0
    gaps = []  # how close each module's max confidence came to the decision gate
    for k in common:
        for a, b in zip(fxi[k].get("detections") or [], rpi[k].get("detections") or []):
            ea, eb = a.get("dbundlr") or [], b.get("dbundlr") or []
            tot += 1
            if [e["function"]["packageName"] for e in ea] == \
               [e["function"]["packageName"] for e in eb]:
                same_top += 1
            for x, y in zip(ea, eb):
                deltas.append(abs(x["confidence"] - y["confidence"]))
            ma = max((e["confidence"] for e in ea), default=None)
            mb = max((e["confidence"] for e in eb), default=None)
            if ma is None or mb is None:
                continue
            if ma > DBUNDLR_MIN:
                gaps.append((abs(ma - DBUNDLR_MIN), k[0],
                             [e["function"]["packageName"] for e in ea
                              if e["confidence"] == ma]))
            else:
                gaps.append((abs(ma - DBUNDLR_MIN), k[0],
                             [e["function"]["packageName"] for e in ea
                              if e["confidence"] == ma]))
            if (ma > DBUNDLR_MIN) != (mb > DBUNDLR_MIN):
                gate_flips += 1
    deltas.sort()
    n = len(deltas)
    exact = sum(1 for d in deltas if d == 0.0)
    maxdelta = deltas[-1] if deltas else 0.0
    print(f"modules compared        : {tot}")
    print(f"identical top-3 packages: {same_top}/{tot} ({100*same_top/max(tot,1):.2f}%)")
    print(f"confidence values       : {n}  exact={exact} ({100*exact/max(n,1):.1f}%)  "
          f"p99={deltas[int(n*0.99)]:.3e}  max={maxdelta:.3e}")
    print(f"modules flipping {DBUNDLR_MIN} gate: {gate_flips}")

    # The confidences feed exactly one decision, max(confidence) > DBUNDLR_MIN, so
    # drift only matters for modules sitting right on that threshold. Report the
    # margin: if it is not comfortably above maxdelta, a reproducer on different
    # hardware can legitimately land on a different FP count.
    gaps.sort()
    near = sum(1 for g, _, _ in gaps if g < 1e-4)
    if gaps:
        g0, site0, pkgs0 = gaps[0]
        ratio = g0 / maxdelta if maxdelta else float("inf")
        print(f"modules within 1e-4 of the gate: {near}")
        print(f"closest approach        : {g0:.3e}  ({site0}, {pkgs0})")
        print(f"safety margin           : {ratio:.1f}x the max drift"
              f"{'  <-- THIN: a ±1 difference in TP/FP/FN is expected on other hardware'
                 if ratio < 5 else ''}")

    print("\n" + "=" * 70)
    print("TIER 3 — RQ2 metrics (the claim that matters)")
    print("=" * 70)
    universe, gt = load_gt()
    sites = sorted(gt)
    trained = {canon(l.lower()) for l in (rp_tl or fx_tl)} & universe
    print(f"eval sites={len(sites)}  universe={len(universe)}  trained∩universe={len(trained)}\n")
    hdr = f"{'':22}{'TP':>5}{'FP':>6}{'FN':>5}{'Prec':>9}{'Recall':>9}{'F1':>9}"
    for scope_name, scope in [("full universe", universe), ("trained libs", trained)]:
        print(f"[{scope_name}]")
        print(hdr)
        for label, recs in [("fixture", fx), ("repro", rp)]:
            tp, fp, fn, P, R, F = metrics(det_by_site(recs), sites, gt, scope)
            print(f"  {label:20}{tp:>5}{fp:>6}{fn:>5}{P:>8.2f}%{R:>8.2f}%{F:>8.2f}%")
        print()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Phase 3: compare a regenerated Aletheia result against the shipped fixture.

Tier 3 here is the version-level table (Major/Minor/Patch + avg candidate range),
replicating cmd/compare-detectors.ts: per (site, lib) take the top-1 score with ties
as the detected version set, then check it against the ground-truth version.
"""
import argparse
import csv
import json
import os

ART = os.environ.get("ARTIFACT_ROOT",
                     os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

ALIAS = {
    'react-dom': 'react', 'angularjs': 'angular.js', 'backbone': 'backbone.js',
    'handlebars': 'handlebars.js', 'hammerjs': 'hammer.js', 'ifvisible.js': 'ifvisible',
    'jquery-ui': 'jqueryui', 'jquery.ui': 'jqueryui', 'lodash': 'lodash.js',
    'moment': 'moment.js', 'requirejs': 'require.js', 'underscore': 'underscore.js',
    'three': 'three.js', 'isotope-layout': 'jquery.isotope',
}
canon = lambda s: ALIAS.get(s, s)  # noqa: E731


def parts(v):
    p = []
    for x in v.split("."):
        try:
            p.append(int(x))
        except ValueError:
            p.append(None)
    while len(p) < 3:
        p.append(None)
    return p[0], p[1], p[2]


def ale_by_site(records):
    """Top-1 with ties, exactly as compare-detectors.ts:191-209."""
    out = {}
    for r in records:
        site = (r.get("urls") or [""])[0].strip()
        if not site:
            continue
        for lib_raw, vermap in (r.get("detections") or {}).items():
            if not vermap:
                continue
            lib = canon(lib_raw.lower())
            mx = max(vermap.values())
            top = {v for v, s in vermap.items() if s == mx}
            out.setdefault(site, {}).setdefault(lib, set()).update(top)
    return out


def load_gt():
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
                    libs[lib] = "" if at < 0 else tok[at + 1:].strip()
            gt[site] = libs
    return gt


def version_stats(by_site, gt):
    tp = M = m = p = 0
    wM, wMm, wMmp = [], [], []
    for site, libs in gt.items():
        site_map = by_site.get(site, {})
        for lib, gtver in libs.items():
            if not gtver or lib not in site_map:
                continue
            versions = site_map[lib]
            if not versions:
                continue
            tp += 1
            gM, gm, gp = parts(gtver)
            majors, minors, patches = set(), set(), set()
            mF = miF = paF = False
            for v in versions:
                a, b, c = parts(v)
                majors.add(a)
                minors.add(f"{a}.{b}")
                patches.add(v)
                if a == gM:
                    mF = True
                if a == gM and b == gm:
                    miF = True
                if a == gM and b == gm and c == gp:
                    paF = True
            M += mF
            m += miF
            p += paF
            wM.append(len(majors))
            wMm.append(len(minors))
            wMmp.append(len(patches))
    avg = lambda a: sum(a) / len(a) if a else 0  # noqa: E731
    return tp, M, m, p, avg(wM), avg(wMm), avg(wMmp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=f"{ART}/src/data/other-tool/aletheia_results_debun.json")
    ap.add_argument("--repro", required=True)
    args = ap.parse_args()

    fx = json.load(open(args.fixture))
    rp = json.load(open(args.repro))

    print("=" * 70)
    print("TIER 1 — structural")
    print("=" * 70)
    print(f"records  fixture={len(fx)}  repro={len(rp)}")
    fxi = {tuple(r.get("urls", [])): r for r in fx}
    rpi = {tuple(r.get("urls", [])): r for r in rp}
    common = sorted(set(fxi) & set(rpi))
    print(f"common bundles {len(common)}  (fixture-only={len(set(fxi)-set(rpi))}, "
          f"repro-only={len(set(rpi)-set(fxi))})")

    print("\n" + "=" * 70)
    print("TIER 2 — per-(bundle,lib) score maps")
    print("=" * 70)
    same_keys = pairs = same_ver = 0
    maxdelta = 0.0
    keydiff = []
    for k in common:
        a = fxi[k].get("detections") or {}
        b = rpi[k].get("detections") or {}
        if set(a) == set(b):
            same_keys += 1
        elif len(keydiff) < 5:
            keydiff.append((k[0], sorted(set(a) ^ set(b))))
        for lib in set(a) & set(b):
            pairs += 1
            va, vb = a[lib], b[lib]
            if set(va) == set(vb):
                same_ver += 1
            for v in set(va) & set(vb):
                maxdelta = max(maxdelta, abs(va[v] - vb[v]))
    print(f"bundles with identical lib key sets : {same_keys}/{len(common)}")
    print(f"(bundle,lib) pairs compared         : {pairs}")
    print(f"  identical version key sets        : {same_ver}/{pairs}")
    print(f"  max |score delta|                 : {maxdelta:.3e}")
    for site, diff in keydiff:
        print(f"  key diff @ {site}: {diff}")

    print("\n" + "=" * 70)
    print("TIER 3 — RQ3 version table (paper: TP=98 Major=88 Minor=75 Patch=67)")
    print("=" * 70)
    gt = load_gt()
    print(f"{'':10}{'TP':>5}{'Major':>16}{'Minor':>16}{'Patch':>16}")
    for label, recs in [("fixture", fx), ("repro", rp)]:
        tp, M, m, p, aM, aMm, aMmp = version_stats(ale_by_site(recs), gt)
        print(f"{label:10}{tp:>5}"
              f"{f'{M} (±{aM:.2f})':>16}{f'{m} (±{aMm:.2f})':>16}{f'{p} (±{aMmp:.2f})':>16}")


if __name__ == "__main__":
    main()

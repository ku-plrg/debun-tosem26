#!/usr/bin/env python3
"""Aletheia evaluation driver — a fixed port of tosem/aletheia_eval.py::main().

Upstream issues:
  :100  DATASET_PATH = os.path.join("path","to","dataset.json")  -> placeholder
  :129  the package index is re-deserialized for EVERY (bundle, gt-package) pair;
        with 223 ground-truth instances over a 184 MB index dir that is pure waste.

PKG_MAPPING / translate_package_name / sha256 are imported from the upstream module
rather than copied, so the CDN->npm name mapping is guaranteed identical.

Note this evaluation is oracle-guided: similarities are only computed for packages
that appear in the bundle's ground truth, so Aletheia structurally cannot produce a
false positive here. That is why it appears only in the version-level table.

Run in venv-client with PYTHONPATH pointing at the dolospy build:
  PYTHONPATH=dolospy-build INDEX_DIR=.../aletheia-debun-index venv-client/bin/python run_aletheia.py -o out.json
"""
import argparse
import json
import os
import sys
import time

import dolospy

HERE = os.path.dirname(os.path.abspath(__file__))
# Upstream scripts are vendored verbatim under baselines/upstream/ (see its README).
UPSTREAM = os.environ.get("UPSTREAM_DIR", os.path.join(HERE, "upstream"))
# Heavy inputs fetched by ../../baseline-files.sh; override with BASELINE_DATA.
DATA = os.environ.get("BASELINE_DATA", os.path.join(HERE, "..", "src", "data", "baselines"))
sys.path.insert(0, UPSTREAM)
import aletheia_eval  # noqa: E402  (import-safe; main() is behind __main__)

translate_package_name = aletheia_eval.translate_package_name
sha256 = aletheia_eval.sha256


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--dataset", default=os.path.join(DATA, "dataset.json"))
    ap.add_argument(
        "--index-dir",
        default=os.environ.get("INDEX_DIR", os.path.join(DATA, "aletheia-debun-index")),
    )
    args = ap.parse_args()

    with open(args.dataset) as f:
        data = json.load(f)
    print(f"bundles: {len(data)}  index dir: {args.index_dir}", flush=True)

    index_cache: dict[str, object] = {}
    missing: set[str] = set()

    def get_index(pkg: str):
        """Upstream reloads this per pair; we memoize. Same object, same results."""
        name = translate_package_name(pkg).replace("/", "+")
        if name in index_cache:
            return index_cache[name]
        path = os.path.join(args.index_dir, f"{name}.index.json")
        if not os.path.isfile(path):
            missing.add(f"{pkg} -> {name}")
            index_cache[name] = None
            return None
        with open(path) as f:
            index_cache[name] = dolospy.Index.deserialize(f.read())
        return index_cache[name]

    result = []
    skipped_noversion = 0
    t0 = time.time()
    for i, bundle in enumerate(data):
        detections: dict[str, dict[str, float]] = {}
        for pkg_vers in bundle["groundTruth"]:
            if pkg_vers == "three.js@r148":  # upstream :112
                pkg_vers = "three.js@0.148.0"
            if "@" not in pkg_vers:
                skipped_noversion += 1
                continue
            pkg, _vers = pkg_vers.rsplit("@", 1)
            if len(pkg) == 0:
                continue
            index = get_index(pkg)
            if index is None:
                continue
            pairs = index.matchExternal(bundle["source"])
            detections[pkg] = {
                p.right: (p.covered / p.leftTotal if p.leftTotal > 0 else 0)
                for p in pairs
            }

        result.append({
            "urls": bundle["urls"],
            "bundle": sha256(bundle["source"]),
            "groundTruth": bundle["groundTruth"],
            "detections": detections,
        })
        if (i + 1) % 20 == 0:
            print(f"[{i+1}/{len(data)}] {time.time()-t0:.0f}s", flush=True)

    with open(args.output, "w") as f:
        json.dump(result, f)

    with_det = sum(1 for r in result if r["detections"])
    print(
        f"\nwrote {args.output}\n"
        f"  records={len(result)}  with detections={with_det}\n"
        f"  indices loaded={sum(1 for v in index_cache.values() if v is not None)}"
        f"  gt entries without version={skipped_noversion}\n"
        f"  elapsed={(time.time()-t0)/60:.1f}min",
        flush=True,
    )
    if missing:
        print(f"  no index file for: {sorted(missing)}", flush=True)


if __name__ == "__main__":
    main()

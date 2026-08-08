#!/usr/bin/env python3
"""D-Bundlr evaluation driver — a fixed, resumable port of tosem/dbundlr_eval.py::main().

The upstream main() cannot run as shipped:
  :459  logger.info(..., args.mode, ...)   -> AttributeError, 'mode' never added to argparse
  :463  os.listdir("path","to","dbundlr-debun-dataset") -> TypeError, listdir takes 1 arg
  :462  DATASET_PATH = os.path.join("path","to","dataset.json")  -> placeholder
  :468  if HOSTNAME == "ruidoso":         -> author's debug machine branch

Everything that affects the RESULT is kept byte-identical to upstream: modules come
from the untouched `extract_modules`, each module is POSTed to /predict exactly once,
and the output schema is the same {"result": [...], "trained_libs": [...]}.
What we add is operational only: request concurrency, retries, and a JSONL checkpoint
so a multi-hour run can resume.
"""
import argparse
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
# Upstream scripts are vendored verbatim under baselines/upstream/ (see its README).
UPSTREAM = os.environ.get("UPSTREAM_DIR", os.path.join(HERE, "upstream"))
# Heavy inputs fetched by ../../baseline-files.sh; override with BASELINE_DATA.
DATA = os.environ.get("BASELINE_DATA", os.path.join(HERE, "..", "src", "data", "baselines"))
sys.path.insert(0, UPSTREAM)
import dbundlr_eval  # noqa: E402  (import-safe; its main() is behind __main__)

extract_modules = dbundlr_eval.extract_modules


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode(), usedforsecurity=False).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--server", default="http://127.0.0.1:3446/predict")
    ap.add_argument("--dataset", default=os.path.join(DATA, "dataset.json"))
    ap.add_argument("--trained-dir", default=os.path.join(DATA, "dbundlr-debun-dataset"))
    ap.add_argument("--workers", type=int, default=8, help="concurrent predict requests")
    ap.add_argument("--limit", type=int, help="only process the first N bundles")
    ap.add_argument("--checkpoint", help="JSONL resume file (default: <output>.ckpt.jsonl)")
    args = ap.parse_args()

    ckpt_path = args.checkpoint or args.output + ".ckpt.jsonl"

    # upstream :463, with the listdir bug fixed
    trained_libs = [
        f.split(".", 1)[0].replace("+", "/") for f in os.listdir(args.trained_dir)
    ]

    with open(args.dataset) as f:
        data = json.load(f)
    if args.limit:
        data = data[: args.limit]
    print(f"bundles: {len(data)}  trained_libs: {len(trained_libs)}", flush=True)

    done: dict[int, dict] = {}
    if os.path.exists(ckpt_path):
        with open(ckpt_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                done[rec["_idx"]] = rec
        print(f"resuming: {len(done)} bundles already in {ckpt_path}", flush=True)

    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=args.workers, pool_maxsize=args.workers
    )
    session.mount("http://", adapter)

    def predict(code: str):
        last = None
        for attempt in range(4):
            try:
                r = session.post(args.server, json={"code": code}, timeout=600)
                r.raise_for_status()
                return r.json()
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"predict failed after retries: {last}")

    t0 = time.time()
    calls_done = 0
    calls_total = None
    ck = open(ckpt_path, "a")
    for i, bundle in enumerate(data):
        if i in done:
            continue
        src = bundle["source"]
        functions = extract_modules(src.encode())

        if not functions:
            rec = {"_idx": i, "error": "no modules found in bundle"}
            ck.write(json.dumps(rec) + "\n")
            ck.flush()
            done[i] = rec
            print(f"[{i+1}/{len(data)}] no modules", flush=True)
            continue

        codes = [fn for fn, _ in functions]
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            responses = list(pool.map(predict, codes))  # order preserved

        detections = [
            {
                "moduleStrlength": len(fn),
                "moduleDetectionMethod": str(method),
                "dbundlr": resp,
            }
            for (fn, method), resp in zip(functions, responses)
        ]
        rec = {
            "_idx": i,
            "urls": bundle["urls"],
            "bundle": sha256(src),
            "groundTruth": bundle["groundTruth"],
            "numberOfModules": len(functions),
            "coverage": 100 * sum(len(f) for f, _ in functions) / len(src),
            "detections": detections,
        }
        ck.write(json.dumps(rec) + "\n")
        ck.flush()
        done[i] = rec

        calls_done += len(codes)
        el = time.time() - t0
        rate = calls_done / el if el else 0
        remaining_bundles = len(data) - len(done)
        print(
            f"[{i+1}/{len(data)}] {len(codes)} modules | "
            f"{rate:.1f} pred/s | {el/60:.1f}min elapsed | "
            f"{remaining_bundles} bundles left",
            flush=True,
        )
    ck.close()

    result = []
    for i in range(len(data)):
        rec = dict(done[i])
        rec.pop("_idx", None)
        result.append(rec)
    with open(args.output, "w") as f:
        json.dump({"result": result, "trained_libs": trained_libs}, f)
    total_modules = sum(r.get("numberOfModules", 0) for r in result)
    print(
        f"\nwrote {args.output}\n"
        f"  records={len(result)} modules={total_modules} "
        f"elapsed={(time.time()-t0)/60:.1f}min",
        flush=True,
    )


if __name__ == "__main__":
    main()

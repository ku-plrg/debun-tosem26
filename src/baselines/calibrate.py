#!/usr/bin/env python3
"""Phase 1 step 2: measure real per-call latency and check CPU/MPS agreement.

Loads the D-Bundlr checkpoint directly (no HTTP) and runs the same N modules
through it on each device, so we learn two things before committing to a
multi-hour run:

  1. actual seconds/prediction  -> replaces the "4 hours" guess with a number
  2. do CPU and MPS produce the SAME top-3 packages and confidences?
     If they diverge near the 0.6 threshold, the fast device is not safe to use
     for the reference run.
"""
import argparse
import json
import os
import pickle
import sys
import time

import torch

CODEPREDICT = os.environ["CODEPREDICT"]
HERE = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = os.environ.get("UPSTREAM_DIR", os.path.join(HERE, "upstream"))
DATA = os.environ.get("BASELINE_DATA", os.path.join(HERE, "..", "src", "data", "baselines"))
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(DATA, "debun-model"))

sys.path.insert(0, CODEPREDICT)
import settings  # noqa: E402

settings.output_dir = MODEL_DIR

from transformers import RobertaConfig, RobertaTokenizer  # noqa: E402
from model import Model  # noqa: E402
from predict import predict_candidates  # noqa: E402
from utils import set_seed  # noqa: E402


def load_model(device: str):
    with open(os.path.join(MODEL_DIR, "labelMap.pkl"), "rb") as f:
        label_id_to_label = {v: k for k, v in pickle.load(f).items()}
    set_seed()
    config = RobertaConfig.from_pretrained(settings.model_name)
    config.num_labels = len(label_id_to_label)
    tokenizer = RobertaTokenizer.from_pretrained(settings.model_name)
    model = Model(encoder=None, config=config, tokenizer=tokenizer)
    ckpt = os.path.join(MODEL_DIR, "checkpoint-best-f1", "model.bin")
    model.load_state_dict(torch.load(ckpt, map_location=torch.device("cpu")))
    settings.device = torch.device(device)
    model.to(settings.device)
    model.eval()
    return model, tokenizer, label_id_to_label


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", "--num", type=int, default=200)
    ap.add_argument("--devices", default="cpu,mps")
    ap.add_argument("--modules", default="modules_sample.json",
                    help="module texts dumped by sample_modules.py (venv-client)")
    args = ap.parse_args()

    print(f"labelMap: {MODEL_DIR}/labelMap.pkl", flush=True)
    with open(os.path.join(MODEL_DIR, "labelMap.pkl"), "rb") as f:
        n_labels = len(pickle.load(f))
    print(f"labels: {n_labels}", flush=True)

    mods: list[str] = json.load(open(args.modules))[: args.num]
    print(f"sampled {len(mods)} modules "
          f"(len min={min(map(len,mods))} max={max(map(len,mods))})\n", flush=True)

    results = {}
    for dev in args.devices.split(","):
        dev = dev.strip()
        if dev == "mps" and not torch.backends.mps.is_available():
            print("mps unavailable, skipping")
            continue
        print(f"--- {dev} ---", flush=True)
        model, tok, lmap = load_model(dev)
        predict_candidates(model, tok, mods[0], lmap, n=3)  # warm-up
        t0 = time.time()
        out = []
        for m in mods:
            funcs, conf = predict_candidates(model, tok, m, lmap, n=3)
            out.append([(f, float(c)) for f, c in zip(funcs, conf)])
        el = time.time() - t0
        per = el / len(mods)
        print(f"{el:.1f}s total | {per*1000:.1f} ms/pred | "
              f"55856 preds -> {55856*per/60:.0f} min\n", flush=True)
        results[dev] = out
        del model
        if dev == "mps":
            torch.mps.empty_cache()

    devs = list(results)
    if len(devs) == 2:
        a, b = results[devs[0]], results[devs[1]]
        same_pkg = sum(
            1 for x, y in zip(a, b)
            if [p["packageName"] for p, _ in x] == [p["packageName"] for p, _ in y]
        )
        maxdiff = max(
            abs(cx - cy)
            for x, y in zip(a, b)
            for (_, cx), (_, cy) in zip(x, y)
        )
        # would any module cross the DBUNDLR_MIN=0.6 gate differently?
        flips = sum(
            1 for x, y in zip(a, b)
            if (max(c for _, c in x) > 0.6) != (max(c for _, c in y) > 0.6)
        )
        print("=" * 60)
        print(f"{devs[0]} vs {devs[1]}")
        print(f"  identical top-3 package lists : {same_pkg}/{len(a)}")
        print(f"  max |confidence delta|        : {maxdiff:.3e}")
        print(f"  modules flipping the 0.6 gate : {flips}/{len(a)}")
        print("=" * 60)


if __name__ == "__main__":
    main()

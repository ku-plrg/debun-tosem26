"""Gunicorn entrypoint for D-Bundlr's codepredict server.

Wraps the upstream predictServer.py WITHOUT modifying the D-Bundlr repo:
`settings` is imported first and rewritten in place, so predictServer picks up
our model location and device when it runs its module-level load.

  MODEL_DIR       where labelMap.pkl + checkpoint-best-f1/model.bin live
  DBUNDLR_DEVICE  cpu | mps | cuda   (upstream default: cuda-if-available else cpu)

  gunicorn -w 1 -b 127.0.0.1:3446 --timeout 600 serve:app
"""
import os
import sys

import torch

CODEPREDICT = os.environ["CODEPREDICT"]  # <D-Bundlr checkout>/codepredict
sys.path.insert(0, CODEPREDICT)

import settings  # noqa: E402

# Resolve a relative MODEL_DIR against the repository root, not the working directory:
# gunicorn is started with `--chdir src/baselines`, so a repo-relative path like
# src/data/baselines/debun-model would otherwise be looked up under src/baselines/ and the
# worker dies on a missing labelMap.pkl. Every other path in this artifact is repo-relative.
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_model_dir = os.environ["MODEL_DIR"]
if not os.path.isabs(_model_dir):
    _model_dir = os.path.join(_REPO, _model_dir)
settings.output_dir = _model_dir  # dir with labelMap.pkl + checkpoint-best-f1/
_dev = os.environ.get("DBUNDLR_DEVICE")
if _dev:
    settings.device = torch.device(_dev)

print(f"[serve] model_dir={settings.output_dir} device={settings.device}", file=sys.stderr)

import predictServer  # noqa: E402  (loads the checkpoint at import time)

app = predictServer.app

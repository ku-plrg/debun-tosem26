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

# Resolve relative paths against the repository root, not the working directory: gunicorn is
# started with `--chdir src/baselines`, so a repo-relative path is otherwise looked up under
# src/baselines/. Every other path in this artifact is repo-relative.
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _from_repo(p: str) -> str:
    return p if os.path.isabs(p) else os.path.join(_REPO, p)


# Unresolved, this is the import below dying with ModuleNotFoundError: No module named
# 'settings' rather than anything that names the path it failed on.
CODEPREDICT = _from_repo(os.environ["CODEPREDICT"])  # <D-Bundlr checkout>/codepredict
sys.path.insert(0, CODEPREDICT)

import settings  # noqa: E402

# Unresolved, the worker dies on a missing labelMap.pkl.
_model_dir = os.environ["MODEL_DIR"]
settings.output_dir = _from_repo(_model_dir)  # dir with labelMap.pkl + checkpoint-best-f1/
_dev = os.environ.get("DBUNDLR_DEVICE")
if _dev:
    settings.device = torch.device(_dev)

print(f"[serve] model_dir={settings.output_dir} device={settings.device}", file=sys.stderr)

import predictServer  # noqa: E402  (loads the checkpoint at import time)

app = predictServer.app

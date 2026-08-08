#!/bin/bash
# Per-model fingerprint caches for the five non-full POG models in paper Table 3.
# Without them that table prints `n/a` for those columns; the full model (POG+FBCI),
# which is the one the rest of the paper uses, needs nothing extra.
# ~300 MB — a few minutes.

# The record ID lives in zenodo-record.env — one place for all five scripts.
. "$(dirname "$0")/zenodo-record.env"

mkdir -p src/data

curl -L $ZENODO/ablation-caches.tar.gz -o src/data/ablation-caches.tar.gz

for file in src/data/*.tar.gz; do
    tar -xzf "$file" -C src/data
    rm "$file"
done

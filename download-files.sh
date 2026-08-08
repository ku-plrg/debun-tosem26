#!/bin/bash
# Everything needed to reproduce every table and figure in the paper, plus the
# per-site notes behind the manual ground truth.
# ~117 MB — a few minutes. Start here.

# The record ID lives in zenodo-record.env — one place for all five scripts.
. "$(dirname "$0")/zenodo-record.env"

mkdir -p src/data

curl -L $ZENODO/debun-databases.tar.gz          -o src/data/debun-databases.tar.gz
# Not $ZENODO: this file is unchanged since ASE'25 and stays on that record. See zenodo-record.env.
curl -L $ZENODO_GT/ground-truth-evidence.tar.gz -o src/data/ground-truth-evidence.tar.gz

for file in src/data/*.tar.gz; do
    tar -xzf "$file" -C src/data
    rm "$file"
done

#!/bin/bash
# Inputs for regenerating the D-Bundlr and Aletheia fixtures from their own models
# (src/baselines/build-baselines.sh). Not needed to read the tables — those fixtures
# ship in the repository.
# ~526 MB — ten minutes or so.

# The record ID lives in zenodo-record.env — one place for all five scripts.
. "$(dirname "$0")/zenodo-record.env"

mkdir -p src/data/baselines

curl -L $ZENODO/baseline-inputs.tar.gz -o src/data/baselines/baseline-inputs.tar.gz

for file in src/data/baselines/*.tar.gz; do
    tar -xzf "$file" -C src/data/baselines
    rm "$file"
done

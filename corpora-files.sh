#!/bin/bash
# The raw library and website code, for rebuilding the hash databases with build-db.sh
# instead of downloading them. Only needed if you want to reproduce the databases
# themselves rather than the paper's numbers.
# ~11 GB — an hour or more on a good connection.

# The record ID lives in zenodo-record.env — one place for all five scripts.
. "$(dirname "$0")/zenodo-record.env"

mkdir -p src/data

# The library corpus is not here: ./cdn-files.sh fetches it from cdnjs, which serves the same
# layout the committed manifest describes. Same for the npm corpus and ./npm-files.sh.
curl -L $ZENODO/website-crawled-code.tar.gz -o src/data/website-crawled-code.tar.gz
curl -L $ZENODO/rq3-bundles.tar.gz          -o src/data/rq3-bundles.tar.gz

for file in src/data/*.tar.gz; do
    tar -xzf "$file" -C src/data
    rm "$file"
done

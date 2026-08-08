#!/bin/bash
# DEBUN CLI entrypoint. Runs the TypeScript CLI via ts-node (transpile-only so
# the research prototype runs without a separate build/type-check step).
#
# Every dataset path is resolved against the working directory, so run from the repository
# root — which this enforces rather than leaving to chance: from anywhere else the RQ commands
# would find no databases and report them as missing, which reads like a broken checkout
# rather than a wrong directory. File arguments are therefore relative to the repo root too.
cd "$(dirname "$0")"
npx ts-node --transpile-only src/dist/index.ts "$@"

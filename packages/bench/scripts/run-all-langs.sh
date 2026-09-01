#!/usr/bin/env bash
# Run matrix_run.py / matrix_run.ts / Program.cs / matrix_run.rs /
# MatrixRun.java / matrix_run.c against a single engine for a given
# run_id, writing 6 SCHEMA-v1 JSONs to
# packages/bench/results/$RUN_ID/$ENGINE/{python,web,dotnet,rust,java,c}.json.
#
# Usage:
#   packages/bench/scripts/run-all-langs.sh $RUN_ID $ENGINE [size1 size2 ...]
#
# RUN_ID    e.g. 2026-05-08T01-15-02Z
# ENGINE    one of "sglang", "vllm", "llama.cpp" (must match
#           packages/bench/methodology/$RUN_ID/$ENGINE.json filename).
# sizes     optional list (default: 64 512 2048)
#
# Pre-reqs (one-time per lab box):
#   - Python venv at .venv with codecai + codec_demo installed
#   - Node 18+ (npx fetches tsx)
#   - .NET 9 SDK on PATH
#   - rustc + cargo on PATH
#   - JDK 21 + Maven on PATH
#   - codec-bench C built at packages/demo-c/build/codec-matrix
#
# This script EXITS NON-ZERO if any lang's matrix run fails: the bench is
# only useful when all 6 cells are filled. Re-run individual langs by hand
# if the bulk script aborts.
set -euo pipefail

if [ $# -lt 2 ]; then
    echo "usage: $0 RUN_ID ENGINE [size...]" >&2
    exit 1
fi

RUN_ID="$1"
ENGINE="$2"
shift 2
SIZES="${*:-64 512 2048}"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

METHODOLOGY="packages/bench/methodology/$RUN_ID/$ENGINE.json"
if [ ! -f "$METHODOLOGY" ]; then
    echo "methodology file missing: $METHODOLOGY" >&2
    exit 1
fi

OUTDIR="packages/bench/results/$RUN_ID/$ENGINE"
mkdir -p "$OUTDIR"

# shellcheck disable=SC2206
SIZES_ARR=($SIZES)

# Reps default to 2 (sglang + llama.cpp are stable at 2). Override via env
# for noisier engines: vllm at 2K tokens has ~10 to 20 % wire-byte variance
# from non-deterministic batching/scheduling even at temperature=0; bumping
# REPS=4 stabilises the median. See packages/bench/results/2026-05-08T01-15-02Z/MATRIX.md §7.
REPS="${REPS:-2}"

echo "=== run_id=$RUN_ID engine=$ENGINE sizes=$SIZES reps=$REPS ==="

# Engine image acceptance (gate-before-bench): added after the v0.4.1
# post-mortem caught a stale-Dockerfile regression that shipped broken
# brotli/zstandard + missing v0.4 safety admin endpoints. See
# docs/RELEASE_CHECKLIST.md §3 + packages/bench/tests/test_engine_acceptance.py.
#
# Skip via SKIP_ACCEPTANCE=1 only when you are deliberately benching a
# known-broken engine (rare; document why in the commit message).
if [ "${SKIP_ACCEPTANCE:-0}" != "1" ]; then
    ENGINE_ENDPOINT=$(python3 -c "
import json,sys
d = json.load(open('$METHODOLOGY'))
print(d['engine']['endpoint'])
")
    ENGINE_MODEL_ID=$(python3 -c "
import json,sys
d = json.load(open('$METHODOLOGY'))
print(d['model']['id'])
")
    echo
    echo "--- engine acceptance (tests-before-bench gate) ---"
    CODEC_ENGINE_URL="$ENGINE_ENDPOINT" \
    CODEC_ENGINE_NAME="$ENGINE" \
    CODEC_ENGINE_MODEL="$ENGINE_MODEL_ID" \
    .venv/bin/python -m pytest packages/bench/tests/test_engine_acceptance.py -v --tb=short \
        || { echo "FAIL: engine acceptance gate failed for $ENGINE: bench aborted." >&2; \
             echo "Fix the engine image and retry. To bypass for a known-broken baseline, set SKIP_ACCEPTANCE=1." >&2; \
             exit 3; }
fi

# 1. Python
echo
echo "--- python ---"
.venv/bin/python -m codec_demo.matrix_run \
    --methodology "$METHODOLOGY" \
    --sizes "${SIZES_ARR[@]}" --reps "$REPS" \
    --out "$OUTDIR/python.json"

# 2. TypeScript / Node
echo
echo "--- web ---"
( cd packages/demo && npx -y tsx src/matrix_run.ts \
    --methodology "../../$METHODOLOGY" \
    --sizes "${SIZES_ARR[@]}" --reps "$REPS" \
    --out "../../$OUTDIR/web.json" )

# 3. .NET
echo
echo "--- dotnet ---"
PATH="$HOME/.dotnet:$PATH" dotnet run --project packages/demo-dotnet -c Release --no-build -- \
    --methodology "$METHODOLOGY" \
    --sizes "${SIZES_ARR[@]}" --reps "$REPS" \
    --out "$OUTDIR/dotnet.json"

# 4. Rust
echo
echo "--- rust ---"
./packages/demo-rust/target/release/codec-bench \
    --methodology "$METHODOLOGY" \
    --sizes "${SIZES_ARR[@]}" --reps "$REPS" \
    --out "$OUTDIR/rust.json"

# 5. Java
echo
echo "--- java ---"
PATH="$HOME/jdk/bin:$PATH" java -jar packages/demo-java/target/codec-bench.jar \
    --methodology "$METHODOLOGY" \
    --sizes "${SIZES_ARR[@]}" --reps "$REPS" \
    --out "$OUTDIR/java.json"

# 6. C
echo
echo "--- c ---"
./packages/demo-c/build/codec-matrix \
    --methodology "$METHODOLOGY" \
    --sizes "${SIZES_ARR[@]}" --reps "$REPS" \
    --out "$OUTDIR/c.json"

echo
echo "=== done. 6 cells written to $OUTDIR ==="
ls -la "$OUTDIR"/*.json

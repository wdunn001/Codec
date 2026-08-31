#!/usr/bin/env bash
# Run token_bench.py / token_bench.ts / TokenBench.cs (subcommand) /
# token_bench.rs / TokenBench.java (subcommand) / token_bench.c against
# a single tokenizer map + golden corpus, writing 6 SCHEMA-v1 JSONs to
# packages/bench/results/$RUN_ID/token/{python,web,dotnet,rust,java,c}.json.
#
# Usage:
#   packages/bench/scripts/run-all-token-benches.sh \
#       $RUN_ID \
#       /path/to/codec-maps/maps/qwen/qwen2.json \
#       packages/bench/golden/qwen2.json
#
# Companion to run-all-langs.sh (which runs the live wire bench against
# an engine). This script has no network deps: runs entirely against
# local files: so it works on any dev box with the language toolchains.
set -euo pipefail

if [ $# -lt 3 ]; then
    echo "usage: $0 RUN_ID MAP_JSON_PATH CORPUS_JSON_PATH [reps]" >&2
    exit 1
fi

RUN_ID="$1"
MAP="$(readlink -f "$2")"
CORPUS="$(readlink -f "$3")"
REPS="${4:-200}"
WARMUP="${WARMUP:-20}"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

OUTDIR="packages/bench/results/$RUN_ID/token"
mkdir -p "$OUTDIR"

echo "=== run_id=$RUN_ID map=$MAP corpus=$CORPUS reps=$REPS warmup=$WARMUP ==="

# 1. Python
echo
echo "--- python ---"
.venv/bin/python -m codec_demo.token_bench \
    --map "$MAP" --corpus "$CORPUS" --reps "$REPS" --warmup "$WARMUP" \
    --out "$OUTDIR/python.json"

# 2. TypeScript / Node
echo
echo "--- web ---"
( cd packages/demo && npx -y tsx src/token_bench.ts \
    --map "$MAP" --corpus "$CORPUS" --reps "$REPS" --warmup "$WARMUP" \
    --out "../../$OUTDIR/web.json" )

# 3. .NET
echo
echo "--- dotnet ---"
PATH="$HOME/.dotnet:$PATH" dotnet run --project packages/demo-dotnet -c Release --no-build -- \
    token-bench \
    --map "$MAP" --corpus "$CORPUS" --reps "$REPS" --warmup "$WARMUP" \
    --out "$OUTDIR/dotnet.json"

# 4. Rust
echo
echo "--- rust ---"
./packages/demo-rust/target/release/codec-token-bench \
    --map "$MAP" --corpus "$CORPUS" --reps "$REPS" --warmup "$WARMUP" \
    --out "$OUTDIR/rust.json"

# 5. Java
echo
echo "--- java ---"
PATH="$HOME/jdk/bin:$PATH" java -jar packages/demo-java/target/codec-bench.jar \
    token-bench \
    --map "$MAP" --corpus "$CORPUS" --reps "$REPS" --warmup "$WARMUP" \
    --out "$OUTDIR/java.json"

# 6. C
echo
echo "--- c ---"
./packages/demo-c/build/codec-token-bench \
    --map "$MAP" --corpus "$CORPUS" --reps "$REPS" --warmup "$WARMUP" \
    --out "$OUTDIR/c.json"

echo
echo "=== done. 6 cells written to $OUTDIR ==="
ls -la "$OUTDIR"/*.json

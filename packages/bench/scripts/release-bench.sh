#!/usr/bin/env bash
# release-bench.sh — full release-checklist §3 + §3.5 bench cohort, end-to-end.
#
# One script that runs every bench surface required by the release gate:
#
#   1. §1   synthetic wire bench                  (synthetic_wire_bench.py)
#   2. §3   cross-stack matrix × 3 engines         (run-all-langs.sh)
#   3. §3.5 per-language token bench               (run-all-token-benches.sh)
#   4. §3.5 cross-vocab translator bench           (translator_bench.py)
#   5. §3.5 agent-loop end-to-end (mock+searxng+metamcp+leaf)
#   6.      aggregate -> MATRIX.md                 (aggregate.py)
#
# Designed to be re-runnable for every Codec release. Pass a RUN_ID
# (UTC timestamp); the script generates one if omitted.
#
# Usage:
#   bash packages/bench/scripts/release-bench.sh                  # auto RUN_ID
#   bash packages/bench/scripts/release-bench.sh 2026-05-17T23-06-45Z
#
# Required containers running (verify before invoking):
#   - codec-deployable @ 192.168.1.88:30002  (sglang v0.X.Y)
#   - codec-vllm       @ 192.168.1.88:30003  (vllm v0.X.Y, GPU-pinned if shared)
#   - codec-llamacpp   @ 192.168.1.88:30004  (llamacpp v0.X.Y)
#   - codec-time-leaf  @ wherever (for leaf-mode microbench)
#   - metamcp          @ 192.168.1.88:12008  (for metamcp + leaf paths)
#   - searxng          @ wherever            (for searxng path; can be skipped via SKIP_SEARXNG=1)
#
# Required toolchains on the orchestrator host (this machine):
#   - .venv/bin/python  with codec_demo, msgpack, brotli, zstandard, numpy, httpx, pytest installed
#   - node + npx        (for TypeScript bench clients)
#   - ~/.dotnet         (for .NET self-contained binary)
#   - cargo target      already built (rust)
#   - ~/jdk/bin/java    (for Java)
#   - packages/demo-c/build/codec-matrix  built  (for C)
#
# Env overrides:
#   RUN_ID                  — UTC timestamp; auto-generated if absent
#   SGLANG_URL              — default http://192.168.1.88:30002
#   VLLM_URL                — default http://192.168.1.88:30003
#   LLAMACPP_URL            — default http://192.168.1.88:30004
#   VLLM_REPS               — default 4 (per the documented scheduler-variance mitigation)
#   SKIP_TRANSLATOR         — 1 to skip; default 0
#   SKIP_AGENT_MCP          — 1 to skip metamcp + leaf paths (requires metamcp); default 0
#   SKIP_SEARXNG            — 1 to skip the searxng agent-loop path; default 0
#   FAIL_FAST               — 1 to exit on first surface failure; default 0 (report all)
#
# Exit codes:
#   0   — all surfaces ran cleanly
#   1   — one or more surfaces failed (summary printed at end)
#   2   — pre-flight error (missing toolchain, unreachable engine, etc.)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

# ── Args + env ─────────────────────────────────────────────────────────────

RUN_ID="${1:-${RUN_ID:-$(date -u +"%Y-%m-%dT%H-%M-%SZ")}}"
SGLANG_URL="${SGLANG_URL:-http://192.168.1.88:30002}"
VLLM_URL="${VLLM_URL:-http://192.168.1.88:30003}"
LLAMACPP_URL="${LLAMACPP_URL:-http://192.168.1.88:30004}"
VLLM_REPS="${VLLM_REPS:-4}"
SKIP_TRANSLATOR="${SKIP_TRANSLATOR:-0}"
SKIP_AGENT_MCP="${SKIP_AGENT_MCP:-0}"
SKIP_SEARXNG="${SKIP_SEARXNG:-0}"
FAIL_FAST="${FAIL_FAST:-0}"

RESULTS_DIR="packages/bench/results/$RUN_ID"
METHOD_DIR="packages/bench/methodology/$RUN_ID"
mkdir -p "$RESULTS_DIR/agent-loop" "$METHOD_DIR"

# Tracking
declare -A SURFACE_STATUS
FAILED_SURFACES=()

run_surface() {
    local name="$1"; shift
    echo
    echo "================================================================"
    echo "  surface: $name"
    echo "  cmd:     $*"
    echo "================================================================"
    if "$@"; then
        SURFACE_STATUS[$name]="ok"
        echo "[$name] OK"
    else
        local code=$?
        SURFACE_STATUS[$name]="FAIL(exit=$code)"
        FAILED_SURFACES+=("$name")
        echo "[$name] FAIL (exit=$code)"
        [ "$FAIL_FAST" = "1" ] && { echo "FAIL_FAST=1; aborting."; report; exit 1; }
    fi
}

report() {
    echo
    echo "================================================================"
    echo "  release-bench summary — RUN_ID=$RUN_ID"
    echo "================================================================"
    for name in "${!SURFACE_STATUS[@]}"; do
        printf "  %-40s %s\n" "$name" "${SURFACE_STATUS[$name]}"
    done
    echo
    if [ "${#FAILED_SURFACES[@]}" -eq 0 ]; then
        echo "  RESULT: all surfaces passed."
    else
        echo "  RESULT: ${#FAILED_SURFACES[@]} surface(s) failed: ${FAILED_SURFACES[*]}"
    fi
    echo
}

# ── Pre-flight ─────────────────────────────────────────────────────────────

echo "release-bench.sh — RUN_ID=$RUN_ID"
echo

# Engine endpoints reachable?
for url in "$SGLANG_URL" "$VLLM_URL" "$LLAMACPP_URL"; do
    if ! curl -fsS -m 5 "$url/health" | grep -q '"backend_running":true'; then
        echo "PRE-FLIGHT FAIL: $url is not healthy (need backend_running:true)" >&2
        exit 2
    fi
done

# venv?
if [ ! -x .venv/bin/python ]; then
    echo "PRE-FLIGHT FAIL: .venv/bin/python missing" >&2
    exit 2
fi

# Java?
if [ ! -x "$HOME/jdk/bin/java" ]; then
    echo "WARN: $HOME/jdk/bin/java missing; Java bench cells will fail" >&2
fi

# .NET self-contained binary?
if [ ! -x packages/demo-dotnet/bin/Release/net8.0/codec-bench ]; then
    echo "WARN: dotnet release binary missing; .NET bench cells will fail" >&2
fi

# Rust release binary?
if [ ! -x packages/demo-rust/target/release/codec-bench ]; then
    echo "WARN: rust release binary missing; Rust bench cells will fail" >&2
fi

# C release binary?
if [ ! -x packages/demo-c/build/codec-matrix ]; then
    echo "WARN: packages/demo-c/build/codec-matrix missing; C bench cells will fail" >&2
fi

# Java jar?
if [ ! -f packages/demo-java/target/codec-bench.jar ]; then
    echo "WARN: java jar missing; Java bench cells will fail" >&2
fi

# ── 1. Methodology capture (one per engine) ────────────────────────────────

run_surface "methodology:sglang" \
    .venv/bin/python packages/bench/scripts/capture_methodology.py \
        --engine sglang --endpoint "$SGLANG_URL" \
        --model Qwen/Qwen2.5-0.5B-Instruct \
        --run-id "$RUN_ID" --quantization fp16 \
        --notes "release-bench.sh auto-run"

run_surface "methodology:vllm" \
    .venv/bin/python packages/bench/scripts/capture_methodology.py \
        --engine vllm --endpoint "$VLLM_URL" \
        --model Qwen/Qwen2.5-0.5B-Instruct \
        --run-id "$RUN_ID" --quantization fp16 \
        --notes "release-bench.sh auto-run"

run_surface "methodology:llama.cpp" \
    .venv/bin/python packages/bench/scripts/capture_methodology.py \
        --engine llama.cpp --endpoint "$LLAMACPP_URL" \
        --model Qwen/Qwen2.5-0.5B-Instruct \
        --run-id "$RUN_ID" --quantization fp16 \
        --notes "release-bench.sh auto-run"

# ── 2. §1 synthetic wire bench ─────────────────────────────────────────────

run_surface "§1 synthetic" \
    .venv/bin/python packages/bench/scripts/synthetic_wire_bench.py "$RUN_ID"

# ── 3. §3 cross-stack matrix × 3 engines ───────────────────────────────────

run_surface "§3 sglang"    bash packages/bench/scripts/run-all-langs.sh "$RUN_ID" sglang
REPS="$VLLM_REPS" \
    run_surface "§3 vllm (REPS=$VLLM_REPS)"  bash packages/bench/scripts/run-all-langs.sh "$RUN_ID" vllm
run_surface "§3 llama.cpp" bash packages/bench/scripts/run-all-langs.sh "$RUN_ID" llama.cpp

# ── 4. §3.5 per-language token bench ───────────────────────────────────────
# Args: RUN_ID MAP CORPUS REPS
# Maps + corpus live under packages/bench/golden/. We use the qwen2 map + golden corpus.

TOKEN_MAP="packages/bench/golden/qwen/qwen2.json"
TOKEN_CORPUS="packages/bench/golden/qwen2.json"

if [ -f "$TOKEN_MAP" ] && [ -f "$TOKEN_CORPUS" ]; then
    run_surface "§3.5 token-bench" \
        bash packages/bench/scripts/run-all-token-benches.sh "$RUN_ID" "$TOKEN_MAP" "$TOKEN_CORPUS"
else
    echo "SKIP token-bench: $TOKEN_MAP or $TOKEN_CORPUS not found"
    SURFACE_STATUS["§3.5 token-bench"]="SKIPPED(missing-fixtures)"
fi

# ── 5. §3.5 cross-vocab translator bench ───────────────────────────────────

if [ "$SKIP_TRANSLATOR" = "1" ]; then
    SURFACE_STATUS["§3.5 translator"]="SKIPPED(env)"
    echo "SKIP translator: SKIP_TRANSLATOR=1"
else
    mkdir -p "$RESULTS_DIR/translator"
    run_surface "§3.5 translator" \
        .venv/bin/python packages/bench/scripts/translator_bench.py \
            --out "$RESULTS_DIR/translator/python.json"
fi

# ── 6. §3.5 agent-loop end-to-end ──────────────────────────────────────────
# Each variant captures stdout to a .txt; agent_bench prints a results table.
# Variants are differentiated by URL/prompt; the agent_bench module uses the
# same dispatch surface for all (mock/searxng/metamcp) per the dispatch
# registry in packages/demo-python/src/codec_demo/agent_bench.py.

run_surface "§3.5 agent-loop:mock" bash -c "
    .venv/bin/python -m codec_demo.agent_bench \
        --url '$SGLANG_URL' \
        --model Qwen/Qwen2.5-0.5B-Instruct \
        --prompt 'What is the weather in Tokyo?' \
        > '$RESULTS_DIR/agent-loop/mock.txt' 2>&1
"

if [ "$SKIP_SEARXNG" = "1" ]; then
    SURFACE_STATUS["§3.5 agent-loop:searxng"]="SKIPPED(env)"
    echo "SKIP agent-loop:searxng: SKIP_SEARXNG=1"
else
    run_surface "§3.5 agent-loop:searxng" bash -c "
        .venv/bin/python -m codec_demo.agent_bench \
            --url '$SGLANG_URL' \
            --model Qwen/Qwen2.5-0.5B-Instruct \
            --prompt 'Search the web for the latest news about Anthropic Claude.' \
            > '$RESULTS_DIR/agent-loop/searxng.txt' 2>&1
    "
fi

if [ "$SKIP_AGENT_MCP" = "1" ]; then
    SURFACE_STATUS["§3.5 agent-loop:metamcp"]="SKIPPED(env)"
    SURFACE_STATUS["§3.5 leaf-microbench"]="SKIPPED(env)"
    echo "SKIP agent-loop:metamcp + leaf: SKIP_AGENT_MCP=1"
else
    run_surface "§3.5 agent-loop:metamcp" bash -c "
        .venv/bin/python -m codec_demo.agent_bench \
            --url '$SGLANG_URL' \
            --model Qwen/Qwen2.5-0.5B-Instruct \
            --prompt 'What time is it in UTC?' \
            > '$RESULTS_DIR/agent-loop/metamcp.txt' 2>&1
    "

    # leaf-live.ts via npx tsx
    if command -v npx >/dev/null; then
        run_surface "§3.5 leaf-microbench" bash -c "
            cd packages/bench && \
            npx -y tsx src/leaf-live.ts \
                > '../../$RESULTS_DIR/agent-loop/leaf.txt' 2>&1
        "
    else
        SURFACE_STATUS["§3.5 leaf-microbench"]="SKIPPED(no-npx)"
    fi
fi

# ── 7. Aggregate ───────────────────────────────────────────────────────────

run_surface "aggregate -> MATRIX.md" \
    .venv/bin/python packages/bench/scripts/aggregate.py "$RUN_ID"

# ── Done ───────────────────────────────────────────────────────────────────

report

if [ "${#FAILED_SURFACES[@]}" -eq 0 ]; then
    exit 0
else
    exit 1
fi

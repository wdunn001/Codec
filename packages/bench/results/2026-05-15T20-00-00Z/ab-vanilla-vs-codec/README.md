# Vanilla sglang vs Codec-patched sglang — A/B verdict

**Result for v0.4.1: byte-identical by construction. No runtime A/B was rerun.**

## Why a runtime A/B isn't needed for v0.4.1

The Codec patches to `wdunn001/sglang` are **purely additive**. They introduce
new code paths without modifying the existing JSON-SSE pipeline:

| Code path                                        | Touched by Codec patches? |
|--------------------------------------------------|---------------------------|
| `serving_completions.py` JSON-SSE response       | NO — vanilla code path unchanged |
| `chat/completions` JSON-SSE                      | NO — vanilla unchanged |
| `serving_completions.py` `stream_format="msgpack"` dispatch | YES — new branch added |
| `serving_completions.py` `stream_format="protobuf"` dispatch | YES — new branch added |
| `/v1/completions/codec` (bidirectional binary)   | YES — new endpoint |
| `codec_frame.py`                                 | NEW file (added by patch) |
| `codec_compression.py`                           | NEW file (added by patch) |
| `codec_version.py`                               | NEW file (added by patch) |
| `codec_agent.py`                                 | NEW file (added by patch) |

The Codec branch in `serving_completions.py` is gated on the request's
`stream_format` field. When a request comes in without that field (or with
`stream_format="json"`), the dispatch falls through to the vanilla path
verbatim — the JSON-SSE bytes are produced by code the patches never touched.

**v0.4.1 specifically** changed only `codec_compression.py` (the brotli
per-chunk-flush fix) and added `codec_zstd_dict_registry` to llama.cpp.
Both of those are exclusively in the Codec axes; neither touches JSON-SSE
generation.

Therefore: the JSON-SSE wire bytes from `wdunn001/codec-sglang:v0.4.1` for
any given prompt are byte-identical to the JSON-SSE wire bytes from
`lmsysorg/sglang:nightly-dev-cu12-20260506-22cf7d2b` (the base image) for
the same prompt. This is true by construction; the prior runtime A/B
(captured at v0.3.x in `results/2026-05-08T01-15-02Z/sglang/agent_bench_mock.txt`
et al.) confirmed it empirically. No code in the JSON-SSE pipeline has
changed in v0.4 or v0.4.1 that would alter that property.

## When this assumption needs revisiting

A future Codec cut that modifies any of the following would invalidate
the structural-equivalence argument and require a fresh runtime A/B:

- Any change to `serving_completions.py` outside the `if request.stream_format != "json"` branch.
- Any change to `chat/completions` SSE rendering.
- Any change to the OpenAI-compat response shape for `stream: true` requests.
- Any change to the streaming HTTP middleware (uvicorn/Starlette
  invocation, ASGI wiring).

The `release-checklist` §3 acceptance probes catch most of these
behaviorally; structural changes to those code paths should always re-fire
the A/B as a belt-and-suspenders check.

## Reference: prior runtime A/B (captured pre-v0.4.1)

Saved at `results/2026-05-08T01-15-02Z/sglang/agent_bench_mock.txt` and
referenced in `RESULTS.md` §1. JSON-SSE wire bytes were 15.2 KB on both
vanilla and Codec-patched; Codec msgpack/protobuf shapes ranged 16-69×
reduction over JSON-SSE depending on encoding. None of those JSON-SSE
numbers can have shifted in v0.4.1 because the code that produces them
is unchanged.

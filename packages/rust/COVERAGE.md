# codec-rs — coverage

Last measured: 2026-05-11 (v0.4 release-cut). Quantitative number
pending — see "How" below.

## How (wiring needed locally)

```
cargo install cargo-llvm-cov  # one-time
cd packages/rust
cargo llvm-cov --workspace --html
cargo llvm-cov --workspace --summary-only
```

The above wasn't run for this cut because `cargo-llvm-cov` isn't
installed on the box that produced the v0.4 release artifacts.
Tracked as a v0.5 follow-up. The test count is captured here as a
floor: every test below passes.

## Result (v0.4 baseline — test count as floor)

All 7 test files pass:

| File                    | Tests | Notes                                             |
|-------------------------|------:|---------------------------------------------------|
| `tests/bpe_tests.rs`    |     7 | qwen / p50k / o200k / mistral-nemo parity tests   |
| `tests/detokenize_tests.rs` |   3 |                                                   |
| `tests/translator_tests.rs` |   1 |                                                   |
| `tests/tool_watcher_tests.rs` | 5 |                                                   |
| `tests/safety_policy_tests.rs` | 8 | descriptor parse + hash + load + discovery       |
| `tests/stream_tests.rs` |     3 |                                                   |
| `tests/map_tests.rs`    |  many | (count varies; see `cargo test`)                  |
| `pretok_program::tests` |     3 | inline unit tests in src/pretok_program.rs        |

Plus a documented gap: BPETokenizer construction against Qwen-2 /
Llama-3 / Phi-4 / cl100k_base / p50k_base maps was previously
*unbuildable* because the `regex` crate doesn't support `(?i:...)`
inline-flag groups or `\s+(?!\S)` lookahead. v0.4 ports
`pre_tokenizer_program` (see `pretok_program.rs`) so the Rust BPE
now bypasses the regex path entirely on those maps. Tests
`p50k_base_round_trips_via_lead_space_program_ops`,
`chat_template_and_fim_specials_emit_atomic_ids`,
`o200k_base_case_aware_splits_via_letters_cased`, and
`mistral_nemo_case_aware_splits_via_letters_cased` cover the new
op set.

## Intentionally uncovered

- BPE encoder against maps without `pre_tokenizer_program` whose
  regex pattern the `regex` crate rejects (lookaround / inline
  flags). Currently the BPETokenizer::new() errors with a clear
  message pointing to the durable fix (regen the map with
  `pre_tokenizer_program`). Tested via the error-path test
  separately.

## v0.5 follow-up

- Install `cargo-llvm-cov` on the bench box, capture % per module,
  fail-on-regression in CI.
- Add a dedicated `tests/pretok_program_tests.rs` that walks the
  full GPT-2-family op set against a synthetic 100-input corpus
  (currently the inline `mod tests` covers 3 inputs; more inputs
  give better branch-coverage signal).

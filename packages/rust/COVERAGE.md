# codec-rs: coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

```
cargo install cargo-llvm-cov  # one-time
cd packages/rust
cargo llvm-cov --workspace --summary-only
cargo llvm-cov --workspace --html  # full HTML report
```

## Result (v0.4 baseline)

```
Lines     : 65.34% (2406 lines, 834 missed)
Functions : 74.44% (223 functions, 57 missed)
Regions   : 68.34% (3992 regions, 1264 missed)
```

| File              |  Line cov | Notes                                                   |
|-------------------|----------:|---------------------------------------------------------|
| `byte_encoder.rs` |    90.91% | GPT-2 byte↔unicode table                                 |
| `tool_watcher.rs` |    92.31% |                                                         |
| `map.rs`          |    64.71% | TokenizerMap deserialization + special-token utilities  |
| `detokenize.rs`   |    82.89% |                                                         |
| `pretok_program.rs`|   83.03% | new in v0.4: all 8 op types (literals_ci, literals, letters, letters_cased, numbers, punct_run, newline_block, trailing_ws, ws_run, metaspace_split) |
| `tokenize.rs`     |    68.18% | BPE encoder incl. new special-token pre-scan            |
| `stream.rs`       |    58.04% | msgpack + protobuf decoders                              |
| `safety_policy.rs`|    57.02% | new in v0.4: descriptor parse + hash + load + discover |
| `translator.rs`   |    45.54% | cross-vocab translator                                  |
| `longest_match.rs`|    62.39% | fallback tokenizer for canonical-IR maps                |
| `map_loader.rs`   |    21.43% | http feature: most paths require live origins         |
| `frame.rs`        |    21.43% | mostly types; tested transitively via the matcher       |

## Intentionally uncovered

- `map_loader.rs` (21%): the `http` feature hits live origins
  (jsdelivr / well-known) and isn't exercised by `cargo test` unless
  network is reachable. Covered by the lab cross-stack matrix.
- `frame.rs` (21%): mostly serde-derived type definitions whose
  branches are exercised transitively through encode/decode paths in
  `stream.rs` and `tool_watcher.rs`. The bare type-construction
  branches aren't directly tested.
- `safety_policy.rs` (57%): descriptor-write and pointer-mode
  discovery branches; v0.5 will add fixtures parallel to the TS
  package's coverage gaps.

## v0.5 follow-up

- Cover `translator.rs` cross-vocab paths with real Llama-3↔Qwen-2
  fixtures (45% line coverage is a real gap).
- Lift `safety_policy.rs` toward the 88-90% the TS/Python ports have.
- Wire `cargo llvm-cov` into CI; fail on regression vs the 65.34%
  line baseline.
- Add `cargo llvm-cov --no-default-features` run alongside. The
  no-`http`-feature line coverage is captured separately as a result.

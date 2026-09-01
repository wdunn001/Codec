# libcodec: coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

`CMakeLists.txt` declares an opt-in `CODEC_COVERAGE` option (added
2026-05-11 for the v0.4 cut). Build with that on, run tests, then
extract a report with `gcovr` or `lcov`:

```
cd packages/c
cmake -S . -B build-cov -DCODEC_COVERAGE=ON -DCODEC_BUILD_TESTS=ON
cmake --build build-cov
ctest --test-dir build-cov

# gcovr: pip-installable, prints per-file table + total
gcovr --root . --exclude "test/.*" --exclude "examples/.*" --print-summary
# or HTML:
gcovr --root . --exclude "test/.*" --exclude "examples/.*" --html-details coverage/index.html

# lcov: distro-packaged, traditional Linux choice
lcov --capture --directory build-cov --output-file coverage.info
genhtml coverage.info --output-directory coverage_html
```

## Result (v0.4 baseline)

```
lines:     83.8%  (2082 / 2485 covered)
functions: 95.8%  (181 / 189 covered)
branches:  57.6%  (1437 / 2495 covered)
10 tests passed
```

| File              | Line cov | Notes                                                  |
|-------------------|---------:|--------------------------------------------------------|
| `tool_watcher.c`  |      89% |                                                        |
| `translator.c`    |      89% |                                                        |
| `sha256.c`        |      89% | vendored public-domain                                 |
| `stream.c`        |      71% | msgpack + protobuf decoders                            |
| (others)          |   80-95% | detokenize, codec_frame, jsmn-wrapper, map, encoder    |

## Intentionally uncovered

- **No BPE encoder yet**: libcodec ships detokenize-only for v0.4
  (per the top-level README's polyglot table). BPE encoder + Translator
  encode-path are v0.5+ work pending Unicode-property tables and a
  port of the pre_tokenizer_program runtime (already ported to TS
  / Rust this session, libcodec follows).
- Examples are excluded from coverage (they're documentation, distinct from
  library code).
- `MapLoader` / well-known fetch is not in libcodec: discovery is
  a higher-level concern handled by callers.

## v0.5 follow-up

- The 57.6% branch coverage is the main gap: many functions cover
  every line but not every error / fallback branch. Target: 80%+
  branch coverage by v0.5.
- Wire CI to compute % per file + fail on regression vs the 83.8%
  line baseline.
- When the BPE encoder lands, its pre-tokenizer-program runtime will
  need parity-coverage fixtures with TS / Rust (the 7 BPE tests in
  Rust's `bpe_tests.rs` are the bar).

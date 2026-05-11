# libcodec — coverage

Last measured: 2026-05-11 (v0.4 release-cut). Quantitative number
pending — see "How" below.

## How (wiring needed)

```
cd packages/c
cmake -S . -B build -DCMAKE_C_FLAGS="--coverage" -DCMAKE_EXE_LINKER_FLAGS="--coverage"
cmake --build build
ctest --test-dir build
# gcov / lcov
gcov build/CMakeFiles/codec_static.dir/src/*.gcda
# or
lcov --capture --directory build --output-file coverage.info
genhtml coverage.info --output-directory coverage_html
```

The above wasn't run for this cut — gcov / lcov aren't part of the
CMakeLists yet, and the libcurl-optional flag in `demo-c/CMakeLists.txt`
that was added this session is the only build-system change in v0.4.
Tracked as a v0.5 follow-up.

## Result (v0.4 baseline — test count as floor)

`packages/c/test/` runs via `ctest`. Counts:

| Test file                            | Tests |
|--------------------------------------|------:|
| `test_map.c`                         |  ~5  |
| `test_detokenize.c`                  |  ~6  |
| `test_stream.c`                      |  ~4  |
| `test_tool_watcher.c`                |  ~6  |
| `test_safety_policy.c`               |    8 | (new in v0.4)

(Run `ctest --test-dir build --verbose` for the authoritative count.
The numbers above are approximate; CI will pin them.)

## Intentionally uncovered

- **BPE encoder**: libcodec ships detokenize-only for v0.4 (per the
  top-level README's polyglot table). BPE encoding is a v0.5+ work
  item — pending Unicode-property tables and the pre_tokenizer_program
  runtime port (already ported to TS / Rust this session).
- **Translator**: also pending the BPE encoder.

## v0.5 follow-up

- Add `--coverage` flags + gcov/lcov targets to CMakeLists; wire
  CI to gate on the report.
- BPE encoder + Translator (the two missing surfaces vs the other
  five clients). Pretty much everything else (frame decoders,
  detokenizer, tool watcher, safety descriptor parser, stream
  decoders) is at parity.

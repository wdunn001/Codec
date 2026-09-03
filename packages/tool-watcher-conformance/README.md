# ToolWatcher conformance fixtures

`fixtures/tool-watcher-events.json` is the single source of truth for the
event stream every Codec `ToolWatcher` implementation (C, TypeScript,
Python, Rust, .NET, Java) must produce. When the event contract changes,
edit this file first. Then update every language's tests to match. A
change here without a matching change in all six implementations is a
regression.

## Why this file exists

The ToolWatcher implementations grew independently. C and TypeScript
already emitted interleaved, stream-ordered events. A server-side Python
variant elsewhere flattened everything into two separate lists, losing
each event's position. Hand-written per-language unit tests never
compared the implementations against each other. Nobody caught the
divergence. This file is what every language's tests compare against
now. Drift between implementations surfaces here as a test failure. It
would otherwise surface later, in production, as a bug report.

## Schema

```jsonc
{
  "start_id": 90,   // the watcher's start marker ID for every case below
  "end_id": 91,     // the watcher's end marker ID for every case below
  "cases": [
    {
      "name": "…",                 // stable, descriptive, snake_case
      "region_cap": null,          // null = use the language's default cap; a number = call the cap setter/constructor arg with that value before feeding
      "feeds": [[…], […], …],      // one array of token IDs per feed() call, in order
      "end": null,                 // null = do not call end(); otherwise an object
      // "end": { "finish_reason": "length" | null } = call end(finish_reason) once, after the last feed()
      "events": [                  // the expected events, in order: every feed() call's
                                    // events concatenated, in order, followed by end()'s
                                    // events (if "end" is non-null)
        { "kind": "passthrough", "ids": […] },
        { "kind": "region", "ids": […] },
        { "kind": "truncated", "ids": […], "finish_reason": "length" | null },
        { "kind": "overflow", "ids": […] },
        { "kind": "nested_start", "ids": […] }
      ]
    }
  ]
}
```

Notes:

- `finish_reason` only ever appears on `truncated` events. It is absent
  (or `null`, both mean the same thing) on every other kind.
- `ids` is always present and is `[]` (not omitted) when a region closed,
  overflowed, or was truncated with an empty body.
- A test harness runs every entry in `feeds` through `feed()` in order,
  collects the returned events, then (if `end` is non-null) calls `end()`
  with `finish_reason` and appends its events. The concatenated list must
  equal `events` exactly: same length, same order, same kind, same `ids`,
  same `finish_reason`.

## How each language uses this file

- Six loaders read this file directly and iterate `cases`. A new case
  added here is picked up by all six automatically. None of the six test
  files need to change for that to happen.
  - TypeScript: `packages/web/test/tool-watcher.test.ts`
  - Python: `packages/python/tests/test_tool_watcher.py`
  - Rust: `packages/rust/tests/tool_watcher_fixture_tests.rs`
  - Java: `packages/java/src/test/java/ai/codec/ToolWatcherFixtureTests.java`
  - .NET: `packages/dotnet/test/Codec.Net.Tests/ToolWatcherFixtureTests.cs`
  - C: `packages/c/test/test_tool_watcher_fixture.c`
- Rust uses `serde_json`, already a runtime dependency. Java uses
  Jackson (`ObjectMapper`/`JsonNode`), already a runtime dependency.
  .NET uses `System.Text.Json`, part of the BCL: no new package. C
  parses the fixture at test time with the `jsmn` parser it already
  vendors (`src/jsmn.h`, guarded by `src/codec_jsmn_guard.h`) for
  `map.c`, `codec_safety_policy.c`, `codec_version_signaling.c`. It
  reaches jsmn's declarations from the
  test binary the same way those other two C source files do: `#define
  JSMN_HEADER` before `#include "jsmn.h"`. None of the four added a new
  dependency to get this.
- Each of the six languages also keeps its pre-existing hand-written
  tests, additive to the fixture-driven tests: `tool-watcher.test.ts`'s
  non-fixture tests, `test_tool_watcher.py`'s non-fixture tests,
  `tool_watcher_tests.rs`, `ToolWatcherTests.java`, `ToolWatcherTests.cs`,
  `test_tool_watcher.c`. Those cover language-specific concerns a
  generic fixture loop can't exercise: the `int`/`i32` overloads,
  exception and error types, memory ownership. For C specifically that
  means arena reallocation across regions inside a single `feed()` call.
  It also means the zero-copy-passthrough / regions-in-the-arena
  pointer contract.
- C's fixture loader (`test_tool_watcher_fixture.c`) is wired into
  CMake/CTest the same way every other C unit test is. See
  `packages/c/test/CMakeLists.txt`. It points the loader at this file
  through the `CODEC_FIXTURE_PATH` environment variable.
  `codec_tool_watcher` hands back events whose `ids` alias either the
  caller's feed buffer (`PASSTHROUGH`, `NESTED_START`) or the watcher's
  own arena (`REGION_END`, `REGION_TRUNCATED`, `REGION_OVERFLOW`). Both
  kinds of pointer stay valid only until the *next* `feed()`/`end()`
  call. The loader deep-copies every event immediately after each call,
  before advancing to the next one, to respect that. Getting this wrong
  would not surface as a crash where the actual bug is. It would surface
  as a fixture mismatch, or silently as a read of freed or reused memory.
  That is exactly the class of defect ASan and UBSan are run to catch.
- Until this file was written, C was the only one of the six still
  hand-mirroring the fixture. `test_tool_watcher.c`'s cases were copied
  over by hand: by name, by the shape of the input, by the shape of the
  expected events. A human kept them in sync. That gap is why C was the
  one that missed a real defect. `emit_region()` skipped zero-length
  spans. A start marker immediately followed by an end marker, an empty
  tool call, therefore emitted no event at all in C. The other five
  languages all emitted `REGION_END` with an empty body for that same
  input. The fixture grew from 12 cases to 15 to cover it: the
  `empty_region_*` family. The hand mirror's tests all still passed
  regardless. The fixture had not covered that shape at the time the
  mirror was written. A mirror only covers what the fixture covered
  when someone last updated it. A generic loader cannot carry that
  class of gap. It runs whatever `cases` the fixture contains. A new
  case is exercised the moment it is added here.

## Adding a case

1. Add the case to `fixtures/tool-watcher-events.json`.
2. All six languages' fixture-driven tests pick it up automatically. No
   test-file change is needed for the generic pass/fail. Add a targeted
   assertion in the relevant hand-written test file too, for cases where
   a generic loop failure wouldn't explain what broke.
3. Run every language's test suite you can run locally. State plainly
   which ones you could not run. State why.

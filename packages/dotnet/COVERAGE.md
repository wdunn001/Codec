# Codec.Net — coverage

Last measured: 2026-05-11 (v0.4 release-cut). Quantitative number
pending — see "How" below.

## How (wiring needed)

```
cd packages/dotnet
dotnet add test/Codec.Net.Tests package coverlet.collector  # one-time
dotnet test --collect:"XPlat Code Coverage"
# coverage report under test/Codec.Net.Tests/TestResults/*/coverage.cobertura.xml
```

For human-readable output:

```
dotnet tool install -g dotnet-reportgenerator-globaltool  # one-time
reportgenerator -reports:**/coverage.cobertura.xml -targetdir:coveragereport
```

The above wasn't fully wired for this cut — the test project doesn't
yet reference `coverlet.collector`. `dotnet test --collect:"XPlat Code
Coverage"` runs without error but emits no coverage file because
the collector isn't loaded. Tracked as a v0.5 follow-up; the test
count is captured here as a floor.

## Result (v0.4 baseline — test count as floor)

```
Passed!  - Failed: 0, Passed: 48, Skipped: 4, Total: 52
```

| Test file                            | Tests | Notes                                                  |
|--------------------------------------|------:|--------------------------------------------------------|
| `BPETests.cs`                        |     8 | chat-template specials, p50k, o200k, mistral-nemo     |
| `DetokenizerTests.cs`                |     8 |                                                        |
| `StreamDecoderTests.cs`              |     4 |                                                        |
| `ToolWatcherTests.cs`                |     5 |                                                        |
| `TranslatorTests.cs`                 |     3 |                                                        |
| `SafetyPolicyTests.cs`               |    16 | new in v0.4 — descriptor parse, hash, load, discovery |
| `MapLoaderTests.cs`                  |     4 |                                                        |

(4 skipped are the cross-vocab fixtures that need a Llama-3 map
present locally.)

## Intentionally uncovered

- 4 cross-vocab Translator tests skip without a Llama-3 map.

## v0.5 follow-up

- Add `coverlet.collector` ProjectReference to the test csproj
  so `dotnet test --collect:"XPlat Code Coverage"` actually emits
  the Cobertura XML report.
- Wire CI to compute % and fail on regression.

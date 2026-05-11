# Codec.Net — coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

```
cd packages/dotnet
dotnet test --collect:"XPlat Code Coverage"
# coverage report under test/Codec.Net.Tests/TestResults/<guid>/coverage.cobertura.xml
```

Test project references `coverlet.collector` 6.0.4 (added 2026-05-11
for the v0.4 cut). The `XPlat Code Coverage` collector is part of
that package.

For human-readable HTML output:

```
dotnet tool install -g dotnet-reportgenerator-globaltool  # one-time
reportgenerator -reports:**/coverage.cobertura.xml -targetdir:coveragereport
```

## Result (v0.4 baseline)

```
Line coverage:    75.40%
Branch coverage:  63.25%
48 passed, 4 skipped (cross-vocab Translator tests that need Llama-3 map)
```

Per-class (selected):

| Class                          | Line cov |
|--------------------------------|---------:|
| `SafetyPolicy.cs`              |     100% |  (new in v0.4 — descriptor + hash + load + discover paths) |
| `Detokenizer.cs`               |     100% / 71.9% (two split classes — primary + helper) |
| `BPETokenizer.cs`              |      84% |  (incl. new special-token pre-scan)                     |
| `ByteEncoder.cs`               |      84% |  |
| `LongestMatchTokenizer.cs`     |      75% |  |
| `CodecFrame.cs`                |      75% / 0% (helpers not exercised) |
| `MapLoader.cs`                 |       0% |  (HTTP-fetch paths not unit-tested) |

## Intentionally uncovered

- `MapLoader.cs` HTTP-fetch paths are exercised only by integration
  tests against jsdelivr / well-known origins, not by `dotnet test`.
- 4 cross-vocab Translator tests skip without a Llama-3 map.

## v0.5 follow-up

- Wire `dotnet-reportgenerator-globaltool` into a CI step that emits
  a top-level summary and gates on regression vs the 75.40% baseline.
- Cover `MapLoader.cs` with a `WireMockServer`-style fixture so the
  HTTP paths run in unit tests instead of needing live origins.

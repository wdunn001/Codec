# ai.codec:codec (Java): coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

JaCoCo is wired in `pom.xml` (added 2026-05-11 for the v0.4 cut).

```
cd packages/java
mvn test                                    # runs jacoco:prepare-agent + report
open target/site/jacoco/index.html
```

If no local Maven, build via the lab's Docker maven:

```
ssh vinez@192.168.1.88
docker run --rm -v <path>:/work -w /work maven:3.9-eclipse-temurin-17 \
    mvn -q clean test jacoco:report
```

## Result (v0.4 baseline)

```
Lines:        60% (2,244 of 5,685 missed → 60% covered)
Branches:     49% (409 of 813 missed → 49% covered)
Instructions: 60%
Methods:      ~68%
60 tests passed
```

| Test file                     | Tests |
|-------------------------------|------:|
| `BPETokenizerTests`           |     5 |
| `ByteLevelDetokenizerTests`   |     3 |
| `DetokenizerTests`            |    10 |
| `TokenizerMapTests`           |     5 |
| `MapLoaderTests`              |     5 |
| `ToolWatcherTests`            |     8 |
| `TranslatorTests`             |     4 |
| `StreamDecoderTests`          |     4 |
| `SafetyPolicyTests`           |    16 |  (new in v0.4)

## Intentionally uncovered

- `MapLoader` HTTP-fetch paths: exercised by lab integration tests
  against jsdelivr / well-known origins, never by `mvn test` alone.
- Per-class detail still needs to be filed in the v0.5 follow-up (the
  jacoco index gives line / branch / inst / method % per package but
  not per-test-file breakdown).

## v0.5 follow-up

- The 49% branch coverage is the gap to close: gate-flip behaviors
  in `BPETokenizer` (lead_other / lead_space / lead_other+trailing_ci)
  + cased-letter checkpoint backtracking in the new `letters_cased`
  paths need fixtures that exercise each combination.
- Cover `MapLoader` HTTP paths with `WireMock`-equivalent fixtures.
- Wire CI to compute % per module + fail on regression vs the 60%
  line baseline.

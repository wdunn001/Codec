# ai.codec:codec (Java) — coverage

Last measured: 2026-05-11 (v0.4 release-cut). Quantitative number
pending — see "How" below.

## How (wiring needed)

The pom doesn't yet declare `jacoco-maven-plugin`. Add to
`packages/java/pom.xml`:

```xml
<plugin>
    <groupId>org.jacoco</groupId>
    <artifactId>jacoco-maven-plugin</artifactId>
    <version>0.8.11</version>
    <executions>
        <execution><goals><goal>prepare-agent</goal></goals></execution>
        <execution>
            <id>report</id><phase>test</phase>
            <goals><goal>report</goal></goals>
        </execution>
    </executions>
</plugin>
```

Then:

```
cd packages/java
mvn test  # report in target/site/jacoco/index.html
```

The above wasn't wired for this cut. The build runs via Docker
`maven:3.9-eclipse-temurin-17` (lab has no local Maven). Tracked as
v0.5 follow-up; the test count is captured here as a floor.

## Result (v0.4 baseline — test count as floor)

```
[INFO] Tests run: 60, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
```

| Test file                            | Tests |
|--------------------------------------|------:|
| `BPETokenizerTests.java`             |     5 |
| `ByteLevelDetokenizerTests.java`     |     3 |
| `DetokenizerTests.java`              |    10 |
| `TokenizerMapTests.java`             |     5 |
| `MapLoaderTests.java`                |     5 |
| `ToolWatcherTests.java`              |     8 |
| `TranslatorTests.java`               |     4 |
| `StreamDecoderTests.java`            |     4 |
| `SafetyPolicyTests.java`             |    16 | (new in v0.4)

## v0.5 follow-up

- Wire `jacoco-maven-plugin`, capture % per package, fail-on-regression
  in CI.
- Add cross-vocab Translator tests parallel to .NET / Python / TS
  (currently 4 Translator tests vs 10+ in other clients).

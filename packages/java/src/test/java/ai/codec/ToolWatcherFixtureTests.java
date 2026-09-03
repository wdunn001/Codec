// SPDX-License-Identifier: MIT
//
// Fixture-driven ToolWatcher conformance tests.
//
// packages/tool-watcher-conformance/fixtures/tool-watcher-events.json is
// the cross-language source of truth for the event contract: every Codec
// ToolWatcher implementation must reproduce it exactly. Every case there
// runs here too, generically, so this file can't silently fall out of
// sync with it the way a hand-mirrored test can. See ToolWatcherTests.java
// for the hand-written tests covering Java-specific concerns (the int[]
// overload, exception types, etc.); those stay, this is additive.
//
// Mirrors packages/web/test/tool-watcher.test.ts and
// packages/python/tests/test_tool_watcher.py's fixture loaders. Uses
// Jackson (already a compile dependency of this module, for
// TokenizerMap parsing) to read the fixture; no new dependency added.
package ai.codec;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.File;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Objects;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.fail;

class ToolWatcherFixtureTests {

    /** One normalized event: kind name, ids, and (only for "truncated") finish reason. */
    private record NormEvent(String kind, List<Long> ids, String finishReason) {
        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof NormEvent other)) return false;
            return kind.equals(other.kind) && ids.equals(other.ids)
                    && Objects.equals(finishReason, other.finishReason);
        }
    }

    /**
     * Maps every WatcherEventKind to the fixture's string form. Exhaustive
     * switch with no default: if a new variant is ever added to the enum,
     * this fails at compile time (missing-case warning promoted nowhere,
     * but the explicit throw below covers any variant reachable only at
     * runtime through unsafe casts) rather than silently miscategorizing
     * events of the new kind.
     */
    private static String kindStr(WatcherEventKind kind) {
        return switch (kind) {
            case PASSTHROUGH -> "passthrough";
            case REGION -> "region";
            case TRUNCATED -> "truncated";
            case OVERFLOW -> "overflow";
            case NESTED_START -> "nested_start";
        };
    }

    private static List<Long> toList(long[] ids) {
        List<Long> out = new ArrayList<>(ids.length);
        for (long id : ids) out.add(id);
        return out;
    }

    private static List<NormEvent> normalize(List<WatcherEvent> events) {
        List<NormEvent> out = new ArrayList<>(events.size());
        for (WatcherEvent ev : events) {
            String kind = kindStr(ev.getKind());
            String finishReason = kind.equals("truncated") ? ev.getFinishReason() : null;
            out.add(new NormEvent(kind, toList(ev.getIds()), finishReason));
        }
        return out;
    }

    private static File findFixtureFile() {
        // Candidates cover running from the Maven/Gradle module root
        // (packages/java, the normal case) and running from the repo
        // root, plus an explicit override for anything else.
        String override = System.getenv("CODEC_FIXTURE_PATH");
        List<String> candidates = new ArrayList<>();
        if (override != null && !override.isBlank()) candidates.add(override);
        candidates.add("../tool-watcher-conformance/fixtures/tool-watcher-events.json");
        candidates.add("packages/tool-watcher-conformance/fixtures/tool-watcher-events.json");
        candidates.add("tool-watcher-conformance/fixtures/tool-watcher-events.json");

        for (String c : candidates) {
            File f = new File(c);
            if (f.isFile()) return f;
        }
        fail("could not locate tool-watcher-events.json; tried: " + candidates
                + " (cwd=" + new File(".").getAbsolutePath() + "); set CODEC_FIXTURE_PATH to override");
        throw new AssertionError("unreachable");
    }

    private static JsonNode loadFixture() {
        File f = findFixtureFile();
        try {
            return new ObjectMapper().readTree(f);
        } catch (IOException e) {
            throw new UncheckedIOException("failed to parse fixture at " + f.getAbsolutePath(), e);
        }
    }

    private static TokenizerMap fixtureMap(long startId, long endId) {
        TokenizerMap m = new TokenizerMap();
        m.id = "test/fixture";
        m.version = "2";
        m.vocabSize = 100;
        m.encoder = "byte_level";
        m.vocab = new HashMap<>();
        m.specialTokens = new HashMap<>();
        m.specialTokens.put("<start>", (int) startId);
        m.specialTokens.put("<end>", (int) endId);
        return m;
    }

    private static long[] toLongArray(JsonNode arr) {
        long[] out = new long[arr.size()];
        for (int i = 0; i < arr.size(); i++) out[i] = arr.get(i).asLong();
        return out;
    }

    @TestFactory
    Stream<DynamicTest> fixtureCases() {
        JsonNode fixture = loadFixture();
        long startId = fixture.get("start_id").asLong();
        long endId = fixture.get("end_id").asLong();
        JsonNode cases = fixture.get("cases");
        assertFalse(cases == null || cases.isEmpty(), "fixture loaded but has no cases; loader is broken");

        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : cases) {
            String name = c.get("name").asText();
            tests.add(DynamicTest.dynamicTest("fixture: " + name, () -> runCase(c, startId, endId)));
        }
        return tests.stream();
    }

    private static void runCase(JsonNode c, long startId, long endId) {
        JsonNode regionCapNode = c.get("region_cap");
        int regionCap = (regionCapNode == null || regionCapNode.isNull())
                ? ToolWatcher.DEFAULT_REGION_CAP
                : regionCapNode.asInt();

        ToolWatcher w = new ToolWatcher(fixtureMap(startId, endId), "<start>", "<end>", regionCap);

        List<NormEvent> actual = new ArrayList<>();
        for (JsonNode feed : c.get("feeds")) {
            actual.addAll(normalize(w.feed(toLongArray(feed))));
        }
        JsonNode end = c.get("end");
        if (end != null && !end.isNull()) {
            JsonNode frNode = end.get("finish_reason");
            String finishReason = (frNode == null || frNode.isNull()) ? null : frNode.asText();
            actual.addAll(normalize(w.end(finishReason)));
        }

        List<NormEvent> expected = new ArrayList<>();
        for (JsonNode e : c.get("events")) {
            String kind = e.get("kind").asText();
            long[] ids = toLongArray(e.get("ids"));
            String finishReason = null;
            if (kind.equals("truncated")) {
                JsonNode frNode = e.get("finish_reason");
                finishReason = (frNode == null || frNode.isNull()) ? null : frNode.asText();
            }
            expected.add(new NormEvent(kind, toList(ids), finishReason));
        }

        assertEquals(expected, actual, () -> "case \"" + c.get("name").asText()
                + "\": actual=" + actual + " expected=" + expected);
    }
}

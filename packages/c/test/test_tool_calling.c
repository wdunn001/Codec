/* Tool-calling block: round-trip + validation tests.
 *
 * Mirrors packages/python (TokenizerMap.tool_calling), packages/rust
 * (tests/tool_calling_block_tests.rs), and packages/web (TS interface
 * in src/types.ts) so the spec's `tool_calling` map field is exercised
 * across every client. */

#include "codec/codec.h"
#include "codec_test.h"

static const char QWEN25_MAP_JSON[] =
"{"
"  \"id\": \"qwen/qwen2\","
"  \"version\": \"2\","
"  \"vocab_size\": 151665,"
"  \"vocab\": { \"Hello\": 9707, \"\\u0120world\": 1879 },"
"  \"encoder\": \"byte_level\","
"  \"special_tokens\": { \"<tool_call>\": 151657, \"</tool_call>\": 151658 },"
"  \"tool_calling\": {"
"    \"convention\": \"qwen25\","
"    \"markers\": { \"start\": \"<tool_call>\", \"end\": \"</tool_call>\" },"
"    \"args_format\": \"json\","
"    \"result_format\": \"json\""
"  }"
"}";

static const char LLAMA3_MAP_JSON[] =
"{"
"  \"id\": \"meta-llama/llama-3\","
"  \"version\": \"2\","
"  \"vocab_size\": 128256,"
"  \"vocab\": { \"a\": 0 },"
"  \"special_tokens\": { \"<|python_tag|>\": 128010, \"<|eom_id|>\": 128008 },"
"  \"tool_calling\": {"
"    \"convention\": \"llama3\","
"    \"markers\": { \"start\": \"<|python_tag|>\", \"end\": \"<|eom_id|>\" },"
"    \"args_format\": \"python_args\","
"    \"result_format\": \"text\""
"  }"
"}";

static const char ABSENT_MAP_JSON[] =
"{ \"id\": \"plain\", \"version\": \"2\", \"vocab_size\": 1, \"vocab\": {\"a\":0} }";

static const char BAD_MARKER_JSON[] =
"{ \"id\":\"x\", \"version\":\"2\", \"vocab_size\":1, \"vocab\":{\"a\":0},"
"  \"special_tokens\": {},"
"  \"tool_calling\": { \"convention\":\"qwen25\","
"    \"markers\":{\"start\":\"<x>\",\"end\":\"</x>\"},"
"    \"args_format\":\"json\",\"result_format\":\"json\" } }";

static const char BAD_CONVENTION_JSON[] =
"{ \"id\":\"x\", \"version\":\"2\", \"vocab_size\":1, \"vocab\":{\"a\":0},"
"  \"special_tokens\": {\"<x>\":0,\"</x>\":1},"
"  \"tool_calling\": { \"convention\":\"bogus\","
"    \"markers\":{\"start\":\"<x>\",\"end\":\"</x>\"},"
"    \"args_format\":\"json\",\"result_format\":\"json\" } }";

static void test_round_trip_qwen25(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(QWEN25_MAP_JSON, sizeof(QWEN25_MAP_JSON) - 1, &m), CODEC_OK);
    const codec_tool_calling_t *tc = codec_map_tool_calling(m);
    CT_TRUE(tc != NULL);
    CT_EQ_INT((int)tc->convention,    (int)CODEC_TOOL_CALLING_CONVENTION_QWEN25);
    CT_EQ_INT((int)tc->args_format,   (int)CODEC_TOOL_CALLING_ARGS_JSON);
    CT_EQ_INT((int)tc->result_format, (int)CODEC_TOOL_CALLING_RESULT_JSON);
    CT_EQ_STR(tc->marker_start_name, "<tool_call>");
    CT_EQ_STR(tc->marker_end_name,   "</tool_call>");
    /* Markers also resolve via codec_map_special_id, since they live in
     * special_tokens: that's the spec invariant the validator enforces. */
    uint32_t id = 0;
    CT_EQ_INT(codec_map_special_id(m, "<tool_call>",  &id), CODEC_OK);
    CT_EQ_INT((int)id, 151657);
    CT_EQ_INT(codec_map_special_id(m, "</tool_call>", &id), CODEC_OK);
    CT_EQ_INT((int)id, 151658);
    codec_map_free(m);
}

static void test_round_trip_llama3_python_args(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(LLAMA3_MAP_JSON, sizeof(LLAMA3_MAP_JSON) - 1, &m), CODEC_OK);
    const codec_tool_calling_t *tc = codec_map_tool_calling(m);
    CT_TRUE(tc != NULL);
    CT_EQ_INT((int)tc->convention,    (int)CODEC_TOOL_CALLING_CONVENTION_LLAMA3);
    CT_EQ_INT((int)tc->args_format,   (int)CODEC_TOOL_CALLING_ARGS_PYTHON_ARGS);
    CT_EQ_INT((int)tc->result_format, (int)CODEC_TOOL_CALLING_RESULT_TEXT);
    CT_EQ_STR(tc->marker_start_name, "<|python_tag|>");
    CT_EQ_STR(tc->marker_end_name,   "<|eom_id|>");
    codec_map_free(m);
}

static void test_absent_round_trips_as_null(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(ABSENT_MAP_JSON, sizeof(ABSENT_MAP_JSON) - 1, &m), CODEC_OK);
    CT_TRUE(codec_map_tool_calling(m) == NULL);
    codec_map_free(m);
}

static void test_marker_must_exist_in_specials(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(BAD_MARKER_JSON, sizeof(BAD_MARKER_JSON) - 1, &m),
              CODEC_ERR_VALIDATION);
    CT_TRUE(m == NULL);
}

static void test_unknown_convention_rejected(void) {
    codec_tokenizer_map_t *m = NULL;
    CT_EQ_INT(codec_map_from_json(BAD_CONVENTION_JSON, sizeof(BAD_CONVENTION_JSON) - 1, &m),
              CODEC_ERR_VALIDATION);
    CT_TRUE(m == NULL);
}

int main(void) {
    CT_RUN(test_round_trip_qwen25);
    CT_RUN(test_round_trip_llama3_python_args);
    CT_RUN(test_absent_round_trips_as_null);
    CT_RUN(test_marker_must_exist_in_specials);
    CT_RUN(test_unknown_convention_rejected);
    CT_DONE();
}

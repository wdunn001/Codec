/* CodecFrame encode/decode tests for both wire formats. */
#include "codec/codec.h"
#include "codec_test.h"

static void test_msgpack_round_trip(void) {
    codec_frame_t in;
    codec_frame_init(&in);
    uint32_t ids[] = { 1, 2, 3, 1234567 };
    in.ids = ids;
    in.ids_len = 4;
    in.done = true;
    in.finish_reason = (char *)"stop";

    codec_buffer_t buf = {0};
    CT_EQ_INT(codec_encode_msgpack(&in, &buf), CODEC_OK);
    CT_TRUE(buf.len > 0);

    codec_frame_t out;
    size_t consumed = 0;
    CT_EQ_INT(codec_decode_msgpack(buf.data, buf.len, &out, &consumed), CODEC_OK);
    CT_EQ_SZ(consumed, buf.len);
    CT_EQ_SZ(out.ids_len, 4);
    CT_EQ_INT(out.ids[0], 1);
    CT_EQ_INT(out.ids[3], 1234567);
    CT_TRUE(out.done);
    CT_EQ_STR(out.finish_reason, "stop");

    /* Don't free `ids` (stack) or the literal finish_reason on `in`. */
    in.ids = NULL; in.ids_len = 0; in.finish_reason = NULL;
    codec_frame_destroy(&in);
    codec_frame_destroy(&out);
    codec_buffer_free(&buf);
}

static void test_msgpack_no_finish_reason(void) {
    codec_frame_t in;
    codec_frame_init(&in);
    uint32_t ids[] = { 9 };
    in.ids = ids; in.ids_len = 1; in.done = false; in.finish_reason = NULL;

    codec_buffer_t buf = {0};
    CT_EQ_INT(codec_encode_msgpack(&in, &buf), CODEC_OK);

    codec_frame_t out;
    size_t consumed = 0;
    CT_EQ_INT(codec_decode_msgpack(buf.data, buf.len, &out, &consumed), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 1);
    CT_EQ_INT(out.ids[0], 9);
    CT_TRUE(!out.done);
    CT_TRUE(out.finish_reason == NULL);

    in.ids = NULL; in.ids_len = 0;
    codec_frame_destroy(&in);
    codec_frame_destroy(&out);
    codec_buffer_free(&buf);
}

static void test_protobuf_round_trip(void) {
    codec_frame_t in;
    codec_frame_init(&in);
    uint32_t ids[] = { 100, 200, 300 };
    in.ids = ids; in.ids_len = 3; in.done = true; in.finish_reason = (char *)"length";

    codec_buffer_t buf = {0};
    CT_EQ_INT(codec_encode_protobuf(&in, &buf), CODEC_OK);
    CT_TRUE(buf.len >= 4);

    /* Strip 4-byte length prefix. */
    uint32_t flen = ((uint32_t)buf.data[0] << 24) | ((uint32_t)buf.data[1] << 16)
                  | ((uint32_t)buf.data[2] << 8)  |  (uint32_t)buf.data[3];
    CT_EQ_SZ(buf.len, 4u + flen);

    codec_frame_t out;
    CT_EQ_INT(codec_decode_protobuf_frame(buf.data + 4, flen, &out), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 3);
    CT_EQ_INT(out.ids[0], 100);
    CT_EQ_INT(out.ids[2], 300);
    CT_TRUE(out.done);
    CT_EQ_STR(out.finish_reason, "length");

    in.ids = NULL; in.ids_len = 0; in.finish_reason = NULL;
    codec_frame_destroy(&in);
    codec_frame_destroy(&out);
    codec_buffer_free(&buf);
}

static void test_protobuf_empty_ids(void) {
    /* Terminal frame with no tokens (just done=true + finish_reason). */
    codec_frame_t in; codec_frame_init(&in);
    in.done = true; in.finish_reason = (char *)"error";

    codec_buffer_t buf = {0};
    CT_EQ_INT(codec_encode_protobuf(&in, &buf), CODEC_OK);

    uint32_t flen = ((uint32_t)buf.data[0] << 24) | ((uint32_t)buf.data[1] << 16)
                  | ((uint32_t)buf.data[2] << 8)  |  (uint32_t)buf.data[3];
    codec_frame_t out;
    CT_EQ_INT(codec_decode_protobuf_frame(buf.data + 4, flen, &out), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 0);
    CT_TRUE(out.done);
    CT_EQ_STR(out.finish_reason, "error");

    in.finish_reason = NULL;
    codec_frame_destroy(&in);
    codec_frame_destroy(&out);
    codec_buffer_free(&buf);
}

/* tool_calls encode + forward-compat decode.
 * We don't expose a decoder for the tool_calls field yet (no in-tree
 * consumer needs it), but the existing decoders MUST keep parsing the
 * other fields cleanly when tool_calls is present: every shipped
 * client does the same skip-unknown-key dance. This locks that in. */
static void test_msgpack_tool_calls(void) {
    codec_frame_t in; codec_frame_init(&in);
    uint32_t ids[] = { 42 };
    in.ids = ids; in.ids_len = 1; in.done = false;
    codec_tool_call_t calls[] = {
        { /*name*/ "get_weather",
          /*arguments_json*/ "{\"city\":\"Tokyo\"}",
          /*id*/ "tc_00000001" },
        { /*name*/ NULL, /*arguments_json*/ "{}", /*id*/ NULL },
    };
    in.tool_calls = calls;
    in.tool_calls_len = 2;

    codec_buffer_t buf = {0};
    CT_EQ_INT(codec_encode_msgpack(&in, &buf), CODEC_OK);

    /* The map header is fixmap(3) = 0x83: ids/done/tool_calls (no
     * finish_reason on this frame). If this byte changes, the wire
     * shape changed. */
    CT_EQ_INT(buf.data[0], 0x83);

    /* Forward-compat: decode round-trips the known fields. tool_calls
     * is silently skipped by the decoder until a consumer needs it. */
    codec_frame_t out;
    size_t consumed = 0;
    CT_EQ_INT(codec_decode_msgpack(buf.data, buf.len, &out, &consumed), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 1);
    CT_EQ_INT(out.ids[0], 42);
    CT_TRUE(!out.done);

    in.ids = NULL; in.ids_len = 0; in.tool_calls = NULL; in.tool_calls_len = 0;
    codec_frame_destroy(&in);
    codec_frame_destroy(&out);
    codec_buffer_free(&buf);
}

static void test_protobuf_tool_calls(void) {
    codec_frame_t in; codec_frame_init(&in);
    uint32_t ids[] = { 7 };
    in.ids = ids; in.ids_len = 1; in.done = true; in.finish_reason = (char *)"stop";
    codec_tool_call_t calls[] = {
        { "search", "{\"q\":\"anthropic\"}", "tc_deadbeef" },
    };
    in.tool_calls = calls; in.tool_calls_len = 1;

    codec_buffer_t buf = {0};
    CT_EQ_INT(codec_encode_protobuf(&in, &buf), CODEC_OK);

    /* Strip 4-byte length prefix and verify a ToolCall sub-message
     * (tag 0x22 = field 4, wire-type 2) is somewhere in the payload. */
    uint32_t flen = ((uint32_t)buf.data[0] << 24) | ((uint32_t)buf.data[1] << 16)
                  | ((uint32_t)buf.data[2] << 8)  |  (uint32_t)buf.data[3];
    CT_EQ_SZ(buf.len, 4u + flen);
    int found_field4 = 0;
    for (size_t i = 4; i < buf.len; i++) {
        if (buf.data[i] == 0x22) { found_field4 = 1; break; }
    }
    CT_TRUE(found_field4);

    /* Forward-compat: existing decoder still parses ids + done + finish_reason. */
    codec_frame_t out;
    CT_EQ_INT(codec_decode_protobuf_frame(buf.data + 4, flen, &out), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 1);
    CT_EQ_INT(out.ids[0], 7);
    CT_TRUE(out.done);
    CT_EQ_STR(out.finish_reason, "stop");

    in.ids = NULL; in.ids_len = 0; in.finish_reason = NULL;
    in.tool_calls = NULL; in.tool_calls_len = 0;
    codec_frame_destroy(&in);
    codec_frame_destroy(&out);
    codec_buffer_free(&buf);
}

/* ── Hostile protobuf input ─────────────────────────────────────────────── */
/*
 * The two-pass decoder pre-scans to size the id array, then trusts that scan
 * completely on the second pass. The pre-scan bound was `scan + length > len`
 * with `scan` a size_t and `length` a uint64_t off the wire. A length
 * varint of 0xFFFFFFFFFFFFFFFF wrapped the sum and slipped past the check.
 * Pass two then ran memcpy with a SIZE_MAX count, or wrote packed ids through
 * a NULL base. Both are reachable straight from codec_protobuf_stream_next.
 */

static void test_protobuf_rejects_overflowing_length_varint(void) {
    /* tag 0x1A = field 3 (finish_reason), wire-type 2. Then a 10-byte
     * varint holding 0xFFFFFFFFFFFFFFFF, then padding to keep the pre-scan
     * landing on a byte that reads as a clean tag. */
    uint8_t frame[19];
    memset(frame, 0, sizeof frame);
    frame[0] = 0x1A;
    for (int i = 1; i <= 9; i++) frame[i] = 0xFF;
    frame[10] = 0x01;

    codec_frame_t out;
    CT_EQ_INT(codec_decode_protobuf_frame(frame, sizeof frame, &out),
              CODEC_ERR_PARSE);
    codec_frame_destroy(&out);
}

static void test_protobuf_rejects_overflowing_packed_ids_length(void) {
    /* Same overflow through field 1 (packed ids). The pre-scan counted zero
     * ids and left out->ids NULL; pass two then wrote through it. */
    uint8_t frame[19];
    memset(frame, 0, sizeof frame);
    frame[0] = 0x0A;
    for (int i = 1; i <= 9; i++) frame[i] = 0xFF;
    frame[10] = 0x01;
    for (int i = 11; i < 19; i++) frame[i] = 0x01;

    codec_frame_t out;
    CT_EQ_INT(codec_decode_protobuf_frame(frame, sizeof frame, &out),
              CODEC_ERR_PARSE);
    codec_frame_destroy(&out);
}

static void test_protobuf_rejects_truncated_length_delimited_field(void) {
    /* A plain over-long length with no overflow: field 3 claiming 200 bytes
     * inside a 5-byte frame. */
    uint8_t frame[] = { 0x1A, 0xC8, 0x01, 0x41, 0x41 };
    codec_frame_t out;
    CT_EQ_INT(codec_decode_protobuf_frame(frame, sizeof frame, &out),
              CODEC_ERR_PARSE);
    codec_frame_destroy(&out);
}

static void test_protobuf_rejects_truncated_fixed_width_fields(void) {
    /* wire-type 1 (64-bit) and 5 (32-bit) with no room left in the frame.
     * Pass two advanced pos blindly for both. */
    uint8_t f64[] = { 0x09, 0x00 };          /* field 1, wire-type 1 */
    uint8_t f32[] = { 0x0D, 0x00 };          /* field 1, wire-type 5 */
    codec_frame_t out;
    CT_EQ_INT(codec_decode_protobuf_frame(f64, sizeof f64, &out), CODEC_ERR_PARSE);
    codec_frame_destroy(&out);
    CT_EQ_INT(codec_decode_protobuf_frame(f32, sizeof f32, &out), CODEC_ERR_PARSE);
    codec_frame_destroy(&out);
}

/* ── Unbounded msgpack container nesting ────────────────────────────────── */
/*
 * Both msgpack skippers recursed once per container with no depth cap.
 * Every 0x91 byte (fixarray of one element) costs one stack frame. A run
 * of them exhausts an 8 MiB thread stack well before a megabyte of input.
 * codec_msgpack_stream_next is the worse of the two: mp_end_offset walks
 * the raw accumulated buffer before any frame is decoded. A plain run of
 * 0x91 with no valid frame in it is enough.
 */

static void test_msgpack_rejects_deep_nesting(void) {
    /* 81 A1 78 <N x 0x91> C0 is fixmap(1), key "x", deeply nested value. */
    const size_t N = 200000;
    size_t n = 3 + N + 1;
    uint8_t *b = (uint8_t *)malloc(n);
    CT_TRUE(b != NULL);
    b[0] = 0x81; b[1] = 0xA1; b[2] = 'x';
    memset(b + 3, 0x91, N);
    b[3 + N] = 0xC0;

    codec_frame_t out;
    size_t consumed = 0;
    CT_EQ_INT(codec_decode_msgpack(b, n, &out, &consumed), CODEC_ERR_PARSE);
    codec_frame_destroy(&out);
    free(b);
}

static void test_msgpack_accepts_normal_nesting(void) {
    /* The cap must not reject a real frame. Round-trip one with tool calls,
     * which is the deepest shape the wire format produces. */
    codec_frame_t in;
    codec_frame_init(&in);
    uint32_t ids[] = { 7 };
    codec_tool_call_t call = { (char *)"c1", (char *)"get_time", (char *)"{}" };
    in.ids = ids; in.ids_len = 1; in.done = true;
    in.finish_reason = (char *)"stop";
    in.tool_calls = &call; in.tool_calls_len = 1;

    codec_buffer_t buf = {0};
    CT_EQ_INT(codec_encode_msgpack(&in, &buf), CODEC_OK);
    codec_frame_t out;
    size_t consumed = 0;
    CT_EQ_INT(codec_decode_msgpack(buf.data, buf.len, &out, &consumed), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 1);

    in.ids = NULL; in.ids_len = 0; in.finish_reason = NULL;
    in.tool_calls = NULL; in.tool_calls_len = 0;
    codec_frame_destroy(&in);
    codec_frame_destroy(&out);
    codec_buffer_free(&buf);
}

int main(void) {
    CT_RUN(test_msgpack_round_trip);
    CT_RUN(test_msgpack_no_finish_reason);
    CT_RUN(test_protobuf_round_trip);
    CT_RUN(test_protobuf_empty_ids);
    CT_RUN(test_msgpack_tool_calls);
    CT_RUN(test_protobuf_tool_calls);
    CT_RUN(test_protobuf_rejects_overflowing_length_varint);
    CT_RUN(test_protobuf_rejects_overflowing_packed_ids_length);
    CT_RUN(test_protobuf_rejects_truncated_length_delimited_field);
    CT_RUN(test_protobuf_rejects_truncated_fixed_width_fields);
    CT_RUN(test_msgpack_rejects_deep_nesting);
    CT_RUN(test_msgpack_accepts_normal_nesting);
    CT_DONE();
}

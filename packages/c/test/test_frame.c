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

int main(void) {
    CT_RUN(test_msgpack_round_trip);
    CT_RUN(test_msgpack_no_finish_reason);
    CT_RUN(test_protobuf_round_trip);
    CT_RUN(test_protobuf_empty_ids);
    CT_DONE();
}

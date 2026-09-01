/* Stream decoder tests. */
#include "codec/codec.h"
#include "codec_test.h"

#include <stdlib.h>
#include <string.h>

/* ── helper: build msgpack frames using the encoder we ship ────────────── */

static void encode_frame_msgpack(uint32_t *ids, size_t n, bool done,
                                 const char *finish_reason, codec_buffer_t *out) {
    codec_frame_t f;
    codec_frame_init(&f);
    f.ids = ids; f.ids_len = n; f.done = done; f.finish_reason = (char *)finish_reason;
    CT_EQ_INT(codec_encode_msgpack(&f, out), CODEC_OK);
    /* Don't destroy: f.ids and finish_reason are caller-owned. */
}

static void encode_frame_protobuf(uint32_t *ids, size_t n, bool done,
                                  const char *finish_reason, codec_buffer_t *out) {
    codec_frame_t f;
    codec_frame_init(&f);
    f.ids = ids; f.ids_len = n; f.done = done; f.finish_reason = (char *)finish_reason;
    CT_EQ_INT(codec_encode_protobuf(&f, out), CODEC_OK);
}

/* ── msgpack ───────────────────────────────────────────────────────────── */

static void test_msgpack_in_order_and_stop(void) {
    uint32_t a[] = { 1, 2, 3 };
    uint32_t b[] = { 4, 5 };
    uint32_t c[] = { 6 };
    codec_buffer_t f1 = {0}, f2 = {0}, f3 = {0};
    encode_frame_msgpack(a, 3, false, NULL,   &f1);
    encode_frame_msgpack(b, 2, false, NULL,   &f2);
    encode_frame_msgpack(c, 1, true,  "stop", &f3);

    codec_msgpack_stream_t *s = NULL;
    CT_EQ_INT(codec_msgpack_stream_new(&s), CODEC_OK);
    CT_EQ_INT(codec_msgpack_stream_feed(s, f1.data, f1.len), CODEC_OK);
    CT_EQ_INT(codec_msgpack_stream_feed(s, f2.data, f2.len), CODEC_OK);
    CT_EQ_INT(codec_msgpack_stream_feed(s, f3.data, f3.len), CODEC_OK);

    codec_frame_t out;
    /* Frame 1 */
    CT_EQ_INT(codec_msgpack_stream_next(s, &out), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 3); CT_EQ_INT(out.ids[2], 3);
    CT_TRUE(!out.done);
    codec_frame_destroy(&out);
    /* Frame 2 */
    CT_EQ_INT(codec_msgpack_stream_next(s, &out), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 2);
    codec_frame_destroy(&out);
    /* Frame 3 (terminal) */
    CT_EQ_INT(codec_msgpack_stream_next(s, &out), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 1);
    CT_TRUE(out.done);
    CT_EQ_STR(out.finish_reason, "stop");
    codec_frame_destroy(&out);
    /* Buffer empty → next() returns CODEC_ERR_INCOMPLETE (or PARSE on EOS). */
    CT_EQ_INT(codec_msgpack_stream_next(s, &out), CODEC_ERR_INCOMPLETE);

    codec_msgpack_stream_free(s);
    codec_buffer_free(&f1); codec_buffer_free(&f2); codec_buffer_free(&f3);
}

static void test_msgpack_handles_split_frame(void) {
    uint32_t a[] = { 42, 43, 44 };
    codec_buffer_t f = {0};
    encode_frame_msgpack(a, 3, true, NULL, &f);

    codec_msgpack_stream_t *s = NULL;
    CT_EQ_INT(codec_msgpack_stream_new(&s), CODEC_OK);

    /* Feed in 1-byte chunks. After each, confirm CODEC_ERR_INCOMPLETE
     * until the final byte is appended, at which point we get a frame. */
    codec_frame_t out;
    for (size_t i = 0; i + 1 < f.len; i++) {
        CT_EQ_INT(codec_msgpack_stream_feed(s, f.data + i, 1), CODEC_OK);
        CT_EQ_INT(codec_msgpack_stream_next(s, &out), CODEC_ERR_INCOMPLETE);
    }
    CT_EQ_INT(codec_msgpack_stream_feed(s, f.data + f.len - 1, 1), CODEC_OK);
    CT_EQ_INT(codec_msgpack_stream_next(s, &out), CODEC_OK);
    CT_EQ_SZ(out.ids_len, 3);
    CT_EQ_INT(out.ids[0], 42);
    codec_frame_destroy(&out);

    codec_msgpack_stream_free(s);
    codec_buffer_free(&f);
}

/* ── protobuf ──────────────────────────────────────────────────────────── */

static void test_protobuf_chunked_reassembly(void) {
    uint32_t a[] = { 1, 2 };
    uint32_t b[] = { 3, 4 };
    uint32_t c[] = { 5 };
    codec_buffer_t f1 = {0}, f2 = {0}, f3 = {0};
    encode_frame_protobuf(a, 2, false, NULL,   &f1);
    encode_frame_protobuf(b, 2, false, NULL,   &f2);
    encode_frame_protobuf(c, 1, true,  "stop", &f3);

    /* Concatenate then chop into 7-byte chunks so frames straddle reads. */
    size_t total = f1.len + f2.len + f3.len;
    uint8_t *all = (uint8_t *)malloc(total);
    memcpy(all,                      f1.data, f1.len);
    memcpy(all + f1.len,             f2.data, f2.len);
    memcpy(all + f1.len + f2.len,    f3.data, f3.len);

    codec_protobuf_stream_t *s = NULL;
    CT_EQ_INT(codec_protobuf_stream_new(&s), CODEC_OK);

    size_t frames_seen = 0;
    for (size_t i = 0; i < total; i += 7) {
        size_t n = (i + 7 > total) ? total - i : 7;
        CT_EQ_INT(codec_protobuf_stream_feed(s, all + i, n), CODEC_OK);
        codec_frame_t out;
        while (codec_protobuf_stream_next(s, &out) == CODEC_OK) {
            frames_seen++;
            codec_frame_destroy(&out);
        }
    }
    CT_EQ_SZ(frames_seen, 3);

    codec_protobuf_stream_free(s);
    free(all);
    codec_buffer_free(&f1); codec_buffer_free(&f2); codec_buffer_free(&f3);
}

static void test_msgpack_stream_rejects_deep_nesting(void) {
    /* No valid frame at all — just a run of fixarray-of-1 headers. The
     * stream walker sizes the next frame before decoding anything, so this
     * reaches mp_end_offset directly. */
    const size_t N = 200000;
    uint8_t *b = (uint8_t *)malloc(N);
    CT_TRUE(b != NULL);
    memset(b, 0x91, N);

    codec_msgpack_stream_t *s = NULL;
    CT_EQ_INT(codec_msgpack_stream_new(&s), CODEC_OK);
    CT_EQ_INT(codec_msgpack_stream_feed(s, b, N), CODEC_OK);
    codec_frame_t out;
    CT_EQ_INT(codec_msgpack_stream_next(s, &out), CODEC_ERR_PARSE);
    codec_msgpack_stream_free(s);
    free(b);
}

int main(void) {
    CT_RUN(test_msgpack_in_order_and_stop);
    CT_RUN(test_msgpack_handles_split_frame);
    CT_RUN(test_protobuf_chunked_reassembly);
    CT_RUN(test_msgpack_stream_rejects_deep_nesting);
    CT_DONE();
}

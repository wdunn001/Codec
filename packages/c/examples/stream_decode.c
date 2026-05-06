/*
 * stream_decode.c — minimal end-to-end example.
 *
 * Reads a Codec tokenizer dialect map from a JSON file, encodes a known set
 * of token IDs as a msgpack stream, then decodes it back through the
 * detokenizer and prints the recovered text.
 *
 * Real applications would feed the bytes from `fetch()`/`curl` instead of
 * synthesising them locally, but the decode path is identical.
 *
 *   stream_decode <map.json>
 */
#include "codec/codec.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int slurp(const char *path, char **out, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return 0; }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = 0;
    *out = buf;
    *out_len = got;
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <map.json>\n", argv[0]);
        return 2;
    }

    char  *json = NULL;
    size_t json_len = 0;
    if (!slurp(argv[1], &json, &json_len)) {
        fprintf(stderr, "stream_decode: failed to read %s\n", argv[1]);
        return 2;
    }

    codec_tokenizer_map_t *map = NULL;
    codec_status_t st = codec_map_from_json(json, json_len, &map);
    if (st != CODEC_OK) {
        fprintf(stderr, "stream_decode: %s\n", codec_status_str(st));
        free(json);
        return 1;
    }
    free(json);

    printf("loaded map: %s (vocab_size=%zu, encoder=%d)\n",
           codec_map_id(map), codec_map_vocab_size(map),
           (int)codec_map_encoder(map));

    /* Encode a synthetic 3-frame msgpack stream. */
    codec_buffer_t f1 = {0}, f2 = {0}, f3 = {0};
    {
        codec_frame_t fr; codec_frame_init(&fr);
        uint32_t a[] = { 9707, 11 };  /* "Hello," in Qwen-2 */
        fr.ids = a; fr.ids_len = 2; fr.done = false;
        codec_encode_msgpack(&fr, &f1);
        fr.ids = NULL; codec_frame_destroy(&fr);
    }
    {
        codec_frame_t fr; codec_frame_init(&fr);
        uint32_t a[] = { 1879 };       /* " world" in Qwen-2 */
        fr.ids = a; fr.ids_len = 1; fr.done = false;
        codec_encode_msgpack(&fr, &f2);
        fr.ids = NULL; codec_frame_destroy(&fr);
    }
    {
        codec_frame_t fr; codec_frame_init(&fr);
        uint32_t a[] = { 0 };          /* "!" in Qwen-2 */
        fr.ids = a; fr.ids_len = 1; fr.done = true; fr.finish_reason = (char *)"stop";
        codec_encode_msgpack(&fr, &f3);
        fr.ids = NULL; fr.finish_reason = NULL; codec_frame_destroy(&fr);
    }

    /* Decode the stream incrementally and detokenize. */
    codec_msgpack_stream_t *dec = NULL;
    codec_msgpack_stream_new(&dec);
    codec_msgpack_stream_feed(dec, f1.data, f1.len);
    codec_msgpack_stream_feed(dec, f2.data, f2.len);
    codec_msgpack_stream_feed(dec, f3.data, f3.len);

    codec_detokenizer_t *detok = NULL;
    codec_detokenizer_new(map, &detok);

    printf("output: ");
    for (;;) {
        codec_frame_t out;
        codec_status_t r = codec_msgpack_stream_next(dec, &out);
        if (r == CODEC_ERR_INCOMPLETE) break;
        if (r != CODEC_OK) {
            fprintf(stderr, "\nstream error: %s\n", codec_status_str(r));
            break;
        }
        char *text = NULL;
        size_t text_len = 0;
        codec_detokenize_opts_t opts = { !out.done, false };
        codec_detokenizer_render(detok, out.ids, out.ids_len, opts, &text, &text_len);
        if (text) { fwrite(text, 1, text_len, stdout); free(text); }
        bool done = out.done;
        codec_frame_destroy(&out);
        if (done) break;
    }
    printf("\n");

    codec_detokenizer_free(detok);
    codec_msgpack_stream_free(dec);
    codec_buffer_free(&f1); codec_buffer_free(&f2); codec_buffer_free(&f3);
    codec_map_free(map);
    return 0;
}

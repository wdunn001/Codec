# Pre-trained ZSTD dictionaries

This directory holds the reference pre-trained ZSTD dictionaries that
tokenizer maps can declare to compress Codec frame streams. Distribution
follows the spec's URL + sha256 model (see
[spec/PROTOCOL.md](../spec/PROTOCOL.md) §"Pre-trained ZSTD dictionaries"
and the `zstd_dictionaries` field in
[spec/tokenizer-map.schema.json](../spec/tokenizer-map.schema.json)).

## What's here

Each `.dict` is a raw zstd dictionary as produced by
`zstandard.train_dictionary()` (or equivalently `zstd --train`). It is a
binary blob — load it with `dictionary:` on the encoder/decoder side.

`manifest.json` is the source of truth for what each file is:

- `model` — HF model id the corpus came from
- `codec_format` — `msgpack` or `protobuf` (dicts are not interchangeable)
- `dict_size_bytes` — the dict's byte size (4 KB / 16 KB / 64 KB sweep
  picks the smallest size within 1 percentage point of the best gain)
- `sha256` — content hash; this MUST match the dict body
- `corpus.source` — `live-sglang` (real captures) or `synthetic` (offline
  generator from `bench/golden/qwen2.json`)
- `holdout` — the gain the trainer measured on held-out 20% of the corpus

## Naming

```
<tag>-<format>-<version>.dict
qwen2.5-msgpack-v1.dict           ← live-trained
qwen2.5-synth-msgpack-v1.dict     ← synthetic (offline corpus)
```

The `synth-` infix means the dict was trained against the deterministic
synthetic corpus, not real sglang output. Synthetic dicts are weaker
(they only see the model's tokenizer test corpus, not its actual
generation distribution) but reproducible without GPU access — they're
what CI uses.

## How to retrain

End-to-end, no live server:

```bash
cd packages/bench

# 1. Generate offline corpus (deterministic, fast)
python scripts/synth-codec-samples.py --out ./corpora/qwen2.5-synth

# 2. Train (sweeps {4 KB, 16 KB, 64 KB} dict sizes, picks smallest within
#    1pp of best gain on a 20% holdout)
python scripts/train-zstd-dict.py \
  --corpus ./corpora/qwen2.5-synth \
  --out ../../dictionaries \
  --model "Qwen/Qwen2.5-0.5B-Instruct" \
  --tag qwen2.5-synth \
  --version v1

# 3. Verify gain (round-trip-checked)
npx tsx src/compression-dict.ts \
  --corpus-root corpora/qwen2.5-synth \
  --dict-root ../../dictionaries \
  --tag qwen2.5-synth --version v1
```

End-to-end with real captures (preferred for shipped dicts; assumes a
sglang on the Codec PR branch is up):

```bash
python scripts/capture-codec-samples.py \
  --url http://192.168.1.88:30000 \
  --model Qwen/Qwen2.5-0.5B-Instruct \
  --formats msgpack protobuf \
  --n-samples 256 \
  --out ./corpora/qwen2.5

python scripts/train-zstd-dict.py \
  --corpus ./corpora/qwen2.5 \
  --out ../../dictionaries \
  --tag qwen2.5 \
  --version v1
```

## How clients/servers use these

Loading a dict into the zstd encoder is a single option in every
mainstream binding:

| Binding | API | Dict argument |
|---|---|---|
| Node `node:zlib` (≥ 23) | `zstdCompressSync(buf, { dictionary })` | top-level |
| Python `zstandard` | `ZstdCompressor(dict_data=ZstdCompressionDict(bytes))` | constructor |
| Rust `zstd` | `Encoder::with_dictionary(level, &dict)` | constructor |
| C `libzstd` | `ZSTD_CCtx_loadDictionary(ctx, dict, size)` | once per ctx |
| Go `klauspost/compress/zstd` | `WithEncoderDict(dict)` option | constructor |

Decoders accept the same form. The dictionary is loaded once per stream;
zstd handles the rest.

A future PR teaches sglang's `codec_compression.py` (and the
vLLM/llama.cpp PR equivalents) to pick the right dict by
(`tokenizer_id`, `stream_format`) using the `zstd_dictionaries[]` field
on the loaded tokenizer map. Until that lands, these dicts compress fine
in offline benches but the wire negotiation never selects zstd at all
(see "Why dicts are a precondition, not an optimization" below).

## Why dicts are a precondition for zstd, not an optimization

It's tempting to think of `zstd-no-dict` as a graceful fallback when
the dict is missing. **It isn't.** On Codec streams specifically:

| | bytes vs gzip | streaming TTFB |
|---|---:|---:|
| zstd-no-dict | within noise (RESULTS.md §1f) | catastrophic on shipped middleware (§1d, 334× at 2K tokens) |
| zstd-with-dict | **16–38% smaller** (§1g) | +0.13 ms over no-dict (§1g) |

So no-dict zstd is the worst of both worlds: same bytes as gzip, much
worse TTFB. The picker (`packages/wire-compress`) enforces a hard rule:
`Content-Encoding: zstd` is selected ONLY when both gates pass:

1. **`zstdHasDict`** — the server has loaded a dict from
   `zstd_dictionaries[]` whose `format` matches the response's
   `stream_format`. Set per request.
2. **`zstdEnabled`** — the operator has confirmed the middleware uses
   streaming-zstd-with-flush, not buffered finalisation.

Either gate failing → the picker drops zstd from the candidate set and
returns gzip (or br as the Safari/iOS fallback). This means: if you
don't ship a dict for some tokenizer, requests for that tokenizer
land on gzip. **There is no zstd-no-dict path.** The dict isn't a
performance tweak — it's the gate that lets zstd be on the menu.

Operationally that turns the per-tokenizer training cost from "extra
work to optimise zstd" into "the work that makes zstd usable, period."
The fallback chain is `zstd-with-dict > gzip > br > identity`. No
intermediate `zstd-no-dict` step.

## Why per-format dicts

A msgpack frame and a protobuf frame look totally different on the wire
(map key strings vs varint field tags), so a dict trained on one is
almost useless on the other. Cheap to train both; the storage cost is
~16 KB per format.

## When to retrain

Retrain when any of:

- The model changes its tokenizer (different vocab / merges / pre-tokenizer).
- The wire format changes (e.g. msgpack schema bumps a field name, or
  protobuf adds a new field that appears frequently).
- You measure a noticeable drift in compression ratio against a fresh
  capture (rule of thumb: > 2 percentage points off the original
  holdout gain).

A new training run = a new file with a bumped version (`v1` → `v2`) or
a new sha256 in the manifest. Old dicts stay in place; clients pin by
hash.

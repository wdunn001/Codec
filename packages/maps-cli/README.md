# @codecai/maps-cli

**The `tsc --declaration` for LLM token vocabularies.**

Generate [Codec](https://github.com/wdunn001/Codec) tokenizer dialect maps from HuggingFace `tokenizer.json` files. Maps are content-addressed, immutable JSON files that any [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) client can use to encode/decode token streams.

## Install

```bash
npm install -g @codecai/maps-cli
```

Or run without installing:

```bash
npx @codecai/maps-cli build Qwen/Qwen2.5-7B-Instruct --id=qwen/qwen2
```

## CLI

### `build` — fetch from HuggingFace and convert

```bash
codecai-maps build <hf-model> [--id=<id>] [--out=<path>] [--token=<hf-token>]
```

Fetches `tokenizer.json` from `https://huggingface.co/<hf-model>`, converts to a Codec `TokenizerMap`, writes JSON to disk, and prints the canonical sha256 hash.

```bash
$ codecai-maps build Qwen/Qwen2.5-7B-Instruct --id=qwen/qwen2
▶ fetching Qwen/Qwen2.5-7B-Instruct from HuggingFace…
✓ written  qwen_qwen2.json
  id           qwen/qwen2
  vocab_size   151665
  encoder      byte_level
  merges       151387
  hash         sha256:c73972f7a580…
```

For gated models (Llama, Gemma) pass a HuggingFace access token: `--token=hf_xxx`.

### `convert` — local file in, map out

```bash
codecai-maps convert ./tokenizer.json --id=my-org/my-model --out=./my-model.json
```

### `validate` — schema check

```bash
codecai-maps validate ./qwen_qwen2.json
```

### `hash` — print canonical sha256

```bash
codecai-maps hash ./qwen_qwen2.json
# → sha256:c73972f7a580936d724ffd8df9df2ce546d255c543e9d09b6d75e5bf69b1a64d
```

Use this value when pinning a map: `loadMap({ url, hash })` will reject any map that doesn't match.

### `preview` — sanity check round-trip

```bash
codecai-maps preview ./qwen_qwen2.json --text="Explain entropy."
# map:           qwen/qwen2
# tokenizer:     BPETokenizer
# input:         "Explain entropy."
# token IDs:     [840, 20772, 47502, 13]
# token count:   4
# round-trip:    "Explain entropy."
# exact match:   YES
```

## Programmatic API

```ts
import { convertHFTokenizer, fetchAndConvert, hashMap } from '@codecai/maps-cli/convert';

// From a parsed tokenizer.json object
const map = convertHFTokenizer(hfJson, { id: 'my-org/my-model' });

// Or fetch from HuggingFace directly
const map = await fetchAndConvert({
  hfModel: 'Qwen/Qwen2.5-7B-Instruct',
  id: 'qwen/qwen2',
});

// Compute the hash for pinning
const hash = await hashMap(map);
```

## What gets generated

The output is a JSON file matching the `TokenizerMap` schema from `@codecai/web`:

```json
{
  "id": "qwen/qwen2",
  "version": "2",
  "vocab_size": 151665,
  "vocab": { "Hello": 9707, "Ġworld": 1879, "...": 0 },
  "encoder": "byte_level",
  "merges": ["Ġ Ġ", "ĠĠ ĠĠ", "i n", "..."],
  "pre_tokenizer_pattern": "(?i:'s|'t|'re|...)| ?\\p{L}+|...",
  "special_tokens": {
    "<|endoftext|>": 151643,
    "<|im_start|>": 151644
  },
  "published_at": "2026-05-06T12:00:00.000Z"
}
```

The schema covers three tokenizer families that span ~95% of open models:

- **`byte_level`** — GPT-2 byte→unicode BPE (Llama-3, Qwen, Phi-3, Mistral-Nemo, DeepSeek-V3, …).
- **`metaspace`** — `▁`-prefix BPE with byte fallback (Llama-2, Mistral-v3, Mixtral, Gemma).
- **identity** — vocab-only tokenizers without merges (canonical-IR / closed vocabs).

## Hosting your map

Once generated, host the JSON anywhere static:

- **GitHub + jsDelivr** (free CDN): commit to a public repo, then  
  `https://cdn.jsdelivr.net/gh/<user>/<repo>/path/to/map.json`
- **Hugging Face**: push to a Space or alongside your model weights.
- **S3 / Cloudflare R2**: standard static hosting.
- **Codec community registry**: contribute via PR to [`codec-maps`](https://github.com/wdunn001/codec-maps).

Then any client can pin against your hash:

```ts
import { loadMap } from '@codecai/web';

const map = await loadMap({
  url: 'https://your-host/your-model.json',
  hash: 'sha256:abcd1234…',
});
```

## License

MIT.

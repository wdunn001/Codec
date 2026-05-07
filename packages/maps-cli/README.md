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

### `translate` — cross-vocab token stream conversion

Pipe one tokenizer's IDs through another's vocab with streaming-safe
word-boundary buffering. Useful for previewing what an agent-to-agent
handoff actually emits at the token level.

```bash
codecai-maps translate --from=qwen2.json --to=llama-3.json \
  --text="The quick brown fox."

# from:    qwen/qwen2
# to:      meta-llama/llama-3
# input:   "The quick brown fox."
# src ids: [785, 4937, 13876, 38835, 13]   (5 tokens, qwen-2)
# dst ids: [791, 4062, 14198, 39935, 13]   (5 tokens, llama-3)
# decoded: "The quick brown fox."          (round-trip via llama-3 detok)
```

Or with raw IDs:

```bash
codecai-maps translate --from=qwen2.json --to=llama-3.json --ids=785,4937
```

### `translation-table` — context-free V_A → V_B[] lookup

```bash
codecai-maps translation-table --from=qwen2.json --to=llama-3.json \
  --out=qwen-to-llama.json
```

Emits a JSON file mapping every non-special source ID to the sequence
of target IDs its rendered text encodes to. Context-free (BPE merges
depend on context), so prefer the streaming `translate` for runtime
use; the static table is for analysis (vocab overlap, cost estimation).

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

The output is a JSON file matching the `TokenizerMap` schema from `@codecai/web` (v2.1):

```json
{
  "id": "qwen/qwen2",
  "version": "2",
  "vocab_size": 151665,
  "vocab": { "Hello": 9707, "Ġworld": 1879, "...": 0 },
  "encoder": "byte_level",
  "merges": ["Ġ Ġ", "ĠĠ ĠĠ", "i n", "..."],
  "pre_tokenizer_pattern": "(?i:'s|'t|'re|...)| ?\\p{L}+|...",
  "pre_tokenizer_program": {
    "version": 1,
    "ops": [
      { "op": "literals_ci", "patterns": ["'s","'t","'re","'ve","'m","'ll","'d"] },
      { "op": "letters",     "lead_other": true },
      { "op": "numbers",     "max_run": 1 },
      { "op": "punct_run",   "lead_space": true, "trailing_newlines": true },
      { "op": "newline_block" },
      { "op": "trailing_ws" },
      { "op": "ws_run" }
    ]
  },
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

### Pre-tokenizer program (v2.1, additive)

Both `pre_tokenizer_pattern` and `pre_tokenizer_program` describe the
same splitter. The program is the regex compiled into a named-op list;
runtimes prefer it when present so they can encode without a Unicode
regex engine. The CLI emits it automatically for any pre-tokenizer
regex it recognises (currently the GPT-2-family canonical form used by
Llama-3, Qwen, Phi-3, DeepSeek-V3, Mistral-Nemo, Falcon, SmolLM2,
Codestral byte_level). Maps with unrecognised regexes still build
normally — `pre_tokenizer_program` is just omitted, and runtimes fall
back to the regex string.

See [`spec/PRETOKENIZER_PROGRAM.md`](https://github.com/wdunn001/Codec/blob/main/spec/PRETOKENIZER_PROGRAM.md)
for the full op set and equivalence rules.

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

### `well-known` — publish for `.well-known/codec/` discovery

Generate the static directory tree clients need to find your map by `(origin, id)` alone, so consumers don't have to hard-code your CDN URL:

```bash
codecai-maps well-known --map=./qwen_qwen2.json \
  --url=https://cdn.example/qwen2.json \
  --out-dir=./public
```

This writes:

```
public/.well-known/codec/maps/qwen/qwen2.json   ← pointer { id, url, hash }
public/.well-known/codec/index.json             ← directory of all your maps
```

Drop `./public` onto any static host (GitHub Pages, S3, Vercel) under the origin you control, and any client can do:

```ts
import { discoverMap } from '@codecai/web';
const map = await discoverMap({ origin: 'https://qwen.io', id: 'qwen/qwen2' });
```

Pass `--inline` instead of `--url` to embed the full map at the well-known location (skips the CDN indirection — recommended only for small maps). Re-running with the same id replaces the existing index entry. See [`spec/WELL_KNOWN_DISCOVERY.md`](https://github.com/wdunn001/Codec/blob/main/spec/WELL_KNOWN_DISCOVERY.md) for the publishing contract.

## License

MIT.

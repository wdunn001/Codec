# Pre-tokenizer Program (v2.1 map field)

## Why

Codec tokenizer maps currently ship `pre_tokenizer_pattern` as a Unicode regex string. Every client language must therefore bring a Unicode-aware regex engine (`\p{L}`, `\p{N}`):

| Client | Engine | Cost |
|---|---|---|
| TS / browser | native `RegExp` with `u` flag | free |
| Python | `regex` package (stdlib `re` lacks `\p`) | one PyPI dep |
| .NET | `System.Text.RegularExpressions` | free |
| **C / libcodec** | **none in stdlib** | **PCRE2 dependency or hand-rolled scanner** |

The C gap blocks bidirectional Codec endpoints (text → IDs encoding) for embedded / WASM / single-binary deployments, where pulling PCRE2 is non-trivial. Hand-rolling a Unicode regex inside libcodec is ~600 LOC plus a vendored Unicode property table: and only solves one tokenizer family.

This spec adds an optional, **higher-level** pre-tokenizer description: a small ordered list of named ops. The maps-cli compiles known regexes into this form. Runtimes execute the ops directly: no regex engine, no Unicode property knowledge baked into the runtime beyond what the runtime already has.

The map field is **additive**. Old clients keep using `pre_tokenizer_pattern`. New clients prefer `pre_tokenizer_program` when present.

## Schema

```jsonc
{
  // existing v2 fields ...
  "pre_tokenizer_pattern": "...",   // legacy, still emitted
  "pre_tokenizer_program": {
    "version": 1,
    "ops": [ /* ordered list, see below */ ]
  }
}
```

The interpreter walks the input string left-to-right. At each position it tries each op in order. The first op that matches a non-empty span consumes that span and emits it as a piece; the cursor advances; the loop restarts at the new position. If no op matches at a position, the interpreter consumes a single Unicode scalar value and emits it (defensive: well-formed programs end with a catchall).

## Op set v1

Eight ops cover all currently supported tokenizer families (GPT-2-family byte_level + SentencePiece metaspace).

### `literals_ci`: case-insensitive literal alternatives

```jsonc
{ "op": "literals_ci", "patterns": ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"] }
```

Match the longest of the listed literals at the current position, ASCII case-insensitive. Equivalent to the regex `(?i:p1|p2|...)`.

### `letters`: Unicode letter run, optional leading non-letter

```jsonc
{ "op": "letters", "lead_other": true }
```

Match `[^\r\n\p{L}\p{N}]?\p{L}+` when `lead_other: true`, else `\p{L}+`. The leading char (if matched) must not be `\r`, `\n`, or `\p{L}`/`\p{N}`.

### `numbers`: digit run, optionally bounded

```jsonc
{ "op": "numbers" }
{ "op": "numbers", "max_run": 3 }
```

Match `\p{N}+` (unbounded) or `\p{N}{1,K}` (bounded: Llama-3 uses `K=3`).

### `punct_run`: punctuation/symbol run with optional leading space and trailing newlines

```jsonc
{ "op": "punct_run", "lead_space": true, "trailing_newlines": true }
```

Match ` ?[^\s\p{L}\p{N}]+[\r\n]*`. Both modifiers are independent toggles.

### `newline_block`: whitespace then mandatory newline run

```jsonc
{ "op": "newline_block" }
```

Match `\s*[\r\n]+`: used to keep paragraph breaks attached to leading indentation as a single piece.

### `trailing_ws`: whitespace at end of input

```jsonc
{ "op": "trailing_ws" }
```

Match `\s+(?!\S)`: whitespace that runs to a position with no following non-whitespace. In practice: end of input, or end of input modulo more whitespace.

### `ws_run`: generic whitespace catchall

```jsonc
{ "op": "ws_run" }
```

Match `\s+`. Always last in GPT-2-family programs.

### `metaspace_split`: SentencePiece word splitter

```jsonc
{ "op": "metaspace_split", "prefix_first": false }
```

Used for metaspace-style tokenizers (Llama-2, Mistral-v3, Gemma), as an alternative to the GPT-2 alternation. Splits the input on whitespace, prepends `▁` (U+2581) to each non-whitespace piece. `prefix_first: true` matches SentencePiece's `prepend_scheme: "first"` (don't prefix mid-word continuations).

## Worked examples

### Qwen-2 / DeepSeek-V3 (GPT-2-family, unbounded numbers)

Source regex:
```
(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
```

Compiled program:
```jsonc
{
  "version": 1,
  "ops": [
    { "op": "literals_ci", "patterns": ["'s","'t","'re","'ve","'m","'ll","'d"] },
    { "op": "letters",    "lead_other": true },
    { "op": "numbers" },
    { "op": "punct_run",  "lead_space": true, "trailing_newlines": true },
    { "op": "newline_block" },
    { "op": "trailing_ws" },
    { "op": "ws_run" }
  ]
}
```

### Llama-3 (GPT-2-family, numbers bounded to 3)

Same as Qwen-2 but with `{ "op": "numbers", "max_run": 3 }`.

### Llama-2 / Mistral-v3 (metaspace)

```jsonc
{ "version": 1, "ops": [{ "op": "metaspace_split", "prefix_first": false }] }
```

## Class membership

Two ops (`letters`, `numbers`, plus the implicit `\s` and `[^\s\p{L}\p{N}]` etc. used by others) require Unicode character-class queries at runtime:

- `\p{L}`: General_Category=Letter
- `\p{N}`: General_Category=Number
- `\s`: `\p{White_Space}` plus the ASCII whitespace fallbacks (already standard)

**These tables are owned by the runtime and are never shipped in the map.** Each language uses its native facility:

| Runtime | Mechanism |
|---|---|
| TS / JS | `/\p{L}/u`, `/\p{N}/u` (native regex, no extra dep) |
| Python | `regex` package (already a dep for `pre_tokenizer_pattern` mode) |
| .NET | `Char.IsLetter`, `Char.IsDigit` (BCL) |
| **C / libcodec** | Vendored interval-list tables, ~30KB static `.c` file generated from Unicode UCD by a small build-time tool. Lookup is binary search, ~15 LOC. |

The Unicode version travels with the runtime. Tokenizer training is fairly insensitive to which Unicode minor version classifies a given exotic character: what matters is that the runtime and the training-time pre-tokenizer agree on the *common* code points (Latin, CJK, common digits). Every runtime in practice does agree on those.

## Compatibility

- Maps may emit both `pre_tokenizer_pattern` and `pre_tokenizer_program`. Old clients see only the pattern; new clients prefer the program.
- A map without a program continues to work in old clients. A map without a pattern is **valid** but consumable only by program-aware clients (will mostly happen in v3+).
- New tokenizer families that don't fit the v1 op set: emit `pre_tokenizer_program: null` (CLI fall-through), keep `pre_tokenizer_pattern` only. Old behavior preserved.

## Equivalence

For any input string, applying `pre_tokenizer_program` to it MUST produce the same sequence of pieces as compiling and running `pre_tokenizer_pattern` (modulo the legacy regex's zero-width-match guard). That guard never affects observable output. This is the property the maps-cli compiler is tested against on every emitted map.

# Pre-tokenizer Program (v2.1 map field)

## Why

Codec tokenizer maps currently ship `pre_tokenizer_pattern` as a Unicode regex string. Every client language must therefore bring a Unicode-aware regex engine (`\p{L}`, `\p{N}`):

| Client | Engine | Cost |
|---|---|---|
| TS / browser | native `RegExp` with `u` flag | free |
| Python | `regex` package (stdlib `re` lacks `\p`) | one PyPI dep |
| .NET | `System.Text.RegularExpressions` | free |
| **C / libcodec** | **none in stdlib** | **PCRE2 dependency or hand-rolled scanner** |

The C gap blocks bidirectional Codec endpoints (text → IDs encoding) for embedded / WASM / single-binary deployments, where pulling PCRE2 is non-trivial. Hand-rolling a Unicode regex inside libcodec is ~600 LOC plus a vendored Unicode property table. It also only solves one tokenizer family.

This spec adds an optional, **higher-level** pre-tokenizer description: an ordered program the maps-cli compiles from a model's real HuggingFace pre-tokenizer. Runtimes execute the program directly: no regex engine, no Unicode property knowledge baked into the runtime beyond what the runtime already has.

The map field is **additive**. Old clients keep using `pre_tokenizer_pattern`. New clients prefer `pre_tokenizer_program` when present.

Two program shapes exist, distinguished by the program's own `version` field. That field is a separate number from the map's top-level `version` field named in this document's title. See § Versioning for the full distinction.

- **v1**: `{ "version": 1, "ops": [...] }`. A flat, ordered list of ops. The interpreter tries each op in turn at every cursor position. The whole program is one alternation scan over the raw input text. This is sufficient for any tokenizer whose HuggingFace pre-tokenizer is, or reduces to, exactly one alternation regex.
- **v2**: `{ "version": 2, "stages": [...] }`. An ordered list of STAGES. Each stage transforms every piece the stage before it produced. This mirrors HuggingFace's `Sequence` pre-tokenizer exactly. It is required for a source whose real pre-tokenizer runs more than one kind of stage in sequence. Four published maps need it: HuggingFaceTB/SmolLM2, tiiuae/falcon, deepseek-ai/DeepSeek-V3, and deepseek-ai/DeepSeek-R1.

## Schema

```jsonc
// v1: one alternation scan.
{
  "pre_tokenizer_pattern": "...",   // legacy, still emitted when honest (see § Compatibility)
  "pre_tokenizer_program": {
    "version": 1,
    "ops": [ /* ordered list, see § Op set */ ]
  }
}
```

```jsonc
// v2: an ordered pipeline of stages.
{
  // pre_tokenizer_pattern omitted: a multi-stage Sequence has no single
  // regex that reproduces its output honestly. See § Compatibility.
  "pre_tokenizer_program": {
    "version": 2,
    "stages": [ /* ordered list, see § Stages (v2) */ ]
  }
}
```

### v1 execution

The interpreter walks the input string left-to-right. At each position it tries each op in order. The first op that matches a non-empty span consumes that span and emits it as a piece. The cursor advances. The loop restarts at the new position. If no op matches at a position, the interpreter consumes a single Unicode scalar value and emits it (defensive: well-formed v1 programs end with a catchall).

### v2 execution

The interpreter starts with a piece list containing the whole input text as its only entry. For each stage, in order, every current piece is fed through that stage independently. The results are concatenated to form the next piece list. The final piece list, once every stage has run, is the program's output.

One of the stage kinds, `alternation`, runs the same op-priority scan v1 uses. It is scoped to a single piece. Its match-failure behavior differs from v1's in one place: an unmatched span is emitted as ONE piece. This is `Split`-Isolated gap semantics: a whole unmatched span becomes a single piece. See § `alternation`.

For a v1 program, or a v2 program whose only stage is `alternation`, those two behaviors coincide. A GPT-2-family op list is exhaustive over every Unicode scalar value when it runs directly against raw, unprocessed text. Every position matches something there. That branch therefore stays unreachable either way. It becomes reachable once an earlier v2 stage has already stripped a character class this alternation's own ops were never meant to see. It matters there too. DeepSeek-V3's third stage is the concrete case: it receives whole digit-run and CJK-run pieces from the two stages ahead of it. It has no digit or CJK branch of its own.

## Op set

These run inside a v1 program directly, or inside a v2 `alternation` stage.

### `literals_ci`: case-insensitive literal alternatives

```jsonc
{ "op": "literals_ci", "patterns": ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"] }
```

Match the longest of the listed literals at the current position, ASCII case-insensitive. Equivalent to the regex `(?i:p1|p2|...)`.

### `literals`: case-sensitive literal alternatives

```jsonc
{ "op": "literals", "patterns": ["'s", "'t", "'re", "'ve", "'m", "'ll", "'d"] }
```

Match the longest of the listed literals at the current position, exact case. Used by the older OpenAI tokenizers (p50k_base, r50k_base) and by `ByteLevel(use_regex=true)`'s fixed internal regex (see § `alternation`).

### `letters`: Unicode letter run, optional leading character

```jsonc
{ "op": "letters", "lead_other": true }
{ "op": "letters", "lead_other": true, "lead_other_class": "l_p_s", "body": "L_M" }
```

Base form: match `[^\r\n\p{L}\p{N}]?\p{L}+` when `lead_other: true`, `\p{L}+` when neither lead flag is set, or ` ?\p{L}+` when `lead_space: true`. The `lead_other` leading char, if matched, must not be `\r`, `\n`, `\p{L}`, or `\p{N}`.

Two optional fields refine `lead_other`. DeepSeek-V3's third `Split` stage added both:

- `lead_other_class`: which class the lead char must avoid. `"l_n"` is the default. It is also the only value any map emitted before these fields existed. It excludes `\r`, `\n`, `\p{L}`, `\p{N}`. `"l_p_s"` excludes `\r`, `\n`, `\p{L}`, `\p{P}`, `\p{S}`. A digit at the lead position is admitted under `"l_p_s"`.
- `body`: the letter-run body class. `"L"` is the default: `\p{L}+`. `"L_M"` is `[\p{L}\p{M}]+`, letters plus combining marks. A base letter and a following combining accent stay one piece under `"L_M"`.

### `numbers`: digit run, optionally bounded

```jsonc
{ "op": "numbers" }
{ "op": "numbers", "max_run": 3 }
```

Match `\p{N}+` (unbounded) or `\p{N}{1,K}` (bounded: Llama-3 uses `K=3`). `lead_space: true` prepends an optional literal space, for the older OpenAI shape.

### `punct_run`: punctuation/symbol run with optional leading space and trailing chars

```jsonc
{ "op": "punct_run", "lead_space": true, "trailing_newlines": true }
{ "op": "punct_run", "lead_space": true, "trailing_newlines": true, "charset": "p_s" }
```

Base form: match ` ?[^\s\p{L}\p{N}]+[\r\n]*` when both modifiers are set. Each toggles independently. `trailing_chars` overrides the trailing set with an explicit charset (o200k_base / mistral-nemo use `[\r\n/]`).

`charset` controls the run's own body class. `"not_ws_L_N"` is the default. It is also the only value any map emitted before this field existed: the complement class `[^\s\p{L}\p{N}]+`. `"p_s"` is `[\p{P}\p{S}]+`. DeepSeek-V3's third `Split` stage names its punctuation/symbol class explicitly this way. That excludes combining marks and any other leftover Unicode category the complement class would otherwise sweep in.

### `punct_ascii_letters`: one ASCII punctuation character, then ASCII letters

```jsonc
{ "op": "punct_ascii_letters" }
```

Match `[!-\/:-@\[-\`{-~][A-Za-z]+`: one ASCII punctuation character, from the 32-character set HuggingFace's `is_ascii_punctuation` accepts, then one or more ASCII letters. This is DeepSeek-V3's third `Split` stage's FIRST alternative, tried before the general letters/punct branches. An apostrophe glued to identifier letters, `'m` in code like Python's `sys.platform == 'linux'`, comes out as one piece under this op. No combination of the other ops can express this shape. It needs a leading char restricted specifically to ASCII punctuation, followed by a body restricted specifically to ASCII letters.

### `newline_block`: whitespace then mandatory newline run

```jsonc
{ "op": "newline_block" }
```

Match `\s*[\r\n]+`. Keeps paragraph breaks attached to leading indentation as a single piece.

### `trailing_ws`: whitespace at end of input

```jsonc
{ "op": "trailing_ws" }
```

Match `\s+(?!\S)`: whitespace that runs to a position with no following non-whitespace. In practice this means end of input, or end of the current piece.

### `ws_run`: generic whitespace catchall

```jsonc
{ "op": "ws_run" }
```

Match `\s+`. Always last in a GPT-2-family op list.

### `letters_cased`: case-boundary letter run, o200k_base / mistral-nemo

```jsonc
{ "op": "letters_cased", "kind": "title", "lead_other": true, "trailing_ci": ["'s", "'t"] }
{ "op": "letters_cased", "kind": "upper", "lead_other": true }
```

`kind: "title"` matches `[Lu Lt Lm Lo M]* [Ll Lm Lo M]+` (zero or more upper-cluster chars, then one or more lower-cluster chars). `kind: "upper"` matches `[Lu Lt Lm Lo M]+ [Ll Lm Lo M]*` (the reverse minimum). Used in a matched title/upper pair to split words on case boundaries: `"MyCamelCase"` becomes `["My", "Camel", "Case"]`. `trailing_ci`, when set, appends the same ASCII case-fold contraction match `literals_ci` uses.

### `metaspace_split`: SentencePiece word splitter

```jsonc
{ "op": "metaspace_split", "prefix_first": false }
```

Used for metaspace-style tokenizers (Llama-2, Mistral-v3, Gemma), as a v1 single-op program. It is never mixed with other ops. It never appears inside a v2 stage. It splits the input on whitespace. It prepends `▁` (U+2581) to each non-whitespace piece. `prefix_first: true` matches SentencePiece's `prepend_scheme: "first"`: mid-word continuations stay bare.

## Stages (v2)

A v2 `pre_tokenizer_program`'s `stages` array holds these. Each one corresponds to exactly one node the maps-cli compiler recognised while walking a HuggingFace `Sequence` pre-tokenizer; see packages/maps-cli/src/convert.ts's `compilePreTokenizerStages`.

### `digits_isolate`: isolate digit runs

```jsonc
{ "stage": "digits_isolate", "mode": "individual" }
{ "stage": "digits_isolate", "mode": "grouped" }
{ "stage": "digits_isolate", "mode": "grouped", "max_run": 3 }
```

`mode: "individual"`: every digit becomes its own piece. Lowered from HuggingFace's `Digits(individual_digits=true)` (SmolLM2's first stage).

`mode: "grouped"`: consecutive digits stay together as one piece, chunked to `max_run` digits when set (a run longer than `max_run` becomes several pieces of at most `max_run` digits each, the last one possibly shorter). Lowered from `Digits(individual_digits=false)` when `max_run` is omitted (Falcon's third stage), or from `Split(\p{N}{1,K}, Isolated, invert=false)` when `max_run` is set to `K` (DeepSeek-V3's first stage, `K=3`).

### `digit_triples_isolate`: exact 3-ASCII-digit windows

```jsonc
{ "stage": "digit_triples_isolate" }
```

Lowered from `Split([0-9][0-9][0-9], Isolated, invert=false)`: Falcon's fourth stage. Scans left to right for non-overlapping windows of exactly 3 ASCII digits. A digit run whose length isn't a multiple of 3 leaves a remainder. That remainder stays ungrouped, as part of the surrounding non-match content.

This stage is deliberately distinct from `digits_isolate`'s `max_run`. That field chunks a `\p{N}` run into pieces of at most K digits, with zero leftover ever produced. `[0-9][0-9][0-9]` only ever produces exactly-3-digit pieces, plus whatever digits fall outside any 3-digit window.

### `punctuation_contiguous`: group punctuation/non-punctuation runs

```jsonc
{ "stage": "punctuation_contiguous" }
```

Lowered from HuggingFace's `Punctuation(Contiguous)`: Falcon's first stage. Classifies each character into one of two buckets, ASCII-punctuation-or-`\p{P}` and everything else. Groups each maximal run of the same bucket into one piece. Whitespace and letters share the "everything else" bucket. A whitespace run therefore stays attached to its adjacent letters as one piece here.

### `cjk_isolate`: isolate CJK/Hiragana/Katakana runs

```jsonc
{ "stage": "cjk_isolate" }
```

Lowered from `Split([一-龥぀-ゟ゠-ヿ]+, Isolated, invert=false)`: DeepSeek-V3's second stage. Isolates maximal runs of three fixed ranges as their own pieces. A CJK run stays isolated from adjacent Latin text and from a preceding space this way:

| Range | Block |
|---|---|
| U+4E00-U+9FA5 | CJK Unified Ideographs. This is DeepSeek-V3's own literal bound; the full block runs to U+9FFF. |
| U+3040-U+309F | Hiragana |
| U+30A0-U+30FF | Katakana |

### `alternation`: op-priority scan, scoped to one piece

```jsonc
{ "stage": "alternation", "ops": [ /* see § Op set */ ] }
```

Runs the op-priority scan described in § v2 execution. It is scoped to one piece here. Lowered from one of two HuggingFace node shapes:

- `ByteLevel(use_regex=true)`: always the SAME fixed 6-op list (`literals`, `letters` with `lead_space`, `numbers` with `lead_space`, `punct_run` with `lead_space`, `trailing_ws`, `ws_run`). `ByteLevel`'s internal regex is a constant in the HuggingFace `tokenizers` crate. It is never a per-model value read from `tokenizer.json`. SmolLM2's second stage and Falcon's second stage both lower to this.
- `Split(pattern, Isolated, invert=false)`, where `pattern` is one of the recognised exhaustive alternation regexes: the main GPT-2-family shape, the older OpenAI shape, the o200k/mistral-nemo cased-letter shape, or DeepSeek-V3's third-stage shape. `Split(pattern, Removed, invert=true)` on one of those same recognised shapes reduces to the same output; see packages/maps-cli/src/convert.ts's Split-node comment for the full derivation.

`ByteLevel(use_regex=false)` contributes NO stage. It is a byte-encode-only step. Byte encoding itself is unconditional whenever the map's `encoder` is `byte_level`. It applies downstream of the whole pre_tokenizer_program, on its own.

## Worked examples

### Qwen-2 (GPT-2-family, unbounded numbers, v1)

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

### Llama-3 (GPT-2-family, numbers bounded to 3, v1)

Same as Qwen-2 but with `{ "op": "numbers", "max_run": 3 }`.

### Llama-2 / Mistral-v3 (metaspace, v1)

```jsonc
{ "version": 1, "ops": [{ "op": "metaspace_split", "prefix_first": false }] }
```

### HuggingFaceTB/SmolLM2 (v2: `Sequence[Digits, ByteLevel]`)

Source Sequence: `Digits(individual_digits=true)`, `ByteLevel(use_regex=true)`.

```jsonc
{
  "version": 2,
  "stages": [
    { "stage": "digits_isolate", "mode": "individual" },
    { "stage": "alternation", "ops": [
      { "op": "literals", "patterns": ["'s","'t","'re","'ve","'m","'ll","'d"] },
      { "op": "letters", "lead_space": true },
      { "op": "numbers", "lead_space": true },
      { "op": "punct_run", "lead_space": true },
      { "op": "trailing_ws" },
      { "op": "ws_run" }
    ] }
  ]
}
```

`"a  1"` is a whitespace run of two or more code points immediately followed by a digit. It becomes `["a", "  ", "1"]`. `digits_isolate` isolates the `1` first. The two-space run therefore lands inside the SAME piece as the `a`, before `ByteLevel` ever runs. That piece's own `trailing_ws` op then keeps the whole run together.

### tiiuae/falcon (v2: `Sequence[Punctuation, ByteLevel, Digits, Split]`)

Source Sequence: `Punctuation(Contiguous)`, `ByteLevel(use_regex=true)`, `Digits(individual_digits=false)`, `Split([0-9][0-9][0-9], Isolated)`.

```jsonc
{
  "version": 2,
  "stages": [
    { "stage": "punctuation_contiguous" },
    { "stage": "alternation", "ops": [
      { "op": "literals", "patterns": ["'s","'t","'re","'ve","'m","'ll","'d"] },
      { "op": "letters", "lead_space": true },
      { "op": "numbers", "lead_space": true },
      { "op": "punct_run", "lead_space": true },
      { "op": "trailing_ws" },
      { "op": "ws_run" }
    ] },
    { "stage": "digits_isolate", "mode": "grouped" },
    { "stage": "digit_triples_isolate" }
  ]
}
```

`"a  .b"` carries the same whitespace-run-then-glued-content shape as SmolLM2's example, with punctuation standing in for the digit. `punctuation_contiguous` runs first, producing three pieces before `ByteLevel` even sees the text: `"a  "` (letter and spaces share the non-punct classification), `"."`, `"b"`. `"12345"` becomes `["123", "45"]`. `Digits(individual_digits=false)` first groups the whole run into one piece. `digit_triples_isolate` then chunks that piece into windows of exactly 3.

### deepseek-ai/DeepSeek-V3, deepseek-ai/DeepSeek-R1 (v2: `Sequence[Split, Split, Split, ByteLevel]`)

Source Sequence: `Split(\p{N}{1,3}, Isolated)`, `Split([一-龥぀-ゟ゠-ヿ]+, Isolated)`, `Split(<third-stage regex>, Isolated)`, `ByteLevel(use_regex=false)`.

```jsonc
{
  "version": 2,
  "stages": [
    { "stage": "digits_isolate", "mode": "grouped", "max_run": 3 },
    { "stage": "cjk_isolate" },
    { "stage": "alternation", "ops": [
      { "op": "punct_ascii_letters" },
      { "op": "letters", "lead_other": true, "lead_other_class": "l_p_s", "body": "L_M" },
      { "op": "punct_run", "lead_space": true, "trailing_newlines": true, "charset": "p_s" },
      { "op": "newline_block" },
      { "op": "trailing_ws" },
      { "op": "ws_run" }
    ] }
  ]
}
```

`ByteLevel(use_regex=false)` contributes no fourth stage: byte-encode-only, see § `alternation`. `"日本語abc"` becomes `["日本語", "abc"]`. `cjk_isolate` separates the CJK run from the adjacent Latin run before the alternation stage ever sees either one. `"12345"` becomes `["123", "45"]`, the same chunking shape as Falcon's digit-triples example, reached here through the bounded `digits_isolate` stage. A decomposed `"é"`, `e` plus a combining acute (U+0301), followed by another letter, stays one piece here. The `letters` op's `body: "L_M"` keeps the base letter and its mark together.

## Class membership

Several ops and stages require Unicode character-class queries at runtime: `letters`, `numbers`, `punct_run`, `punct_ascii_letters`, `newline_block`, `trailing_ws`, `ws_run`, `punctuation_contiguous`, `digits_isolate`, `digit_triples_isolate`. They use these classes:

- `\p{L}`: General_Category=Letter
- `\p{N}`: General_Category=Number
- `\p{M}`: General_Category=Mark
- `\p{P}`: General_Category=Punctuation
- `\p{S}`: General_Category=Symbol
- `\s`: `\p{White_Space}` plus the ASCII whitespace fallbacks (already standard)

**These tables are owned by the runtime and are never shipped in the map.** Each language uses its native facility:

| Runtime | Mechanism |
|---|---|
| TS / JS | `/\p{L}/u`, `/\p{N}/u` (native regex, no extra dep) |
| Python | `regex` package (already a dep for `pre_tokenizer_pattern` mode) |
| .NET | `Char.IsLetter`, `Char.IsDigit` (BCL) |
| **C / libcodec** | Vendored interval-list tables, ~30KB static `.c` file generated from Unicode UCD by a small build-time tool. Lookup is binary search, ~15 LOC. |

The Unicode version travels with the runtime. Tokenizer training is fairly insensitive to which Unicode minor version classifies a given exotic character. What matters is that the runtime and the training-time pre-tokenizer agree on the *common* code points (Latin, CJK, common digits). Every runtime in practice does agree on those.

The `cjk_isolate` stage's ranges (§ `cjk_isolate`) are fixed literal code-point intervals. They are not a Unicode general-category query. A runtime implements them as three integer comparisons. No property table is needed for this one.

## Compiler failure is loud

The maps-cli compiler recognises a fixed, named set of HuggingFace pre-tokenizer node shapes (§ Op set, § Stages (v2)). Three shapes make the whole conversion throw: a `Sequence` child it doesn't recognise, a `Split` node whose `behavior` or `invert` combination it hasn't verified a lowering for, and a `Punctuation` node with a behavior other than `Contiguous`. The compiler never falls back to a plausible-looking guess for any of these.

This is a direct response to the defect the compiler used to have. The original converter took the FIRST `Split` node found anywhere in the tree via a recursive search. It silently discarded every other stage in the `Sequence`. It silently dropped that Split's own `behavior` and `invert` fields too. A later hand-patch replaced the resulting broken output with a substitute regex, on the strength of a correctness claim that turned out to be false: the corpus it was checked against was too narrow to reach the cases where the substitute and the real tokenizer disagree. On real source code and markdown, one of the four affected published maps failed 95% of samples.

A map with neither a working `pre_tokenizer_program` nor an honest `pre_tokenizer_pattern` is unusable at encode time, regardless of when the gap is discovered. Throwing at conversion time surfaces that gap immediately. The error message names the exact unsupported node. It therefore also points at what needs a new recognised shape. That is the whole alternative to shipping a plausible-looking map that fails silently and unpredictably downstream.

One exception exists, narrow and specific to `pre_tokenizer_pattern`. It never applies to `pre_tokenizer_program`. Take a lone `Split(pattern, Isolated, invert=false)` node whose pattern isn't a recognised shape, with nothing else in the Sequence contributing a program stage. That case degrades to a pattern-only map, with no program at all. Failing outright is not required here. The reason: `Isolated` with `invert=false` on ANY regex, recognised or not, means exactly "find every match, emit each as a piece." That is the literal, faithful semantics of the legacy `pre_tokenizer_pattern` field on its own. Falling back to it therefore carries zero approximation. This fallback disappears the moment the pattern sits alongside any other real stage in the Sequence. At that point the whole program has to be expressible, or none of it gets emitted.

## Versioning

`pre_tokenizer_program.version` is a schema version for the program's own shape. It picks between `ops` and `stages`. It settles which op/stage names exist at each version. It is a different number from the map's own top-level `version` field, currently `"2"` and unrelated to this document's `2.1` in its title. The two must never be confused.

A v1-only client, one that only knows the `{ "ops": [...] }` shape, MUST refuse to execute a v2 program. Guessing is not an acceptable fallback here. Interpreting `stages` as if each entry were an `op` produces exactly the class of silent wrong-shaped output this whole format exists to prevent; so does ignoring the `stages` wrapper and hunting for an `ops` field that isn't there. `packages/web/src/pretok-program.ts`'s interpreter throws immediately on any `version` it doesn't recognise. The error names the version. It never falls through to either execution model by guesswork.

As of this revision, `packages/web` (TypeScript) understands both v1 and v2. Three other clients understand v1 only: `packages/python`, `packages/rust`, `packages/c`. Their interpreters have not yet been extended for v2 stages. `packages/maps-cli`'s converter accounts for this gap directly: it stays on v1 whenever a source reduces to exactly one `alternation` stage. That covers every currently published byte_level map except SmolLM2, Falcon, and DeepSeek-V3/R1. Those maps see zero output change from this revision. They keep working unmodified on every client. Only the four sources that genuinely need more than one stage emit v2. Only a client updated to execute v2 can consume those four maps' programs. Every other client falls back to whatever `pre_tokenizer_pattern` the map carries. That is none, for these four: see § Compiler failure is loud. Absent both fields, such a client fails to construct a tokenizer at all. Bringing Python, Rust, and C up to v2 is tracked as follow-up work. It is not done in this revision.

## Compatibility

- Maps may emit both `pre_tokenizer_pattern` and `pre_tokenizer_program`. Old clients see only the pattern. New clients prefer the program.
- A map without a program continues to work in old clients. A map without a pattern is **valid**, though consumable only by program-aware clients. Every v2 map (§ Versioning) is in this position: a multi-stage Sequence simply has no single regex that reproduces its output.
- A `Sequence` shape the compiler doesn't recognise makes the conversion throw. Neither field gets emitted in that case. See § Compiler failure is loud.

## Equivalence

Take a v1 program, or a v2 program whose HuggingFace source reduces to a single `Split`/`ByteLevel` alternation stage. Applying `pre_tokenizer_program` to any input string MUST produce the same sequence of pieces as compiling and running `pre_tokenizer_pattern`, modulo the legacy regex's zero-width-match guard. That guard never affects observable output.

A v2 program with more than one stage has no `pre_tokenizer_pattern` to compare against (§ Compatibility). The property is stated against the source instead: applying `pre_tokenizer_program` to any input string MUST produce the same sequence of pieces as a faithful transcription of the model's real HuggingFace `Sequence` pre-tokenizer, run with the same vocab, merges, and special-token handling held constant. This is what distinguishes a map-data fault in the pretok lowering from a fault anywhere else in the encoder. Holding everything downstream of pre-tokenization fixed, then swapping in the real Sequence, is the differential test the maps-cli compiler is checked against for SmolLM2, Falcon, DeepSeek-V3, and DeepSeek-R1. It runs across three corpora: a golden corpus, a combinatorial stress corpus, and real source-code-and-markdown samples.

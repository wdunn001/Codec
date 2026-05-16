# Crafting compressible response prompts

Codec's wire-byte savings come from two layers stacked: (1) token-ID
framing replaces detokenized-text framing (~15× over JSON-SSE at default
identity), and (2) HTTP `Content-Encoding` compression crushes the
repetitive bytes left in the stream (gzip/br to ~3–5 B/token, dict-zstd
to under 1 B/token on highly-structured outputs). Layer 2's effectiveness
depends on what the model actually emits — token sequences with low
entropy and structural repetition compress orders of magnitude better
than free-form prose.

This file is a practical reference for **prompts that produce naturally
compressible responses while still returning the information the caller
asked for**. Sister to `RESULTS.md` (which measures realised ratios on
canonical workloads) and the v0.5 synthetic-stream bench cell (which
will isolate protocol framing from model-output content; see GitHub
issue tracking task #43).

The cross-stack v0.4.1 bench surfaced a 14× ratio gap on the same prompt
(sglang 86×, vllm 8×) caused entirely by the engines settling into
different greedy continuations at temperature=0 — same framing, same
compressor, different bytes. This document is the prompt-engineering
side of that observation.

---

## The mental model

You want each line of the response to be **mostly predictable from
earlier lines**, with only the actual data carrying entropy. gzip's
LZ77 stage memorises any repeated byte sequence within ~32 KB, and
deflate's Huffman stage cheap-encodes the high-frequency tokens that
result. dict-zstd starts with ~16 KB of pre-trained context already in
its window, so the first response byte already pays for itself.

The framing bytes inside a Codec msgpack frame are ~9 constant bytes
plus a 1–3 byte varint per token ID. Over 2048 frames that's ~20 KB of
identical structural bytes that gzip eats down to near-zero — only the
content (token IDs and their patterns) carries through. If the content
itself is templated, you get another order of magnitude.

So the goal is: **structured output formats that the LLM has lots of
training data for, with the variable bits scoped tightly**.

---

## High-compression prompt patterns

### Schema-locked output

Replace prose with a fixed scaffold; only the values vary line to line.

Before:
> "Tell me about three quantum computing applications and their use cases."

After:
> List three quantum computing applications. Format each as:
> ```
> Application: <name>
> Domain: <field>
> Use case: <one sentence>
> Maturity: <research|prototype|production>
> ```
> Output exactly three entries, no preamble.

After the first entry the gzip window has seen the entire
`\nApplication: \nDomain: \nUse case: \nMaturity: ` skeleton; each
subsequent entry costs only the actual values. Same information density,
markedly higher compressibility.

### Vocabulary-locked answers

> Answer each question with exactly one of: YES, NO, MAYBE. Then a
> single short reason starting with "because".

Three tokens (`YES`, `NO`, `MAYBE`) and the word `because` repeat every
line. Only the reason varies. The maturity field in the schema example
above is the same idea — a closed enum.

### Restate-then-answer

> For each question below, output:
> ```
> Q: <question verbatim>
> A: <answer>
> ```
> Questions: ...

The `Q:` line is essentially free under gzip — its tokens are already in
the prompt context, and the deflate window memorises them after the
first iteration. The `A:` lines carry the actual content.

### Enumerated lists over prose

> List the 10 most common Python errors. One per line. Format:
> `<N>. <error name> — <one-sentence cause>` — no headers, no intro.

The `. ` and ` — ` separators repeat. Numerals 1–10 are single-token IDs.
Only the error names + causes are entropy.

### Tabular

> Output as a markdown table with columns: Name | Year | Author |
> Subject. No prose. Five rows.

Column separators and header row repeat — and for cross-row repetition,
gzip eats the `|` token-IDs cheaply.

### Known-template formats

> Respond as a man page entry: NAME / SYNOPSIS / DESCRIPTION / OPTIONS /
> SEE ALSO sections.

The man-page scaffold is highly repetitive and the model has seen
thousands of examples in training, so it produces a structurally
consistent skeleton. Compresses well, reads well to humans.

### Numeric-precision constraints

> All scores to 2 decimal places. All durations in seconds. All
> percentages as integers 0–100.

Predictable number formats compress better than free-form floats. A
2-decimal field like `0.87` is two token-IDs the compressor sees
repeatedly; a free-form `0.8734129…` is a different token sequence each
time.

---

## What to avoid if you care about compressibility

- "Be creative", "vary your phrasing", "use different words each time"
  — kills the repetition gzip needs
- "Use bullet points but vary the formatting" — kills templates
- Asking for synonyms or alternate phrasings
- Free-form prose with no structure

---

## The Codec-specific multiplier: domain-tuned dicts

All of the above interacts with Codec's dict-zstd path. A zstd dict
trained on a corpus of typical responses for your domain (medical,
legal, code, finance, support tickets, etc.) starts the compressor with
~16 KB of pre-loaded context. A domain-tuned dict + a templated output
prompt can push response sizes into the 100–1000× compression range
without losing any information.

See `spec/versions/v0.4.md` § "Pre-trained ZSTD dictionaries" for the
dict contract, and `packages/bench/scripts/train-zstd-dict.py` for the
reference training pipeline.

---

## Why this works (the wire-level intuition)

A Codec msgpack frame at one token per chunk looks like:

```
\x82\xa3ids\x91\xcd\x5b\xf0\xa4done\xc2
```

Eleven bytes total: a fixed 9-byte structural scaffold (`\x82\xa3ids\x91`
+ `\xa4done\xc2`) and a 2-byte varint token ID. The scaffold is byte-
identical across all frames in the stream.

The first frame teaches gzip's sliding window the scaffold. From the
second frame onward, the scaffold encodes to ~1 bit; only the token-ID
varint carries entropy. If those token IDs are themselves repetitive
(low cardinality, templated transitions), they compress to fractions of
a bit each.

With 2048 frames × low-entropy content, the wire reduces from ~30 KB
identity to ~350 B gzipped or ~290 B dict-zstd — matching the v0.4.1
bench's observed ratios when the model output happens to be highly
structured.

When the model output is free-form (one of the bench's tokenizer-stream
runs against a creative prompt would do this), the same compressor on
the same wire format yields ~3–4 KB — still 8–10× better than JSON-SSE
but a far cry from the 1700× headline.

**Therefore:** Codec's headline compression is **real but
content-dependent.** Bench numbers measure the multiplication of
framing efficiency by content structure; prompt design moves the
content-structure axis.

---

## Practical recommendations

For agent-to-agent loops, mobile clients, edge deployments, or any
bandwidth-constrained Codec consumer:

1. **Default to structured output formats** (JSON Schema, fixed-shape
   markdown, fixed CSV) even when humans aren't the immediate consumer.
2. **Constrain vocabulary** where the domain allows (enum fields, fixed
   precision, known templates).
3. **Train a domain-specific zstd dict** if you control both ends.
4. **Measure realised wire bytes**, not just whether the response
   "looks right" — the prompt-engineering changes show up in the wire
   bytes, not in human readability.

For benchmarking the protocol itself rather than the model + protocol
together, prefer the v0.5 synthetic-stream cell when it lands (see
`packages/bench/methodology/SCHEMA.md` § synthetic-stream — TBD).

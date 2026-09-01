# Unicode-Level Smuggling

**Status:** research: v0.6 security workstream. Sibling files: see [README](README.md).

## TL;DR

Unicode contains entire ranges of characters that are either invisible to humans, visually identical to common ASCII, or invisible *and* tokenized as distinct tokens by LLM tokenizers. These ranges form a covert channel that lets an attacker plant instructions in any user-controlled text field (LinkedIn bios, GitHub READMEs, email bodies, code comments, filenames, document metadata) that look empty or innocuous to a human but carry adversarial prompts when tokenized.

For Codec specifically: **anything client-side that round-trips user text through the protocol should normalize and strip these ranges at the boundary**, both inbound (data entering the encoder) and outbound (data leaving the decoder before rendering or re-tokenization).

## Threat model

- **Attacker capability:** can place arbitrary Unicode text in any field that will eventually be tokenized and fed to a model (or rendered to a downstream consumer that re-tokenizes).
- **Attacker goal:** smuggle instructions past human review and past naive keyword filters.
- **Defender constraint:** cannot reject all non-ASCII content (legitimate Unicode use is the default; stripping all non-ASCII breaks every non-English application).

## Vectors

### 1. Unicode Tag block (U+E0000:U+E007F)

**Mechanism.** The Unicode Tag block is a copy of ASCII (U+E0000 + ASCII codepoint = the tag equivalent). These characters render as nothing in every commonly-deployed font. Most BPE tokenizers (GPT, Llama, Claude, Mistral) tokenize them as distinct tokens. An attacker can encode an arbitrary ASCII string in tag-block characters and the model will see it as text while a human reviewer sees nothing.

**Public reference:** Riley Goodside's June 2024 demonstration. Joseph Thacker's subsequent writeup. Cataloged at https://embracethered.com under "ASCII Smuggler."

**Status of platform mitigations as of 2026-05:**
- LinkedIn About field: strips most of the range; recently partial.
- Twitter/X: passes through.
- GitHub README: passes through.
- Most email clients: passes through.
- Google Docs comments: passes through.

**Defense.**

```python
import unicodedata

TAG_BLOCK_START = 0xE0000
TAG_BLOCK_END = 0xE007F

def strip_unicode_smuggling(s: str) -> str:
    return ''.join(
        c for c in s
        if not (TAG_BLOCK_START <= ord(c) <= TAG_BLOCK_END)
    )
```

For Codec: strip at the encoder boundary AND at the decoder boundary. The double-pass is intentional: an intermediate transformation (compression dictionary, tokenizer-map roundtrip) could theoretically reintroduce these characters from a poisoned dictionary. The decode-side strip is the catch-net for exactly that case.

Recommend ALSO logging the density of stripped tag-block characters per request. A non-zero count is almost always a smuggling attempt; legitimate use is essentially nonexistent.

### 2. Zero-width characters

The relevant codepoints:

| Codepoint | Name | Renders as |
|---|---|---|
| U+200B | Zero-width space | nothing |
| U+200C | Zero-width non-joiner | nothing (legitimate use in Persian/Arabic) |
| U+200D | Zero-width joiner | nothing (legitimate use in emoji ZWJ sequences, Indic scripts) |
| U+2060 | Word joiner | nothing |
| U+FEFF | Zero-width no-break space / BOM | nothing |

**Mechanism.** Insert between every character of a banned phrase to defeat keyword/regex filtering. `ignore previous instructions` becomes `i​g​n​o​r​e​ ​p​r​e​v​i​o​u​s​ ​i​n​s​t​r​u​c​t​i​o​n​s` with U+200B between each char: visually identical, but a regex like `/ignore previous/i` won't match.

Importantly: **tokenizers handle these inconsistently.** Some tokenizers strip them implicitly (no smuggling effect, just filter bypass); others tokenize them as their own tokens, splitting words into many short tokens: which means the model sees the phrase as fragmented and may still understand the intent.

**Public reference:** widely discussed since 2023. See https://embracethered.com and Simon Willison's blog. Used in viral LinkedIn bio prompt injections (May 2026, tmuxvim "Old English").

**Defense.**

```python
ZERO_WIDTH_CHARS = {
    '​', '‌', '‍', '⁠', '﻿',
}

def strip_zero_width(s: str, preserve_zwj: bool = True) -> str:
    # ZWJ (U+200D) is legitimately used in emoji sequences (👨‍👩‍👧‍👦) and
    # Indic scripts; stripping breaks those. If your application receives
    # emoji or Indic content, keep ZWJ and strip only the others.
    skip = ZERO_WIDTH_CHARS - ({'‍'} if preserve_zwj else set())
    return ''.join(c for c in s if c not in skip)
```

For Codec: strip at the boundary. For tokenizer-map dictionaries: reject any dictionary entry whose key contains zero-width characters (legitimate corpus phrases do not need these).

### 3. Variation selectors

**Mechanism.** Two ranges:

- **VS-1 through VS-16:** U+FE00:U+FE0F (BMP, single-codepoint).
- **VS-17 through VS-256:** U+E0100:U+E01EF (supplementary, surrogate-pair encoded).

These attach to the preceding character and modify its presentation. Originally for CJK font variants and emoji presentation. Recent research demonstrates encoding arbitrary payload data in long sequences of variation selectors after a carrier character: effectively a covert channel of up to 256 bits per carrier character.

**Public reference:** Paul Butler's "Smuggling arbitrary data through an emoji" (2024); analyzed by Anthropic researchers and added to Claude content filters. https://paulbutler.org/2025/smuggling-arbitrary-data-through-an-emoji/

**Defense.** Same pattern: strip at the boundary. Variation selectors have legitimate use in CJK rendering. A blanket strip can therefore be hostile to East-Asian users. Recommended policy: strip *consecutive* variation selectors (more than one in a row is non-legitimate), keep single VS-15/VS-16 immediately following an emoji-eligible character.

```python
def strip_smuggled_variation_selectors(s: str) -> str:
    out = []
    last_was_vs = False
    for c in s:
        cp = ord(c)
        is_vs = (0xFE00 <= cp <= 0xFE0F) or (0xE0100 <= cp <= 0xE01EF)
        if is_vs and last_was_vs:
            continue  # drop second-and-onward consecutive VS
        out.append(c)
        last_was_vs = is_vs
    return ''.join(out)
```

### 4. Right-to-left override and bidirectional controls

**Codepoints:** U+202A:U+202E (Embedding/Override), U+2066:U+2069 (Isolate).

**Mechanism.** Reverses or rearranges display order without reordering the underlying bytes. The "Trojan Source" attacks demonstrated this in source code: comments and string literals that visually read benign while parsing as malicious. The same trick works in prose targeting human review.

**Public reference:** Boucher & Anderson, "Trojan Source: Invisible Vulnerabilities" (2021), CVE-2021-42574.

**Defense.** Strip all of U+202A:U+202E and U+2066:U+2069 from any field that will be reviewed by a human or that influences instruction parsing. For genuinely RTL content (Arabic, Hebrew), the natural directionality of the characters handles rendering: explicit BiDi controls are very rarely needed.

```python
BIDI_CONTROL_CHARS = set(chr(cp) for cp in
    list(range(0x202A, 0x202F)) + list(range(0x2066, 0x206A)))

def strip_bidi_controls(s: str) -> str:
    return ''.join(c for c in s if c not in BIDI_CONTROL_CHARS)
```

### 5. Confusables (homoglyphs)

**Mechanism.** Visually identical characters from different scripts. Cyrillic 'а' (U+0430) for Latin 'a' (U+0061); Greek 'ο' (U+03BF) for Latin 'o' (U+006F); etc. Defeats keyword matching (a regex for `admin` won't match `аdmin` with Cyrillic а). Smuggled instructions hide in plain sight as a result.

The Unicode Consortium publishes a confusables table: https://www.unicode.org/Public/security/latest/confusables.txt

**Defense.** NFKC normalization handles many but not all confusables (it normalizes presentation-form characters but doesn't unify across scripts). For mixed-script detection, use the Unicode `Script` property and flag strings that mix scripts where one script alone would suffice. Python's `unicodedata` plus a confusables library (e.g., `confusable-homoglyphs` PyPI package) is the standard approach.

```python
import unicodedata

def normalize_for_policy_check(s: str) -> str:
    # Normalize for keyword matching; do NOT use this normalized form
    # as the canonical text to ship to the model (lossy).
    return unicodedata.normalize('NFKC', s).casefold()
```

For Codec: NFKC-normalize BEFORE running any policy check (banned-pattern matching), but ship the original NFC form to the model so user content is preserved verbatim.

### 6. Mathematical alphanumeric and alternate scripts

**Mechanism.** Unicode contains entire alternate Latin-looking alphabets:

- Mathematical bold (U+1D400+): 𝐀𝐁𝐂...
- Mathematical italic (U+1D434+): 𝐴𝐵𝐶...
- Mathematical bold italic, script, fraktur, double-struck, sans-serif, sans-serif bold, sans-serif italic, sans-serif bold italic, monospace.
- Fullwidth Latin (U+FF21+): ＡＢＣ...
- Enclosed alphanumerics (U+2460+): ⒶⒷⒸ...
- Mongolian variation selectors (U+180B:U+180D).

Most of these are visually distinct (a careful reader sees them) but defeat substring matching and naive content filters.

**Defense.** NFKC normalization handles most of them (math alphanumerics, fullwidth, enclosed all normalize to base Latin under NFKC). This is one of the strongest arguments for NFKC-then-check as the policy pattern.

### 7. Glitch tokens

**Mechanism.** Model-specific tokens that, when fed to certain models, produce hallucinated, malformed, or off-topic outputs. The classic GPT-3 example: ` SolidGoldMagikarp` (note leading space) and related tokens whose embeddings were under-trained because the corresponding words were filtered from training data after tokenizer training. Sending these to the model can break instruction-following.

**Public reference:** Rumbelow & Watkins, "SolidGoldMagikarp (plus, prompt generation)," LessWrong 2023. Catalogs maintained at https://github.com/cohere-ai/sandbox-toy-glitch-tokens (illustrative; check for current per-model lists).

**Defense.** Maintain a per-model glitch-token blocklist. If user content contains one, replace with a near-equivalent or reject. For Codec: this is a per-model concern that belongs in the tokenizer-map metadata, NOT in core Codec encoding. The reference implementation should expose a hook for downstream policy.

## Codec-specific implementation

Recommended v0.6 additions:

1. **Normative client requirement:** all Codec implementations MUST strip the Unicode Tag block (U+E0000:U+E007F) from inbound user text before encoding. Decoders SHOULD strip on output as a defense-in-depth measure.
2. **Policy hook in tokenizer-map:** the tokenizer-map handshake (see [02-wire-protocol-attacks.md](02-wire-protocol-attacks.md)) should include a `forbidden_codepoint_ranges` field, defaulting to the union of tag block + bidi controls + invisible-VS-runs.
3. **Counter telemetry:** clients SHOULD emit a counter for stripped smuggling chars per request. Sustained nonzero values are an indicator of attack-in-progress.
4. **Reject mixed-script tokens in dictionary uploads:** if v0.6 ships prompt dialects (sibling proposal), dictionary keys MUST be single-script per entry, NFKC-normalized.

## Verification

A test corpus of smuggling inputs should be added to `packages/bench/fixtures/smuggling/`:

- Tag-block-encoded prompts (a known plaintext encoded into invisible chars)
- ZWSP-salted prompts (banned phrases with U+200B between letters)
- VS-suffixed payload (256 bytes encoded in VS chain after a carrier)
- RLO-reversed visible/effective mismatch
- Cyrillic-confusable homoglyph payload
- Fullwidth-Latin payload
- Known glitch tokens per supported model

Each fixture should have:
- Visible text (what a human sees)
- Underlying bytes (what the model would receive)
- Expected post-strip output (what Codec MUST produce)
- Expected counter increments (telemetry)

The cross-stack bench (`packages/bench/`) should include a "smuggling resistance" axis alongside the existing wire-overhead and decode-quality axes.

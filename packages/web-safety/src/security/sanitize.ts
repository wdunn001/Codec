/**
 * Layer 0 — boundary sanitizer for invisible / special-token attacks.
 *
 * Runs BEFORE the prefilter ([prefilter.ts](../prefilter.ts)). Strips
 * classes of input that should not survive into the wire payload regardless
 * of intent:
 *
 *   - Unicode Tag block (U+E0000–U+E007F) — invisible covert channel
 *   - Zero-width chars (U+200B/200C/200D/2060/FEFF) — filter-evasion
 *   - Variation selector runs — covert payload encoding
 *   - BiDi controls (U+202A–U+202F, U+2066–U+2069) — Trojan Source
 *   - Chat-template special tokens — boundary-break injection
 *
 * Why this is layer 0 and not part of prefilter:
 *
 *   - These strips are non-negotiable. The prefilter classifies-and-warns
 *     (host app decides to redact or refuse); the sanitizer just strips
 *     unconditionally.
 *   - The prefilter operates on what's SEMANTICALLY present (secrets, PII,
 *     jailbreak templates). The sanitizer operates on what's
 *     STRUCTURALLY hostile (covert channels, role-confusion tokens).
 *
 * Maps to spec/proposals/v0.6-security/01-unicode-smuggling.md and
 * v0.6-security/03-indirect-injection.md.
 */

const TAG_BLOCK_START = 0xe0000;
const TAG_BLOCK_END = 0xe007f;

const ZERO_WIDTH_CHARS = new Set([
  '​', // zero-width space
  '‌', // zero-width non-joiner
  '‍', // zero-width joiner (legitimate in emoji/Indic — see options)
  '⁠', // word joiner
  '﻿', // zero-width no-break space / BOM
]);

const BIDI_CONTROL_CHARS = new Set<string>();
for (let cp = 0x202a; cp <= 0x202e; cp++) BIDI_CONTROL_CHARS.add(String.fromCodePoint(cp));
for (let cp = 0x2066; cp <= 0x2069; cp++) BIDI_CONTROL_CHARS.add(String.fromCodePoint(cp));

const CHAT_TEMPLATE_TOKENS: readonly string[] = [
  // ChatML (OpenAI internal, Qwen, many fine-tunes)
  '<|im_start|>',
  '<|im_end|>',
  '<|im_sep|>',
  '<|endoftext|>',
  // Llama 3
  '<|begin_of_text|>',
  '<|end_of_text|>',
  '<|eot_id|>',
  '<|start_header_id|>',
  '<|end_header_id|>',
  // Mistral / Mixtral instruct
  '[INST]',
  '[/INST]',
  '<s>',
  '</s>',
  // Gemma
  '<start_of_turn>',
  '<end_of_turn>',
  // DeepSeek (uses different bar characters)
  '<｜begin▁of▁sentence｜>',
  '<｜end▁of▁sentence｜>',
];

export interface SanitizeOptions {
  /** Preserve U+200D (ZWJ) — set true if the app accepts emoji or Indic scripts. Default false. */
  preserveZeroWidthJoiner?: boolean;
  /** Strip variation selector runs of length >= this. Default 2. */
  variationSelectorRunMin?: number;
}

export interface SanitizeResult {
  /** The sanitized text. */
  text: string;
  /** Per-vector strip counts — emit as telemetry. Nonzero values indicate attack-in-progress. */
  removed: {
    tagBlock: number;
    zeroWidth: number;
    variationSelectors: number;
    bidiControls: number;
    chatTemplateTokens: number;
  };
}

/**
 * Sanitize a user-supplied string at the Codec boundary.
 *
 * Strips invisible smuggling channels and chat-template special tokens.
 * Returns sanitized text plus per-vector strip counts for telemetry.
 */
export function sanitizeForCodec(
  input: string,
  options: SanitizeOptions = {},
): SanitizeResult {
  const preserveZWJ = options.preserveZeroWidthJoiner ?? false;
  const vsRunMin = options.variationSelectorRunMin ?? 2;

  const removed = {
    tagBlock: 0,
    zeroWidth: 0,
    variationSelectors: 0,
    bidiControls: 0,
    chatTemplateTokens: 0,
  };

  const zwSet = preserveZWJ
    ? new Set([...ZERO_WIDTH_CHARS].filter((c) => c !== '‍'))
    : ZERO_WIDTH_CHARS;

  // First pass — character-level strips using a code-point-aware iteration.
  const chars = Array.from(input);
  const filtered: string[] = [];
  let vsRunLen = 0;

  for (const c of chars) {
    const cp = c.codePointAt(0)!;

    // Tag block
    if (cp >= TAG_BLOCK_START && cp <= TAG_BLOCK_END) {
      removed.tagBlock++;
      vsRunLen = 0;
      continue;
    }

    // Zero-width
    if (zwSet.has(c)) {
      removed.zeroWidth++;
      vsRunLen = 0;
      continue;
    }

    // BiDi controls
    if (BIDI_CONTROL_CHARS.has(c)) {
      removed.bidiControls++;
      vsRunLen = 0;
      continue;
    }

    // Variation selectors: strip when consecutive run reaches threshold.
    // (Single VS is legitimate for emoji presentation, e.g. U+FE0F.)
    const isVS =
      (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
    if (isVS) {
      vsRunLen++;
      if (vsRunLen >= vsRunMin) {
        removed.variationSelectors++;
        continue;
      }
      filtered.push(c);
      continue;
    }
    vsRunLen = 0;
    filtered.push(c);
  }

  let text = filtered.join('');

  // Second pass — chat-template token string-replace.
  for (const tok of CHAT_TEMPLATE_TOKENS) {
    const before = text.length;
    text = text.split(tok).join('');
    if (text.length !== before) {
      removed.chatTemplateTokens += (before - text.length) / tok.length;
    }
  }

  return { text, removed };
}

/**
 * Minimal cross-script confusables fold. NFKC handles compatibility-class
 * confusables (mathematical alphanumerics, fullwidth Latin, enclosed alphanums)
 * but NOT cross-script confusables — Cyrillic 'а' (U+0430) is visually
 * identical to Latin 'a' but has no compatibility decomposition. This table
 * is the small Latin-look-alike subset of Cyrillic and Greek needed for the
 * common cases. Production deployments should layer in the full Unicode
 * confusables table (see `confusable-homoglyphs` npm or the official table
 * at https://www.unicode.org/Public/security/latest/confusables.txt).
 */
const CONFUSABLES_MAP: Record<string, string> = {
  // Cyrillic lowercase
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's', і: 'i',
  // Cyrillic uppercase
  А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O',
  Р: 'P', Т: 'T', Х: 'X', У: 'Y', І: 'I',
  // Greek lowercase
  α: 'a', ο: 'o', ν: 'v', ρ: 'p',
  // Greek uppercase
  Α: 'A', Β: 'B', Ε: 'E', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M',
  Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};

/** Fold a small set of cross-script confusables to their Latin lookalikes. */
export function foldConfusables(s: string): string {
  let out = '';
  for (const c of s) out += CONFUSABLES_MAP[c] ?? c;
  return out;
}

/**
 * NFKC-normalize + confusables-fold + casefold for policy/matching use ONLY.
 *
 * Folds mathematical alphanumerics (𝐓 → T), fullwidth Latin (Ｔ → T), enclosed
 * alphanumerics (Ⓣ → T), and the common Cyrillic/Greek lookalikes (Cyrillic
 * 'а' → Latin 'a'). Useful for keyword matching against banned-word lists.
 *
 * **Lossy** — never ship the normalized form to the model or over the wire;
 * ship the original NFC form. This is for policy decisions only.
 */
export function normalizeForPolicy(s: string): string {
  return foldConfusables(s).normalize('NFKC').toLowerCase();
}

/**
 * NFC normalize for wire payload — preserves user content exactly while
 * stabilizing combining sequences. Safe to ship.
 */
export function normalizeForWire(s: string): string {
  return s.normalize('NFC');
}

/**
 * Returns true if any of the structural-attack classes are present in the
 * raw input. Useful as a fast pre-check before paying the full sanitize cost.
 */
export function looksLikeSmuggling(s: string): boolean {
  let vsRun = 0;
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    if (cp >= TAG_BLOCK_START && cp <= TAG_BLOCK_END) return true;
    if (ZERO_WIDTH_CHARS.has(c)) return true;
    if (BIDI_CONTROL_CHARS.has(c)) return true;
    const isVS = (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
    if (isVS) {
      vsRun++;
      if (vsRun >= 2) return true; // run of VS chars is suspicious
    } else {
      vsRun = 0;
    }
  }
  for (const tok of CHAT_TEMPLATE_TOKENS) {
    if (s.includes(tok)) return true;
  }
  return false;
}

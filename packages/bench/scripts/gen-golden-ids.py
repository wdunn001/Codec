#!/usr/bin/env python3
"""
gen-golden-ids.py — generate ground-truth (text, ids) pairs using HuggingFace
tokenizers, the same library that produced our codec-maps. The output is a
JSON file consumed by tokenizer-accuracy.ts to validate that @codecai/web's
pure-JS BPE matches the reference tokenizer exactly.

Usage:
  pip install tokenizers
  python scripts/gen-golden-ids.py Qwen/Qwen2.5-7B-Instruct \
      --out golden/qwen2.json \
      --hf-token <optional, only for gated models>

The output looks like:
  {
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "samples": [
      { "text": "Hello, world!", "ids": [9707, 11, 1879, 0] },
      ...
    ]
  }

Add new test cases to TEST_CORPUS below — keep them realistic and varied
(prose, code, multilingual, edge cases like multiple spaces, CJK, emoji).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from tokenizers import Tokenizer
except ImportError:
    sys.stderr.write(
        "error: `tokenizers` not installed. Run: pip install tokenizers\n"
    )
    sys.exit(1)

# Curated stress-test corpus. Stable across runs so the golden file is
# deterministic. Add liberally — every input we don't test is one we don't
# know is correct.
TEST_CORPUS = [
    # ASCII basics
    "Hello, world!",
    "The quick brown fox jumps over the lazy dog.",
    "1 + 1 = 2",
    "Multiple   spaces   between   words.",
    "Tabs\tand\tnewlines\nlive\nhere",
    "",                               # empty input
    " ",                              # single space
    "  leading and trailing  ",       # whitespace edges
    # Code (matters because models see lots of it)
    "def add(a, b):\n    return a + b",
    "const x = arr.map((n) => n * 2);",
    "SELECT * FROM users WHERE id = 42;",
    "import { foo } from 'bar';",
    "if __name__ == '__main__':\n    main()",
    # Punctuation density
    "!@#$%^&*()_+-=[]{}|;':\",./<>?`~",
    "...what?!?! \"He said it.\"",
    # Multilingual
    "Café résumé naïve façade",        # Latin diacritics
    "日本語のテキスト",                  # Japanese
    "한국어 텍스트",                    # Korean
    "你好,世界",                        # Chinese
    "Привет, мир",                    # Cyrillic
    "مرحبا بالعالم",                  # Arabic
    "שלום עולם",                      # Hebrew
    # Emoji + multi-byte UTF-8
    "🚀 launch",
    "🎉🎊✨ party time",
    "Family: 👨‍👩‍👧‍👦",                  # ZWJ sequence
    "Skin tones: 👋🏽 hello",
    # Realistic prompts
    "Explain the second law of thermodynamics in one sentence.",
    "Write a Python function that returns the nth Fibonacci number.",
    "Translate 'good morning' to Japanese, French, and Arabic.",
    "Summarize this article: ...",
    # Repetitions and patterns
    "AAAAAAAAAA",
    "abcabcabcabcabc",
    "the the the the the",
    # Mixed
    "Q: What's 2+2?\nA: 4 — easy! 🎯",
    "TODO(user): fix #1234 before 2026-05-06",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("hf_model", help="HuggingFace model ID, e.g. Qwen/Qwen2.5-7B-Instruct")
    ap.add_argument("--out", required=True, help="Output JSON path")
    ap.add_argument("--hf-token", default=None, help="HF token for gated models")
    args = ap.parse_args()

    if args.hf_token:
        os.environ["HF_TOKEN"] = args.hf_token

    print(f"▶ loading tokenizer for {args.hf_model}…", file=sys.stderr)
    tok = Tokenizer.from_pretrained(args.hf_model)

    samples = []
    for text in TEST_CORPUS:
        ids = tok.encode(text, add_special_tokens=False).ids
        samples.append({"text": text, "ids": ids})

    out = {
        "model": args.hf_model,
        "tokenizer_lib": "huggingface/tokenizers",
        "add_special_tokens": False,
        "samples": samples,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ wrote {len(samples)} samples to {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

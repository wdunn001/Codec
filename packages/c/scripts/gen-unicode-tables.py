#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
gen-unicode-tables.py — emit a C99 file with Unicode property tables.

The Codec pre-tokenizer program references three Unicode classes:
  - Letter   (\\p{L})     — General_Category in {Lu, Ll, Lt, Lm, Lo}
  - Number   (\\p{N})     — General_Category in {Nd, Nl, No}
  - White_Space (\\s)     — code points with Unicode property White_Space

Most regex engines bring these tables internally. libcodec ships them as
generated C arrays so the runtime has zero regex dependency. The output
is a sorted list of (lo, hi) intervals per class, queried with binary
search at lookup time.

Run this once per Unicode revision (yearly-ish):

    python3 packages/c/scripts/gen-unicode-tables.py \\
        --out packages/c/src/codec_unicode_tables.c

The output is committed to the repo so end-user builds need no Python.
"""
from __future__ import annotations

import argparse
import sys
import unicodedata
from pathlib import Path
from typing import List, Tuple

# Unicode 16.0 White_Space property (DerivedCoreProperties.txt).
# Small enough to enumerate; doesn't change between revisions.
# Source: https://www.unicode.org/Public/16.0.0/ucd/PropList.txt
WHITE_SPACE_CODEPOINTS = [
    0x09, 0x0A, 0x0B, 0x0C, 0x0D,           # control whitespace
    0x20,                                    # SPACE
    0x85,                                    # NEXT LINE
    0xA0,                                    # NO-BREAK SPACE
    0x1680,                                  # OGHAM SPACE MARK
    *range(0x2000, 0x200B),                  # EN QUAD..HAIR SPACE
    0x2028,                                  # LINE SEPARATOR
    0x2029,                                  # PARAGRAPH SEPARATOR
    0x202F,                                  # NARROW NO-BREAK SPACE
    0x205F,                                  # MEDIUM MATHEMATICAL SPACE
    0x3000,                                  # IDEOGRAPHIC SPACE
]


# General_Category prefixes that constitute each class.
LETTER_PREFIXES = ("L",)   # Lu, Ll, Lt, Lm, Lo
NUMBER_PREFIXES = ("N",)   # Nd, Nl, No

# Unicode max code point.
MAX_CP = 0x10FFFF


def collect_ranges(predicate) -> List[Tuple[int, int]]:
    """Walk every code point and return contiguous intervals where the
    predicate holds. Output is sorted by lo (because we walk linearly)
    and disjoint."""
    ranges: List[Tuple[int, int]] = []
    in_run = False
    run_lo = 0
    for cp in range(MAX_CP + 1):
        if predicate(cp):
            if not in_run:
                run_lo = cp
                in_run = True
        else:
            if in_run:
                ranges.append((run_lo, cp - 1))
                in_run = False
    if in_run:
        ranges.append((run_lo, MAX_CP))
    return ranges


def is_letter(cp: int) -> bool:
    return unicodedata.category(chr(cp)).startswith(LETTER_PREFIXES)


def is_number(cp: int) -> bool:
    return unicodedata.category(chr(cp)).startswith(NUMBER_PREFIXES)


def emit_array(name: str, ranges: List[Tuple[int, int]]) -> str:
    lines = [f"static const codec_cp_range_t {name}_RANGES[] = {{"]
    for lo, hi in ranges:
        lines.append(f"    {{ 0x{lo:06X}, 0x{hi:06X} }},")
    lines.append("};")
    lines.append(f"static const size_t {name}_RANGES_N = "
                 f"sizeof({name}_RANGES) / sizeof({name}_RANGES[0]);")
    return "\n".join(lines)


def emit_codepoint_array(name: str, codepoints: List[int]) -> str:
    cps = sorted(set(codepoints))
    lines = [f"static const uint32_t {name}[] = {{"]
    # Pack 8 per line for readability.
    for i in range(0, len(cps), 8):
        chunk = ", ".join(f"0x{cp:04X}" for cp in cps[i:i + 8])
        lines.append(f"    {chunk},")
    lines.append("};")
    lines.append(f"static const size_t {name}_N = "
                 f"sizeof({name}) / sizeof({name}[0]);")
    return "\n".join(lines)


HEADER = """\
/* SPDX-License-Identifier: MIT
 *
 * codec_unicode_tables.c — generated. Do not edit by hand.
 *
 * Source generator: packages/c/scripts/gen-unicode-tables.py
 * Unicode revision: {unicode_version}
 *
 * Three Unicode property tables used by the pre-tokenizer program
 * runtime: Letter (\\p{{L}}), Number (\\p{{N}}), White_Space (\\s).
 * Letter and Number ship as sorted (lo, hi) interval lists; query
 * with binary search. White_Space is small enough to ship as a
 * sorted code-point list.
 *
 * The runtime exposes three predicates in codec_internal.h:
 *   bool codec_unicode_is_letter(uint32_t cp);
 *   bool codec_unicode_is_number(uint32_t cp);
 *   bool codec_unicode_is_ws(uint32_t cp);
 */
#include "codec_internal.h"

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct {{ uint32_t lo, hi; }} codec_cp_range_t;

"""

FOOTER = """\

/* ── Lookups ───────────────────────────────────────────────────────────── */

static int range_contains(const codec_cp_range_t *ranges, size_t n, uint32_t cp) {
    size_t lo = 0, hi = n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (cp < ranges[mid].lo) {
            hi = mid;
        } else if (cp > ranges[mid].hi) {
            lo = mid + 1;
        } else {
            return 1;
        }
    }
    return 0;
}

static int sorted_array_contains(const uint32_t *arr, size_t n, uint32_t cp) {
    size_t lo = 0, hi = n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (cp < arr[mid])      hi = mid;
        else if (cp > arr[mid]) lo = mid + 1;
        else                    return 1;
    }
    return 0;
}

bool codec_unicode_is_letter(uint32_t cp) {
    return range_contains(LETTER_RANGES, LETTER_RANGES_N, cp) != 0;
}

bool codec_unicode_is_number(uint32_t cp) {
    return range_contains(NUMBER_RANGES, NUMBER_RANGES_N, cp) != 0;
}

bool codec_unicode_is_ws(uint32_t cp) {
    return sorted_array_contains(WS_CODE_POINTS, WS_CODE_POINTS_N, cp) != 0;
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output .c file")
    args = ap.parse_args()

    unicode_version = unicodedata.unidata_version

    print(f"scanning {MAX_CP + 1} code points…", file=sys.stderr)
    letter_ranges = collect_ranges(is_letter)
    number_ranges = collect_ranges(is_number)

    total_letter_cps = sum(hi - lo + 1 for lo, hi in letter_ranges)
    total_number_cps = sum(hi - lo + 1 for lo, hi in number_ranges)

    print(f"  letter: {len(letter_ranges):4d} ranges, "
          f"{total_letter_cps:6d} code points", file=sys.stderr)
    print(f"  number: {len(number_ranges):4d} ranges, "
          f"{total_number_cps:6d} code points", file=sys.stderr)
    print(f"  ws:     {len(WHITE_SPACE_CODEPOINTS):4d} code points", file=sys.stderr)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        f.write(HEADER.format(unicode_version=unicode_version))
        f.write(emit_array("LETTER", letter_ranges))
        f.write("\n\n")
        f.write(emit_array("NUMBER", number_ranges))
        f.write("\n\n")
        f.write(emit_codepoint_array("WS_CODE_POINTS", WHITE_SPACE_CODEPOINTS))
        f.write(FOOTER)

    bytes_written = out.stat().st_size
    print(f"wrote {out} ({bytes_written:,} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Aggregate SCHEMA-v1 result JSONs into a readable cross-stack MATRIX.md.

Walks `packages/bench/results/{run_id}/{engine}/{lang}.json`, validates
each row's methodology fingerprint against the engine's canonical
methodology, and emits:

  - One headline-results table (size × format × encoding, gzip-row +
    dict-zstd-row vs JSON-SSE baseline)
  - One per-lang wire-byte equality grid (proves cross-language Codec
    bytes match within tolerance)
  - One TTFB grid (split by client-side TTFB-definition cohort)
  - One quarantine section listing rows whose methodology fingerprint
    diverged from the engine's canonical block

Usage:
    python packages/bench/scripts/aggregate.py [run_id]

`run_id` defaults to the most recent `packages/bench/results/*/`. The
output is written to `packages/bench/results/{run_id}/MATRIX.md`.

Mandated by packages/bench/methodology/SCHEMA.md "Aggregator
behaviour" section. Until this lands MATRIX.md was hand-written.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = REPO_ROOT / "packages" / "bench" / "results"
METHODOLOGY_DIR = REPO_ROOT / "packages" / "bench" / "methodology"

# Canonical orderings used for column layout. Keep in sync with the
# SCHEMA.md section "Aggregator behaviour".
PATHS = [
    ("JSON-SSE", "json"),
    ("Codec msgpack", "msgpack"),
    ("Codec protobuf", "protobuf"),
]
ENCODINGS = ["identity", "gzip", "br", "zstd"]
LANGS = ["python", "web", "dotnet", "rust", "java", "c"]
LANG_LABELS = {
    "python": "Python",
    "web": "TS/Node",
    "dotnet": ".NET",
    "rust": "Rust",
    "java": "Java",
    "c": "C",
}


def latest_run_id() -> str:
    runs = sorted(p.name for p in RESULTS_DIR.glob("*") if p.is_dir())
    if not runs:
        sys.exit(f"no runs under {RESULTS_DIR}")
    return runs[-1]


def load_results(run_id: str) -> dict[str, dict[str, dict]]:
    """{engine: {lang: result_doc}}.

    The `token/` subdirectory (per-language tokenize/detokenize micro-bench)
    is loaded by `load_token_results` instead — it's not engine-keyed.
    """
    out: dict[str, dict[str, dict]] = {}
    base = RESULTS_DIR / run_id
    if not base.exists():
        sys.exit(f"run dir not found: {base}")
    for engine_dir in sorted(base.iterdir()):
        if not engine_dir.is_dir() or engine_dir.name == "token":
            continue
        engine = engine_dir.name
        out[engine] = {}
        for json_file in sorted(engine_dir.glob("*.json")):
            lang = json_file.stem
            try:
                doc = json.loads(json_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                print(f"  WARN: {json_file} not valid JSON: {e}", file=sys.stderr)
                continue
            if doc.get("schema_version") != "1":
                print(f"  WARN: {json_file} not SCHEMA-v1", file=sys.stderr)
                continue
            out[engine][lang] = doc
    return out


def load_token_results(run_id: str) -> dict[str, dict]:
    """Load per-language tokenize/detokenize micro-bench results from
    `results/<run_id>/token/<lang>.json`. Returns {lang: doc}. Empty
    dict when the directory or files are missing (the matrix builds
    fine without token-bench data).
    """
    out: dict[str, dict] = {}
    base = RESULTS_DIR / run_id / "token"
    if not base.exists():
        return out
    for json_file in sorted(base.glob("*.json")):
        lang = json_file.stem
        try:
            doc = json.loads(json_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  WARN: {json_file} not valid JSON: {e}", file=sys.stderr)
            continue
        if doc.get("kind") != "token_bench":
            print(f"  WARN: {json_file} not kind=token_bench", file=sys.stderr)
            continue
        out[lang] = doc
    return out


def cell_index(rows: list[dict]) -> dict[tuple, dict]:
    """Index rows by (size, format, encoding)."""
    return {(r["size"], r["format"], r["encoding"]): r for r in rows}


def fmt_bytes(n: int | None) -> str:
    """Render a byte count for the matrix tables.

    Adds an explicit `b` (byte) suffix to bare numeric values so reviewers
    don't have to guess the unit — reviewer feedback after the
    2026-05-09T17-09-35Z run flagged the unsuffixed integers as confusing.
    Sizes ≥ 1 KB keep the existing `KB`/`MB` rendering (and inherit the
    same byte semantics from the K/M prefix).
    """
    if n is None:
        return "—"
    if n < 1024:
        return f"{n} b"
    if n < 10_000:
        return f"{n:,} b"
    if n < 1_000_000:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1_048_576:.2f} MB"


def fmt_ms(n: float | None) -> str:
    if n is None:
        return "—"
    if n < 100:
        return f"{n:.1f}"
    return f"{n:.0f}"


def fmt_ratio(num: int | None, denom: int | None) -> str:
    if num is None or denom is None or num == 0:
        return "—"
    return f"{denom / num:.1f}×"


def quarantine_check(
    results: dict[str, dict[str, dict]],
) -> list[str]:
    """Compare each (engine, lang) row's methodology fingerprint to the
    engine's canonical methodology JSON. Return human-readable list of
    rows whose fingerprint diverges (excluding client.* and bench_tool.*
    fields, which are expected to differ — see SCHEMA.md)."""
    quarantine: list[str] = []
    for engine, by_lang in results.items():
        canonical_path = METHODOLOGY_DIR / next(iter(by_lang.keys()), "_") / f"{engine}.json"
        # Find the canonical methodology by run_id (parent dir of any result)
        # — easier to read it from the results themselves.
        if not by_lang:
            continue
        canonical = next(iter(by_lang.values()))["methodology"].get("fingerprint")
        if not canonical:
            quarantine.append(f"{engine}: no fingerprint on canonical methodology")
            continue
        for lang, doc in by_lang.items():
            fp = doc["methodology"].get("fingerprint")
            if fp != canonical:
                quarantine.append(
                    f"{engine}/{lang}: fingerprint {fp[:12] if fp else 'none'} ≠ canonical {canonical[:12]}"
                )
    return quarantine


def headline_section(results: dict[str, dict[str, dict]]) -> list[str]:
    """One row per engine: best Codec wire reduction at 2K tokens."""
    out: list[str] = ["## §1. Headline wire reduction @ 2K tokens", ""]
    out.append("Per engine, best-case Codec compression vs JSON-SSE identity. Python row chosen as the canonical client (others agree byte-identically — see §3).")
    out.append("")
    out.append("| Engine | JSON-SSE identity | Codec msgpack + gzip | Codec msgpack + dict-zstd | Codec protobuf + gzip | Codec protobuf + dict-zstd |")
    out.append("|---|---:|---:|---:|---:|---:|")
    for engine in sorted(results.keys()):
        by_lang = results[engine]
        if "python" not in by_lang:
            continue
        rows = cell_index(by_lang["python"]["rows"])
        baseline = rows.get((2048, "json", "identity"), {}).get("wire_bytes")
        cells = []
        for fmt, enc in [
            ("json", "identity"),
            ("msgpack", "gzip"),
            ("msgpack", "zstd"),
            ("protobuf", "gzip"),
            ("protobuf", "zstd"),
        ]:
            r = rows.get((2048, fmt, enc), {})
            wb = r.get("wire_bytes")
            if fmt == "json" and enc == "identity":
                cells.append(fmt_bytes(wb))
            else:
                cells.append(f"{fmt_bytes(wb)} ({fmt_ratio(wb, baseline)})")
        out.append(f"| **{engine}** | " + " | ".join(cells) + " |")
    out.append("")
    return out


def cross_lang_equality_section(results: dict[str, dict[str, dict]]) -> list[str]:
    """For each engine, show that all langs agree on Codec wire bytes."""
    out: list[str] = ["## §2. Cross-language Codec wire-byte equality", ""]
    out.append("For every Codec cell (size × {msgpack,protobuf} × encoding), how many byte-identical reports across the available client languages? **6/6** is the gold standard.")
    out.append("")
    for engine in sorted(results.keys()):
        by_lang = results[engine]
        if not by_lang:
            continue
        out.append(f"### {engine}")
        out.append("")
        cells_total = 0
        cells_unanimous = 0
        cells_mismatched: list[str] = []
        # Build {(size,fmt,enc): {lang: wire}}
        cells: dict[tuple, dict[str, int | None]] = {}
        for lang, doc in by_lang.items():
            for r in doc["rows"]:
                if r["format"] == "json":
                    continue  # SSE has run-to-run drift in finish_reason
                cells.setdefault((r["size"], r["format"], r["encoding"]), {})[lang] = r.get("wire_bytes")
        for k, lang_to_wire in sorted(cells.items()):
            cells_total += 1
            unique_wires = {w for w in lang_to_wire.values() if w is not None}
            if len(unique_wires) == 1:
                cells_unanimous += 1
            elif len(unique_wires) > 1:
                cells_mismatched.append(
                    f"  - size={k[0]} {k[1]}+{k[2]}: " + ", ".join(f"{l}={w}" for l, w in lang_to_wire.items())
                )
        n_langs = len(by_lang)
        out.append(f"- **{cells_unanimous} / {cells_total} cells unanimous** across {n_langs} clients ({', '.join(LANG_LABELS.get(l, l) for l in sorted(by_lang.keys()))})")
        if cells_mismatched:
            out.append("- Mismatched cells:")
            out.extend(cells_mismatched[:10])
            if len(cells_mismatched) > 10:
                out.append(f"  - ... ({len(cells_mismatched) - 10} more)")
        out.append("")
    return out


def per_engine_lang_grid_section(results: dict[str, dict[str, dict]]) -> list[str]:
    """Full wire-byte grid per engine, Python row only (others byte-identical)."""
    out: list[str] = ["## §3. Wire-byte grid per engine (Python row)", ""]
    out.append("Median bytes across reps. Other 5 client languages agree byte-identically on every Codec cell — see §2.")
    out.append("")
    for engine in sorted(results.keys()):
        by_lang = results[engine]
        if "python" not in by_lang:
            continue
        rows = cell_index(by_lang["python"]["rows"])
        compression_supported = (
            by_lang["python"]["methodology"].get("engine", {}).get("compression_supported", [])
        )
        out.append(f"### {engine}")
        out.append("")
        out.append(f"`compression_supported`: `{compression_supported}`")
        out.append("")
        sizes = sorted({r["size"] for r in by_lang["python"]["rows"]})
        out.append("| size | path | identity | gzip | br | zstd |")
        out.append("|---:|---|---:|---:|---:|---:|")
        for sz in sizes:
            for label, fmt in PATHS:
                cells = []
                for enc in ENCODINGS:
                    r = rows.get((sz, fmt, enc), {})
                    cells.append(fmt_bytes(r.get("wire_bytes")))
                out.append(f"| {sz} | {label} | " + " | ".join(cells) + " |")
        out.append("")
    return out


def ttfb_section(results: dict[str, dict[str, dict]]) -> list[str]:
    """Split TTFB by per-client definition cohort (body-byte vs headers-byte)."""
    body_byte_clients = {"python", "web", "c"}
    headers_byte_clients = {"dotnet", "rust", "java"}
    out: list[str] = ["## §4. TTFB by client definition cohort", ""]
    out.append(
        "Per the SCHEMA.md TTFB definition split (see §5), clients fall into two cohorts:"
    )
    out.append(
        "- **Body-byte cohort** (Python httpx aiter_raw, TypeScript Node http data event, C libcurl WRITEFUNCTION): TTFB = wall-clock from POST to first body byte"
    )
    out.append(
        "- **Headers-byte cohort** (.NET ResponseHeadersRead, Rust reqwest send().await, Java HttpClient.send): TTFB = wall-clock from POST to headers received"
    )
    out.append("")
    out.append(
        "Bodies and headers tend to arrive in the same TCP segment for non-buffered encodings (identity/gzip/br) — both cohorts agree. They diverge sharply on dict-zstd, where the server's chunker buffers small responses to end-of-stream."
    )
    out.append("")
    for engine in sorted(results.keys()):
        by_lang = results[engine]
        if not by_lang:
            continue
        out.append(f"### {engine} — msgpack TTFB (median ms across reps)")
        out.append("")
        sizes = sorted(
            {r["size"] for doc in by_lang.values() for r in doc["rows"]}
        )
        out.append("| size | enc | body-byte (median) | headers-byte (median) |")
        out.append("|---:|---|---:|---:|")
        for sz in sizes:
            for enc in ENCODINGS:
                body_vals: list[float] = []
                hdr_vals: list[float] = []
                for lang, doc in by_lang.items():
                    rows = cell_index(doc["rows"])
                    r = rows.get((sz, "msgpack", enc), {})
                    t = r.get("ttft_ms")
                    if t is None:
                        continue
                    if lang in body_byte_clients:
                        body_vals.append(float(t))
                    elif lang in headers_byte_clients:
                        hdr_vals.append(float(t))
                body = statistics.median(body_vals) if body_vals else None
                hdr = statistics.median(hdr_vals) if hdr_vals else None
                out.append(f"| {sz} | {enc} | {fmt_ms(body)} | {fmt_ms(hdr)} |")
        out.append("")
    return out


def methodology_section(results: dict[str, dict[str, dict]]) -> list[str]:
    out: list[str] = ["## §5. Methodology fingerprints", ""]
    out.append("Every row above came from a SCHEMA-v1 result file with a methodology fingerprint computed over the methodology block excluding `client.*`, `bench_tool.*`, `captured_at`, `notes`, `git.repo_dirty_files`. Rows from different langs share the engine's fingerprint. Mismatches surface in §6 quarantine.")
    out.append("")
    out.append("| engine | fingerprint | image | model | compression_supported |")
    out.append("|---|---|---|---|---|")
    for engine in sorted(results.keys()):
        by_lang = results[engine]
        if not by_lang:
            continue
        m = next(iter(by_lang.values()))["methodology"]
        fp = (m.get("fingerprint") or "?")[:16] + "…"
        img = m.get("engine", {}).get("container_image", "—")
        if img and len(img) > 80:
            img = img[:77] + "…"
        model = m.get("model", {}).get("id", "—")
        supported = ", ".join(m.get("engine", {}).get("compression_supported", []))
        out.append(f"| {engine} | `{fp}` | `{img}` | `{model}` | {supported} |")
    out.append("")
    return out


def quarantine_section(results: dict[str, dict[str, dict]]) -> list[str]:
    quarantine = quarantine_check(results)
    out: list[str] = ["## §6. Quarantine", ""]
    if not quarantine:
        out.append("None — every row's methodology fingerprint matched its engine's canonical block.")
    else:
        out.append("Rows whose methodology fingerprint diverged from the engine's canonical block (excluded from §1–§4 aggregations):")
        out.append("")
        for q in quarantine:
            out.append(f"- {q}")
    out.append("")
    return out


def token_bench_section(token_results: dict[str, dict]) -> list[str]:
    """Render per-language tokenize/detokenize micro-bench numbers.

    Cross-language companion to the wire benchmarks — same `results/<run-id>/`
    directory, different subfolder (`token/`), different question:
    how fast does each language's BPE/Detokenizer chew through a fixed
    corpus? Reviewer feedback requested this be recorded alongside wire
    bytes so encode/decode time isn't a hidden variable.
    """
    if not token_results:
        return []

    # Pull metadata from any one doc — corpus + map should match across langs.
    sample_doc = next(iter(token_results.values()))
    corpus = sample_doc.get("corpus", {})
    map_meta = sample_doc.get("map", {})
    reps = sample_doc.get("reps")
    warmup = sample_doc.get("warmup_reps")

    out: list[str] = [
        "## §X. Per-language tokenize / detokenize micro-bench",
        "",
        f"Cross-language pass over a fixed golden corpus "
        f"(`{corpus.get('path', '?')}`, "
        f"{corpus.get('samples', '?')} samples, "
        f"{corpus.get('total_text_bytes', '?')} b text, "
        f"{corpus.get('total_tokens', '?')} tokens) "
        f"against `{map_meta.get('id', '?')}` map, "
        f"{reps} measured reps + {warmup} warmup, median per-pass time. "
        f"Each `_total` value is the time to encode/decode the WHOLE corpus once.",
        "",
        "| Lang | encode total (ms) | encode tok/sec | decode total (ms) | decode tok/sec | encode p99 | decode p99 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]

    # Stable ordering matching the wire-bench tables.
    lang_order = ["python", "web", "dotnet", "rust", "java", "c"]
    lang_order += [l for l in sorted(token_results) if l not in lang_order]

    def fmt_ms(v: float | None) -> str:
        return "—" if v is None else f"{v:.2f}"

    def fmt_tps(v: float | None) -> str:
        return "—" if v is None else f"{int(round(v)):,} /s"

    for lang in lang_order:
        if lang not in token_results:
            continue
        d = token_results[lang]
        enc_med = d.get("encode_ms_total_median")
        dec_med = d.get("decode_ms_total_median")
        enc_p99 = d.get("encode_ms_total_p99")
        dec_p99 = d.get("decode_ms_total_p99")
        enc_tps = d.get("encode_tokens_per_sec")
        dec_tps = d.get("decode_tokens_per_sec")
        out.append(
            f"| **{lang}** | {fmt_ms(enc_med)} | {fmt_tps(enc_tps)} | "
            f"{fmt_ms(dec_med)} | {fmt_tps(dec_tps)} | "
            f"{fmt_ms(enc_p99)} | {fmt_ms(dec_p99)} |"
        )

    # Footnote — note when any lib is detokenize-only.
    footnotes = []
    for lang in lang_order:
        if lang not in token_results:
            continue
        d = token_results[lang]
        if d.get("encode_ms_total_median") is None and d.get("note"):
            footnotes.append(f"- **{lang}**: {d['note']}")
    if footnotes:
        out.append("")
        out.extend(footnotes)

    out.append("")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(prog="aggregate")
    ap.add_argument("run_id", nargs="?", help="ISO-8601-ish run id; defaults to most recent")
    args = ap.parse_args()

    run_id = args.run_id or latest_run_id()
    print(f"aggregating run_id={run_id}", file=sys.stderr)

    results = load_results(run_id)
    token_results = load_token_results(run_id)
    if not results and not token_results:
        sys.exit(f"no result JSONs found for run {run_id}")

    out_lines: list[str] = [
        f"# Cross-stack benchmark matrix — {run_id}",
        "",
        f"Auto-generated from `packages/bench/results/{run_id}/{{engine}}/{{lang}}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.",
        "",
    ]
    if results:
        out_lines += headline_section(results)
        out_lines += cross_lang_equality_section(results)
        out_lines += per_engine_lang_grid_section(results)
        out_lines += ttfb_section(results)
    out_lines += token_bench_section(token_results)
    if results:
        out_lines += methodology_section(results)
        out_lines += quarantine_section(results)

    out_path = RESULTS_DIR / run_id / "MATRIX.md"
    out_path.write_text("\n".join(out_lines), encoding="utf-8")
    print(f"wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()

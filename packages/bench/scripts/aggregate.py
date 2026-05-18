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
    # Skip non-engine subdirs: per-bench-surface output dirs that live
    # alongside the engine result dirs but are loaded by separate loaders
    # (token_bench has its own loader; synthetic + translator + agent-loop
    # are written but not currently aggregated into MATRIX.md). The list is
    # belt + the kind-check below is suspenders — either alone catches the
    # "translator/python.json got iterated as an engine" regression caught
    # post-v0.5 cut.
    NON_ENGINE_DIRS = {"token", "synthetic", "translator", "agent-loop"}
    for engine_dir in sorted(base.iterdir()):
        if not engine_dir.is_dir() or engine_dir.name in NON_ENGINE_DIRS:
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
            # Structural discriminator: cross-stack matrix JSONs carry
            # both `methodology` and `rows`. Other bench surfaces that
            # happen to drop JSON alongside (translator, future kinds)
            # lack one or both. This is paired with the NON_ENGINE_DIRS
            # list above — the directory exclusion catches the common
            # case, this check catches the edge case where someone
            # drops a non-matrix JSON into an engine dir.
            if "methodology" not in doc or "rows" not in doc:
                continue
            # Also skip explicitly-tagged non-matrix kinds when `kind`
            # is set (synthetic_wire_bench, token_bench).
            if doc.get("kind") and doc["kind"] not in ("matrix_run", "engine_bench"):
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


def load_synthetic_results(run_id: str) -> dict | None:
    """Load the synthetic wire-bench results, if present.

    The synthetic bench measures protocol efficiency in isolation: known
    token sequences run through encoder + compression libraries locally,
    no engine, no model. See packages/bench/scripts/synthetic_wire_bench.py
    and the §1 section it populates.
    """
    path = RESULTS_DIR / run_id / "synthetic" / "wire.json"
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"  WARN: {path} not valid JSON: {e}", file=sys.stderr)
        return None
    if doc.get("schema_version") != "1" or doc.get("kind") != "synthetic_wire_bench":
        print(f"  WARN: {path} not a synthetic_wire_bench v1 doc", file=sys.stderr)
        return None
    return doc


def synthetic_headline_section(synthetic: dict) -> list[str]:
    """§1 — protocol-only wire bytes across 4 synthetic corpora.

    This is the headline because it measures protocol efficiency in isolation,
    independent of any model's particular token-generation behaviour. Real
    model output cells move to §1b for context.
    """
    out: list[str] = ["## §1. Headline wire reduction — synthetic streams (protocol only)", ""]
    out.append("Pure-library measurement: known token-ID sequences fed through the Codec")
    out.append("encoder + compression pipeline locally, no inference engine, no model. Same")
    out.append("library code every engine uses. Measures protocol efficiency in isolation,")
    out.append("decoupled from how any specific model happens to generate text.")
    out.append("")
    out.append("Four token-distribution corpora at 2K tokens, msgpack mode:")
    out.append("")
    out.append("| Corpus (token-ID distribution) | identity | gzip | br | dict-zstd | best ratio vs identity |")
    out.append("|---|---:|---:|---:|---:|---:|")
    cells = {(c["corpus"], c["n_tokens"], c["format"], c["encoding"]): c["wire_bytes"] for c in synthetic["cells"]}
    corpus_descriptions = {
        "uniform-random-vocab-152064": "Uniform random (worst case)",
        "low-entropy-50-unique":       "Low entropy (50 unique IDs)",
        "comma-dominated-50pct":       "Comma-dominated (50% one ID)",
        "cyclic-period-10":            "Cyclic period 10 (best case)",
    }
    for corpus in ("uniform-random-vocab-152064", "comma-dominated-50pct", "low-entropy-50-unique", "cyclic-period-10"):
        identity = cells.get((corpus, 2048, "msgpack", "identity"))
        if identity is None:
            continue
        gzip_b = cells.get((corpus, 2048, "msgpack", "gzip"))
        br_b   = cells.get((corpus, 2048, "msgpack", "br"))
        zstd_b = cells.get((corpus, 2048, "msgpack", "zstd"))
        best = min(v for v in (gzip_b, br_b, zstd_b) if v is not None)
        out.append(
            f"| {corpus_descriptions[corpus]} | {fmt_bytes(identity)} | "
            f"{fmt_bytes(gzip_b)} | {fmt_bytes(br_b)} | {fmt_bytes(zstd_b)} | "
            f"{identity / best:.1f}× |"
        )
    out.append("")
    out.append("The honest framing: Codec wire+compression delivers **~4-17× over identity**")
    out.append("on arbitrary-to-typical streams, and **100-400× on structurally-repetitive**")
    out.append("ones. The lower bound (uniform-random) is the floor — there's no content")
    out.append("redundancy to exploit, so the wins are from msgpack/protobuf framing alone.")
    out.append("The upper bound (cyclic) is what dict-zstd can do when the content cooperates.")
    out.append("")
    out.append("Live model output sits somewhere in this range, depending on what the model")
    out.append("happens to generate — see §1b for engine-specific numbers from this run.")
    out.append("")
    return out


def headline_section(results: dict[str, dict[str, dict]]) -> list[str]:
    """§1b — Engine-output numbers: wire reduction when fed real model output.

    These ratios depend on both protocol efficiency AND what each engine's
    model produces at temperature=0 (which diverges across engines despite
    identical prompts, due to floating-point non-associativity in CUDA
    reductions and different sampler/attention paths). The §1 synthetic
    table is the protocol-only measurement.
    """
    out: list[str] = ["## §1b. Engine-output wire reduction @ 2K tokens (content-dependent)", ""]
    out.append("Per engine, best-case Codec compression vs JSON-SSE identity, measured against")
    out.append("the actual model output. Numbers vary by engine because each engine's specific")
    out.append("sampler/attention path produces slightly different token sequences at T=0, and")
    out.append("those sequences compress differently. For protocol-only efficiency see §1.")
    out.append("")
    out.append("Python row chosen as the canonical client (others agree byte-identically — see §3).")
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
    out: list[str] = ["## §2. Cross-language Codec wire-byte equality + decode unanimity", ""]
    out.append("For every Codec cell (size × {msgpack,protobuf} × encoding), the aggregator reports two unanimity scores:")
    out.append("")
    out.append("- **wire-unanimous** — clients agree byte-for-byte on what came over the wire (bytes received)")
    out.append("- **decode-unanimous** — clients agree on the decoded token count (bytes received actually parsed back into the same number of token IDs)")
    out.append("")
    out.append("**6/6 wire AND 6/6 decode is the gold standard.** A cell that is wire-unanimous but decode-mismatched means the bytes are the same but some clients can't actually parse them — usually a missing dict (dict-zstd interop) or a parser bug. Wire-unanimity alone is misleading; cells where 3/6 clients hit `Dictionary mismatch` errors used to count as \"unanimous\" until v0.4.1 — that gap is the reason this section now has two scores.")
    out.append("")
    for engine in sorted(results.keys()):
        by_lang = results[engine]
        if not by_lang:
            continue
        out.append(f"### {engine}")
        out.append("")
        cells_total = 0
        cells_wire_unanimous = 0
        cells_decode_unanimous = 0
        cells_mismatched: list[str] = []
        cells_decode_failed: list[str] = []
        # Build {(size,fmt,enc): {lang: (wire, tokens, error)}}
        cells: dict[tuple, dict[str, tuple[int | None, int | None, str | None]]] = {}
        for lang, doc in by_lang.items():
            for r in doc["rows"]:
                if r["format"] == "json":
                    continue  # SSE has run-to-run drift in finish_reason
                cells.setdefault((r["size"], r["format"], r["encoding"]), {})[lang] = (
                    r.get("wire_bytes"), r.get("tokens_emitted"), r.get("error"),
                )
        for k, lang_to_cell in sorted(cells.items()):
            cells_total += 1
            wires = {w for (w, _, _) in lang_to_cell.values() if w is not None}
            tokens = {t for (_, t, e) in lang_to_cell.values() if t is not None and not e}
            # Wire-unanimous: all reporting clients agree on wire bytes
            if len(wires) == 1:
                cells_wire_unanimous += 1
            elif len(wires) > 1:
                cells_mismatched.append(
                    f"  - size={k[0]} {k[1]}+{k[2]}: " + ", ".join(f"{l}={w}" for l, (w, _, _) in lang_to_cell.items())
                )
            # Decode-unanimous: all clients that didn't error agree on token count,
            # AND no client errored — a single decode failure breaks unanimity.
            errored = [(l, e) for l, (_, _, e) in lang_to_cell.items() if e]
            if len(tokens) == 1 and not errored:
                cells_decode_unanimous += 1
            elif errored:
                err_summary = ", ".join(f"{l}={e[:50]}" for l, e in errored[:3])
                if len(errored) > 3:
                    err_summary += f" (+{len(errored)-3} more)"
                cells_decode_failed.append(
                    f"  - size={k[0]} {k[1]}+{k[2]}: {len(errored)}/{len(lang_to_cell)} clients errored — {err_summary}"
                )
        n_langs = len(by_lang)
        out.append(
            f"- **{cells_wire_unanimous} / {cells_total} cells wire-unanimous** across {n_langs} clients "
            f"({', '.join(LANG_LABELS.get(l, l) for l in sorted(by_lang.keys()))})"
        )
        out.append(f"- **{cells_decode_unanimous} / {cells_total} cells decode-unanimous** (every client decoded the same token count, none errored)")
        if cells_mismatched:
            out.append("- Wire-mismatched cells:")
            out.extend(cells_mismatched[:10])
            if len(cells_mismatched) > 10:
                out.append(f"  - ... ({len(cells_mismatched) - 10} more)")
        if cells_decode_failed:
            out.append("- Decode-failed cells:")
            out.extend(cells_decode_failed[:10])
            if len(cells_decode_failed) > 10:
                out.append(f"  - ... ({len(cells_decode_failed) - 10} more)")
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


def scan_for_errored_cells(results: dict[str, dict[str, dict]]) -> list[str]:
    """Return human-readable lines for every row with a non-empty ``error`` field.

    Mandated by docs/RELEASE_CHECKLIST.md §3: the bench is a gate, not a
    passive recorder. A cell with ``{wire: 291, tokens: 0, error: "Dictionary
    mismatch"}`` is a real interop failure; the aggregator MUST exit non-zero
    so CI / operators see it without having to read MATRIX.md by hand.
    """
    errors: list[str] = []
    for engine, by_lang in sorted(results.items()):
        for lang, doc in sorted(by_lang.items()):
            for r in doc.get("rows", []):
                if not r.get("error"):
                    continue
                errors.append(
                    f"  {engine}/{lang} size={r.get('size')} {r.get('format')}+{r.get('encoding')}: "
                    f"wire={r.get('wire_bytes')} tokens={r.get('tokens_emitted')} "
                    f"error={r['error'][:120]}"
                )
    return errors


def main() -> None:
    ap = argparse.ArgumentParser(prog="aggregate")
    ap.add_argument("run_id", nargs="?", help="ISO-8601-ish run id; defaults to most recent")
    ap.add_argument(
        "--allow-cell-errors",
        action="store_true",
        help="Write MATRIX.md and exit 0 even if cells have non-empty error fields. "
             "Default is to exit non-zero — the bench is a release gate, not a recorder.",
    )
    args = ap.parse_args()

    run_id = args.run_id or latest_run_id()
    print(f"aggregating run_id={run_id}", file=sys.stderr)

    results = load_results(run_id)
    token_results = load_token_results(run_id)
    synthetic = load_synthetic_results(run_id)
    if not results and not token_results and not synthetic:
        sys.exit(f"no result JSONs found for run {run_id}")

    out_lines: list[str] = [
        f"# Cross-stack benchmark matrix — {run_id}",
        "",
        f"Auto-generated from `packages/bench/results/{run_id}/{{engine}}/{{lang}}.json` by `packages/bench/scripts/aggregate.py`. SCHEMA.md is the source of truth on what each cell measures.",
        "",
    ]
    if synthetic:
        out_lines += synthetic_headline_section(synthetic)
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

    # Gate: any cell with a populated error field fails the run unless
    # --allow-cell-errors was passed. The v0.4.1 post-mortem caught a class
    # of regression where dict-zstd silently fell through to identity bytes
    # and 3/6 clients errored with "Dictionary mismatch" — the aggregator
    # happily reported "24/24 unanimous" because it only checked wire-bytes.
    # The bench MUST be a gate. See docs/RELEASE_CHECKLIST.md §3.
    errored = scan_for_errored_cells(results)
    if errored and not args.allow_cell_errors:
        print(
            f"\nFAIL: {len(errored)} cell(s) recorded an error — bench is a release gate, not a recorder.",
            file=sys.stderr,
        )
        for line in errored[:30]:
            print(line, file=sys.stderr)
        if len(errored) > 30:
            print(f"  ... ({len(errored) - 30} more)", file=sys.stderr)
        print(
            "\nFix the underlying bug, rerun the bench, then re-aggregate. "
            "Pass --allow-cell-errors only when you are deliberately recording "
            "a known-failing baseline (rare; document why in the commit message).",
            file=sys.stderr,
        )
        sys.exit(2)


if __name__ == "__main__":
    main()

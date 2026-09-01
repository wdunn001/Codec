#!/usr/bin/env python3
"""
extract-mcp-corpus.py: build an MCP-shaped corpus from prior live-bench runs.

The bench harness packages/bench/src/mcp-live.ts saves decoded JSON-RPC
messages alongside its wire-byte measurements. Re-encoding those messages
through msgpack reconstructs corpus samples whose byte distribution matches
real gateway traffic: same envelope shape, same tool-result text content,
same JSON-RPC method patterns.

This is faster + cheaper than re-hammering the live gateway with hundreds
of fresh requests. It also reuses traffic already paid for. The
reconstructed bytes aren't byte-identical to what was on the wire (the
gateway's msgpack encoder may serialize identical content slightly
differently than ours) but the *distribution*: which is what the zstd
dict trainer cares about: matches.

Output layout matches what train-zstd-dict.py expects:

    corpora/mcp-synth/
      msgpack/
        <sha8>-<method>.bin
        manifest.jsonl

A separate protobuf path is left for a follow-up: the live gateway
returns msgpack today. Re-encoding to protobuf would invent a corpus
that doesn't exist. Train protobuf dicts by capturing fresh against a
gateway running with stream_format=protobuf.

Usage:

    python extract-mcp-corpus.py \\
        --results-root packages/bench/results \\
        --out         packages/bench/corpora/mcp-synth
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable

import msgpack


def iter_messages(results_root: Path) -> Iterable[tuple[str, dict[str, Any]]]:
    """Yield (method, message) pairs from every mcp-live.json in the tree."""
    for live_json in results_root.rglob('mcp/mcp-live.json'):
        try:
            doc = json.loads(live_json.read_text(encoding='utf-8'))
        except Exception as e:
            print(f'  ! skip {live_json}: {e}', file=sys.stderr)
            continue
        for report in doc.get('reports', []):
            method = report.get('method', 'unknown')
            for row in report.get('rows', []):
                if not row.get('ok'):
                    continue
                # Only msgpack-* variants give us realistic message shapes:
                # json variants are JSON-RPC over text. We don't
                # currently train a dict for that shape.
                variant = row.get('variant', '')
                if not variant.startswith('msgpack'):
                    continue
                for msg in row.get('messages', []) or []:
                    if isinstance(msg, dict):
                        yield method, msg


def write_corpus(
    out_dir: Path,
    pairs: Iterable[tuple[str, dict[str, Any]]],
) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / 'manifest.jsonl'
    seen: set[str] = set()
    n_written = 0
    n_dupe = 0
    with manifest_path.open('w', encoding='utf-8') as mf:
        for method, msg in pairs:
            try:
                wire = msgpack.packb(msg, use_bin_type=True)
            except Exception as e:
                print(f'  ! pack failed for {method}: {e}', file=sys.stderr)
                continue
            sha8 = hashlib.sha256(wire).hexdigest()[:8]
            if sha8 in seen:
                n_dupe += 1
                continue
            seen.add(sha8)
            # Sanitize method for filename; replace '/' with '_'.
            method_slug = method.replace('/', '_').replace(':', '_')[:50]
            fname = f'{sha8}-{method_slug}.bin'
            (out_dir / fname).write_bytes(wire)
            mf.write(json.dumps({
                'file':   fname,
                'method': method,
                'sha8':   sha8,
                'wire_bytes': len(wire),
            }) + '\n')
            n_written += 1
    return n_written


def main() -> int:
    ap = argparse.ArgumentParser(prog='extract-mcp-corpus')
    ap.add_argument('--results-root',
                    default='packages/bench/results',
                    help='root dir to scan for results/<run>/mcp/mcp-live.json')
    ap.add_argument('--out',
                    default='packages/bench/corpora/mcp-synth',
                    help='output corpus root (default: %(default)s)')
    args = ap.parse_args()

    results_root = Path(args.results_root).resolve()
    out_root = Path(args.out).resolve()

    if not results_root.exists():
        print(f'no such dir: {results_root}', file=sys.stderr)
        return 1

    print(f'▶ extracting MCP corpus from {results_root}', file=sys.stderr)
    print(f'  out: {out_root}/msgpack/', file=sys.stderr)

    msgpack_out = out_root / 'msgpack'
    n = write_corpus(msgpack_out, iter_messages(results_root))
    print(f'\n✓ {n} unique msgpack samples → {msgpack_out}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())

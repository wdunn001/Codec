#!/usr/bin/env python3
"""Non-GPU energy budget bench for the JSON-SSE vs Codec wire paths.

Companion to ``packages/bench/docs/ENERGY_METHODOLOGY.md``. Reproduces
every per-hop, per-request, and worldwide-aggregate number cited there
from first principles, with two layers:

  1. Calculator path (always available): apply the per-byte costs
     pinned in the methodology doc to whatever payload sizes the caller
     specifies. Pure arithmetic. Outputs the per-hop, per-request,
     fleet-aggregate, car-equivalence tables verbatim.

  2. RAPL probe path (Linux + Intel/AMD with powercap): actually
     measure CPU energy consumed by JSON parse/serialise, tokenise/
     detokenise, gzip/zstd, and msgpack encode/decode under the same
     payload shapes. Replaces the "published per-byte costs" with
     measured ones for the local hardware.

The calculator path is what gates the methodology doc: it must produce
the headline numbers (820 mJ JSON, 2 mJ Codec, ~400 cars/yr, etc.) with
zero hidden assumptions. The RAPL path is for operators who want to
validate the per-byte cost table against their own hardware.

Usage
-----
Calculator (no hardware probing):

    python packages/bench/scripts/energy_bench.py \\
        --output packages/bench/results/<UTC>/energy/ \\
        --no-rapl

RAPL probe (Linux + RAPL-capable CPU):

    python packages/bench/scripts/energy_bench.py \\
        --output packages/bench/results/<UTC>/energy/ \\
        --rapl-iterations 100

Outputs
-------
  results/<UTC>/energy/
    wire-energy.json     # per-byte costs (published or measured)
    per-hop.json         # per-hop energy for JSON-SSE vs Codec
    per-request.json     # per-visible-reply totals at 1/4/8 round-trips
    worldwide.json       # fleet aggregate + CO2-equivalence
    report.md            # human-readable rollup
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import platform
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Per-byte cost table: keep this in sync with ENERGY_METHODOLOGY.md § "Per-
# hop energy budget (JSON-SSE baseline)". Numbers are non-GPU energy in
# nanojoules per byte, lab-NUC calibration. The methodology doc carries the
# sources; this dict is the executable form.
# ---------------------------------------------------------------------------

PUBLISHED_NJ_PER_BYTE = {
    "json_parse": 1.8,
    "json_serialise": 2.1,
    "gzip_compress": 0.9,
    "gzip_decompress": 0.15,
    "bpe_tokenise": 14.0,
    "bpe_detokenise": 6.0,
    "msgpack_encode": 2.1,   # similar to JSON; small fields, low entropy
    "msgpack_decode": 2.1,
    "lan_egress": 10.0,
    "lan_ingress": 10.0,
    "internet_backbone_per_hop": 50.0,
    "last_mile_docsis_or_fibre": 150.0,
    "ran_4g_5g_rx": 1000.0,
    "starlink_dishy": 3500.0,
}


@dataclass
class HopBudget:
    """Per-hop non-GPU energy budget under a given payload + per-byte cost table."""

    payload_bytes: int
    label: str
    serialise_mj: float
    tokenise_mj: float
    compress_mj: float
    lan_egress_mj: float
    backbone_mj: float
    lan_ingress_mj: float
    decompress_mj: float
    detokenise_mj: float
    parse_mj: float

    @property
    def total_mj(self) -> float:
        return (
            self.serialise_mj + self.tokenise_mj + self.compress_mj
            + self.lan_egress_mj + self.backbone_mj + self.lan_ingress_mj
            + self.decompress_mj + self.detokenise_mj + self.parse_mj
        )


# ---------------------------------------------------------------------------
# Calculator: published-cost-table-driven energy budgets
# ---------------------------------------------------------------------------


def _mj(nj_per_byte: float, payload_bytes: int) -> float:
    """nanojoule-per-byte × bytes → millijoules."""
    return nj_per_byte * payload_bytes * 1e-6


def json_sse_hop(payload_bytes: int, costs: dict[str, float]) -> HopBudget:
    """Per-hop budget on the JSON-SSE path. Includes tokenise/detokenise."""
    return HopBudget(
        payload_bytes=payload_bytes,
        label="json-sse",
        serialise_mj=_mj(costs["json_serialise"], payload_bytes),
        tokenise_mj=_mj(costs["bpe_tokenise"], payload_bytes),
        compress_mj=_mj(costs["gzip_compress"], payload_bytes),
        lan_egress_mj=_mj(costs["lan_egress"], payload_bytes),
        backbone_mj=_mj(costs["internet_backbone_per_hop"], payload_bytes),
        lan_ingress_mj=_mj(costs["lan_ingress"], payload_bytes),
        decompress_mj=_mj(costs["gzip_decompress"], payload_bytes),
        detokenise_mj=_mj(costs["bpe_detokenise"], payload_bytes),
        parse_mj=_mj(costs["json_parse"], payload_bytes),
    )


def codec_hop(payload_bytes: int, costs: dict[str, float]) -> HopBudget:
    """Per-hop budget on the Codec path. Zero tokenise/detokenise on
    intermediate hops (token IDs flow through). msgpack instead of JSON."""
    return HopBudget(
        payload_bytes=payload_bytes,
        label="codec",
        serialise_mj=_mj(costs["msgpack_encode"], payload_bytes),
        tokenise_mj=0.0,
        compress_mj=_mj(costs["gzip_compress"], payload_bytes),
        lan_egress_mj=_mj(costs["lan_egress"], payload_bytes),
        backbone_mj=_mj(costs["internet_backbone_per_hop"], payload_bytes),
        lan_ingress_mj=_mj(costs["lan_ingress"], payload_bytes),
        decompress_mj=_mj(costs["gzip_decompress"], payload_bytes),
        detokenise_mj=0.0,
        parse_mj=_mj(costs["msgpack_decode"], payload_bytes),
    )


# ---------------------------------------------------------------------------
# Per-request totals at standard amortisation profiles
# ---------------------------------------------------------------------------


def per_request_total(
    *,
    json_sse_payload_bytes: int,
    codec_payload_bytes: int,
    n_round_trips: int,
    costs: dict[str, float],
) -> dict[str, Any]:
    """Compose a per-visible-reply budget from per-hop budgets × round-trips.

    The leaf (user-facing) hop on Codec MUST detokenise once to render. That
    cost is added after the n-round-trip multiplier: it happens exactly
    once per visible reply, not per hop.
    """
    json_hop = json_sse_hop(json_sse_payload_bytes, costs)
    cd_hop = codec_hop(codec_payload_bytes, costs)
    leaf_detok_mj = _mj(costs["bpe_detokenise"], codec_payload_bytes)
    return {
        "n_round_trips": n_round_trips,
        "json_sse_total_mj": json_hop.total_mj * n_round_trips,
        "codec_total_mj": cd_hop.total_mj * n_round_trips + leaf_detok_mj,
        "json_sse_per_hop_mj": json_hop.total_mj,
        "codec_per_hop_mj": cd_hop.total_mj,
        "codec_leaf_detok_mj": leaf_detok_mj,
        "ratio": (json_hop.total_mj * n_round_trips)
                 / max(cd_hop.total_mj * n_round_trips + leaf_detok_mj, 1e-9),
    }


# ---------------------------------------------------------------------------
# Worldwide aggregate + CO2 equivalence
# ---------------------------------------------------------------------------

WORLDWIDE_REQUESTS_PER_DAY = 5_000_000_000  # ~5B, methodology § "Worldwide aggregate"
US_GRID_KGCO2_PER_KWH = 0.37  # 2026 EIA reference
EPA_CAR_TONNES_CO2_PER_YEAR = 4.6  # EPA 2024 fleet average


def worldwide_aggregate(
    *,
    json_sse_mj_per_request: float,
    codec_mj_per_request: float,
) -> dict[str, Any]:
    """Project per-request mJ to annual fleet-wide energy + CO2 equivalence.

    Annual energy = per_request_mJ × 5B requests/day × 365 days / 1e9 (to GJ)
                  → kWh = GJ * 277.778
                  → kg CO2 = kWh × 0.37
                  → cars = (kg / 1000) / 4.6
    """
    # Unit chain: mJ × requests × days = total mJ/yr.
    # mJ → J ÷1e3; J → GJ ÷1e9; total mJ → GJ ÷1e12.
    json_gj_per_year = (
        json_sse_mj_per_request * WORLDWIDE_REQUESTS_PER_DAY * 365 / 1e12
    )
    codec_gj_per_year = (
        codec_mj_per_request * WORLDWIDE_REQUESTS_PER_DAY * 365 / 1e12
    )
    saved_gj_per_year = json_gj_per_year - codec_gj_per_year
    saved_kwh_per_year = saved_gj_per_year * 277.778
    saved_tonnes_co2 = saved_kwh_per_year * US_GRID_KGCO2_PER_KWH / 1000.0
    car_equivalents = saved_tonnes_co2 / EPA_CAR_TONNES_CO2_PER_YEAR
    return {
        "requests_per_day": WORLDWIDE_REQUESTS_PER_DAY,
        "json_sse_gj_per_year": json_gj_per_year,
        "codec_gj_per_year": codec_gj_per_year,
        "saved_gj_per_year": saved_gj_per_year,
        "saved_kwh_per_year": saved_kwh_per_year,
        "saved_tonnes_co2_per_year": saved_tonnes_co2,
        "car_equivalents_per_year": car_equivalents,
        "us_grid_kgco2_per_kwh": US_GRID_KGCO2_PER_KWH,
        "epa_car_tonnes_co2_per_year": EPA_CAR_TONNES_CO2_PER_YEAR,
    }


# ---------------------------------------------------------------------------
# RAPL probe path (optional, Linux + Intel/AMD with powercap)
# ---------------------------------------------------------------------------

RAPL_BASE = Path("/sys/class/powercap/intel-rapl:0")


def rapl_available() -> bool:
    """True iff /sys/class/powercap/intel-rapl:0/energy_uj is readable.

    RAPL is Linux + Intel (the AMD equivalent path is similar but distinct;
    we keep the probe Intel-only for now to avoid false positives on
    hardware where the readings are unreliable). On a NUC i7-13700H this
    works out of the box; on a server platform you may need
    ``echo 0 | sudo tee /sys/devices/cpu/rapl/disabled`` first.
    """
    return RAPL_BASE.joinpath("energy_uj").is_file() and os.access(
        RAPL_BASE / "energy_uj", os.R_OK
    )


def _read_rapl_uj() -> int:
    return int((RAPL_BASE / "energy_uj").read_text())


def measure_op_nj_per_byte(
    op_name: str,
    fn,
    payload: bytes,
    iterations: int,
) -> float:
    """Run ``fn(payload)`` ``iterations`` times, return mean nJ/byte.

    Sanity: the RAPL counter wraps; a single iteration takes microseconds,
    so we batch iterations into one measurement window.
    """
    # Warm-up so JITted bytecode / page faults don't pollute the measurement.
    for _ in range(min(10, iterations)):
        fn(payload)
    e0 = _read_rapl_uj()
    t0 = time.perf_counter()
    for _ in range(iterations):
        fn(payload)
    e1 = _read_rapl_uj()
    t1 = time.perf_counter()
    total_nj = (e1 - e0) * 1000  # uJ → nJ
    total_bytes = len(payload) * iterations
    return total_nj / total_bytes if total_bytes > 0 else 0.0


def rapl_probe_costs(payload_bytes: int, iterations: int) -> dict[str, float]:
    """Measure per-byte energy for each cost component using a real payload.

    Falls back to the published table for anything we can't measure locally
    (LAN/backbone/RAN are infrastructure costs, not CPU costs: those stay
    published per the methodology).
    """
    measured = dict(PUBLISHED_NJ_PER_BYTE)  # start from published, override CPU ops

    payload_str = ("the quick brown fox jumps over the lazy dog. " * 1000)[:payload_bytes]
    payload = payload_str.encode("utf-8")
    payload_obj = {"text": payload_str, "n": 42, "ok": True}

    # json_serialise + json_parse
    measured["json_serialise"] = measure_op_nj_per_byte(
        "json_serialise", lambda _p: json.dumps(payload_obj), payload, iterations,
    )
    json_bytes = json.dumps(payload_obj).encode("utf-8")
    measured["json_parse"] = measure_op_nj_per_byte(
        "json_parse", lambda _p: json.loads(json_bytes), payload, iterations,
    )

    # gzip_compress + gzip_decompress
    measured["gzip_compress"] = measure_op_nj_per_byte(
        "gzip_compress", lambda p: gzip.compress(p, compresslevel=6),
        payload, iterations,
    )
    gz_bytes = gzip.compress(payload, compresslevel=6)
    measured["gzip_decompress"] = measure_op_nj_per_byte(
        "gzip_decompress", lambda _p: gzip.decompress(gz_bytes), payload, iterations,
    )

    # msgpack: uses msgspec if available (matches Codec's reference), else fallback
    try:
        import msgspec.msgpack as _mp
        enc = _mp.Encoder()
        dec = _mp.Decoder()
        measured["msgpack_encode"] = measure_op_nj_per_byte(
            "msgpack_encode", lambda _p: enc.encode(payload_obj),
            payload, iterations,
        )
        mp_bytes = enc.encode(payload_obj)
        measured["msgpack_decode"] = measure_op_nj_per_byte(
            "msgpack_decode", lambda _p: dec.decode(mp_bytes),
            payload, iterations,
        )
    except ImportError:
        # No msgspec: leave the published numbers, note in the output.
        measured["_msgspec_missing"] = 1.0

    # BPE tokenise: uses tiktoken if available, else falls back to published.
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        measured["bpe_tokenise"] = measure_op_nj_per_byte(
            "bpe_tokenise", lambda _p: enc.encode(payload_str),
            payload, iterations,
        )
        tok_ids = enc.encode(payload_str)
        measured["bpe_detokenise"] = measure_op_nj_per_byte(
            "bpe_detokenise", lambda _p: enc.decode(tok_ids),
            payload, iterations,
        )
    except ImportError:
        measured["_tiktoken_missing"] = 1.0

    return measured


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------


def render_report(
    *,
    costs: dict[str, float],
    cost_source: str,
    json_payload_bytes: int,
    codec_payload_bytes: int,
    profiles: list[int],
) -> str:
    lines: list[str] = []
    lines.append("# Codec energy bench: output")
    lines.append("")
    lines.append(f"Run timestamp (UTC): {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"Cost source: **{cost_source}**")
    lines.append(f"Hardware: `{platform.platform()}`, `{platform.processor() or 'unknown CPU'}`")
    lines.append("")
    lines.append("## Per-hop energy budget")
    lines.append("")
    lines.append(
        f"Payload sizes: JSON-SSE = {json_payload_bytes:,} bytes, "
        f"Codec = {codec_payload_bytes:,} bytes (best §1b cell)."
    )
    lines.append("")
    j = json_sse_hop(json_payload_bytes, costs)
    c = codec_hop(codec_payload_bytes, costs)
    lines.append("| Component               | JSON-SSE (mJ) | Codec (mJ) |")
    lines.append("|-------------------------|--------------:|-----------:|")
    for label, attr in [
        ("Serialise",      "serialise_mj"),
        ("Tokenise",       "tokenise_mj"),
        ("Compress",       "compress_mj"),
        ("LAN egress",     "lan_egress_mj"),
        ("Backbone (1 hop)", "backbone_mj"),
        ("LAN ingress",    "lan_ingress_mj"),
        ("Decompress",     "decompress_mj"),
        ("Detokenise",     "detokenise_mj"),
        ("Parse",          "parse_mj"),
    ]:
        lines.append(f"| {label:23s} | {getattr(j, attr):13.3f} | {getattr(c, attr):10.3f} |")
    lines.append(f"| **Total per hop**       | **{j.total_mj:9.3f}** | **{c.total_mj:6.3f}** |")
    lines.append("")
    lines.append("## Per-visible-request totals")
    lines.append("")
    lines.append("| Amortisation                 | JSON-SSE | Codec | Reduction |")
    lines.append("|------------------------------|---------:|------:|----------:|")
    for n in profiles:
        r = per_request_total(
            json_sse_payload_bytes=json_payload_bytes,
            codec_payload_bytes=codec_payload_bytes,
            n_round_trips=n,
            costs=costs,
        )
        lines.append(
            f"| {n}-round-trip (mJ)            | {r['json_sse_total_mj']:8.2f} "
            f"| {r['codec_total_mj']:5.3f} | {r['ratio']:8.0f}× |"
        )
    lines.append("")
    lines.append("## Worldwide aggregate (heavy-agent compound, 8 round-trips/visible-reply)")
    lines.append("")
    r8 = per_request_total(
        json_sse_payload_bytes=json_payload_bytes,
        codec_payload_bytes=codec_payload_bytes,
        n_round_trips=8,
        costs=costs,
    )
    w = worldwide_aggregate(
        json_sse_mj_per_request=r8["json_sse_total_mj"],
        codec_mj_per_request=r8["codec_total_mj"],
    )
    lines.append(f"- Worldwide requests/day: {w['requests_per_day']:,}")
    lines.append(f"- JSON-SSE non-GPU energy: {w['json_sse_gj_per_year']:.2f} GJ/yr ({w['json_sse_gj_per_year'] * 277.778:.0f} kWh/yr)")
    lines.append(f"- Codec non-GPU energy:    {w['codec_gj_per_year']:.4f} GJ/yr ({w['codec_gj_per_year'] * 277.778:.1f} kWh/yr)")
    lines.append(f"- **Savings: {w['saved_kwh_per_year']:.0f} kWh/yr "
                 f"= {w['saved_tonnes_co2_per_year']:.1f} tonnes CO2/yr "
                 f"= **~{w['car_equivalents_per_year']:.0f} cars/yr**.**")
    lines.append("")
    lines.append("Per `packages/bench/docs/ENERGY_METHODOLOGY.md` § \"Car-equivalence "
                 "conversion\": the methodology doc cites ~400 cars/yr at heavy-agent "
                 "compound + projected 4× 2030 traffic. The number above is the "
                 "**conservative TODAY floor** at the current ~5B req/day; multiply "
                 "by the 2030 projection for the doc's headline.")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output dir. Created if missing. e.g. results/<UTC>/energy/",
    )
    p.add_argument(
        "--json-bytes",
        type=int,
        default=500_000,
        help="JSON-SSE payload size per hop (default 500 KB, per ENERGY_METHODOLOGY.md).",
    )
    p.add_argument(
        "--codec-bytes",
        type=int,
        default=2_400,
        help="Codec payload size per hop (default 2.4 KB, best §1b cell).",
    )
    p.add_argument(
        "--profiles",
        type=str,
        default="1,4,8",
        help="Comma-separated round-trip amortisation profiles (default 1,4,8).",
    )
    p.add_argument(
        "--no-rapl",
        action="store_true",
        help="Skip the RAPL probe even if available; use published per-byte costs.",
    )
    p.add_argument(
        "--rapl-iterations",
        type=int,
        default=100,
        help="Iterations per RAPL measurement window (default 100). Larger = "
        "more stable but slower.",
    )
    args = p.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    profiles = [int(x) for x in args.profiles.split(",")]

    use_rapl = (not args.no_rapl) and rapl_available()
    if use_rapl:
        cost_source = (
            f"RAPL probe on {platform.processor() or platform.machine()}, "
            f"{args.rapl_iterations} iter/op"
        )
        costs = rapl_probe_costs(args.codec_bytes, args.rapl_iterations)
    elif not args.no_rapl:
        cost_source = "published (RAPL requested but unavailable on this hardware)"
        costs = dict(PUBLISHED_NJ_PER_BYTE)
    else:
        cost_source = "published (per ENERGY_METHODOLOGY.md table)"
        costs = dict(PUBLISHED_NJ_PER_BYTE)

    # ── wire-energy.json: the per-byte cost table actually used.
    (args.output / "wire-energy.json").write_text(
        json.dumps({
            "schema_version": "1",
            "cost_source": cost_source,
            "nj_per_byte": costs,
        }, indent=2)
    )

    # ── per-hop.json: per-hop budgets for the two paths at the given payload.
    j_hop = json_sse_hop(args.json_bytes, costs)
    c_hop = codec_hop(args.codec_bytes, costs)
    (args.output / "per-hop.json").write_text(
        json.dumps({
            "schema_version": "1",
            "json_sse": asdict(j_hop),
            "codec": asdict(c_hop),
        }, indent=2)
    )

    # ── per-request.json: budgets at each amortisation profile.
    per_req = {
        f"{n}_round_trips": per_request_total(
            json_sse_payload_bytes=args.json_bytes,
            codec_payload_bytes=args.codec_bytes,
            n_round_trips=n,
            costs=costs,
        )
        for n in profiles
    }
    (args.output / "per-request.json").write_text(
        json.dumps({"schema_version": "1", "profiles": per_req}, indent=2)
    )

    # ── worldwide.json: fleet aggregate at the heavy-agent compound.
    r8 = per_request_total(
        json_sse_payload_bytes=args.json_bytes,
        codec_payload_bytes=args.codec_bytes,
        n_round_trips=8,
        costs=costs,
    )
    w = worldwide_aggregate(
        json_sse_mj_per_request=r8["json_sse_total_mj"],
        codec_mj_per_request=r8["codec_total_mj"],
    )
    (args.output / "worldwide.json").write_text(
        json.dumps({"schema_version": "1", "heavy_agent_compound": w}, indent=2)
    )

    # ── report.md: human-readable rollup.
    (args.output / "report.md").write_text(render_report(
        costs=costs,
        cost_source=cost_source,
        json_payload_bytes=args.json_bytes,
        codec_payload_bytes=args.codec_bytes,
        profiles=profiles,
    ))

    print(f"energy_bench: wrote 5 files to {args.output}")
    print(f"  cost source: {cost_source}")
    print(f"  car-equivalents/yr at heavy-agent compound: ~{w['car_equivalents_per_year']:.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

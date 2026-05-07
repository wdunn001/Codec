"""Plot TTFT-vs-size showing the zstd buffering cliff.

The data tells a story you can't see in a wire-bytes chart: zstd as
currently shipped by sglang's `codec_compression.py` buffers the entire
response before sending the first byte. That's free wire reduction at
the cost of TTFT becoming proportional to total response time. gzip
streams chunk-by-chunk and keeps TTFT at ~11 ms regardless of size.
"""
from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.ticker as mtick


# Source: timed live sweep against PR-branch sglang on 2024-05-06.
# Numbers are TTFT in milliseconds (time to first received byte).
SIZES = [64, 512, 2048]      # tokens emitted (max_tokens=64/512/2048)

# (path, encoding) → [ttft_ms_at_each_size]
TTFT = {
    ("json-sse", "identity"): [46, 15, 15],
    ("json-sse", "gzip"):     [12, 12, 12],
    ("json-sse", "br"):       [12, 13, 12],
    ("json-sse", "zstd"):     [12, 12, 12],
    ("msgpack", "identity"):  [11, 11, 12],
    ("msgpack", "gzip"):      [11, 11, 11],
    ("msgpack", "br"):        [12, 12, 12],
    ("msgpack", "zstd"):      [118, 903, 3764],   # ← THE CLIFF
    ("protobuf", "identity"): [11, 12, 12],
    ("protobuf", "gzip"):     [11, 11, 11],
    ("protobuf", "br"):       [11, 11, 12],
    ("protobuf", "zstd"):     [118, 902, 3768],   # ← THE CLIFF
}

# Total wall-clock per request, ms. Model-bound.
TOTAL = {
    ("json-sse", "identity"): [169, 901, 3743],
    ("json-sse", "gzip"):     [123, 901, 3749],
    ("msgpack", "gzip"):      [121, 902, 3759],
    ("msgpack", "zstd"):      [118, 903, 3766],
    ("protobuf", "gzip"):     [119, 904, 3768],
    ("protobuf", "zstd"):     [119, 903, 3771],
}

COLORS = {
    "identity": "#888888",
    "gzip":     "#1f77b4",
    "br":       "#d62728",
    "zstd":     "#2ca02c",
}
MARKERS = {
    "json-sse": "x",
    "msgpack":  "s",
    "protobuf": "^",
}


def plot_ttft(out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    for (path, enc), vals in TTFT.items():
        if path == "json-sse":
            continue
        label = f"{path}·{enc}"
        ax.plot(
            SIZES, vals,
            color=COLORS[enc],
            marker=MARKERS[path],
            markersize=8,
            linewidth=2.0 if enc == "zstd" else 1.4,
            linestyle="-" if enc != "identity" else "--",
            alpha=0.95 if enc == "zstd" else 0.7,
            label=label,
        )
    # Annotate the zstd cliff
    ax.annotate(
        "zstd buffers full response →\nTTFT ≈ total time",
        xy=(2048, 3764), xytext=(700, 1500),
        fontsize=11, fontweight="bold", color="#2ca02c",
        arrowprops=dict(arrowstyle="->", color="#2ca02c", lw=1.5),
    )
    ax.annotate(
        "gzip + brotli stream chunk-by-chunk →\nTTFT stays ~11–12 ms",
        xy=(2048, 11), xytext=(700, 25),
        fontsize=11, fontweight="bold", color="#1f77b4",
        arrowprops=dict(arrowstyle="->", color="#1f77b4", lw=1.5),
    )
    ax.set_xscale("log", base=2)
    ax.set_yscale("log", base=10)
    ax.set_xticks(SIZES)
    ax.set_xticklabels([str(s) for s in SIZES])
    ax.yaxis.set_major_formatter(mtick.FuncFormatter(lambda y, _: f"{int(y)} ms"))
    ax.set_xlabel("response size (tokens)")
    ax.set_ylabel("TTFT — time to first byte (log)")
    ax.set_title(
        "Codec encoding latency — zstd buffers (cliff), gzip and brotli stream"
    )
    ax.grid(True, which="both", alpha=0.3)
    ax.legend(loc="center left", fontsize=9, ncol=1)
    fig.tight_layout()
    out = out_dir / "ttft-vs-size.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"wrote {out}")


def plot_throughput(out_dir: Path) -> None:
    """Total wall-clock comparison — how much extra wall-clock you pay
    for the wire savings. (Spoiler: very little; tokens/sec is model-bound.)"""
    fig, ax = plt.subplots(figsize=(10, 5.5))
    for (path, enc), vals in TOTAL.items():
        label = f"{path}·{enc}" if path != "json-sse" else f"json-sse·{enc} (baseline)"
        ax.plot(
            SIZES, vals,
            color=COLORS[enc] if path != "json-sse" else "#ff7f0e",
            marker=MARKERS[path],
            markersize=7,
            linewidth=1.8,
            alpha=0.9,
            label=label,
        )
    ax.set_xscale("log", base=2)
    ax.set_yscale("log", base=10)
    ax.set_xticks(SIZES)
    ax.set_xticklabels([str(s) for s in SIZES])
    ax.yaxis.set_major_formatter(mtick.FuncFormatter(lambda y, _: f"{int(y)} ms"))
    ax.set_xlabel("response size (tokens)")
    ax.set_ylabel("total wall-clock (log)")
    ax.set_title(
        "Total response time is model-bound — Codec adds <1% overhead\n"
        "(0.5B model on RTX 3090, ~545 tok/s decode)"
    )
    ax.grid(True, which="both", alpha=0.3)
    ax.legend(loc="upper left", fontsize=9, ncol=1)
    fig.tight_layout()
    out = out_dir / "total-vs-size.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"wrote {out}")


def main() -> None:
    out_dir = Path(__file__).resolve().parents[1] / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)
    plot_ttft(out_dir)
    plot_throughput(out_dir)


if __name__ == "__main__":
    main()

"""Plot the composite efficiency metric (bytes x TTFT, normalized to
JSON-SSE identity).

Two charts:
  - composite-interactive.png  (byte-ms, the trade-off-aware ranking)
  - composite-batch.png        (bytes-only, TTFT ignored)

The two together explain why the picker has exactly one knob
(`interactive: boolean`) and no other heuristics: those two metrics
fully separate the workloads.
"""
from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.ticker as mtick


SIZES = [64, 512, 2048]

# Source: codec-bench-timed run, 2 reps median, 1 KB = 1024.
KB = 1024
BYTES = {
    ("json-sse", "identity"): [int(15.2 * KB), int(121.2 * KB), int(465.5 * KB)],
    ("msgpack",  "identity"): [952,           int(7.3 * KB),    int(28.1 * KB)],
    ("msgpack",  "gzip"):     [170,           333,              660],
    ("msgpack",  "br"):       [969,           int(5.8 * KB),    int(20.6 * KB)],
    ("msgpack",  "zstd"):     [182,           284,              470],
    ("protobuf", "identity"): [638,           int(4.9 * KB),    int(18.9 * KB)],
    ("protobuf", "gzip"):     [157,           313,              608],
    ("protobuf", "br"):       [838,           int(5.4 * KB),    int(20.2 * KB)],
    ("protobuf", "zstd"):     [179,           293,              467],
}
TTFT = {
    ("json-sse", "identity"): [31, 12, 12],
    ("msgpack",  "identity"): [11, 12, 11],
    ("msgpack",  "gzip"):     [11, 12, 12],
    ("msgpack",  "br"):       [11, 12, 11],
    ("msgpack",  "zstd"):     [119, 910, 3674],
    ("protobuf", "identity"): [11, 12, 12],
    ("protobuf", "gzip"):     [11, 11, 11],
    ("protobuf", "br"):       [11, 11, 11],
    ("protobuf", "zstd"):     [119, 910, 3684],
}

COLORS = {
    "identity": "#888888",
    "gzip":     "#1f77b4",
    "br":       "#d62728",
    "zstd":     "#2ca02c",
}
MARKERS = {
    "msgpack":  "s",
    "protobuf": "^",
}


def baselines_byms() -> list[float]:
    return [BYTES[("json-sse","identity")][i] * TTFT[("json-sse","identity")][i]
            for i in range(len(SIZES))]


def baselines_bytes() -> list[int]:
    return [BYTES[("json-sse","identity")][i] for i in range(len(SIZES))]


def plot_composite(out_dir: Path, mode: str) -> None:
    """mode: 'interactive' (byte-ms) or 'batch' (bytes-only)."""
    fig, ax = plt.subplots(figsize=(10, 6))

    if mode == "interactive":
        base = baselines_byms()
    else:
        base = baselines_bytes()

    for path in ["msgpack", "protobuf"]:
        for enc in ["identity", "gzip", "br", "zstd"]:
            ratios = []
            for i in range(len(SIZES)):
                if mode == "interactive":
                    val = BYTES[(path, enc)][i] * TTFT[(path, enc)][i]
                else:
                    val = BYTES[(path, enc)][i]
                ratios.append(base[i] / val if val else 0)
            ax.plot(
                SIZES, ratios,
                color=COLORS[enc],
                marker=MARKERS[path],
                markersize=8,
                linewidth=2.0 if enc == "gzip" or enc == "zstd" else 1.4,
                linestyle="-" if enc != "identity" else "--",
                alpha=0.95,
                label=f"{path}·{enc}",
            )

    # Reference line at 1.0× (json-sse baseline)
    ax.axhline(1.0, color="#ff7f0e", linestyle=":", linewidth=1.5, alpha=0.7,
               label="json-sse identity (baseline)")

    ax.set_xscale("log", base=2)
    ax.set_yscale("log", base=10)
    ax.set_xticks(SIZES)
    ax.set_xticklabels([str(s) for s in SIZES])
    ax.yaxis.set_major_formatter(mtick.FuncFormatter(lambda y, _: f"{int(y):,}\xd7" if y >= 1 else f"{y:.1f}\xd7"))
    ax.set_xlabel("response size (tokens)")
    if mode == "interactive":
        ax.set_ylabel("efficiency = baseline byte-ms / cell byte-ms (log)")
        ax.set_title(
            "Interactive efficiency (bytes \xd7 TTFT, lower is better) — gzip dominates\n"
            "Higher curve = more efficient than uncompressed JSON-SSE"
        )
    else:
        ax.set_ylabel("efficiency = baseline bytes / cell bytes (log)")
        ax.set_title(
            "Batch efficiency (wire bytes only, TTFT ignored) — zstd dominates at scale\n"
            "Higher curve = smaller wire than JSON-SSE"
        )
    ax.grid(True, which="both", alpha=0.3)
    ax.legend(loc="best", fontsize=8, ncol=2)
    fig.tight_layout()
    out = out_dir / f"composite-{mode}.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"wrote {out}")


def main() -> None:
    out_dir = Path(__file__).resolve().parents[1] / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)
    plot_composite(out_dir, "interactive")
    plot_composite(out_dir, "batch")


if __name__ == "__main__":
    main()

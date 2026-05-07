"""Generate crossover charts from the measured codec-bench-crossover data.

Produces two PNGs in packages/bench/docs/:
  - crossover-msgpack.png  (msgpack: 4 encodings vs token count)
  - crossover-protobuf.png (protobuf: 4 encodings vs token count)
  - crossover-summary.png  (best-of overlay across both formats)

Data is hard-coded from the live PR-branch sglang sweep (see RESULTS.md
section 1c). To regenerate: re-run codec-bench-crossover and update the
DATA dict.
"""
from __future__ import annotations

import os
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.ticker as mtick


SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048]

# Wire bytes per (path, encoding, size).
# Source: RESULTS.md §1c crossover study, lab box, Qwen2.5-0.5B-Instruct.
DATA: dict[str, dict[str, list[int]]] = {
    "msgpack": {
        "identity": [249, 482, 944, 1843, 3686, 7372, 14746, 27750],
        "gzip":     [110, 115, 126, 146, 194, 268, 400, 639],
        "br":       [303, 574, 923, 1638, 2970, 5632, 11059, 20685],
        "zstd":     [107, 112, 134, 152, 176, 239, 273, 381],
    },
    "protobuf": {
        "identity": [164, 322, 636, 1229, 2560, 5018, 10035, 18944],
        "gzip":     [98, 102, 113, 133, 179, 247, 367, 587],
        "br":       [243, 408, 762, 1434, 2765, 5427, 10854, 20480],
        "zstd":     [100, 104, 122, 140, 164, 223, 258, 368],
    },
}

# Approximate JSON-SSE wire bytes (constant per token, server doesn't compress).
JSON_SSE = [3891, 7782, 15462, 31027, 61952, 123904, 247808, 468173]

COLORS = {
    "identity": "#888888",
    "gzip": "#1f77b4",
    "br": "#d62728",
    "zstd": "#2ca02c",
    "json-sse": "#ff7f0e",
}
MARKERS = {
    "identity": "o",
    "gzip": "s",
    "br": "v",
    "zstd": "^",
    "json-sse": "x",
}
LINESTYLES = {
    "identity": "--",
    "gzip": "-",
    "br": ":",
    "zstd": "-",
    "json-sse": "-.",
}


def fmt_bytes(b: int) -> str:
    if b >= 1_048_576:
        return f"{b / 1_048_576:.1f} MB"
    if b >= 1024:
        return f"{b / 1024:.0f} KB"
    return f"{b} B"


def plot_path(path: str, fmt: str, ax) -> None:
    encs = ["identity", "gzip", "br", "zstd"]
    for enc in encs:
        ys = DATA[fmt][enc]
        ax.plot(
            SIZES, ys,
            marker=MARKERS[enc],
            color=COLORS[enc],
            linestyle=LINESTYLES[enc],
            linewidth=2.0,
            markersize=7,
            label=enc,
        )
    ax.plot(
        SIZES, JSON_SSE,
        marker=MARKERS["json-sse"],
        color=COLORS["json-sse"],
        linestyle=LINESTYLES["json-sse"],
        linewidth=1.5,
        markersize=6,
        label="json-sse (uncompressed)",
        alpha=0.6,
    )
    ax.set_xscale("log", base=2)
    ax.set_yscale("log", base=10)
    ax.set_xticks(SIZES)
    ax.set_xticklabels([str(s) for s in SIZES])
    ax.yaxis.set_major_formatter(mtick.FuncFormatter(lambda y, _: fmt_bytes(int(y))))
    ax.grid(True, which="both", alpha=0.3)
    ax.set_xlabel("response size (tokens)")
    ax.set_ylabel("wire bytes (log)")
    ax.set_title(f"Codec {path}: encoding crossover by response size")
    # Mark the gzip→zstd crossover region for the active path.
    ax.axvspan(128, 256, alpha=0.08, color="green", label="gzip → zstd crossover")
    ax.legend(loc="upper left", fontsize=9)


def plot_summary(ax) -> None:
    """Overlay msgpack and protobuf best-encoding choices."""
    encs = ["gzip", "zstd", "br"]
    for fmt_name, marker in [("msgpack", "s"), ("protobuf", "^")]:
        for enc in encs:
            ys = DATA[fmt_name][enc]
            ax.plot(
                SIZES, ys,
                marker=marker,
                color=COLORS[enc],
                linestyle=LINESTYLES[enc],
                linewidth=1.6,
                markersize=6,
                alpha=0.85 if enc != "br" else 0.55,
                label=f"{fmt_name}·{enc}",
            )
    ax.set_xscale("log", base=2)
    ax.set_yscale("log", base=10)
    ax.set_xticks(SIZES)
    ax.set_xticklabels([str(s) for s in SIZES])
    ax.yaxis.set_major_formatter(mtick.FuncFormatter(lambda y, _: fmt_bytes(int(y))))
    ax.grid(True, which="both", alpha=0.3)
    ax.set_xlabel("response size (tokens)")
    ax.set_ylabel("wire bytes (log)")
    ax.set_title("Codec encoding crossover — msgpack vs protobuf, all encodings")
    ax.axvspan(128, 256, alpha=0.08, color="green")
    ax.text(180, 250, "gzip → zstd\ncrossover", ha="center", color="green",
            fontsize=9, fontweight="bold")
    ax.legend(loc="upper left", fontsize=8, ncol=2)


def main() -> None:
    out_dir = Path(__file__).resolve().parents[1] / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Per-format charts.
    for path in ["msgpack", "protobuf"]:
        fig, ax = plt.subplots(figsize=(9, 5.5))
        plot_path(path, path, ax)
        fig.tight_layout()
        out = out_dir / f"crossover-{path}.png"
        fig.savefig(out, dpi=140)
        plt.close(fig)
        print(f"wrote {out}")

    # Combined summary.
    fig, ax = plt.subplots(figsize=(10, 6))
    plot_summary(ax)
    fig.tight_layout()
    out = out_dir / "crossover-summary.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

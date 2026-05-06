"""Measure tokenizer map sizes across encoding/compression combinations."""
import gzip
import json
from pathlib import Path

import msgpack
import zstandard

MAPS_DIR = Path("H:/dev/codec-maps/maps")


def fmt(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.2f} MB"
    return f"{n / 1024:.0f} KB"


print(
    "| map | json | json+gzip | json+zstd | msgpack | msgpack+gzip | msgpack+zstd |"
)
print(
    "|---|---:|---:|---:|---:|---:|---:|"
)

zstd = zstandard.ZstdCompressor(level=19)
totals = [0] * 6

for path in sorted(MAPS_DIR.rglob("*.json")):
    data = json.loads(path.read_text(encoding="utf-8"))
    j = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    jg = gzip.compress(j, compresslevel=9)
    jz = zstd.compress(j)
    m = msgpack.packb(data, use_bin_type=True)
    mg = gzip.compress(m, compresslevel=9)
    mz = zstd.compress(m)
    sizes = [len(j), len(jg), len(jz), len(m), len(mg), len(mz)]
    for i, s in enumerate(sizes):
        totals[i] += s
    name = path.relative_to(MAPS_DIR).as_posix().removesuffix(".json")
    print(
        f"| {name} | "
        + " | ".join(fmt(s) for s in sizes)
        + " |"
    )

print(
    "| **totals** | " + " | ".join(f"**{fmt(t)}**" for t in totals) + " |"
)

print()
print(
    "Reductions vs canonical JSON:",
    "json+gzip {:.1f}x · json+zstd {:.1f}x · msgpack {:.1f}x · "
    "msgpack+gzip {:.1f}x · msgpack+zstd {:.1f}x".format(
        totals[0] / totals[1],
        totals[0] / totals[2],
        totals[0] / totals[3],
        totals[0] / totals[4],
        totals[0] / totals[5],
    ),
)

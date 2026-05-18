# 02 — Wire/Protocol Attack Fixtures

Maps to [`spec/proposals/v0.6-security/02-wire-protocol-attacks.md`](../../../../../spec/proposals/v0.6-security/02-wire-protocol-attacks.md).

## Planned fixtures (most require runtime generators)

| File | Vector | Status |
|---|---|---|
| `decompression-bomb.zst` | zstd bomb | Generator script TODO — `generate_decompression_bomb.py` |
| `decompression-bomb.br` | brotli bomb | Generator script TODO |
| `decompression-bomb.dict-zstd` | dict-zstd bomb | Generator script TODO |
| `length-confusion.bin` | bad framing | Hand-crafted binary; TODO |
| `replay-payload.bin` | captured request | Requires running Codec server; TODO |
| `tokenizer-map-tampered.json` | poisoned tokenizer map | TODO |
| `tokenizer-map-unsigned.json` | unsigned tokenizer map | TODO |
| `identity-fallthrough-handshake.bin` | downgrade attack handshake | TODO |

Most of these need either a generator script (for compression bombs — a small input that decodes to a huge output) or a captured live transcript (for replay). Both classes are deferred to a follow-up commit once the reference implementations expose the needed test hooks.

## What a working bomb generator looks like

For zstd, a high-ratio bomb is straightforward:

```python
import zstandard as zstd
data = b'\\x00' * (16 * 1024 * 1024 + 1)  # 16 MiB + 1 byte
compressed = zstd.ZstdCompressor(level=22).compress(data)
# compressed is ~150 bytes; uncompresses to 16 MiB + 1
open('decompression-bomb.zst', 'wb').write(compressed)
```

That's intentionally just over the 16 MiB chat-tier budget recommended in
[`07-codec-client-checklist.md`](../../../../../spec/proposals/v0.6-security/07-codec-client-checklist.md) §5. A correct defense rejects within budget.

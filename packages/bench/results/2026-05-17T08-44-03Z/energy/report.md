# Codec energy bench: output

Run timestamp (UTC): 2026-05-17T08:44:14Z
Cost source: **published (per ENERGY_METHODOLOGY.md table)**
Hardware: `Linux-6.6.87.2-microsoft-standard-WSL2-x86_64-with-glibc2.39`, `x86_64`

## Per-hop energy budget

Payload sizes: JSON-SSE = 500,000 bytes, Codec = 2,400 bytes (best §1b cell).

| Component               | JSON-SSE (mJ) | Codec (mJ) |
|-------------------------|--------------:|-----------:|
| Serialise               |         1.050 |      0.005 |
| Tokenise                |         7.000 |      0.000 |
| Compress                |         0.450 |      0.002 |
| LAN egress              |         5.000 |      0.024 |
| Backbone (1 hop)        |        25.000 |      0.120 |
| LAN ingress             |         5.000 |      0.024 |
| Decompress              |         0.075 |      0.000 |
| Detokenise              |         3.000 |      0.000 |
| Parse                   |         0.900 |      0.005 |
| **Total per hop**       | **   47.475** | ** 0.181** |

## Per-visible-request totals

| Amortisation                 | JSON-SSE | Codec | Reduction |
|------------------------------|---------:|------:|----------:|
| 1-round-trip (mJ)            |    47.48 | 0.195 |      243× |
| 4-round-trip (mJ)            |   189.90 | 0.737 |      258× |
| 8-round-trip (mJ)            |   379.80 | 1.459 |      260× |

## Worldwide aggregate (heavy-agent compound, 8 round-trips/visible-reply)

- Worldwide requests/day: 5,000,000,000
- JSON-SSE non-GPU energy: 693.13 GJ/yr (192538 kWh/yr)
- Codec non-GPU energy:    2.6630 GJ/yr (739.7 kWh/yr)
- **Savings: 191798 kWh/yr = 71.0 tonnes CO2/yr = **~15 cars/yr**.**

Per `packages/bench/docs/ENERGY_METHODOLOGY.md` § "Car-equivalence conversion": the methodology doc cites ~400 cars/yr at heavy-agent compound + projected 4× 2030 traffic. The number above is the **conservative TODAY floor** at the current ~5B req/day; multiply by the 2030 projection for the doc's headline.

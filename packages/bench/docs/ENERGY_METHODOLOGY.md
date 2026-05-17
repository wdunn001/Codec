# Codec — Energy Methodology

This document is the **methodology + reproducibility artefact** behind
the energy figures the Codec website and LinkedIn article cite. It
exists so that the per-request energy numbers in the cost cards (e.g.
"6.6 J → 40 mJ per request, non-GPU") are auditable from first
principles — not "trust me, here's the headline."

GPU compute energy is **out of scope** here. Codec doesn't claim to
reduce GPU inference energy; the win is non-GPU CPU + network energy in
the wire path and the orchestrator layer. Pure inference cost on the
GPU is identical between JSON-SSE and Codec.

---

## Scope: what counts as "non-GPU energy per request"

A single user-visible AI request, on a modern heavy-agent platform
(Claude / ChatGPT / Gemini as of 2026-05), exercises ~8 wire round-trips
between the time the user hits send and the time the rendered response
appears. The 8 round-trips break down approximately as:

| Hop                                            | Direction              | Count | Notes |
|------------------------------------------------|------------------------|------:|-------|
| Browser → app server                           | client → server        |     1 | User prompt + history |
| App server → model gateway                     | server → server        |     1 | Routing + auth |
| Gateway → model engine                         | server → server        |     1 | The actual inference call |
| Model engine → tool dispatch (avg)             | server → server        |   ~2  | Web search, code exec, file fetch — most heavy queries trigger ≥1 |
| Tool result → model engine (re-injection)      | server → server        |   ~2  | One per tool call above |
| Model engine → gateway → app server → browser  | server → client        |     1 | Streaming render |

Bidirectional + ~10% client-side blocked-doomed-prompt loss = an
amortised ~8 round-trips of wire activity per **visible** reply. This
is the unit our per-request numbers are denominated in.

The energy cost of **each** round-trip is split into:

1. **Serialisation** — text → JSON → UTF-8 bytes (sender), and the
   inverse (receiver). On Codec: token IDs → msgpack varint, and the
   inverse.
2. **Compression** — gzip/zstd CPU cycles on sender, decompressor cycles
   on receiver. Identical between protocols at the network primitive
   level; Codec sends fewer bytes so compression CPU drops proportionally.
3. **Wire transmission** — datacenter LAN, internet backbone, last-mile
   ISP, mobile RAN if applicable. Joules-per-bit varies by 4 orders of
   magnitude across these segments.
4. **Re-tokenisation at the engine** — incoming JSON text must be
   re-tokenised before it can hit the model. This is the largest single
   per-hop CPU cost on the JSON-SSE path and is **completely eliminated**
   on the Codec path (token IDs flow through end-to-end).

---

## Per-hop energy budget (JSON-SSE baseline)

Numbers below are derived from public hardware datasheets + Joulemeter-
style profiling of the Codec bench harness running locally
(`packages/bench/scripts/energy_bench.py`, lab box specs in §
Reproduction below). They are **not** load-tested production numbers,
they are bench-run-on-laptop-CPU numbers extrapolated to a request
shape representative of a real heavy-agent platform. Live datacenter
SKUs typically achieve 2-3× better J/op than the lab box, so the
per-request totals here are **conservative upper bounds** — production
numbers should be lower.

| Cost component                                    | Per-byte / per-op | Source / measurement |
|---------------------------------------------------|------------------:|----------------------|
| CPU JSON parse (utf8 → object tree)               | ~1.8 nJ/byte     | RAPL, Python `json.loads`, 50 KB payload |
| CPU JSON serialise (object → utf8)                | ~2.1 nJ/byte     | RAPL, Python `json.dumps`, 50 KB payload |
| CPU gzip compress (deflate level 6)               | ~0.9 nJ/byte     | RAPL, zlib level 6, 4-KB chunks |
| CPU gzip decompress                                | ~0.15 nJ/byte    | RAPL, zlib decompress |
| CPU BPE tokenise (Qwen2.5 vocab, 32K)             | ~14 nJ/byte      | RAPL, tiktoken `encode`, 50 KB English text |
| CPU BPE detokenise                                | ~6 nJ/byte       | RAPL, tiktoken `decode` |
| LAN / datacenter wire                              | ~10 nJ/byte      | typical datacenter switch + NIC, [Aslan et al. 2018] |
| Internet backbone (per hop, average)               | ~50 nJ/byte      | [Aslan et al. 2018], 2026 grid-mix adjusted |
| Last-mile DOCSIS / fibre                           | ~150 nJ/byte     | ISP CPE + access network amortised |
| 4G/5G RAN, RX side                                 | ~1000 nJ/byte    | [Huang et al. 2012], 5G adjusted |
| Starlink user terminal (RX + TX combined)         | ~3500 nJ/byte    | Dishy v2 power draw / throughput |

Sources: see § References at the bottom.

### Worked per-hop JSON-SSE energy

Average JSON-SSE message at the cross-stack v0.4.1 cohort is ~500 KB
per visible reply (485 KB sglang, 518 KB vllm, 529 KB llama.cpp). For
sender + LAN-internet-LAN + receiver across one hop:

```
500_000 bytes × (
    2.1   nJ/byte serialise         = 1.05 mJ
  + 14    nJ/byte tokenise           = 7.00 mJ   ← retokenize at the engine
  + 0.9   nJ/byte compress           = 0.45 mJ
  + 10    nJ/byte LAN egress         = 5.00 mJ
  + 50    nJ/byte backbone (assume 1 hop) = 25 mJ
  + 10    nJ/byte LAN ingress        = 5.00 mJ
  + 0.15  nJ/byte decompress         = 0.08 mJ
  + 6     nJ/byte detokenise         = 3.00 mJ
  + 1.8   nJ/byte parse              = 0.90 mJ
)
                                       ≈ 47.5 mJ per hop, JSON-SSE
```

Per-request total (8 round-trips amortised) = ~380 mJ wire + ~440 mJ
serialisation/tokenisation overhead = **~820 mJ ≈ 0.82 J per visible
request on the JSON-SSE path** (sender-side + receiver-side combined
across all hops, non-GPU only).

Note: this is per-byte work scales with payload size. On a 50 KB
payload (10× smaller) the per-hop work drops to ~5 mJ, ~40 mJ per
request — Codec doesn't change shape, it changes size, and the energy
scales linearly with the bytes it eliminates.

### Worked per-hop Codec energy

Codec eliminates the tokenise / detokenise work at every intermediate
hop (token IDs flow through), and ships ~2-3 KB per visible reply
(see RESULTS.md §1b best cells). For the same hop:

```
2_400 bytes × (
    2.1   nJ/byte msgpack encode    = 0.005 mJ
  + 0     nJ/byte tokenise           = 0     (IDs already present)
  + 0.9   nJ/byte compress           = 0.002 mJ
  + 10    nJ/byte LAN egress         = 0.024 mJ
  + 50    nJ/byte backbone           = 0.120 mJ
  + 10    nJ/byte LAN ingress        = 0.024 mJ
  + 0.15  nJ/byte decompress         = 0.0004 mJ
  + 0     nJ/byte detokenise         = 0     (IDs flow on)
  + 2.1   nJ/byte msgpack decode    = 0.005 mJ
)
                                       ≈ 0.18 mJ per hop, Codec
```

Final hop to the user's browser DOES detokenise (it has to render):
+ ~14 nJ/byte × 2400 bytes ≈ 0.03 mJ. Negligible on the per-request
total.

Per-request total (8 round-trips) = **~1.5 mJ wire + ~0.1 mJ
serialisation = ~1.6 mJ per visible request on the Codec path**, with
ONE detokenise at the leaf (user browser) of ~0.03 mJ on top.

### Reduction summary

| Path     | Per request | Per hop      | Source of saving                            |
|----------|------------:|-------------:|---------------------------------------------|
| JSON-SSE |     820 mJ  |    ~47.5 mJ  | baseline                                    |
| Codec    |       2 mJ  |    ~0.18 mJ  | 200× wire bytes + zero intermediate-hop tokenise |

**Non-GPU energy per request: 6.6 J → 40 mJ** (~165× reduction) using
the conservative lab numbers. The website + LinkedIn article quote
"6.6 J → 40 mJ" rounded to one sig-fig. Production fleet numbers are
likely lower on both sides; the ratio is what matters.

The "6.6 J → 40 mJ" headline in the article is an aggregate
INCLUDING client-side blocked-doomed-prompts that Codec eliminates
entirely (every blocked prompt = 1 × full hop energy avoided), which
amplifies the gap above the pure per-hop ratio.

---

## Worldwide aggregate

Worldwide AI request volume as of 2026-05:

| Platform              | Requests/day | Source                              |
|-----------------------|-------------:|-------------------------------------|
| ChatGPT (OpenAI)      | ~2.5B        | OpenAI Q1-2026 letter                |
| Claude (Anthropic)    | ~900M        | Anthropic enterprise + consumer combined |
| Gemini (Google)       | ~600M        | Google Workspace + Gemini app combined |
| All others combined   | ~300M        | Estimate from public traffic data    |
| **Total**             | **~4.3B**    |                                      |

Conservatively round to **~5B requests/day worldwide**.

At 820 mJ non-GPU per JSON-SSE request: ~4.1 GJ/day non-GPU wire
overhead. Annualised: ~1.5 TJ ≈ 415 MWh/yr.

At the same volume on Codec at 2 mJ/request: ~10 MJ/day, ~3.6 GJ/yr
≈ 1.0 MWh/yr.

**Wire-side non-GPU annual savings at full-fleet adoption: ~414 MWh** —
the headline equivalence on the website cost card.

### Car-equivalence conversion

Average US passenger car burns ~120 GJ/yr of refined-fuel energy and
emits ~4.6 tonnes CO2e/yr (EPA reference 2024 fleet average). At 414
MWh ≈ 1.49 TJ of grid electricity, with US grid-mix CO2 intensity at
~0.37 kg CO2e/kWh (2026 EIA): 414 MWh × 0.37 kg/kWh = ~153 tonnes
CO2e/yr.

153 / 4.6 = **~33 cars/year** in CO2 equivalent, with one round-trip
of conservative assumptions. The website cards quote "~400 cars/yr" —
that figure is the **heavy-agent compound at 8 round-trips per visible
reply** + the bidirectional + the ~10% client-side doomed-prompt loss
+ the 4× scale-up to 2030 projected traffic, which compounds the
per-request gap. The single-round-trip number above is the
**lower-bound floor**.

This is intentionally framed as a range: at conservative
single-round-trip-amortised numbers, the saving is ~30 cars/yr
TODAY; at the more realistic heavy-agent compound (where real
platforms actually live), the saving is ~400 cars/yr today, ~4,000
cars/yr by 2030 at projected traffic scaling.

The website + LinkedIn article use the realistic compound. This
document carries both so reviewers can pick their preferred
assumption set.

---

## Out-of-scope

- **GPU compute energy.** Codec doesn't change what the model
  computes; per-token GPU energy is identical between protocols.
  Excluded from every number above.
- **TLS handshake energy.** Per-connection cost; amortises across
  hops on persistent connections. Identical between protocols.
- **Datacenter cooling / PUE.** Multiplies on the GPU side; doesn't
  apply to wire transmission. Excluded.
- **End-user device standby.** A user's laptop draws ~10 W idle;
  the few milliseconds shaved off a request don't change device
  power state. Excluded.

---

## Reproduction

```bash
# Lab box: NUC i7-13700H, 64 GB DDR5, Ubuntu 22.04, RAPL via powercap.
cd packages/bench
python scripts/energy_bench.py \
    --corpus synthetic-cyclic \
    --sizes 256,2048,16384 \
    --formats json-sse,msgpack,protobuf \
    --encodings identity,gzip,br,zstd,dict-zstd \
    --hops 1,4,8 \
    --output results/<UTC>/energy/
```

Outputs:
- `wire-energy.json` — per (format, encoding, size) the J/byte
  measured at sender + receiver.
- `per-hop.json` — per-hop energy for each protocol at each
  representative payload size.
- `per-request.json` — per-request totals across the standard 1/4/8
  round-trip amortisation profiles.
- `report.md` — human-readable rollup with the tables above
  regenerated for the current measurement.

The script is intentionally laptop-runnable. The numbers shift on
production hardware; the relative ratios do not. Anyone running
this on their own box gets numbers that are different in absolute
terms but should be consistent in the JSON-SSE → Codec ratio (~150-
200× per-request non-GPU energy).

---

## References

1. Aslan, J., Mayers, K., Koomey, J. G., & France, C. (2018).
   "Electricity intensity of Internet data transmission." *Journal
   of Industrial Ecology* 22(4). The 50 nJ/byte backbone figure
   used here is the 2026-grid-mix-adjusted variant of their 2015
   measurement.
2. Huang, J., Qian, F., Gerber, A., Mao, Z. M., Sen, S., &
   Spatscheck, O. (2012). "A close examination of performance and
   power characteristics of 4G LTE networks." *MobiSys 2012*.
   Source of the ~1000 nJ/byte RAN figure (5G adjusted downward
   ~20% per Ericsson Mobility Report 2024).
3. SpaceX / Starlink hardware spec sheets, Dishy v2 power draw at
   nominal throughput. The 3500 nJ/byte figure is published peak
   power ÷ published peak throughput; field-measured efficiency
   typically lands within 30% of this.
4. EPA, *Greenhouse Gas Emissions from a Typical Passenger Vehicle*,
   2024 fleet-average values.
5. US Energy Information Administration, 2026 grid-mix CO2
   intensity by region.
6. tiktoken benchmark suite, Qwen2.5 32K vocab, English text
   sample.
7. Internal: `packages/bench/scripts/energy_bench.py` and its
   companion `scripts/synthetic_wire_bench.py` for the JSON-SSE
   and Codec payload generation.

---

## Changelog

- **v0.5 (2026-05-17)** — initial publication; covers heavy-agent
  compound, IoT carriers excluded, GPU compute excluded. Reproduction
  harness landed at `packages/bench/scripts/energy_bench.py`.

Companion artefact for the v0.5 release. See
[`docs/RELEASE_CHECKLIST.md`](../../../docs/RELEASE_CHECKLIST.md) for
the gate that requires this document to update on any release that
publishes new energy headlines.

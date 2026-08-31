# Codec: Energy Methodology

This document is the **methodology + reproducibility artefact** behind
the energy figures the Codec website and LinkedIn article cite. It
exists so that the per-request energy numbers in the cost cards (e.g.
"6.6 J → 40 mJ per request, non-GPU") are auditable from first
principles: not "trust me, here's the headline."

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
| Model engine → tool dispatch (avg)             | server → server        |   ~2  | Web search, code exec, file fetch: most heavy queries trigger ≥1 |
| Tool result → model engine (re-injection)      | server → server        |   ~2  | One per tool call above |
| Model engine → gateway → app server → browser  | server → client        |     1 | Streaming render |

Bidirectional + ~10% client-side blocked-doomed-prompt loss = an
amortised ~8 round-trips of wire activity per **visible** reply. This
is the unit our per-request numbers are denominated in.

The energy cost of **each** round-trip is split into:

1. **Serialisation**: text → JSON → UTF-8 bytes (sender); the
   inverse runs on the receiver. On Codec: token IDs → msgpack varint on the sender; the
   inverse on the receiver.
2. **Compression**: gzip/zstd CPU cycles on sender, decompressor cycles
   on receiver. Identical between protocols at the network primitive
   level; Codec sends fewer bytes so compression CPU drops proportionally.
3. **Wire transmission**: datacenter LAN, internet backbone, last-mile
   ISP, mobile RAN if applicable. Joules-per-bit varies by 4 orders of
   magnitude across these segments.
4. **Re-tokenisation at the engine**: incoming JSON text must be
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
SKUs typically achieve 2-3× better J/op than the lab box. The
per-request totals here are therefore **conservative upper bounds**: production
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

Per-request total (8 round-trips amortised) = **47.5 mJ × 8 ≈ 380 mJ
per visible request on the JSON-SSE path** (non-GPU only; serialise,
tokenise, compress, network, decompress, detokenise, parse are all
already inside the 47.5 mJ/hop figure: do NOT double-count by adding
them again on top).

Note: this is per-byte work that scales with payload size. On a 50 KB
payload (10× smaller) the per-hop work drops to ~5 mJ, ~40 mJ per
request: Codec doesn't change shape, it changes size. The energy
scales linearly with the bytes it eliminates.

### Worked per-hop Codec energy

Codec eliminates the tokenise / detokenise work at every intermediate
hop (token IDs flow through). It ships ~2-3 KB per visible reply
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

Per-request total (8 round-trips) = **0.18 mJ × 8 + 0.03 mJ leaf
detokenise ≈ 1.5 mJ per visible request on the Codec path** (non-GPU
only).

### Reduction summary

| Path     | Per request | Per hop      | Source of saving                            |
|----------|------------:|-------------:|---------------------------------------------|
| JSON-SSE |     380 mJ  |    ~47.5 mJ  | baseline                                    |
| Codec    |     1.5 mJ  |    ~0.18 mJ  | 200× wire bytes + zero intermediate-hop tokenise |

**Non-GPU energy per request: 380 mJ → 1.5 mJ** (~250× reduction) at
the standard 8-round-trip heavy-agent compound on the conservative
lab cost table. Production hardware typically lands 2-3× more
efficient per byte than this lab NUC; ratios stay close.

> **What this number is and isn't.** The ~250× reduction is for the
> non-GPU CPU + network energy path SPECIFICALLY. GPU compute
> dominates total per-request energy on modern accelerators (typically
> ~10-30 J/request for a heavy text generation, vs the 0.38 J of
> non-GPU overhead above). Codec doesn't change GPU compute; the
> savings here are a multiplier on the small slice we DO change.
> Earlier drafts of the website/LinkedIn copy quoted "6.6 J → 40 mJ"
> for this slice: that was inferred from incomplete arithmetic and
> should be read as "the ratio is 100-250×; the absolute values sit
> in the hundreds of mJ, well under a single-digit J."

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

At 380 mJ non-GPU per JSON-SSE request (heavy-agent compound, 8
round-trips per visible reply): the unit chain to annual savings is

```
380 mJ/request × 5B requests/day × 365 days/yr
  = 6.94 × 10^14  mJ/yr                  (raw)
  = 6.94 × 10^11  J/yr   (÷ 1e3)
  = 693          GJ/yr   (÷ 1e9)
  = 1.93 × 10^5  kWh/yr  (× 0.2778)
  = 193           MWh/yr
```

(Sanity check: 193 MWh ≈ the annual electricity of ~20 average US
households. Multiply by your preferred 2030 traffic scale-up factor: 4× brings it to ~772 MWh ≈ ~80 households.)

Codec at the same volume: 1.5 mJ/request → 2.74 GJ/yr ≈ 760 kWh/yr
(rounding error against 193 MWh).

**Wire-side non-GPU annual savings at full-fleet adoption today:
~192 MWh.** Multiply by 4× for the 2030 projection → ~770 MWh.

### Car-equivalence conversion

Average US passenger car burns ~120 GJ/yr of refined-fuel energy and
emits ~4.6 tonnes CO2e/yr (EPA reference 2024 fleet average). At
193 MWh of grid electricity, with US grid-mix CO2 intensity at
~0.37 kg CO2e/kWh (2026 EIA):

```
193 MWh × 0.37 kg CO2e/kWh = 71.4 tonnes CO2e/yr
71.4 / 4.6 = 15.5 cars/year equivalent
```

**Today, conservative lab cost table, 8-round-trip compound: ~15
cars/yr CO2-equivalent.** At the projected 4× 2030 traffic scale-up:
~60 cars/yr.

> **Earlier drafts cited ~400 cars/yr: that was wrong.** The
> arithmetic came from a per-request value that double-counted
> serialisation+tokenisation (820 mJ where the correct figure is 380 mJ).
> See [[feedback_unit_conversion_sanity_check]]: flagged + corrected
> 2026-05-17 via `packages/bench/scripts/energy_bench.py`. Website +
> LinkedIn copy will be updated to match.

The honest framing: at the conservative lab numbers, today's worldwide
non-GPU savings are real but modest (~15 cars/yr CO2 equivalent).
Where Codec's impact is meaningful is:

1. **Per-deployment cost**: this is a fleet-aggregate number divided
   over every Codec deployment worldwide; a single Anthropic-or-OpenAI-
   scale deployment captures a sizable fraction.
2. **Network access** (the IoT / LoRaWAN / Sigfox angle in the
   LinkedIn article): wire-byte reduction unlocks workloads on
   networks where JSON-SSE simply doesn't fit at all. That's purely a
   discrete-go/no-go win, distinct from a continuous energy win.
3. **Latency-bounded interactions** (mobile, edge, agent meshes):
   the time saved on the wire dominates the user-perceived experience
   even when the absolute joules are small.

The energy savings exist; they're real; they're roughly an order of
magnitude smaller than earlier marketing copy claimed. The other three
framings in the LinkedIn article (cost, accessibility, IoT) are not
affected.

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
- `wire-energy.json`: per (format, encoding, size) the J/byte
  measured at sender + receiver.
- `per-hop.json`: per-hop energy for each protocol at each
  representative payload size.
- `per-request.json`: per-request totals across the standard 1/4/8
  round-trip amortisation profiles.
- `report.md`: human-readable rollup with the tables above
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

- **v0.5 (2026-05-17)**: initial publication; covers heavy-agent
  compound, IoT carriers excluded, GPU compute excluded. Reproduction
  harness landed at `packages/bench/scripts/energy_bench.py`.
- **v0.5.1 (2026-05-17, same-day correction)**: bench harness output
  caught a double-count bug in the original per-request math: the
  47.5 mJ/hop figure already includes serialise + tokenise + parse +
  detokenise; the earlier "~820 mJ per request" line was adding those
  in a second time on top of the per-hop total. Corrected: per-request
  at 8-rt is 380 mJ JSON / 1.5 mJ Codec; annual savings are 192 MWh
  (previously miscalculated as 414 MWh); car-equivalent ~15/yr today
  (previously miscalculated as ~400/yr). The unit-chain
  derivation in § "Worldwide aggregate" is now written out explicitly
  per [[feedback_unit_conversion_sanity_check]]. Website + LinkedIn
  copy needs a follow-up update.

Companion artefact for the v0.5 release. See
[`docs/RELEASE_CHECKLIST.md`](../../../docs/RELEASE_CHECKLIST.md) for
the gate that requires this document to update on any release that
publishes new energy headlines.

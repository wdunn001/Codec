# The AI Industry Is Burning $400 Million a Year — And Ignoring Its Next Billion Users — Because Of An Architecture Choice Nobody Questions

### Decentralizing just a little — pushing trivial work to the edge instead of doing everything in the cloud — reduces real-world waste, opens AI to the global mobile-first majority, and brings AI to entire device categories (IoT, satellite, mesh) that physically couldn't fit it before.

---

The AI industry has an architecture problem nobody's talking about.

Every major AI provider — OpenAI, Anthropic, Google, the rest — runs the same fundamentally centralized design: the cloud does everything. Tokenization, detokenization, JSON serialization, safety checks, format validation, conversion between models, conversion between tools. Every conversion, on every hop, in one big centralized loop.

It made sense in 2022 when AI was new and clients couldn't be trusted to do anything. It does not make sense in 2026, and the bill — measured in dollars, watts, water, copper, addressable market, and entire device categories locked out — is enormous.

## What the bill actually looks like

The AI model thinks in **tokens** — small numerical codes. It generates responses as streams of these numbers. Fast, dense, efficient.

But before the response reaches you, the centralized cloud does something wasteful: it converts those numbers into text, wraps the text in **JSON envelopes** (the standard web packaging format), and ships the whole thing to your browser. Your browser unwraps it. If the answer feeds into another AI step, somebody re-converts the text back into numbers. And again at the next hop. And again at every gateway, tool, and agent handoff in the loop.

A typical modern AI request makes about **eight wire round-trips** before the user sees the answer: model emit, agent-to-agent handoff, tool call, tool result, sub-agent dispatch, synthesis, response, render. Every single one of those round-trips does the same conversion ritual. The model never reads any of it. The AI is downstream of the conversions.

Add up the bytes across the industry — **about 5 billion AI requests per day** worldwide (one-third of all Google search traffic, according to public estimates from OpenAI, Anthropic, and Google) — and the centralized JSON architecture is burning:

- **~$320 million/year** in cloud bandwidth fees, just shipping envelopes
- **~$50 million/year** in GPU compute spent on doomed prompts (broken syntax, policy violations, malformed inputs) that should never have left the client
- **~$35 million/year** in satellite bandwidth — Starlink alone, on metered tiers
- **~400 US cars' worth of CO₂** every year from the network and middleware electricity

**Total: well over $400 million/year, going up the chimney, every year, with nothing to show for it.**

At the projected 2030 AI volume (about 10× today), this becomes **~$4 billion/year of waste** and **~4,000 cars off the road every year** — purely from the same architecture choice nobody's questioning.

## The waste behind the dollar number

The $400 million is the visible part. The real waste is structural:

- **Datacenter buildout** is racing AI demand and getting blamed for grid pressure across the US, Ireland, Singapore, and northern Europe. Every gigabyte of JSON envelope that doesn't need to ship is a gigabyte of network capacity that doesn't need to exist. Every GPU-second wasted on a doomed prompt is a GPU-second the next datacenter doesn't have to add.
- **Water consumption** in datacenter cooling is now a political issue in drought-stressed regions. The watts saved on the wire and middleware translate directly into the cooling load that didn't need to happen.
- **Materials** — copper, fiber, rare-earth magnets in network gear — get consumed building the infrastructure that ships envelopes. Less envelope, less infrastructure churn.
- **E-waste** from short server lifecycles in hyperscale datacenters. Lower utilization pressure = longer-lived equipment = less landfill.
- **Network congestion** — every kilobyte of JSON envelope competes with every other application on the shared internet. AI is eating the capacity budget for everything else.

None of this shows up on a cloud invoice. All of it is real.

The dollar number is what makes CFOs care. The waste behind it is what makes engineers, sustainability teams, regulators, and grid operators care. Both bills come due.

## The global market the industry is voluntarily excluding

The flawed architecture isn't just expensive. It actively prices billions of users out of the AI market entirely — and this is a **global** story, not a developing-world story.

Half the world is on **mobile-only metered connections** — including most of the Middle East, Southeast Asia, India, Latin America, and the rural fringes of Europe and North America. Mobile-only doesn't mean poor. It means the wire matters.

- **The Gulf states** — Saudi Arabia, UAE, Qatar, Bahrain, Oman — are mobile-dominant markets where 5G is widespread but international data bundles and roaming plans charge per-MB. JSON envelopes on regional or cross-border traffic add up fast.
- **Egypt, Morocco, Jordan, Turkey, Lebanon** — mobile-first populations of hundreds of millions where 1 GB of data isn't free and AI usage growth is constrained more by data costs than by interest.
- **Indonesia, Philippines, Vietnam, Pakistan, Bangladesh** — about 700 million people combined on prepaid mobile, all sensitive to per-byte costs.
- **Rural Australia, the Canadian north, the US Plains, Alaska, Siberia** — bandwidth-limited regardless of national wealth.
- **Anyone on a plane, a ship, a train, a hotspot, or in a basement office** — paying per-MB on Starlink, in-flight Wi-Fi, maritime satellite, mobile tethering.

Concrete numbers from the current JSON-SSE architecture:

- **Starlink Maritime ($10/GB)**: a 20-crew offshore vessel running AI tools pays ~$1,455/month *just for JSON envelopes* — $17,500/year per vessel.
- **Mobile data in the Gulf region (~$3–8/GB on international/roaming plans)**: an AI power-user racks up real costs from envelope overhead alone, even with cheap base-tier subscriptions.
- **2G or satellite-voice links (~256 Kbps)** — common in rural Saudi Arabia, central Asia, parts of Latin America: a JSON AI reply takes **15+ seconds** to physically arrive. Unusable.
- **Cheap Android phones (the global majority)**: parsing 485 KB JSON + re-tokenizing for each step burns enough battery that agent loops aren't practical.

This isn't 2.6 billion people the industry is "failing to serve." This is **the global majority of human internet users** structurally excluded from real AI adoption — not because the model couldn't help them, but because the **transport layer** prices them out before they ever reach it.

## And then there's everything that isn't a phone

The next part is the most under-discussed: there are entire categories of devices that **physically cannot fit a JSON-SSE AI conversation in their network budget**. Not "too expensive" — physically impossible. The AI industry has quietly written them off.

- **LoRaWAN sensors** — agricultural soil monitors, environmental stations, asset trackers, smart-meter endpoints — have a payload window of **11 to 242 bytes per uplink** and may transmit only a handful of times per day to preserve battery. A 485 KB JSON-SSE response is 2,000× too big to even attempt. A 291-byte Codec response **fits in a single packet**.
- **NB-IoT and LTE-M** devices — millions of them already deployed for utility metering, fleet telematics, healthcare wearables, industrial monitoring — operate on data budgets of a few hundred KB per *day* per device to keep batteries lasting years. JSON-SSE can fit roughly *half* of one AI response in that daily budget. Codec can fit thousands.
- **Sigfox** endpoints — 12 bytes per message, 140 messages/day per device, deployed across logistics and agriculture: Codec control-frame responses fit; JSON doesn't even start.
- **Satellite IoT networks** — Iridium SBD, Swarm, Astrocast — charge per-byte at rates that make JSON AI traffic economically nonsensical. Codec brings them inside the economics envelope.
- **Mesh networks** — Meshtastic, Helium, Reticulum, ad-hoc tactical mesh used in conservation, expedition, search-and-rescue, and disaster comms — operate at link rates of tens to hundreds of bps. AI was simply unavailable to them.
- **Industrial bus protocols** at the edge (Modbus, CAN, BACnet) bridged through gateways with tight bandwidth budgets — Codec frames can ride the gateway's small uplink window where JSON envelopes can't.

What this opens up:

- **Smart agriculture** — soil sensors that send AI-derived irrigation or fertilization recommendations on a daily uplink budget that was previously enough only for raw telemetry.
- **Wildlife conservation** — anti-poaching collars and trail cameras with on-the-fly AI-assisted classification and alerting, where the satellite link previously allowed only timestamp + GPS.
- **Cold-chain logistics** — pharma and food shipments with AI-driven anomaly alerts on routes that previously had to wait for port arrival to upload data.
- **Disaster response and field medicine** — degraded-network environments where AI triage and translation can now ride the small comms budget that was previously voice-only.
- **Pipeline, grid, and remote infrastructure monitoring** — AI-assisted predictive maintenance at sites where the connection has always been the limiting factor.
- **Maritime, aviation, and expedition telemetry** — small AI-derived advisories travelling on the satellite link that previously could only carry position pings.
- **Smart-city endpoints** — parking, lighting, water, waste — adaptive AI behaviour on the same NB-IoT links they already use.

These are **massive markets that the industry has been treating as out of scope** because the architecture made them out of scope. They're not out of scope for AI capability. They're out of scope for JSON envelopes.

## The fix is small and looks nothing like a revolution

Here's the part that should bother every AI product team: **the fix is trivial**. It's not "build bigger datacenters." It's not "wait for 6G." It's not "compress harder." It's not blockchain or peer-to-peer or any of the buzzword-laden "decentralization" pitches.

It's just: **stop doing every conversion at the centralized cloud. Push trivial work to the edge.**

A Codec-aware client (a browser, a mobile app, an agent runtime, an embedded device) does three small things the centralized cloud no longer needs to do:

1. **Holds a token dictionary locally** — a few hundred KB on a phone, even smaller compact subsets viable on microcontrollers. Means token IDs can flow over the wire without conversion at every hop.
2. **Does basic safety/format checks before shipping a prompt** — catches the ~10% of doomed prompts that the centralized cloud would have caught later, after burning a full GPU pass.
3. **Speaks a tiny binary frame format** instead of JSON-SSE — same content, none of the envelope.

None of this is hard. None of it requires new ML capability. None of it changes what the model does. It's just **redistribution of trivial work from one centralized loop to the edges that were going to handle bytes anyway**.

And the result of that small redistribution:

- **Up to 1,700× less data on the wire** for the same response
- **Up to 10× faster** AI responses on mobile connections
- **Up to 165× less non-GPU energy** per response
- **Cloud bills shrink by hundreds of millions** across the industry
- **Datacenter and grid pressure ease** because the bytes that don't ship are bytes that don't need switching, cooling, or backup
- **The accessibility ceiling lifts globally** — AI suddenly works on Gulf-region roaming, $0.20/GB Indian prepaid, $50 Android phones, Starlink Maritime, rural Australian hotspots, in-flight Wi-Fi
- **Entire device categories come online** — LoRaWAN sensors, NB-IoT meters, Sigfox endpoints, satellite-IoT trackers, mesh-network nodes — all viable AI clients for the first time

Decentralizing **just a little** — moving a few KB of dictionary and a few lines of safety code from the cloud to the client — unlocks all of it.

## Why isn't this happening already

It isn't happening because the centralized JSON architecture is the **default**, and defaults are sticky. Every AI product gets built on top of someone else's gateway, which uses JSON because the upstream provider uses JSON, which uses JSON because every framework expects JSON, which expects JSON because that's how the first generation of AI APIs shipped in 2022.

Each individual provider keeps doing what worked yesterday because none of them are individually paying the full bill of the architecture. They each pay their slice. The aggregate $400M/yr waste, the datacenter capacity pressure, the locked-out global mobile-first majority, and the entire IoT/edge market category are everyone's problem and therefore no one's problem.

An open protocol called **Codec** (codecai.net) is the small structural change that fixes all of it. Six client libraries (TypeScript, Python, Rust, Java, .NET, C — including a C99 library small enough for microcontrollers) plug into existing AI servers (sglang, vLLM, llama.cpp) with no code rewrite. Same model. Same prompts. Same answers. Different transport. Different defaults. Different economics. Different addressable market — by orders of magnitude.

## The honest pitch

This isn't a story about a clever protocol. It's a story about an industry running on an architecture decision that made sense for one moment in 2022 and stopped making sense around 2024 — but nobody noticed because nobody benchmarks the architecture, only the model.

We can't make AI models smaller. We can't make GPUs cheaper. We can't make datacenters greener overnight.

But we **can** stop pretending the cloud has to be the only place where work happens. We can push a tiny amount of intelligence to the edge. And by doing that, we can recover hundreds of millions of dollars a year, dramatically shrink AI's network and grid footprint, open the door for the global mobile-first majority who currently can't afford or can't physically use AI at JSON-SSE scale, and bring AI to billions of low-power devices that have never had access to it.

Decentralizing just a little saves a lot — money, watts, water, copper, the next several billion humans, and the trillion sensors and embedded systems we haven't even started counting.

If you're building AI products, running AI infrastructure, working on sustainability and grid policy, building IoT or edge devices, or thinking about where AI's real addressable market sits: the full benchmarks, cost analysis, energy breakdowns, and per-region accessibility tables are at **[codecai.net](https://codecai.net)**.

The protocol is open. The implementations are real. The numbers are measured.

The architecture is the bottleneck. And it's the cheapest part of the stack to fix.

# The AI Industry Is Burning $400 Million A Year On Bytes The AI Never Reads

### Cloud bills, datacenter power, mobile bandwidth, satellite minutes, and an entire billion-user market: all paying for envelopes the model never opens. The fix is small. We just have to notice the bill.

---

There's a quiet, expensive, environmentally costly thing happening every time anyone uses AI today.

It costs the industry **more than $400 million a year** in direct cloud, network, and compute fees. It contributes to **datacenter buildout, grid pressure, and water usage** in regions already running short of all three. It locks **billions of potential users** out of AI access for reasons that have nothing to do with the model and everything to do with the wire. And it puts AI **out of reach for entire categories of low-power devices**: IoT sensors, satellite endpoints, mesh networks: that physically can't fit current AI traffic.

All of it traces back to a single architecture decision made in 2022, when AI was new and nobody was paying attention to the bill.

The decision is still in force. The bill is real. And almost nobody is looking at it.

## The conversion that nobody asked for

The AI model thinks in **tokens**: small numerical codes. It generates responses as streams of these numbers. Fast, dense, efficient. That's what the model produces and that's what any downstream model would prefer to consume.

But before the response reaches you, the cloud does something wasteful: it converts those numbers into text, wraps the text in **JSON envelopes** (the standard web packaging format), and ships the whole thing to your browser. Your browser unwraps it. If the answer feeds into another AI step: a tool call, a sub-agent, an aggregator, a chain: somebody re-converts the text back into numbers. And again at the next hop. And again at every gateway, tool, and agent handoff in the loop.

A typical modern AI request makes about **eight wire round-trips** before the user sees the answer: model emit, agent-to-agent handoff, tool call, tool result, sub-agent dispatch, synthesis, response, render. Every single one of those round-trips does the same conversion ritual: **numbers → text → JSON → ship → JSON → text → numbers**.

And the request side of every round-trip carries its own envelope too: 5 to 50 KB of system prompt, history, tool schemas, all serialized at the client, parsed and re-tokenized at the gateway, re-parsed at the server. **The bidirectional, multi-round-trip reality of a single AI request is about 4 megabytes of JSON moving across the wire, in both directions, every time someone asks an AI a question.**

The model never reads any of it. The model is downstream of the conversions. The AI is the *consumer* of token IDs alone.

## What the bill looks like

Across the AI industry today: **about 5 billion conversational AI requests per day** (one-third of all Google search traffic, per public estimates from OpenAI, Anthropic, and Google): the JSON-envelope architecture burns:

- **~$320 million/year** in cloud bandwidth fees at the heavy-agent baseline that Claude, ChatGPT, and Gemini actually run today (per-platform: Claude ~$56M/yr, ChatGPT ~$160M/yr, Gemini ~$36M/yr)
- **~$50 to 100 million/year** in GPU compute spent on doomed prompts (broken syntax, policy violations, malformed inputs) that should never have left the client
- **~$150 million+/year** in Starlink bandwidth alone, on the metered tiers (Roam, Mobile Priority, Maritime)

**Total: ~$400 to 700 million/year**, depending on agent-topology depth, going up the chimney with nothing to show for it.

At the 2030 AI volume most analysts project (~10× today), this becomes **~$4 to 7 billion/year of waste**: locked in by the same architecture decision, in perpetuity.

## The waste behind the dollar number

The $400 million is the visible part. The deeper waste is structural: and not on any cloud invoice:

- **Datacenter buildout** is racing AI demand and getting blamed for grid pressure across the US, Ireland, Singapore, and northern Europe. Every gigabyte of JSON envelope that doesn't need to ship is a gigabyte of network capacity that doesn't need to exist. Every GPU-second wasted on a doomed prompt is a GPU-second the next datacenter doesn't have to add.
- **Water consumption** in datacenter cooling is now a political issue in drought-stressed regions. Watts saved on the wire and middleware translate directly into cooling load that didn't need to happen.
- **Materials**: copper, fiber, rare-earth magnets in network gear: get consumed building the infrastructure that ships envelopes. Less envelope, less infrastructure churn.
- **E-waste** from short server lifecycles in hyperscale datacenters. Lower utilization pressure = longer-lived equipment = less landfill.
- **Network congestion**: every kilobyte of JSON envelope competes with every other application on the shared internet. AI is eating the capacity budget for everything else.

The dollar number is what makes CFOs care. The waste behind it is what makes engineers, sustainability teams, regulators, and grid operators care. Both bills come due.

## The market the industry is voluntarily excluding

The flawed architecture isn't just expensive: it actively prices billions of users out of AI entirely. And this is a **global** story that reaches well past the developing world.

Half the world is on **mobile-only metered connections**: most of the Middle East, Southeast Asia, India, Latin America, and the rural fringes of Europe and North America. Mobile-only doesn't mean poor. It means the wire matters.

At the heavy-agent baseline: ~4 MB of JSON moving per AI request: the per-request data cost is what shows up on a metered customer's bill:

| Region / connection | $/GB | Cost per AI request |
|---|---|---|
| US, postpaid mobile (add'l data) | ~$10 | **$0.040** |
| India, prepaid mobile | ~$0.20 | $0.0008 |
| Sub-Saharan Africa average | ~$2 to 5 | $0.008 to 0.020 |
| Starlink Roam (add'l data) | ~$2 | $0.008 |
| Starlink Maritime Mobile Priority | ~$10 | **$0.040** |
| Iridium satellite (legacy maritime) | ~$5 to 15/MB | **$20 to 60** |

Bottom row: at Iridium maritime rates, a single agentic AI request currently bills **$20 to 60 just for envelopes**. The same answer on a tokens-native wire bills under 4 cents. That's not a small efficiency win: it's the difference between "AI on this connection" and "AI is impossible on this connection."

And the wall-clock at low bandwidths is even more decisive:

| Link | JSON-SSE per request | Tokens-native per request |
|---|---|---|
| Mobile 4G: 10 Mbps | ~3.5 seconds | ~0.4 seconds |
| Edge / weak mobile: 1 Mbps | ~32 seconds | ~0.4 seconds |
| 2G / satellite-voice: 256 Kbps | **~2 minutes** | ~0.5 seconds |

JSON-SSE on a 1 Mbps edge link takes **half a minute per agentic AI request**. On a 256 Kbps satellite link, **2 minutes**. Unusable. The same workload on a binary token-stream wire stays under half a second on every connection.

The lockout falls on:

- **The Gulf states**: Saudi Arabia, UAE, Qatar, Bahrain, Oman: where 5G is everywhere but international and roaming plans charge per-MB
- **Egypt, Morocco, Jordan, Turkey, Lebanon**: mobile-first populations of hundreds of millions sensitive to data costs
- **Indonesia, Philippines, Vietnam, Pakistan, Bangladesh**: about 700 million people on prepaid mobile
- **Rural Australia, the Canadian north, the US Plains, Alaska, Siberia**: bandwidth-limited regardless of national wealth
- **Anyone on a plane, ship, train, hotspot, or in a basement office**: paying per-MB on Starlink, in-flight Wi-Fi, maritime satellite, mobile tethering

This isn't 2.6 billion people the industry is "failing to serve." This is **the global majority of human internet users** structurally excluded from real AI adoption, priced out by the **transport layer** before they ever reach it. The model was never the obstacle.

## And then there's everything that isn't a phone

The next part is the most under-discussed: there are entire categories of devices that **physically cannot fit a JSON-SSE AI conversation in their network budget**. Not "too expensive": physically impossible. The AI industry has quietly written them off.

- **LoRaWAN sensors**: agricultural soil monitors, environmental stations, asset trackers, smart-meter endpoints: have a payload window of **11 to 242 bytes per uplink** and may transmit only a handful of times per day to preserve battery. A 4 MB per-request JSON-SSE conversation is roughly 20,000× too big to even attempt. A binary token-stream response **fits in one or two packets**.
- **NB-IoT and LTE-M** devices: millions deployed for utility metering, fleet telematics, healthcare wearables, industrial monitoring: operate on data budgets of a few hundred KB per *day* per device to keep batteries lasting years. JSON-SSE at heavy-agent scale can't fit *one* AI request in the daily budget. A binary token wire can fit hundreds.
- **Sigfox**: 12 bytes per message, 140 messages/day per device: binary control-frame responses fit; JSON doesn't even start.
- **Satellite IoT**: Iridium SBD, Swarm, Astrocast: charges per-byte at rates that make JSON AI traffic economically nonsensical.
- **Mesh networks**: Meshtastic, Helium, Reticulum, tactical mesh used in conservation, expedition, search-and-rescue, disaster comms: operate at link rates of tens to hundreds of bps. AI was simply unavailable to them.
- **Industrial bus protocols** at the edge (Modbus, CAN, BACnet) bridged through gateways with tight bandwidth budgets: binary frames can ride the gateway's small uplink window where JSON envelopes can't.

What this opens up:

- **Smart agriculture**: soil sensors that send AI-derived irrigation or fertilization recommendations on a daily uplink budget that previously fit only raw telemetry.
- **Wildlife conservation**: anti-poaching collars and trail cameras with on-the-fly AI-assisted classification, where the satellite link previously allowed only timestamp + GPS.
- **Cold-chain logistics**: pharma and food shipments with AI-driven anomaly alerts en route, well before port arrival.
- **Disaster response and field medicine**: degraded-network environments where AI triage and translation can now ride the small comms budget that was previously voice-only.
- **Pipeline, grid, and remote infrastructure monitoring**: AI-assisted predictive maintenance where the connection has always been the limiting factor.
- **Maritime, aviation, and expedition telemetry**: AI advisories on the same satellite link that previously could only carry position pings.
- **Smart-city endpoints**: parking, lighting, water, waste: adaptive AI behaviour on the same NB-IoT links they already use.

These are **massive markets the industry has treated as out of scope** because the architecture made them out of scope. They're not out of scope for AI capability. They're out of scope for JSON envelopes.

## The fix is small

The fix is not "build bigger datacenters." It's not "wait for 6G." It's not "compress harder." It's not blockchain, peer-to-peer, or any of the buzzword-laden "decentralization" pitches.

It's just: **stop doing every conversion at the cloud. Move a tiny amount of trivial work to the edge.**

A client that speaks the model's native token-ID wire format does three small things the cloud no longer needs to do:

1. **Holds a token dictionary locally**: a few hundred KB on a phone, smaller subsets viable on microcontrollers. Token IDs can flow over the wire without conversion at every hop.
2. **Does basic safety / format checks before shipping a prompt**: catches the ~10% of doomed prompts that the cloud would have caught later, after burning a full GPU pass.
3. **Speaks a tiny binary frame format** in place of JSON-SSE: same content, none of the envelope.

None of this is hard. None of it requires new ML capability. None of it changes what the model does. It's just **moving trivial work from one centralized loop to the edges that were going to handle bytes anyway**.

And the result of that small shift:

- **Up to 1,700× less data per round-trip**, compounded across the 8 round-trips a real AI request makes (~4 MB JSON → ~2.4 KB on a tokens-native wire per AI request)
- **Wall-clock collapses on slow links**: ~3.5 s → ~0.4 s on mobile 4G; ~32 s → ~0.4 s on 1 Mbps edge; ~2 minutes → ~0.5 s on satellite voice links
- **Cloud bills shrink by $300 to 700 million/year** across the industry
- **GPU compute on doomed prompts disappears**: ~$50 to 100M/year recovered by catching ~10% of bad inputs client-side, ahead of a full GPU pass
- **Datacenter and grid pressure ease**: bytes that don't ship don't need switching, cooling, or backup
- **The accessibility ceiling lifts globally**: AI works on Gulf-region roaming, $0.20/GB Indian prepaid, $50 Android phones, Starlink Maritime, rural Australian hotspots, in-flight Wi-Fi
- **Entire device categories come online**: LoRaWAN sensors, NB-IoT meters, Sigfox endpoints, satellite-IoT trackers, mesh-network nodes: all viable AI clients for the first time

## Why isn't this happening already

It isn't happening because the centralized JSON architecture is the **default**. Defaults are sticky. Every AI product gets built on top of someone else's gateway. That gateway uses JSON because the upstream provider uses JSON. The upstream provider uses JSON because every framework expects JSON. Every framework expects JSON because that's how the first generation of AI APIs shipped in 2022.

Each individual provider keeps doing what worked yesterday because none of them are individually paying the full bill. They each pay their slice. The aggregate $400 to 700M/yr waste, the datacenter capacity pressure, the locked-out global majority, and the trillion-sensor device market are everyone's problem and therefore no one's problem.

An open protocol called **Codec** ([codecai.net](https://codecai.net)) is the small structural change. Six client libraries (TypeScript, Python, Rust, Java, .NET, C: the C99 library is small enough for microcontrollers) plug into existing AI servers (sglang, vLLM, llama.cpp) with no code rewrite. Same model. Same prompts. Same answers. Different transport. Different defaults. Different economics. Different addressable market.

## The honest pitch

This isn't a story about a clever protocol. It's a story about an industry running on an architecture decision that made sense for one moment in 2022 and stopped making sense around 2024: but nobody noticed because nobody benchmarks the architecture, only the model.

We can't make AI models smaller. We can't make GPUs cheaper. We can't make datacenters greener overnight.

But we **can** stop pretending the cloud has to be the only place where work happens. We can stop shipping envelopes the AI never reads. We can stop spending hundreds of millions of dollars, megawatt-hours of electricity, megalitres of cooling water, and the AI access of the global mobile-first majority on overhead nobody benefits from.

We can stop burning what we're burning.

If you're building AI products, running AI infrastructure, working on sustainability or grid policy, building IoT or edge devices, or thinking about where AI's real addressable market sits: the full benchmarks, cost analysis, energy breakdowns, and per-region accessibility tables are at **[codecai.net](https://codecai.net)**.

The protocol is open. The implementations are real. The numbers are measured.

The architecture is the bottleneck. And it's the cheapest part of the stack to fix.

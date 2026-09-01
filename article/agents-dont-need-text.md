# Agents Don't Need Text

In an earlier article I argued that AI APIs ship text over the wire when text is not what the model actually uses. That piece focused on the bytes-per-token math: a model emits a 17-bit integer, the wire carries 150-190 bytes, and the only reader at the other end is usually another model that will translate the text right back into integers it never needed.

The wire reduction is the easy claim. It's measurable, the numbers are large, and the energy implications follow straightforwardly from "stop shipping a stack of envelopes when the contents don't need them."

But there's a second-order claim that I want to argue separately. It's where the agent era actually changes the cost structure. **Once token IDs stay token IDs end-to-end, certain operations that used to require infrastructure stop requiring it.** Not "get faster." Stop existing as expense lines. The text round-trip wasn't just a wire tax. It was the precondition for an entire class of work that disappears when the layers get drawn right.

Two operations make the case concretely.

## Tool calls

Every chat-tuned model in production today emits tool calls the same way: a special-token marker that delimits a JSON region. Qwen 2.5 uses `<tool_call>` and `</tool_call>`. Llama 3.1+ uses `<|python_tag|>` and `<|eom_id|>`. DeepSeek-R1 uses `<think>` and `</think>` for reasoning blocks. Those behave the same way. Phi-4, Mistral-Nemo, DeepSeek-V3: every family has its own delimiter pair. They all do the same thing: bracket a JSON-shaped region with a single token at each end.

Single tokens. Single uint32 values, in the model's native vocabulary.

Now consider what happens in the current API design when an orchestrator wants to detect that a tool call is happening. The model emits the marker. The server tokenizer converts the marker's ID to its UTF-8 representation. The string is wrapped in JSON. JSON is shipped over HTTPS. The orchestrator parses the JSON, extracts the string, and runs a substring match against `<tool_call>` (or whatever marker it expects). Substring matches against streaming text are fiddly because tokens don't align to character boundaries; orchestrators end up buffering text across frames, scanning with regex, and dispatching on hits.

The whole thing is built to work around the fact that what arrived was text. The model didn't emit text. It emitted an integer. The integer was distinct. The detection should have been one comparison.

In the layered version, it is. Every Codec client ships a `ToolWatcher` that resolves the start/end marker names to their integer IDs once at construction, then runs a state machine over the wire stream that does exactly this:

```
for each token id in the stream:
    if id == start_marker_id: enter region
    elif id == end_marker_id: exit region; emit the buffered body
    else: forward (or buffer)
```

That's the entire algorithm. No detokenization. No vocab lookup. No string allocation. No regex. The hot loop is a compare against two cached uint32s and an occasional memcpy into a buffer that holds the region body for downstream JSON parsing: and even that only happens when the orchestrator actually needs to dispatch a tool call. Pure routing (forward A's tokens to B without inspection) has zero work per token beyond the compares.

I benchmarked the C implementation against the same client's detokenizer running over the same stream. The watcher runs at about 1.6 billion tokens per second on one core. The detokenizer runs at about 16 million. That's not a tweak. That's two orders of magnitude. The watcher is so much cheaper than detokenize that a sufficiently sophisticated orchestrator can run it on every frame of every stream without measurably affecting throughput.

The interesting part isn't the speedup. The interesting part is what stops being necessary because of it.

Today, "did this stream contain a tool call" is a question that requires the orchestrator to be aware of every token that goes by. That awareness has a cost: the detokenize pass, the regex scan, the buffering: and the cost is paid whether or not a tool call is actually present. So orchestrators add infrastructure: detection workers, message queues, pre-parse caches, sometimes dedicated services that exist just to watch for marker text. The question is expensive enough that you build a thing.

Once the question is a uint32 compare, you don't build a thing. You inline it in the read loop next to the network read. The infrastructure that used to be necessary is no longer necessary. The expense line that justified its existence isn't justified anymore.

This is the pattern that matters. Cheap operations don't need infrastructure. Expensive operations do. Eliminating the text round-trip moves a whole category of orchestration work across that boundary.

## Machine-to-machine translation

The other operation worth examining is what happens when agent A's output flows into agent B as a prompt and the two models use different vocabularies.

Today the pipeline is:

1. Agent A's model emits token IDs in its vocab V_A.
2. Server-side tokenizer converts them to UTF-8.
3. UTF-8 is wrapped in JSON, shipped over HTTPS to the orchestrator.
4. The orchestrator parses the JSON, extracts the text, and forwards it to agent B's API as the next prompt.
5. JSON-wraps the text, ships over HTTPS to agent B's server.
6. Agent B's server-side tokenizer converts the text back to integer IDs in V_B.
7. Agent B's model consumes the IDs.

Steps 2-6 exist for nobody. There is no human anywhere in this pipeline. Both endpoints are models. Both endpoints speak integers natively. The text intermediate that survives every hop is decoded and re-encoded and re-decoded purely because the API contract was designed for a human reader who was never going to be there.

The text wasn't a transport-layer requirement. It was a presentation-layer requirement that leaked into the transport layer because the layers weren't separated. Once they are, you get a different shape:

1. Agent A's IDs ship over the wire as binary frames in V_A.
2. The orchestrator runs a local `Translator(V_A, V_B)` that pipes the IDs through a detokenizer for V_A and a tokenizer for V_B in-process.
3. Agent B's input ships as binary frames in V_B.

The text intermediate still exists at step 2: there's no algebraic shortcut from one BPE vocabulary to another, the merges depend on the exact string boundaries: but it exists *only inside the orchestrator's address space*. It never enters a wire frame. It never gets serialized to JSON. It never crosses a network. It exists for microseconds in a buffer between two function calls.

That's the move. The text didn't need to disappear. It just needed to stop being something the network deals with.

What this enables is the part most agent infrastructure people care about: orchestrators that fan out to heterogeneous models with the same wire contract everywhere. A router that sends Qwen's output to Llama's input and Llama's output to GPT's input doesn't pay six text round-trips per hop. It pays zero. The wire is binary. The translation is local. Everything that used to be a network-cost decision (which models can I afford to chain together?) becomes a CPU-cost decision (do I have a few microseconds per token to spare?). The answer is always yes.

The streaming case is where this gets specifically interesting. BPE merges depend on context: re-tokenizing a half-word produces different IDs than re-tokenizing the complete word later. Naive translators that just decode-then-encode each frame as it arrives will quietly produce wrong output at word boundaries. The Translator handles this by buffering text at whitespace boundaries, since pre-tokenizers always split there, then flushing complete words through the BPE merge step. The result is bit-identical to what you'd get from one-shot translation of the entire output, but it streams as the model produces tokens.

Round-trip: take a sentence, tokenize it through Qwen, translate the IDs through the Translator into Llama's vocab, detokenize Llama's IDs back to text, compare. The output text equals the input text. We verify this on every test run, on real production tokenizers (Qwen-2 152K vocab, Llama-3 128K vocab), on every client implementation.

## What's specifically agentic about this

Both of these examples: tool detection and cross-vocab handoff: exist as expensive infrastructure problems for the same reason: agent workloads send AI output to AI input. The presentation layer was sized for the human-in-the-loop case, where rendering text on a screen was the actual point. Agent workloads inherit that sizing without inheriting the requirement.

It's worth being precise about why this is an AI-specific opportunity. Most network protocols transit *opaque payloads*. The transport doesn't know what's inside; it carries bytes from one address to another. The text-layer waste in HTTP is purely JSON envelope overhead.

AI APIs are different. The payload IS structured by the model into discrete units that the model itself produces and consumes. Tokens are the *internal data type of the system*. They are not opaque to the endpoints; they are the only thing the endpoints actually understand. The tokenizer at the API boundary is a pure adapter: it exists to translate between the system's native data type and the human-facing one. When neither endpoint is human, the adapter is doing zero useful work, every time.

This is the move that the AI stack has not yet made and that older mature protocol stacks made decades ago: separate the *transport* layer from the *presentation* layer. Don't run the presentation layer when nobody needs the presentation. Token IDs over the wire isn't a new thing protocol designers have to invent. It's the obvious choice in any system where the payload has internal structure that both endpoints share. We just haven't drawn the boundary correctly yet because the agent era is new enough that the human-API contract is still the default.

Once you draw the boundary correctly, the operations follow. Tool detection is a uint32 compare. Cross-vocab translation is two function calls in process memory. The streaming wire is half a millisecond per kilotoken. Each of those, taken alone, is a 10-50× improvement on the current state. Composed across an agent pipeline that runs millions of these operations per minute, the difference is structural.

## What this looks like at scale

The largest consumers of AI APIs are no longer chatbots. They're pipelines: RAG systems doing retrieval and generation, copilots running tool-use loops, multi-agent orchestrators handing context between specialist models, code-generation agents calling executors and reading their output. The traffic shape has flipped. Human-readable text on the wire used to be the common case. It is becoming the special case.

Every text round-trip in an agent pipeline currently pays a tax that has nothing to do with what the agents are computing. The tax is invariant: it doesn't shrink when the workload gets bigger or the model gets smarter. It's a fixed multiplier on every operation. As inference traffic compounds, the tax compounds with it.

The fix isn't a faster model. It isn't a smarter routing algorithm. It isn't more datacenters. It's drawing the layer boundary in the right place. The presentation layer for the human reader stays exactly as it is: when a human is actually going to read the output, you detokenize at the edge, the same as today. The transport layer for everything else stops doing presentation work that nobody asked for.

This is the move agents have been waiting for, whether the people building them know it or not. Tool calls become free to detect. Cross-vocab handoff becomes free to perform. The orchestrator stops being a translation pipeline and starts being a routing fabric. That's what it should have been all along.

The protocol changes are small. The implementation changes are smaller. The implications, if you take them seriously, are large.

The AI economy is being built on top of an API contract designed for a different audience. The audience changed. The contract should change with it.

# Text Is the Wrong Wire Format for AI

In an [earlier article](https://www.linkedin.com/pulse/we-stopped-teaching-one-expressive-skill-replaced-throttled-dunn-41vfe/) I argued that we are sending children into an AI-shaped world equipped with a typing layout designed in the 1870s to keep mechanical typewriters from jamming. The transmission medium between human and machine is throttled by an accident of history. We have not stopped to ask whether the accident still serves us.

This article is the other side of that argument. The human-to-machine medium is throttled, yes. But so is the wire that carries every conversation between a client and a model, no matter what the client is. The reason is the same kind: an early decision about how AI systems should expose themselves to the world, made when humans were the only callers, has never been revisited.

We are shipping text over the wire when text is not what the model actually uses.

## What is actually happening when you talk to an AI

Watch a ChatGPT response stream into your browser. Characters appear one at a time, as if the model is typing them. The animation is satisfying. It is also a lie about what the model is doing.

The model does not emit characters. It emits **tokens**. Those are integer IDs drawn from a fixed vocabulary of around 100,000 entries. A token might represent a whole word like "the," a word fragment like "ography," a single character like "q," or a common phrase like " of the." Every token has a numeric ID. Internally, the model produces and consumes those IDs natively. They are roughly 17 bits each.

What happens between the model and your browser is this:

1. The model emits a token ID.
2. The server-side tokenizer converts that ID to a UTF-8 string fragment.
3. The fragment is wrapped in a JSON envelope.
4. The JSON is sent over an HTTP streaming protocol.
5. Your browser receives the JSON, extracts the string, and appends it to the DOM.
6. CSS animates it into view, character by character.

The model emitted one 17-bit number. Your browser received something on the order of 50 to 100 bytes per token, depending on framing overhead. The character-by-character animation is happening at the rendering layer, after the text has already been transmitted in bulk. The streaming visual is decorative. The waste is upstream.

This is the same pattern the stenography article was about, in reverse. Stenographers compress at the transmission layer because their reader is themselves. They decompress at the display layer for the eventual human reader who comes later. The current AI stack does the opposite. It decompresses *for* transmission, even when the only reader at the other end is another machine that will immediately recompress what it receives.

## Three jobs, one format

Text is currently doing three jobs in the AI stack. It is the format the model conceptually consumes (after tokenization). It is the format that ships over the wire. And it is the format humans read on their screens.

Text is good at exactly one of those jobs. The other two are accidents of API design.

The model's native format is token IDs. Forcing them into UTF-8 at every boundary is a translation step that exists for nobody. The wire's natural format is bytes, framed efficiently. UTF-8 inside JSON inside HTTPS is a stack of envelopes, each carrying overhead, each demanding a parser at the other end. The human's natural format is rendered text. They do not care whether what crossed the wire was a token ID or a UTF-8 string. They care that their screen shows words.

Each of those three audiences wants something different. The current architecture serves all three with the same format and serves the model and the wire badly to do it.

## What the layered version looks like

The fix is the same fix mature protocol stacks have always landed on: separate the layers so each can do its one job well.

**Model layer.** Operates on token IDs natively, as it already does. Nothing changes here.

**Transport layer.** Ships token IDs over the wire as binary. No UTF-8 round-trip, no JSON envelope wrapping text that no human will read. The protocol declares its tokenizer at session start, the way HTTP declares its content-encoding. From there the wire is pure token IDs in an efficient framing.

**Presentation layer.** Lives client-side. A tokenizer map that decodes token IDs to displayable characters at the moment of display, only when a human is actually going to read the result. For machine-to-machine communication, this layer is never invoked.

The result is that text becomes purely a *render target*, no longer a *transport format*. The same architectural move browsers made when they stopped treating HTML as the only thing that crossed the wire and let CSS, JSON, binary protocols, and image formats each travel in their natural shape.

## "But every vendor has their own tokenizer"

This is the objection that gets raised first. It has a clean answer. The same answer the rest of the industry landed on decades ago for an essentially identical problem.

The web did not unify on a single character encoding. It unified on a protocol for *declaring which encoding is in use*. A page declares `Content-Type: text/html; charset=UTF-8`. The browser reads the declaration, loads the appropriate decoder, renders the bytes. Latin-1 pages still work. Shift-JIS pages still work. The encoding stayed vendor- and locale-specific. The contract did not have to.

Tokenizer vocabularies are the same kind of problem. GPT-4o's tokenizer is not Claude's is not Llama's. The vocabularies are tied to model weights. Unifying them would require retraining every frontier model on earth. They will never be unified. That is fine. The vocabularies don't need to be unified. The *contract* for declaring and fetching them does.

This is just the contract pattern from the documentation series, applied to a different layer of the stack. The contract specifies the shape: how a tokenizer map is structured, how it is declared at session start, how it is versioned, how byte-fallback tokens are marked, how special tokens (end-of-stream, system markers) are handled. Each vendor publishes a map that honors the contract. Each client knows how to load any compliant map. Vocabularies vary. The protocol does not.

A client that talks to three model vendors loads three maps, the same way a media player loads three codecs. Cached after first fetch. Versioned with the model. Updated when the model updates. This is solved territory.

## What about subwords

Subword tokens are the second concern engineers raise. They are not actually a problem. They are how the current system already works.

When the model emits the word "stenography," it might ship three tokens: `sten`, `ography`, and a leading space marker. The client receives three IDs, looks each one up in the map, and concatenates the resulting fragments. "Stenography" appears on screen.

That concatenation is happening today. It is happening server-side, after which the concatenated text is shipped over the wire as UTF-8. The proposal moves the concatenation to the client. It skips the step entirely when no client is going to render the result. The work isn't new. It just stops happening in places where nobody benefits from it.

The two real edge cases the contract has to specify are byte-fallback (when the model emits raw UTF-8 bytes for characters outside its vocabulary) and partial-sequence handling during streaming (don't render half an emoji). Both are solved problems in every existing text decoder. Neither is specific to AI.

## Where the waste compounds: agents calling agents

Once the client-to-model path is layered correctly, a particularly wasteful pattern in modern AI deployments stops being a separate problem. It just disappears.

Two AI agents talking to each other today are doing this:

1. Agent A's model emits token IDs.
2. Server-side tokenizer converts to UTF-8.
3. UTF-8 wrapped in JSON, shipped over HTTPS.
4. Agent B's API receives JSON, extracts UTF-8.
5. Agent B's tokenizer converts back to token IDs.
6. Agent B's model consumes the IDs.

Steps 2 through 5 exist for an audience of zero. No human reads the intermediate text. Both ends are models. Both ends speak token IDs natively. The text that crossed the wire was decoded and re-encoded for nobody.

In the layered version, steps 2 through 5 simply do not happen. Agent A ships token IDs. Agent B receives token IDs. If the two models use different vocabularies, the protocol handles translation the same way any cross-codec system does, declared maps, known transformations, no detour through a human-readable intermediate.

This is not a separate proposal. It is what falls out of doing the human-facing version correctly. Once the presentation layer is decoupled from the transport layer, the presentation layer is simply not invoked when no presentation is required. Agent-to-agent traffic skips the layer that exists for humans, automatically. There is no human in the call.

This case matters because it's growing. The largest consumers of AI APIs are no longer humans typing into chat windows. They are pipelines, orchestrators, and agents calling other agents at scale. The text round-trip that was a small inefficiency for a single human conversation becomes a structural tax on every multi-step agent workflow in production.

## What this would actually take

The honest list of work, with no padding:

A protocol specification for the tokenizer-map contract. Roughly the size of a small RFC. Defines map structure, declaration at session start, versioning, byte-fallback marking, special-token semantics, streaming framing.

A wire format for token IDs. Probably a binary framing on top of HTTP/2 or QUIC. Existing protocols (gRPC, MessagePack, CBOR) already do binary framing well; this is choosing among them rather than inventing something new.

Tooling for human-readable inspection. A Wireshark equivalent that decodes a captured token stream into text using the declared map. Logging, debugging, and audit systems all currently assume text; they will need to learn to decode tokens for human eyes the same way network tools learned to decode binary protocols decades ago.

A migration path. Text APIs do not go away. They coexist with the token-native protocol the way HTTP/1.1 coexists with HTTP/2. Clients that want efficiency opt in. Clients that want simplicity stay on text.

None of this is research. It is engineering. The pieces exist. The work is assembly and agreement.

## Why it hasn't happened

The text API was a reasonable default when it was designed. Humans were the only callers. Curl and Postman were the debugging tools. Logs needed to be greppable. Every decision pointed at text.

The assumptions that justified that default have weakened. The API surface hasn't moved with them. The cost of the current design is invisible to the people paying it. Nobody sees the bytes on the wire. Nobody sees the detokenization-retokenization round-trips. The cost is hidden in latency budgets, bandwidth bills, datacenter power draw, and inference compute that is doing work that would not exist if the layers were drawn correctly. Invisible costs are the hardest kind to fix: no single team owns them and no single quarter's metrics show them. They show up instead in the aggregate, in the megawatts and the water and the grid capacity, places where the bill arrives years later and lands on people who never made the decision.

## What this is really about

The pattern across both this article and the stenography piece is the same.

Stenographers learned to compress at the transmission layer because their transmission medium served them directly. They decompressed at display time, for the human who came later. That separation of layers, transmission for the writer, display for the reader, is what made stenography fast.

AI systems should do the same thing in reverse. The model is the writer. The wire serves the model. Display is for the human who comes later, when there is one. When there isn't, the display layer is simply not invoked.

This is not just an elegance argument. The industry is scaling AI inference at a rate that is already straining grids, water tables, and carbon budgets. Datacenters are being sited next to whatever power and cooling resources can be conscripted to feed them. The infrastructure required to keep up with current usage patterns is becoming a planetary-scale problem before the technology has finished arriving. Every layer of waste in that stack compounds at the rate the stack grows.

A protocol that eliminates a translation step on every API call, on every streaming token, on every agent-to-agent handoff, is not a marginal optimization at this scale. It is the difference between an inference economy that fits within sustainable resource constraints and one that doesn't. The current API surface was designed when AI was a small thing. It is no longer a small thing. Continuing to ship UTF-8 envelopes around token IDs, at the volume the industry is now operating at, is a decision to burn power and water for nothing, in service of an audience that mostly does not exist.

We do not need to teach models stenography. They already speak it. They speak it to themselves, internally, in token IDs. The proposal is just to stop forcing them to translate it into longhand at every API boundary, when most of the time the only reader at the other end is another model that will translate it right back.

The medium of professional life changed. The protocol layer hasn't caught up. And at the scale we are now running, "hasn't caught up" is no longer just an engineering complaint. It is a resource problem that compounds every quarter the industry chooses not to solve it.

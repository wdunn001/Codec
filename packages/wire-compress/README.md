# wire-compress

Pick the right `Content-Encoding` for streaming responses based on what the client supports and how big the payload is. Framework-agnostic, zero dependencies, ~5 KB.

The conventional advice is "always brotli for HTTP." That's right for static web assets. It's wrong for **streaming responses with bursty small frames** — SSE, Codec, gRPC-Web text, server-streamed JSON. Brotli's per-block overhead doesn't amortise across 10-25 byte frames, gzip and zstd do.

This library encodes that decision so you don't have to relitigate it per server.

## Install

```bash
npm install wire-compress
```

Works with any HTTP framework — Express, Fastify, Hono, Node's `http`, Bun, Deno, Cloudflare Workers. Pure functions, no middleware.

## Quick start

Server side — pick what to apply:

```ts
import { pick } from 'wire-compress';

app.get('/stream', (req, res) => {
  const choice = pick({
    acceptEncoding: req.headers['accept-encoding'],
    estimatedSize: 1024,                // tokens or bytes — your call
    interactive: true,                  // human reads as it streams (default)
  });
  if (choice.encoding !== 'identity') {
    res.setHeader('Content-Encoding', choice.encoding);
  }
  // ... apply the chosen compressor and stream
});
```

For agent-to-agent or batch traffic where TTFT doesn't matter, set `interactive: false` to unlock zstd's larger ratio.

Client side — build the request header:

```ts
import { buildAcceptEncoding } from 'wire-compress';

fetch('/stream', {
  headers: { 'Accept-Encoding': buildAcceptEncoding() },
  // → "zstd;q=1.0, gzip;q=0.9, br;q=0.5"
});
```

## The thresholds (and why)

Defaults are calibrated against measured streaming binary frames (Codec on sglang, see `packages/bench/RESULTS.md` §1c-1d in the parent repo, or [the chart](#chart)). Override them via `pick({ thresholds })`.

There are two regimes — interactive (humans read as it streams) and agent-mode (consumer reads everything at once). The `interactive` flag selects between them.

### Interactive (default)

Always picks gzip when available. Reason: measured TTFT on Codec streams jumps from ~11 ms (gzip) to ~3,800 ms (zstd) at 2K tokens, because zstd compressors typically buffer the full stream to finalise their dictionary. For chat, code completion, anything a human reads as it streams, **gzip is the only safe choice** — and it still gets you ~225× wire reduction vs uncompressed JSON-SSE.

### Agent-mode (`interactive: false`)

| stream length | best encoding | rationale |
|---|---|---|
| **≤ 128 tokens** | **gzip** | tiny deflate header beats zstd's frame header on payloads under ~150 tokens |
| **mid-band 128-256** | zstd if available, else gzip | both are within 10% of optimal; zstd wins as the stream grows past the estimate |
| **≥ 256 tokens** | **zstd** | Huffman + dictionary keep amortising — 562× smaller than uncompressed JSON-SSE at 2K tokens |

### What about brotli?

Brotli has wider client coverage than zstd — Safari, iOS, older Firefox all ship br but not zstd. So brotli matters as a **fallback**, not a primary choice. The picker reflects that:

- If client supports gzip → never use br (gzip wins on this workload at every size we measured).
- If client supports br but not gzip or zstd → use br. It's strictly better than identity.
- If client supports nothing compressible → identity.

This means for the modern web (Chrome 123+ / Firefox 126+) you get zstd, for older browsers and Safari you get gzip, and br only kicks in for genuinely unusual clients that disabled gzip.

### What about identity?

Identity loses at every size we measured — even at 16 tokens, compressed Codec is ≥2× smaller than raw. The CPU cost of gzip/zstd on a single CodecFrame is sub-microsecond. So identity is **only** chosen when the client refuses everything else, or when you explicitly restrict `serverSupports`.

## Chart

![Crossover chart](https://raw.githubusercontent.com/wdunn001/Codec/main/packages/bench/docs/crossover-summary.png)

(Source data lives in `packages/bench/RESULTS.md` §1c. Regenerate with `python packages/bench/scripts/plot_crossover.py`.)

## API

### `pick(input: PickInput): PickOutput`

```ts
interface PickInput {
  acceptEncoding?: string | null;          // raw header value
  estimatedSize: number;                    // tokens or bytes (your unit)
  thresholds?: Thresholds;                  // override defaults
  serverSupports?: Encoding[];              // restrict server-side capabilities
}

interface PickOutput {
  encoding: 'identity' | 'gzip' | 'br' | 'zstd';
  reason: string;                           // human-readable, for logs
}
```

### `parseAcceptEncoding(header): ClientSupport`

RFC 7231 §5.3.4-compliant parser. Sorts entries by q-value descending, drops `q=0` entries, respects `identity;q=0` to disable identity, returns `unspecified=true` when the header is absent.

### `buildAcceptEncoding(opts?): string`

Builds the recommended Accept-Encoding header for clients to send. Default order reflects the measured preference: `zstd;q=1.0, gzip;q=0.9, br;q=0.5`. Pass `{ zstd: false }` etc. to omit individual encodings.

### `describeRule(t?): string`

Pretty-print the threshold rule for log lines or `--help` output.

### `DEFAULT_THRESHOLDS`

```ts
const DEFAULT_THRESHOLDS = {
  gzipPreferredUpTo: 128,    // size <= this → gzip
  zstdPreferredFrom: 256,    // size >= this → zstd
  brotliFallbackOnly: true,  // br only when nothing better is available
  identityFallbackOnly: true,
};
```

## Why a separate package?

This logic is genuinely useful outside Codec. Anywhere you have:

- Streaming responses (SSE, gRPC-Web text, event streams)
- Many small frames rather than one big blob
- Mixed clients (modern browsers, mobile webviews, CLI tools, IoT)

…the right encoding depends on size and client support, and the standard "always-brotli" advice is wrong. Drop this in instead of writing your own switch statement.

The thresholds were measured for streaming token frames specifically. They generalise to other small-frame streaming workloads (chat APIs, log streams, telemetry) but you may want to recalibrate for your data — pass a custom `thresholds` argument to `pick()`.

## License

MIT.

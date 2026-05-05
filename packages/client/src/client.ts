import { decodeMultiStream } from '@msgpack/msgpack';
import type { CodecFrame } from '@codec/core';

export interface StreamOptions {
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  stop?: string[];
}

export interface CodecStats {
  tokenCount: number;
  byteCount: number;
  bytesPerToken: number;
  finishReason?: string;
}

/**
 * Client for a vLLM server with the Codec binary transport protocol.
 *
 * POST /v1/completions        — JSON body, add stream_format:"msgpack"|"protobuf"
 * POST /v1/completions/codec  — binary body (msgpack or protobuf prompt IDs in)
 * GET  /codec/schema          — proto schema for CodecFrame / CodecRequest
 *
 * Usage:
 *   const client = new CodecClient('http://localhost:8000');
 *   for await (const frame of client.stream('Explain entropy.')) {
 *     console.log(frame.ids);
 *   }
 */
export class CodecClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: { apiKey?: string; model?: string } = {}
  ) {}

  private get authHeaders(): Record<string, string> {
    return this.options.apiKey
      ? { authorization: `Bearer ${this.options.apiKey}` }
      : {};
  }

  /**
   * Stream token IDs from the model using the vLLM completions endpoint.
   * Sends stream_format:"msgpack" to receive binary MessagePack frames.
   */
  async *stream(prompt: string, opts: StreamOptions = {}): AsyncIterable<CodecFrame> {
    const model = this.options.model ?? 'default';
    const response = await fetch(`${this.baseUrl}/v1/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        stream_format: 'msgpack',
        max_tokens: opts.maxNewTokens ?? 512,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.topP !== undefined && { top_p: opts.topP }),
        ...(opts.seed !== undefined && { seed: opts.seed }),
        ...(opts.stop?.length && { stop: opts.stop }),
      }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`Codec stream error ${response.status}: ${text}`);
    }

    for await (const value of decodeMultiStream(response.body as ReadableStream<Uint8Array>)) {
      const frame = value as CodecFrame;
      yield frame;
      if (frame.done) break;
    }
  }

  /**
   * Bidirectional codec: send prompt as token ID array, receive token IDs.
   * No text ever crosses the boundary — zero detokenize/retokenize round-trips.
   */
  async *streamFromIds(promptIds: number[], opts: StreamOptions = {}): AsyncIterable<CodecFrame> {
    const body = this._encodeMsgpackRequest(promptIds, opts);
    const response = await fetch(`${this.baseUrl}/v1/completions/codec`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-msgpack',
        ...this.authHeaders,
      },
      body,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`Codec stream error ${response.status}: ${text}`);
    }

    for await (const value of decodeMultiStream(response.body as ReadableStream<Uint8Array>)) {
      const frame = value as CodecFrame;
      yield frame;
      if (frame.done) break;
    }
  }

  /**
   * Collect all token IDs from a prompt, returning them with stats.
   */
  async generate(prompt: string, opts: StreamOptions = {}): Promise<{
    ids: number[];
    stats: CodecStats;
  }> {
    const ids: number[] = [];
    let byteCount = 0;
    let finishReason: string | undefined;

    for await (const frame of this.stream(prompt, opts)) {
      ids.push(...frame.ids);
      byteCount += frame.ids.length * 4;
      if (frame.finish_reason) finishReason = frame.finish_reason;
    }

    return {
      ids,
      stats: {
        tokenCount: ids.length,
        byteCount,
        bytesPerToken: ids.length > 0 ? byteCount / ids.length : 0,
        finishReason,
      },
    };
  }

  /**
   * Pass token IDs from one model call directly into the next.
   * Agent A generates → IDs passed directly to Agent B as binary input.
   * No text conversion at any point.
   */
  async agentHandoff(
    agentAPrompt: string,
    agentBPrompt: (aIds: number[]) => string,
    opts: StreamOptions = {}
  ): Promise<{
    agentA: { ids: number[]; stats: CodecStats };
    agentB: { ids: number[]; stats: CodecStats };
  }> {
    const agentA = await this.generate(agentAPrompt, opts);

    // Pure token handoff: agentA.ids → agentB input, no text ever produced
    const agentBIds: number[] = [];
    let agentBByteCount = 0;
    let agentBFinishReason: string | undefined;

    for await (const frame of this.streamFromIds(agentA.ids, opts)) {
      agentBIds.push(...frame.ids);
      agentBByteCount += frame.ids.length * 4;
      if (frame.finish_reason) agentBFinishReason = frame.finish_reason;
    }

    const agentB = {
      ids: agentBIds,
      stats: {
        tokenCount: agentBIds.length,
        byteCount: agentBByteCount,
        bytesPerToken: agentBIds.length > 0 ? agentBByteCount / agentBIds.length : 0,
        finishReason: agentBFinishReason,
      },
    };

    return { agentA, agentB };
  }

  /** Encode a binary codec request body as msgpack. */
  private _encodeMsgpackRequest(promptIds: number[], opts: StreamOptions): Uint8Array {
    // Hand-encode a minimal msgpack map: {prompt_ids, max_tokens, ...}
    // We use the encode-from-JS approach via @msgpack/msgpack
    const { encode } = require('@msgpack/msgpack');
    const obj: Record<string, unknown> = {
      prompt_ids: promptIds,
      max_tokens: opts.maxNewTokens ?? 512,
      stream_format: 'msgpack',
    };
    if (opts.temperature !== undefined) obj.temperature = opts.temperature;
    if (opts.stop?.length) obj.stop = opts.stop;
    return encode(obj);
  }
}

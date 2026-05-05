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
 * Client for a Codec-enabled TGI server.
 *
 * Sends `parameters.codec: true` on every stream request, which tells TGI to:
 *   1. Skip detokenization on the model server
 *   2. Return token IDs as binary MessagePack frames instead of JSON/SSE
 *
 * Usage:
 *   const client = new CodecClient('http://localhost:3000');
 *   for await (const frame of client.stream('Explain entropy.')) {
 *     console.log(frame.ids);
 *   }
 */
export class CodecClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: { apiKey?: string } = {}
  ) {}

  /**
   * Stream token IDs from the model.
   * Yields one CodecFrame per chunk — typically one token ID per frame,
   * though TGI may batch during speculative decoding.
   */
  async *stream(prompt: string, opts: StreamOptions = {}): AsyncIterable<CodecFrame> {
    const response = await fetch(`${this.baseUrl}/generate_stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey
          ? { authorization: `Bearer ${this.options.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          codec: true,
          max_new_tokens: opts.maxNewTokens ?? 512,
          ...(opts.temperature !== undefined && { temperature: opts.temperature }),
          ...(opts.topP !== undefined && { top_p: opts.topP }),
          ...(opts.seed !== undefined && { seed: opts.seed }),
          ...(opts.stop?.length && { stop: opts.stop }),
        },
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
   * Collect all token IDs from a prompt, returning them with stats.
   * Convenience wrapper over stream() for non-streaming callers.
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
      byteCount += frame.ids.length * 4; // 4 bytes per uint32
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
   * Pass token IDs from one model call directly into the next —
   * the core agent-to-agent use case: no text ever crosses the boundary.
   *
   * agentA and agentB are prompts; agentA's output token IDs are
   * returned alongside agentB's output so callers can measure both.
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
    // agentA.ids are passed directly — no text conversion
    const agentB = await this.generate(agentBPrompt(agentA.ids), opts);
    return { agentA, agentB };
  }
}

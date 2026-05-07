/**
 * The Tool runtime interface. Implement this to ship a Codec-native
 * bolt-on tool.
 *
 * Two execution modes:
 *
 * 1. **Token-native** (the fast path): the tool receives argument
 *    *token IDs* directly from the gateway — no detokenize at the
 *    gateway, no re-tokenize at the tool. The tool decodes args once
 *    at the boundary, computes its result, and returns response tokens
 *    pre-cached for this model. Round trip: token IDs → tool internal
 *    state → token IDs. The gateway never sees text.
 *
 * 2. **Text fallback**: if the tool doesn't have a pre-cached binding
 *    for the model the gateway is serving, the tool returns text
 *    instead of tokens. The gateway tokenises the text using its own
 *    tokeniser to inject the result. Slower, but works for any model.
 *
 * Tools are independently versioned and deployed. The gateway only
 * trusts the manifest — there's no SDK lock-in beyond this interface.
 */

import type { ToolManifest } from './manifest.js';

/**
 * A tool-call as it crosses the wire from gateway to tool.
 *
 * The argument bytes are *whatever the tool author wants* — usually
 * msgpack or protobuf encoding of the argument object. The gateway
 * doesn't interpret them; it just routes the call to the tool and
 * trusts the tool to decode.
 */
export interface CodecToolCall {
  /** Tool name (matches manifest.name). */
  name: string;
  /** A monotonic call id assigned by the gateway. Echoed in the result. */
  callId: string | number;
  /**
   * Argument token IDs — what the model emitted between
   * `<tool_call>` and `</tool_call>` markers. These are the *raw* IDs
   * from the model's vocabulary; the tool decodes them however it
   * needs to.
   */
  argumentIds: number[];
  /** Hugging Face model id the gateway is serving right now. */
  modelId: string;
}

/**
 * The result the tool returns.
 *
 * Either `responseIds` (token-native fast path) or `text` (text
 * fallback). Exactly one must be present.
 */
export type CodecToolResult =
  | {
      callId: string | number;
      kind: 'tokens';
      /**
       * Pre-tokenised response, ready to be reinjected into the
       * generation context. Must use the model's tokeniser; the gateway
       * verifies tokenizer-hash compatibility against the manifest.
       */
      responseIds: number[];
    }
  | {
      callId: string | number;
      kind: 'text';
      /**
       * Plain UTF-8 result. The gateway tokenises this itself using its
       * own model's tokeniser. Use this when no pre-cached binding
       * exists for the active model.
       */
      text: string;
    }
  | {
      callId: string | number;
      kind: 'error';
      /** Human-readable error message. */
      message: string;
      /** Optional structured error code for the client. */
      code?: string;
    };

/**
 * The tool runtime. Each bolt-on package exports an object that
 * conforms to this shape.
 */
export interface CodecTool {
  /** The manifest this tool ships alongside its code. */
  manifest: ToolManifest;
  /**
   * Handle a call. May return tokens (fast path) or text (fallback) or
   * an error. The framework retries once on transient errors.
   */
  handle(call: CodecToolCall): Promise<CodecToolResult>;
}

/**
 * Helper for building token-native results.
 */
export function tokensResult(callId: string | number, ids: number[]): CodecToolResult {
  return { callId, kind: 'tokens', responseIds: ids };
}

/**
 * Helper for building text-fallback results.
 */
export function textResult(callId: string | number, text: string): CodecToolResult {
  return { callId, kind: 'text', text };
}

/**
 * Helper for building error results.
 */
export function errorResult(
  callId: string | number,
  message: string,
  code?: string,
): CodecToolResult {
  return { callId, kind: 'error', message, code };
}

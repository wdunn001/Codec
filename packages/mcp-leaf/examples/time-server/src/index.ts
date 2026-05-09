#!/usr/bin/env node
/**
 * Codec-aware Time MCP server — reference example for the leaf-mode contract.
 *
 * Mirrors the surface of the canonical `mcp-server-time` (Python reference)
 * MCP server, but adds @codecai/mcp-leaf wrapping so every CallToolResult
 * carries a `_codec_meta` sibling block alongside its text content. A
 * Codec-aware gateway (metamcp at feat/codec-binary-transport, commit
 * 6632f17 onwards) detects the pre-tokenized output via its
 * `hasExistingCodecMeta` guard and bypasses its back-compat shim — the
 * gateway becomes a transparent ID pipe for this hop, the `leafBypasses`
 * counter increments, and the once-per-(vocab, process) `[Codec][leaf]`
 * info log fires.
 *
 * Non-Codec-aware clients on the same MCP namespace ignore the `_codec_meta`
 * block and see the original text exactly as before. The contract is
 * additive — graduating to leaf-mode is invisible to legacy clients.
 *
 * Tools exposed:
 *   - get_current_time(timezone?: string)
 *   - convert_time(source_timezone, time, target_timezone)
 *
 * Run via stdio (the canonical MCP transport):
 *
 *   npm run build && npm start
 *
 * Or with the Codec map URL + hash configured:
 *
 *   CODEC_MAP_URL=https://cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/qwen/qwen2.json \
 *   CODEC_MAP_HASH=sha256:9db56ff6bb53b22d3dd697de3cdd25973d2171f089dd1a15ca8925b710f07394 \
 *   codec-time-leaf
 *
 * Without the env vars, the server runs without leaf-mode (gateway falls
 * through to its back-compat shim path — which is fine, just slower wire).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  makeMetaTokenizer,
  wrapToolCall,
  type MetaTokenizer,
} from '@codecai/mcp-leaf';

// ── Tool implementations ──────────────────────────────────────────────────────

interface CurrentTimeArgs {
  timezone?: string;
}

interface ConvertTimeArgs {
  source_timezone: string;
  time: string;
  target_timezone: string;
}

function getCurrentTime(args: CurrentTimeArgs): string {
  const tz = args.timezone ?? 'UTC';
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short',
      hour12: false,
    });
    return `${fmt.format(now)} (${tz})`;
  } catch (e) {
    return `Error: unknown timezone ${JSON.stringify(tz)}`;
  }
}

function convertTime(args: ConvertTimeArgs): string {
  const { source_timezone, time, target_timezone } = args;
  // Parse a HH:MM time string in the source timezone, render in target.
  const [hStr, mStr] = time.split(':');
  const h = Number(hStr), m = Number(mStr);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return `Error: time must be HH:MM in 24-hour format, got ${JSON.stringify(time)}`;
  }
  // Anchor the time on today in the source timezone, then format in target.
  // Intl can't directly construct a Date in a given timezone; we approximate
  // by composing the offset string. Sufficient for a reference example.
  try {
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    // Inject the H:M into today's date in the source timezone.
    const srcDate = new Date(`${isoToday}T${time.padStart(5, '0')}:00`);
    const srcFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: source_timezone,
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const tgtFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: target_timezone,
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return (
      `${srcFmt.format(srcDate)} ${source_timezone}  →  ` +
      `${tgtFmt.format(srcDate)} ${target_timezone}`
    );
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

// ── Server setup ─────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    {
      name: 'codec-time-leaf',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  // Lazy-loaded leaf-mode tokenizer. Only constructed if the env vars
  // are present — otherwise the server runs without leaf-mode and falls
  // back to standard text-only responses (gateway shim handles those).
  let leafMeta: MetaTokenizer | null = null;
  const mapUrl = process.env.CODEC_MAP_URL;
  const mapHash = process.env.CODEC_MAP_HASH;
  if (mapUrl && mapHash) {
    try {
      leafMeta = await makeMetaTokenizer({ mapUrl, mapHash });
      // Use stderr so it doesn't pollute stdio MCP transport.
      console.error(`[codec-time-leaf] leaf-mode enabled: ${leafMeta.mapHash}`);
    } catch (e) {
      console.error(
        `[codec-time-leaf] WARN: failed to load Codec map ${mapUrl}: ${(e as Error).message}`,
      );
      console.error('[codec-time-leaf] continuing without leaf-mode tokenization');
    }
  } else {
    console.error(
      '[codec-time-leaf] leaf-mode disabled: set CODEC_MAP_URL + CODEC_MAP_HASH to enable',
    );
  }

  // ── tools/list ─────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_current_time',
        description: 'Return the current time, optionally in a named timezone.',
        inputSchema: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description:
                'IANA timezone name (e.g. "UTC", "America/New_York", "Asia/Tokyo"). Defaults to UTC.',
            },
          },
          required: [],
        },
      },
      {
        name: 'convert_time',
        description: 'Convert a time-of-day from one timezone to another.',
        inputSchema: {
          type: 'object',
          properties: {
            source_timezone: { type: 'string' },
            time: { type: 'string', description: 'HH:MM, 24-hour' },
            target_timezone: { type: 'string' },
          },
          required: ['source_timezone', 'time', 'target_timezone'],
        },
      },
    ],
  }));

  // ── tools/call ─────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let text: string;
    try {
      switch (req.params.name) {
        case 'get_current_time':
          text = getCurrentTime(args as unknown as CurrentTimeArgs);
          break;
        case 'convert_time':
          text = convertTime(args as unknown as ConvertTimeArgs);
          break;
        default:
          throw new Error(`unknown tool: ${req.params.name}`);
      }
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }

    const result = {
      content: [{ type: 'text' as const, text }],
    };
    // Wrap with _codec_meta sibling iff leaf-mode is enabled. A NULL meta
    // skips the wrap and returns the raw result — graceful degradation
    // for environments without a Codec map configured.
    return leafMeta ? wrapToolCall(result, leafMeta) : result;
  });

  // ── Run over stdio ─────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[codec-time-leaf] running on stdio');
}

main().catch((e) => {
  console.error(`[codec-time-leaf] fatal: ${(e as Error).message}`);
  process.exit(1);
});

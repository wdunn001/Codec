/**
 * Tool / agent / MCP defenses — companion to
 * spec/proposals/v0.6-security/06-tool-agent-attacks.md.
 *
 * Implements untrusted-content wrapping for tool descriptions and tool
 * results, plus tool-name collision detection. The MCP-specific transport
 * (STDIO, HTTP) lives elsewhere; this module is the policy layer that any
 * MCP host SHOULD apply to inbound content before it reaches the model.
 *
 * The Anthropic MCP "by design" STDIO command-injection wave of April 2026
 * (Ox Security, 7,000+ servers, 150M+ downloads) puts the burden on host
 * implementations rather than the protocol — see
 * spec/proposals/v0.6-security/references/06-tool-agent-refs.md for context.
 * This module is exactly the kind of layer Anthropic deferred to host
 * developers.
 */

/**
 * Authority-claim patterns commonly used to hijack model attention in
 * tool descriptions and resource content. Matched case-insensitively at
 * word boundaries. Hits get redacted before injection into model context.
 */
const AUTHORITY_PATTERNS: readonly RegExp[] = [
  /\bIMPORTANT\s*:/gi,
  /\bMUST\b/gi,
  /\bMUST NOT\b/gi,
  /\bSYSTEM\s*:/gi,
  /\bATTENTION\s*:/gi,
  /\bPRIORITY OVERRIDE\b/gi,
  /\bNOTE\s+TO\s+(THE\s+)?(AI|LLM|MODEL|ASSISTANT)\b/gi,
  /\bignore\s+(all\s+)?previous\s+(instructions|prompts)\b/gi,
];

export interface ToolDescriptionScan {
  /** Description with authority-claim phrases redacted to `[REDACTED]`. */
  sanitized: string;
  /** Per-pattern hits, for telemetry. */
  hits: Array<{ pattern: string; count: number }>;
  /** True if the description should be wrapped in untrusted-content tags before reaching the model. */
  suspicious: boolean;
}

const TOOL_DESC_MAX_LENGTH = 1500;

/**
 * Sanitize an MCP tool description before injecting into a system prompt.
 *
 * Strips known authority-claim language patterns. Enforces a length cap
 * (legitimate descriptions are usually <500 chars; over 1500 is anomalous
 * and probably an injection vehicle). Returns telemetry per matched pattern.
 */
export function sanitizeToolDescription(description: string): ToolDescriptionScan {
  let sanitized = description;
  const hits: Array<{ pattern: string; count: number }> = [];
  for (const re of AUTHORITY_PATTERNS) {
    const matches = description.match(re);
    if (matches) {
      sanitized = sanitized.replace(re, '[REDACTED]');
      hits.push({ pattern: re.source, count: matches.length });
    }
  }
  if (sanitized.length > TOOL_DESC_MAX_LENGTH) {
    sanitized = sanitized.slice(0, TOOL_DESC_MAX_LENGTH) + '[…TRUNCATED]';
    hits.push({ pattern: 'length-overflow', count: 1 });
  }
  return { sanitized, hits, suspicious: hits.length > 0 };
}

export type TrustTier = 'system' | 'user' | 'external' | 'tool_result';

/**
 * Wrap externally-sourced content in `<untrusted_content>` tags before
 * concatenating into a model prompt. The companion system-prompt directive
 * (host-supplied) instructs the model to treat content inside these tags as
 * data, not instructions.
 *
 * Origin labels:
 *   - `mcp.<server>.tool-description` — tool description from MCP server
 *   - `mcp.<server>.<tool>.result` — tool result from MCP server
 *   - `user-upload.<mime>` — user-uploaded document content
 *   - `web-fetch.<host>` — agent web-fetch result
 */
export function wrapUntrustedContent(
  content: string,
  origin: string,
  options: { mime?: string; sha256?: string } = {},
): string {
  const attrs = [`origin="${escapeAttr(origin)}"`];
  if (options.mime) attrs.push(`mime="${escapeAttr(options.mime)}"`);
  if (options.sha256) attrs.push(`sha256="${escapeAttr(options.sha256)}"`);
  return `<untrusted_content ${attrs.join(' ')}>\n${content}\n</untrusted_content>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface ToolName {
  server: string;
  name: string;
}

export interface CollisionResult {
  collisions: Array<{ name: string; servers: string[] }>;
  namespaced: ReadonlyMap<string, ToolName>;
}

/**
 * Detect tool-name collisions across multiple MCP servers, and produce the
 * recommended namespacing (server-qualified). When two servers register the
 * same tool name, the model has no way to choose between them; namespacing
 * with `<server>.<name>` removes the ambiguity AND surfaces the situation
 * to the host application for explicit user confirmation before granting
 * either tool access.
 */
export function detectToolNameCollisions(tools: readonly ToolName[]): CollisionResult {
  const byName = new Map<string, Set<string>>();
  for (const t of tools) {
    if (!byName.has(t.name)) byName.set(t.name, new Set());
    byName.get(t.name)!.add(t.server);
  }
  const collisions: CollisionResult['collisions'] = [];
  for (const [name, servers] of byName) {
    if (servers.size > 1) {
      collisions.push({ name, servers: [...servers].sort() });
    }
  }
  const namespaced = new Map<string, ToolName>();
  for (const t of tools) {
    namespaced.set(`${t.server}.${t.name}`, t);
  }
  return { collisions, namespaced };
}

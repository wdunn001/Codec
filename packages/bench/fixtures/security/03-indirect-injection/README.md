# 03 — Indirect Prompt Injection Fixtures

Maps to [`spec/proposals/v0.6-security/03-indirect-injection.md`](../../../../../spec/proposals/v0.6-security/03-indirect-injection.md).

## Fixtures

| File | Vector | What it carries |
|---|---|---|
| `json-role-injection-bio.txt` | JSON role injection breakout | Visible LinkedIn-style bio prose followed by a JSON-syntax payload that, if interpolated into an f-string-built JSON `messages` array, escapes the user-content string and injects a peer `system` message. |
| `json-role-injection-bio.expected.txt` | (expected after defense) | The same bio prose with the JSON breakout characters escaped (via `JSON.stringify` / `json.dumps`) so the breakout is inert. |
| `chat-template-tokens.txt` | Chat-template special-token boundary break | Bio prose containing literal `<\|im_end\|>`, `<\|eot_id\|>`, `</s>`, `<end_of_turn>`, `[/INST]`, `<\|im_start\|>system`, etc. — meant to close the current chat turn on a vulnerable serving stack. |
| `chat-template-tokens.expected.txt` | (expected after defense) | The same bio with all known special-token strings removed. |
| `system-reminder-mimicry.txt` | `<system-reminder>` tag mimicry | Bio with `<system-reminder>...</system-reminder>` content masquerading as a real Claude harness append. |
| `system-reminder-mimicry.expected.txt` | (expected after defense) | Bio with the mimicked tag wrapped as untrusted-content with an `origin="ingested"` attribute, preserving the literal text but neutralizing the role. |

## Binary fixtures (PDF, image, email)

Out of scope for this initial commit. A follow-up commit will add:

- `generate_injection_pdf_invisible_text.py` — produces a PDF with white-on-white text carrying an injection.
- `generate_injection_image_skywriting.py` — produces an image with corner-of-frame adversarial OCR text.
- `injection_email.eml` — example email with adversarial `From`, `Subject`, `X-*` headers.

These need binary generators to keep the repo clean; the generator script is the source-of-truth, the binary is build output.

## How to interpret these fixtures

The JSON role injection fixture is the most subtle. The visible bio is plain
prose; the injection only fires if the bio is then interpolated into a
string-built JSON payload like:

```python
prompt = f'{{"messages":[{{"role":"user","content":"{bio}"}}]}}'
payload = json.loads(prompt)  # ← ★ this reparses, fires the breakout
```

The fixture is identical to what one might paste into a LinkedIn About field.
The "attack" is in the failure mode of the consuming pipeline, not in any
visible markup. Tests should:

1. Build a vulnerable f-string pipeline.
2. Pipe the fixture through it.
3. Verify the resulting message array contains TWO `system` messages where
   only one was intended.
4. Apply the defense (use `JSON.stringify`/`json.dumps` instead).
5. Verify only the intended `system` message survives.

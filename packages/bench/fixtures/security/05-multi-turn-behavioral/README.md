# 05: Multi-Turn / Behavioral Attack Fixtures

Maps to [`spec/proposals/v0.6-security/05-multi-turn-behavioral.md`](../../../../../spec/proposals/v0.6-security/05-multi-turn-behavioral.md).

## Planned fixtures (require live model runs to fully validate)

| File | Vector | Status |
|---|---|---|
| `many-shot-jailbreak.json` | conversation with N fake compliance examples | TODO: needs assembled conversation transcript |
| `crescendo.json` | gradual-escalation conversation | TODO |
| `role-confusion.json` | user claims a prior assistant turn was system | TODO |
| `prefilling-attack.json` | user content flowed into assistant prefill | TODO |
| `prompt-extraction-trickery.json` | prompts attempting to extract system prompt | TODO |

These attacks are defined solely as **conversation traces**, never single-message payloads. Validation requires either a live model run (gated behind `RUN_MODEL_TESTS=1` env var) or a recorded reference output from a chosen model.

## Why fixtures are JSON

Each fixture is a recorded `messages` array (OpenAI-format or equivalent), suitable for feeding directly into a chat completion call. The fixture documents:

- `description`: what the attack is.
- `messages`: the conversation array.
- `expected_safe_outcome`: model refuses / does not comply.
- `expected_failure_signal`: what evidence indicates the attack succeeded (specific output phrases, tool calls made, etc.).

A correct defense is one where `expected_safe_outcome` is observed and `expected_failure_signal` is not. Test infrastructure is the same as [`packages/bench/`](../../../../../packages/bench/) classifier evals.

# codecai: coverage

Last measured: 2026-05-11 (v0.4 release-cut)

## How

```
pip install pytest-cov
cd packages/python
python -m pytest tests/ --cov=codecai --cov-report=term
```

## Result (v0.4 baseline)

```
TOTAL    1481    522    65%
66 passed, 5 skipped
```

| Module                  | Cov% | Notes                                                  |
|-------------------------|-----:|--------------------------------------------------------|
| `discover.py`           | 96%  | well-known fetch + cache + hash-verify                 |
| `map_loader.py`         | 93%  |                                                        |
| `tool_watcher.py`       | 92%  |                                                        |
| `encoder.py`            | 91%  |                                                        |
| `safety_policy.py`      | 88%  | new in v0.4: covers descriptor parse, hash, load     |
| `types.py`              | 87%  |                                                        |
| `detokenize.py`         | 75%  | byte-fallback paths exercised; some metaspace branches |
| `stream.py`             | 72%  | msgpack + protobuf decoders both exercised             |
| `tokenize.py`           | 60%  | encoder + special-token pre-scan + new lead_space ops |
| `translate.py`          | 24%  | cross-vocab translator: needs more cross-vocab fixtures |
| `server/latent_frame.py`|  0%  | server-side encoder, exercised only by integration tests on the lab, never the per-package pytest |

## Intentionally uncovered

- `server/latent_frame.py` (0%): server-side latent-frame encoder. Tested
  only via `packages/bench/` lab integration runs (`comfyui` / `diffusers`
  containers), never the per-package pytest. Local `pytest` skips it
  because it requires a torch/CUDA stack.
- 5 `Translator` tests (`test_translate.py`) are skipped without a
  Llama-3 map present locally: they run in the cross-stack matrix
  on the lab.

## v0.5 follow-up

- Translator coverage: sample more cross-vocab pairs.
- `tokenize.py` 60% reflects the new `letters_cased` / `lead_space`
  branches that landed in v0.4; the corpus needs samples that
  exercise each cased-letter checkpoint-backtrack path.
- Wire CI to run `pytest-cov` and fail on regression.

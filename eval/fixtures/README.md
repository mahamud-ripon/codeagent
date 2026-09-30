# Live-recorded provider fixtures (QA-4)

No live fixtures are checked in yet — recording needs a model endpoint.

- Synthetic replay + fault injection in `tests/providerContract.test.ts` stays
  the CI gate until fixtures exist.
- To record one (needs `EVAL_LIVE=1` plus `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, or `OPENAI_BASE_URL` + `MODEL`):

```bash
EVAL_LIVE=1 npm run eval:record -- mystream
```

- Output: `eval/fixtures/mystream.jsonl` — first line is `{meta}` (provider,
  model, `promptVersion`, recorded-at), followed by one JSON object per
  `ProviderEvent`. The contract tests can replay these shapes, including
  429/`Retry-After` and truncated-frame handling.
- Do not commit keys or raw secrets — fixtures contain model output only.

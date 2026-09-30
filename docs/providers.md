# Providers

| Backend | Flag | Key | Notes |
|---|---|---|---|
| OpenAI Responses | `--provider openai` (default) | `OPENAI_API_KEY` | True streaming via `/v1/responses` SSE |
| OpenAI-compat Chat | `--provider chat` + `-e URL` | endpoint key or `ollama` | Ollama/Groq/OpenRouter/Gemini-compat |
| Anthropic native | `--provider anthropic` | `ANTHROPIC_API_KEY` | Messages SSE, cache breakpoints |
| Gemini native | `--provider gemini` | `GEMINI_API_KEY`/`GOOGLE_API_KEY` | generateContent SSE |

Model roles (`settings.json → model.main/fast/plan`): `fast` backs compaction summaries, session titles, intent checks; `plan` routes exploration tools (`grep/glob/search/read/...`) when different from `main`.

Capabilities (`model.capabilities.contextWindow/maxOutput`) override the registry; unknown models fall back to 8192/2048.

Small-model mode: auto for `gpt-oss/mini/haiku/7b/8b/...` or `model.smallModel:true` — short prompt, fewer tools, one tool per turn, JSON repair.

Prompt caching: Anthropic `cache_control` breakpoints on the stable prefix (system → tools → memory → history); `supportsPromptCaching()` gates by family.

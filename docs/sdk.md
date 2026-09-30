# SDK (`@codeagent/core` shape)

`src/sdk/query.ts` exposes the same `AgentEvent` stream the TUI consumes:

```ts
import { query } from "./src/sdk/query.js";

for await (const event of query("Fix the failing test.", {
  repoRoot: process.cwd(),
  model: "gpt-5.6-luna",
  provider: "openai",
  maxIterations: 30,
})) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
// yields { type: "done", result } at the end; resolves { finalMessage }
```

- Streaming by default (`providerInstance` on every backend, including OpenAI-compatible chat SSE).
- Roles/hooks/capabilities mirror the CLI (`model.main/fast/plan`, settings hooks).
- Headless callers get stable exit codes via `exitCodeForStopReason` (`src/cli/headless.ts`).
- Publish shape: `dist/` + `docs/` + README/LICENSE/CHANGELOG (`files` in package.json); `npm run bundle` emits a single-file `dist/codeagent.bundle.mjs` via esbuild.

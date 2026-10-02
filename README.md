# CodeAgent 1.0

An autonomous coding agent with a durable local runtime shared by its CLI, SDK, and VS Code bridge. Sessions continue after clients disconnect. Coding workers use isolated Git worktrees and inherit the coordinator's permissions and budget.

**Release status:** implementation candidate. The live quality gate requires a paired baseline/candidate evaluation; no competitor-parity or measured improvement claim is made here.

## Install and run

Requires Node.js 20 or newer, npm, and a configured model provider. Git is required for parallel coding workers. Docker is optional.

```sh
npm ci
npm run build
npm link
codeagent "Fix the failing tests"
codeagent "Implement pagination" --detach
codeagent --attach <session-id>
```

Configure provider credentials using environment variables or the existing global `~/.codeagent/.env`. Supported adapters: OpenAI Responses, OpenAI-compatible chat, Anthropic, and Gemini. Use `--model`, `--provider`, and `--endpoint` to select an endpoint. Explicit model selection is recommended for coding tasks.

Permission prompts are retained in the supervisor until answered. Unattended operation requires explicit allow rules or `--dangerously-skip-permissions`. A requested Docker sandbox never silently falls back to host execution.

## Sessions and controls

```sh
codeagent --sessions
codeagent inspect <session-id>
codeagent steer <session-id> "Preserve the existing public API"
codeagent pause <session-id>
codeagent --resume <session-id> "Continue the task"
codeagent cancel <session-id>
codeagent fork <session-id>
codeagent undo <session-id>
codeagent import-session /path/to/legacy-session.json
```

Interactive commands: `/new`, `/status`, `/tasks`, `/agents`, `/jobs`, `/fork`, `/undo`, `/detach`, and `/exit`. Ctrl+C cancels an attached run. Closing the client leaves the supervisor running. `/detach` exits the idle prompt; `--detach` starts a run without attaching.

`--print --output-format json` returns a structured result; `stream-json` emits versioned runtime events. Headless runs needing approval remain pending and print their session ID. Use `--attach` from a terminal to answer.

## Architecture

- **One agent loop:** coordinator, exploration, planning, coding, and review roles use `AgentRuntime`.
- **Durable supervisor:** authenticated local IPC, a single journal writer, JSONL events, atomic snapshots, fork/resume, and correlated approval requests.
- **Common tool gateway:** registry schemas, permission checks, plan restrictions, hooks, workspace locks, checkpoints, and execution records.
- **Task coordination:** dependency graph, atomic ownership, durable mailboxes, three concurrent workers by default, and one delegation level.
- **Workspace isolation:** snapshots include starting dirty and untracked files; integration is serialized, verified, and checked for destination drift.
- **Context:** output artifacts, staged compaction with pinned goals and tasks, on-demand skills, and project-scoped generated memory.
- **Verification:** repository checks are recorded against workspace hashes. Later changes invalidate results. Incomplete work has an explicit blocked/failed/cancelled result.

Runtime data lives in `~/.codeagent/runtime/v1`. `CODEAGENT_RUNTIME_HOME` selects an alternate private directory. Generated memory is separate from user-authored repository instructions. Large tool outputs are stored as retrievable artifacts.

Git worktrees isolate files, not external databases or network services. Shell commands still require the inherited command permissions; use Docker when OS isolation is required. After a supervisor crash, interrupted effects are marked uncertain and require inspection before retrying.

## SDK

```ts
import { query } from '@mahamud-ripon/codeagent';

const run = await query('Fix the failing test', {
  repoRoot: process.cwd(),
  model: process.env.MODEL,
});

for await (const event of run.events()) {
  if (event.type === 'approval_request') {
    // Present event.data.prompt and explicitly collect a user decision.
    // await run.answer(String(event.data.id), approved);
  }
  console.log(event.type, event.agentId);
}
const result = await run.result();
```

See [SDK](docs/sdk.md), [migration](docs/migration-1.0.md), and [runtime architecture](docs/runtime.md).

## Verification and release evaluation

```sh
npm run typecheck
npm test
npm run eval
npm run bundle
npm run eval:release -- --check
```

CI runs typecheck, tests, evaluation smoke checks, and bundling on Linux, Windows, and macOS with Node 22.

The release evaluation freezes 20 advanced and 30 held-out tasks and compares three repetitions per task at matched model/settings/budgets. Passing requires at least 10 percentage points of observed improvement with no increase in false completion, plus the reliability gates. Repetitions of a task are correlated; aggregate counts do not establish general benchmark superiority.

```sh
# Use the archived baseline checkout for the first engine, keeping its dependencies installed.
npm run eval:release -- --engine /path/to/baseline/src/agent/agent.ts --output /tmp/baseline.json
npm run eval:release -- --engine src/agent/agent.ts --output /tmp/candidate.json
npm run eval:release -- --compare --baseline /tmp/baseline.json --candidate /tmp/candidate.json
```

Both engines require the same real provider configuration and `MODEL`. Mock responses and service emulators cannot establish coding quality.

## License

MIT

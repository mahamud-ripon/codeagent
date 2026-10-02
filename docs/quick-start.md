# Quick start (1.0)

```bash
npm ci
npm run typecheck
npm test
npm run eval
npm run build
node dist/index.js --print "Explain this repository"
```

Configure a model through the existing provider environment variables or `~/.codeagent/.env`. Supported providers are OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints. Use `--provider` and `--model` to override selection.

## Sessions

```bash
codeagent "Implement the feature" --detach
codeagent sessions
codeagent --attach <session-id>
codeagent steer <session-id> "Keep the public API compatible"
codeagent pause <session-id>
codeagent cancel <session-id>
codeagent inspect <session-id>
```

Clients connect to a local supervisor. Disconnecting leaves work running. An unattended request for approval remains pending; attach interactively to answer it. Auto-approval requires an explicit option or permission rule.

The interactive prompt supports `/new`, `/status`, `/tasks`, `/agents`, `/jobs`, `/fork`, `/undo`, `/detach`, and `/exit`. Use settings and launch flags for model, sandbox, and permission configuration. See [migration](migration-1.0.md) for replaced legacy controls.

## Headless

```bash
codeagent --print "Fix the failing test" --output-format stream-json
```

Exit codes: 0 completed; 1 failed/blocked; 2 denied permission; 3 budget exhausted; 4 configuration error or input pending; 5 paused; 130 cancelled. Stream events include versioned session, run, agent, sequence, and correlation identifiers.

## Release status

The 1.0 candidate requires reliability CI on Linux, macOS, and Windows plus the matched live evaluation before publication. See [runtime architecture](runtime.md) and [SDK](sdk.md).

# Migrating to 1.0

1. Build with `npm ci && npm run build`. Existing provider environment variables and global credential files remain supported.
2. Add `"schemaVersion": 1` to settings when editing them. Missing versions are interpreted as legacy settings with a diagnostic; unknown versions fail explicitly. Global, project, and local override ordering remains intact.
3. Import older JSON session snapshots using `codeagent import-session <file>`. Import copies history and provenance; original files remain intact. Historical execution guarantees are not invented.
4. Update SDK consumers: `query()` now resolves to a run handle. Iterate `run.events()` and obtain `run.result()`. Events use `{version,sessionId,runId,agentId,sequence,correlationId,timestamp,type,data}`. Only the coordinator's `done` ends the root run.
5. Update the VS Code extension together with the CLI. Initialize the bridge with `protocolVersion: "1.0"`. Approval is disabled by default only when explicitly configured; the extension's default is to ask.
6. Replace assumptions about Docker fallback: requested Docker execution now fails closed. Use explicit local mode when host execution is intended.
7. Treat `completed`, `blocked`, `failed`, `cancelled`, and `paused` distinctly. A textual answer or exhausted stop-hook retry budget does not establish success.

The default interactive CLI now uses a full-screen [terminal UI](ui-next.md). Use `--ui legacy` for the plain prompt, or `--print` for scripts. The interactive runtime supports `/new`, `/status`, `/tasks`, `/agents`, `/jobs`, `/fork`, `/undo`, `/detach`, and `/exit`. Configure provider/model/permission options through launch flags and settings. Old UI helpers remain available internally; production sessions use the supervisor client.

A detached supervisor retains its startup environment. After changing provider credentials, restart that supervisor when no tasks are running so new runs use the updated environment. Its PID is recorded in `~/.codeagent/runtime/v1/supervisor.lock`.

The package version is 1.0.0, but publication is gated on reliability CI and the paired live evaluation in `eval/release-manifest.json`. No release is published by this implementation task.

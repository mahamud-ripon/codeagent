# Runtime architecture

## Ownership

The supervisor is the only journal writer for attached sessions. The IPC endpoint is a Unix socket (0600) or a Windows named pipe. A random token kept in the user's private runtime directory authenticates each request. The protocol version is 1. Model credentials are inherited by the supervisor process and are not transmitted in client requests.

A session contains versioned messages, a task graph, verification evidence, artifacts, and run identifiers. A run owns a shared call/token/cost budget and an agent tree. Children narrow the parent's tool set and share the exact permission manager. Up to three workers execute concurrently; workers cannot delegate further.

## Execution

Tool definitions carry a Zod schema, description, effect, concurrency policy, recovery policy, and handler. Provider schemas derive from that registry. In Docker mode, MCP servers must use HTTP; local stdio servers are rejected so discovery cannot launch a host process. MCP definitions are discovered per run and passed through request-local provider tool definitions, never appended to global provider state.

The gateway validates the schema, permission scope, paths and symlinks, then applies hooks and records an intention before executing. Read batches are bounded to four; mutations are serialized per workspace. Results, output artifacts, and workspace fingerprints follow execution. Shell-created changes are visible in fingerprints.

Docker commands use managed container processes for foreground, streamed, and background operations. Cancellation removes the container. An unavailable daemon blocks execution. Local background jobs are owned by a session and agent, bounded in number, cancellable, and capped by timeout.

## Durability and recovery

Journal records are fsynced; snapshots use write/fsync/rename. An incomplete trailing JSONL record may be truncated. Corruption in a completed record is an error. Replay deduplicates submissions and reconstructs completed call results without executing tools again.

After a supervisor crash, active sessions become paused. Running tasks become blocked with retained artifacts. Resume reconstructs unmatched tool calls as uncertain results, restores prior budgets and worker metadata, and requires the agent to inspect uncertain effects. External side effects cannot be guaranteed exactly once. New approvals are required after restart.

Fork copies conversation history into a new session, without tasks, approvals, jobs, or execution identities. Legacy import preserves the original file and imports conversation provenance only.

## Worker integration

A temporary Git index captures the initial tree, including uncommitted and untracked files, without moving the developer's index or branch. Workers share that initial commit through separate worktrees. A separate integration tree merges their commits in sequence and runs discovered checks. A conflicting or failed result is retained. Integrated workers are removed only after destination completion and only if their files still match the integrated snapshot.

Before applying a binary diff to the destination, the coordinator checks its fingerprint against the expected state and validates the patch. File permission approval is required for every affected file. The main workspace must be verified again after application. Worktree manifests permit recovery of retained results.

## Context and completion

The context manager first moves large historical outputs to artifacts, then summarizes older dialogue while retaining the goal, all user requests and instruction layers, task state, and verification evidence. The initial threshold is 78% (the SDK `compactionThreshold` option accepts 0.50–0.95) of context capacity, additionally bounded by reserved output space. Overflow of pinned context blocks the run instead of silently dropping it.

Skills expose descriptions and load full bodies explicitly. Generated memory has provenance and project scope; it can be listed, deleted, or disabled through session options. User-authored instructions are never rewritten by memory compaction.

Verification records identify the command, workspace hash, outcome and output artifact. Required checks are rediscovered as a project changes. A failed recheck supersedes a previous success. Arbitrary exit-zero commands are not checks. Completion is blocked by pending tasks, unintegrated workers, plan approval, or missing verification. Budget/retry exhaustion never becomes successful completion.

## Hook configuration

```json
{
  "schemaVersion": 1,
  "hooks": {
    "PreToolUse": [{
      "matcher": "write_file|edit_file",
      "command": "node scripts/check-policy.cjs",
      "enforcement": true,
      "timeoutMs": 15000
    }]
  }
}
```

Hook commands require command permission and receive a JSON payload on stdin. An enforcement hook must exit zero and emit `{"decision":"allow"}`. Denials, invalid output, timeouts and errors block the action. Advisory hooks report errors without blocking. Hooks run in the selected workspace; command permissions are inherited.

## Budget accounting

Model-call reservations are shared synchronously across the tree, including compaction. Token and cost limits use reported cumulative usage; an in-flight provider request can cross an observed-usage limit. Unknown prices are reported as unknown and stop further admission when a cost limit was requested. These limits are not a provider-side billing cap. Output limits and compaction headroom follow the active model capabilities.

## Evaluation

`npm run eval:release -- --check` validates frozen suites. Run the harness once with the frozen baseline Agent module and once with the candidate, using the same environment and budgets, then compare with `--compare --baseline <file> --candidate <file>`. Each file must contain all 50 task identities and three repetitions. Reports include completion, false completion, latency, tokens, known cost, failures, and a paired task-cluster bootstrap interval. The interval describes uncertainty; the observed 10-point threshold and unchanged false completion are separate release conditions.

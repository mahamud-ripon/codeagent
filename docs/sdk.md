# SDK 1.0

```ts
import { query, RuntimeClient } from '@mahamud-ripon/codeagent';
const run = await query('Fix the tests', { repoRoot: process.cwd(), model: process.env.MODEL });
for await (const event of run.events()) console.log(event);
const result = await run.result();
```

`RunHandle` provides `events(afterSequence)`, `result()`, `steer(text)`, `answer(requestId, answer)`, `pause()`, `cancel()`, and `detach()`. Disconnecting an event consumer leaves execution running. `RuntimeClient.attach(sessionId)` replays the durable run. Request IDs deduplicate submissions; changed content under the same ID is rejected.

Approval and input events carry a request ID in `data.id`. Display `data.prompt`, collect an explicit decision, and call `run.answer(id, boolean)` for approval or `run.answer(id, string)` for input. A detached request remains pending.

Events are versioned and carry session/run/agent IDs, a monotonically increasing session sequence, a correlation ID, and timestamp. Exactly one coordinator `done` is emitted per run. Child `done` events do not end a parent stream.

`AgentRuntime` is also exported for embedding or injected-provider tests. Embedders own its persistence and lifecycle; production `query` uses the supervisor. A `SessionStore` implementation and per-run provider/tool definitions provide test seams without real credentials.

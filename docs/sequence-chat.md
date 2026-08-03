# Chat (agent conversation)

Every route funnels through `app/api/_lib/agentServer.ts`, which attaches
`x-api-key` server-side so the browser never sees it. Chat is the only flow
that touches the model: it acquires a per-thread lock, replays checkpointed
state, runs the orchestrator, and streams tokens back over SSE.

The run is deliberately **not** tied to this one browser connection anymore:
a disconnect (tab close, refresh, network blip) only stops writes to this
particular reply — the run keeps going server-side to completion, and every
event is durably persisted as it's emitted so a reconnecting client can
replay it. See [Resume after refresh](sequence-resume.md) for that path, and
[Cancel](sequence-cancel.md) for how Stop works now that a disconnect alone
no longer kills the run.

See also: [Thread history](sequence-history.md), [Sprint data view](sequence-sprint.md).

```mermaid
sequenceDiagram
    participant Browser
    participant ChatPanel as ChatPanel.tsx<br/>(app/components)
    participant NextRoute as route.ts<br/>(app/api/chat)
    participant AgentAuth as auth.ts<br/>(src/server)
    participant Routes as routes.ts<br/>(src/server)
    participant SSE as sse.ts<br/>(src/server)
    participant StreamChunks as streamChunks.ts<br/>(src/server)
    participant RunRegistry as runRegistry.ts<br/>(src/server)
    participant Locks as locks.ts<br/>(src/server)
    participant Checkpointer as checkpointer.ts<br/>(src/server)
    participant Agent as agent.ts<br/>(src)
    participant Postgres

    Browser->>ChatPanel: types message, hits Send
    ChatPanel->>ChatPanel: loadOrCreateThreadId()<br/>(localStorage)
    ChatPanel->>NextRoute: POST /api/chat<br/>{ threadId, message }<br/>(no api key)
    NextRoute->>NextRoute: read AGENT_SERVER_API_KEY, AGENT_SERVER_URL (env)
    NextRoute->>Routes: POST /invoke/stream<br/>{ threadId, prompt }<br/>header: x-api-key
    Routes->>AgentAuth: requireApiKey() [onRequest hook]
    AgentAuth->>AgentAuth: lookupApiClient(apiKey)<br/>(apiClients.ts / api-clients.json)
    AgentAuth-->>Routes: 401 if invalid/missing key
    Routes->>Locks: try acquire lock for thread_id
    Locks->>Postgres: INSERT ... ON CONFLICT ... RETURNING
    Postgres-->>Locks: locked (returns run_id) or already-held
    Locks-->>Routes: 409 if already held (stop here)
    Routes->>RunRegistry: registerRun(runId, abortController)<br/>(for /cancel — NOT wired to this reply's disconnect)
    Routes->>Checkpointer: createDeepAgent({ checkpointer })
    Checkpointer->>Postgres: load prior state for thread_id
    Postgres-->>Checkpointer: past messages / agent state
    Routes->>Agent: invoke agent (orchestrator + sub-agents)
    Agent->>Agent: delegates to jiraAnalyst / githubAnalyst<br/>via task tool
    Agent-->>Checkpointer: writes new state after each step
    Checkpointer->>Postgres: save checkpoint for thread_id
    Agent-->>SSE: tokens, tool_call, tool_result,<br/>subagent_start/end, done
    SSE->>StreamChunks: createRunEmitter(): persist each<br/>event (run_id, seq)
    StreamChunks->>Postgres: INSERT INTO stream_chunks
    SSE->>RunRegistry: broadcastLocal(runId, seq, event)<br/>(for any resume subscribers)
    SSE-->>Routes: same SSE event, written to this reply too
    Routes-->>NextRoute: piped SSE response body
    NextRoute-->>ChatPanel: SSE stream (unmodified)
    ChatPanel->>ChatPanel: parse events, render tokens/<br/>tool activity/plan
    ChatPanel-->>Browser: live-updating chat UI
    Note over Browser,Routes: if Browser disconnects here, only writes to<br/>THIS reply stop — the run above keeps running
    Routes->>RunRegistry: unregisterRun(runId) [once run reaches done/error]
    Routes->>Locks: release lock for thread_id
    Locks->>Postgres: DELETE stream_chunks older than<br/>streamChunkTtlHours (TTL sweep)
```

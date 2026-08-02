# Chat (agent conversation)

Every route funnels through `app/api/_lib/agentServer.ts`, which attaches
`x-api-key` server-side so the browser never sees it. Chat is the only flow
that touches the model: it acquires a per-thread lock, replays checkpointed
state, runs the orchestrator, and streams tokens back over SSE.

See also: [Thread history](sequence-history.md), [Sprint data view](sequence-sprint.md).

```mermaid
sequenceDiagram
    participant Browser
    participant ChatPanel as ChatPanel.tsx<br/>(app/components)
    participant NextRoute as route.ts<br/>(app/api/chat)
    participant AgentAuth as auth.ts<br/>(src/server)
    participant Routes as routes.ts<br/>(src/server)
    participant SSE as sse.ts<br/>(src/server)
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
    Postgres-->>Locks: locked or already-held
    Locks-->>Routes: 409 if already held (stop here)
    Routes->>Checkpointer: createDeepAgent({ checkpointer })
    Checkpointer->>Postgres: load prior state for thread_id
    Postgres-->>Checkpointer: past messages / agent state
    Routes->>Agent: invoke agent (orchestrator + sub-agents)
    Agent->>Agent: delegates to jiraAnalyst / githubAnalyst<br/>via task tool
    Agent-->>Checkpointer: writes new state after each step
    Checkpointer->>Postgres: save checkpoint for thread_id
    Agent-->>SSE: tokens, tool_call, tool_result,<br/>subagent_start/end, done
    SSE-->>Routes: SSE event stream
    Routes-->>NextRoute: piped SSE response body
    NextRoute-->>ChatPanel: SSE stream (unmodified)
    ChatPanel->>ChatPanel: parse events, render tokens/<br/>tool activity/plan
    ChatPanel-->>Browser: live-updating chat UI
    Routes->>Locks: release lock for thread_id
```

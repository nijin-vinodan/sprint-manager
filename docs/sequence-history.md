# Thread history (resuming a chat session)

Fired once, on mount, so the ChatPanel can replay prior turns for a `threadId`
recalled from `localStorage` — no agent run involved, just a checkpoint read.

See also: [Chat](sequence-chat.md), [Sprint data view](sequence-sprint.md).

```mermaid
sequenceDiagram
    participant Browser
    participant ChatPanel as ChatPanel.tsx<br/>(app/components)
    participant NextRoute as history/route.ts<br/>(app/api/chat)
    participant AgentAuth as auth.ts<br/>(src/server)
    participant Routes as routes.ts<br/>(src/server)
    participant Checkpointer as checkpointer.ts<br/>(src/server)
    participant Postgres

    Browser->>ChatPanel: page loads, threadId found in localStorage
    ChatPanel->>NextRoute: GET /api/chat/history?threadId=...<br/>(no api key)
    NextRoute->>Routes: GET /threads/:threadId/history<br/>header: x-api-key
    Routes->>AgentAuth: requireApiKey() [onRequest hook]
    AgentAuth-->>Routes: 401 if invalid/missing key
    Routes->>Checkpointer: getCheckpointer()
    Checkpointer->>Postgres: getTuple({ thread_id })
    Postgres-->>Checkpointer: checkpoint (or none)
    Checkpointer-->>Routes: raw messages, or [] if no checkpoint yet
    Routes->>Routes: checkpointMessagesToHistory(rawMessages)
    Routes-->>NextRoute: { threadId, messages }
    NextRoute-->>ChatPanel: JSON passthrough
    ChatPanel->>ChatPanel: render prior turns
    ChatPanel-->>Browser: chat history restored
```

# Resume after refresh (token-level replay)

Fired alongside [Thread history](sequence-history.md) on every ChatPanel
mount — where history only ever recovers *completed* prior turns, this path
recovers a turn that's still in progress. It works because
[Chat](sequence-chat.md) no longer aborts the run when a browser disconnects:
the run keeps going server-side, and every event it emits is durably recorded
in `stream_chunks` (via `createRunEmitter` in `sse.ts`) the instant it
happens. Reconnecting just means reading that backlog from the top, then
falling in step with whatever's still being emitted live.

This is same-replica only today: chunk fan-out to a live subscriber goes
through the in-process `runRegistry.ts`, not a cross-replica channel. A
reconnect that lands on a different replica than the one running the agent
would need Postgres `LISTEN`/`NOTIFY` to tail live chunks — not built yet,
since the deployment is a single Fastify process.

See also: [Chat](sequence-chat.md), [Thread history](sequence-history.md), [Cancel](sequence-cancel.md).

```mermaid
sequenceDiagram
    participant Browser
    participant ChatPanel as ChatPanel.tsx<br/>(app/components)
    participant NextRoute as stream/route.ts<br/>(app/api/chat)
    participant AgentAuth as auth.ts<br/>(src/server)
    participant Routes as routes.ts<br/>(src/server)
    participant RunRegistry as runRegistry.ts<br/>(src/server)
    participant StreamChunks as streamChunks.ts<br/>(src/server)
    participant Postgres

    Note over Browser: page refreshed mid-answer —<br/>the run from Chat keeps going server-side
    Browser->>ChatPanel: page reloads, threadId found in localStorage
    ChatPanel->>ChatPanel: resume effect fires (alongside<br/>the existing history effect)
    ChatPanel->>NextRoute: GET /api/chat/stream?threadId=...<br/>(no api key)
    NextRoute->>Routes: GET /threads/:threadId/stream<br/>header: x-api-key
    Routes->>AgentAuth: requireApiKey() [onRequest hook]
    AgentAuth-->>Routes: 401 if invalid/missing key
    Routes->>Postgres: SELECT locked_by FROM thread_locks<br/>WHERE status = 'running'
    Postgres-->>Routes: run_id, or none

    alt no active run for this thread
        Routes-->>NextRoute: 204 No Content
        NextRoute-->>ChatPanel: 204 (nothing to resume)
        ChatPanel->>ChatPanel: no-op — existing history<br/>fetch already covers completed turns
    else run still active
        Routes->>RunRegistry: subscribeToRun(runId)<br/>(before reading backlog, so nothing<br/>emitted mid-query is lost)
        Routes->>StreamChunks: readStreamChunks(runId)
        StreamChunks->>Postgres: SELECT seq, event<br/>ORDER BY seq ASC
        Postgres-->>StreamChunks: buffered chunks
        StreamChunks-->>Routes: ordered backlog
        Routes-->>NextRoute: replay backlog as SSE frames
        NextRoute-->>ChatPanel: catch-up tokens/tool events
        RunRegistry-->>Routes: live chunks as the run<br/>keeps emitting (same connection)
        Routes-->>NextRoute: live SSE frames, deduped by seq
        NextRoute-->>ChatPanel: live tokens continue
        ChatPanel->>ChatPanel: consumeSseStream() renders replay<br/>+ live as one continuous stream<br/>(same handleEvent as a fresh send)
        Note over Routes,RunRegistry: on done/error, subscriber<br/>unsubscribes and the connection ends
    end

    ChatPanel-->>Browser: chat resumes as if never interrupted
```

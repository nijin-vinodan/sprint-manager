# Cancel (Stop button)

A side effect of [Resume after refresh](sequence-resume.md): since a browser
disconnect no longer aborts the run, the Stop button can't work by simply
closing the connection anymore. It now aborts its own local reader
immediately (so the UI stops right away) *and* asks the server explicitly to
cancel the run.

Same-replica only today — `runRegistry.ts`'s abort-controller map only knows
about runs executing on this process. If the run lives on a different
replica, this is a documented no-op; cross-replica cancel would need the same
`LISTEN`/`NOTIFY` channel that cross-replica resume would (see
[Resume after refresh](sequence-resume.md)).

See also: [Chat](sequence-chat.md), [Resume after refresh](sequence-resume.md).

```mermaid
sequenceDiagram
    participant Browser
    participant ChatPanel as ChatPanel.tsx<br/>(app/components)
    participant NextRoute as cancel/route.ts<br/>(app/api/chat)
    participant AgentAuth as auth.ts<br/>(src/server)
    participant Routes as routes.ts<br/>(src/server)
    participant RunRegistry as runRegistry.ts<br/>(src/server)
    participant Postgres

    Browser->>ChatPanel: clicks Stop
    ChatPanel->>ChatPanel: abortRef.current.abort()<br/>(stops the local reader immediately)
    ChatPanel->>NextRoute: POST /api/chat/cancel<br/>{ threadId } (no api key)
    NextRoute->>Routes: POST /threads/:threadId/cancel<br/>header: x-api-key
    Routes->>AgentAuth: requireApiKey() [onRequest hook]
    AgentAuth-->>Routes: 401 if invalid/missing key
    Routes->>Postgres: SELECT locked_by FROM thread_locks<br/>WHERE status = 'running'
    Postgres-->>Routes: run_id, or none

    alt no active run for this thread
        Routes-->>NextRoute: { cancelled: false }
    else run found, owned by this replica
        Routes->>RunRegistry: cancelRun(runId)
        RunRegistry->>RunRegistry: look up AbortController,<br/>call .abort()
        RunRegistry-->>Routes: true
        Routes-->>NextRoute: { cancelled: true }
    else run found, owned by a different replica
        Routes->>RunRegistry: cancelRun(runId)
        RunRegistry-->>Routes: false (not found locally)
        Routes-->>NextRoute: { cancelled: false }
        Note over Routes: documented gap — Milestone 2 would add<br/>a pg_notify("cancel_run", ...) fallback here
    end

    NextRoute-->>ChatPanel: JSON passthrough
    ChatPanel-->>Browser: input re-enabled, Send button restored
```

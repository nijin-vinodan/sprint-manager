# Docs

## Request sequences

Five independent flows through the dashboard (`app/`) and the standalone
agent server (`src/server/`). All five share the same
`app/api/_lib/agentServer.ts` proxy pattern: the Next.js route holds no logic
of its own beyond attaching `x-api-key` and forwarding.

- [Chat (agent conversation)](sequence-chat.md)
- [Thread history (resuming a chat session)](sequence-history.md)
- [Resume after refresh (token-level replay)](sequence-resume.md)
- [Cancel (Stop button)](sequence-cancel.md)
- [Sprint data view (no agent involved)](sequence-sprint.md)

## Issue resolution history & prediction

Independent of the request sequences above — one manual script, one
background collector, and one tool call the orchestrator makes mid-chat.

- [Backfill, background collector, and live k-NN prediction](sequence-resolution-prediction.md)

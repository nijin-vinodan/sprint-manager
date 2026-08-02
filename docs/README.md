# Docs

## Request sequences

Three independent flows through the dashboard (`app/`) and the standalone
agent server (`src/server/`). All three share the same
`app/api/_lib/agentServer.ts` proxy pattern: the Next.js route holds no logic
of its own beyond attaching `x-api-key` and forwarding.

- [Chat (agent conversation)](sequence-chat.md)
- [Thread history (resuming a chat session)](sequence-history.md)
- [Sprint data view (no agent involved)](sequence-sprint.md)

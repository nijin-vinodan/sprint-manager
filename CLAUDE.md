# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # runs the agent with the default prompt (tsx src/index.ts)
npm run dev -- "What's blocking SMA-42?"   # runs with a custom prompt
npm run build          # tsc -p tsconfig.json
npm run typecheck      # tsc --noEmit
npx tsx src/testTools.ts   # sanity-check the Jira/GitHub tools directly against real data, no model call

npm run dashboard:dev    # starts the Next.js dashboard (next dev) — talks to the agent server over HTTP, no local build needed
npm run dashboard:build  # next build
npm run dashboard:start  # next start (assumes dashboard:build already ran)

npm test              # vitest run — unit tests under tests/ (dateUtils, knn, commentEvaluator, server)
npm run test:watch    # vitest, watch mode

npm run seed:synthetic-resolution   # tsx scripts/generateSyntheticResolutionHistory.ts — seeds issue_resolution_history with synthetic rows
npx tsx scripts/backfillResolutionHistory.ts   # one-off: backfills already-Done/Closed SMA issues into issue_resolution_history as source='real'
npm run loadtest      # tsx scripts/loadtest.ts

DEBUG_AGENT=1 npm run dev -- "..."   # same CLI run, with per-agent tool/delegation logging (see Debugging below)
```

`npm test` runs vitest against `tests/**/*.test.ts` (config in `vitest.config.ts`, setup in `tests/setup.ts`). `src/testTools.ts` remains a separate, throwaway harness that hits the real Jira/GitHub APIs directly, no model/mocking involved.

**Known issue:** `scripts/backfillResolutionHistory.ts` imports from `"../src/featureExtraction.js"`, which doesn't exist — the real module is `src/prediction/featureExtraction.ts`. The script will fail until that import path is fixed; it's also not wired into `package.json` scripts (unlike `seed:synthetic-resolution`).

## Architecture

This is a multi-agent [DeepAgents](https://github.com/langchain-ai/deepagentsjs) system: an orchestrator with no tools of its own, delegating to two read-only sub-agents.

- `src/agent.ts` — `createSprintManagerAgent()` builds the orchestrator via `createDeepAgent`, wired with `ORCHESTRATOR_PROMPT` and the sub-agents below. It holds no Jira/GitHub tools directly.
- `src/agents/jiraAnalyst.ts` / `src/agents/githubAnalyst.ts` — `SubAgent` definitions (name, system prompt, tools, model). Each is facts-only: it fetches and reports data but never judges sprint health or cross-references the other's data.
- `src/agents/jiraWriter.ts` — the one sanctioned **write-capable** sub-agent (`jira-writer`). Posts a Jira comment via `addJiraComment` (`src/tools/jiraComments.ts`) but only after the user has explicitly confirmed the exact comment text in chat — enforced by its description/prompt, not a technical guardrail. Deliberately does not receive `READ_ONLY_NOTICE`. See "Everything is read-only by design" below for how this fits the rest of the system.
- `src/prompts/` — one file per agent's system prompt (`orchestrator.ts`, `jiraAnalyst.ts`, `githubAnalyst.ts`, `jiraWriter.ts`, `digest.ts`), plus `shared.ts` for the `READ_ONLY_NOTICE` the three read-only prompts include.
- `src/tools/jira.ts` / `src/tools/github.ts` — Zod-typed `langchain` `tool()` wrappers around the Jira Cloud REST/Agile API and the GitHub REST API.
- `src/tools/jiraComments.ts` — `addJiraComment`, the write tool used by `jira-writer` only.
- `src/config.ts` — required env vars (throws at startup if missing) plus the `thresholds` object (`STALE_TICKET_DAYS`, `STALE_PR_DAYS`, `K_NEIGHBORS`) used by the tools.
- `src/dateUtils.ts` — shared helpers (`daysSince`, `daysUntil`, `isPastDue`, `extractIssueKey`, `adfToPlainText`) used by both tool files.
- `src/index.ts` — CLI entry point; takes an optional prompt as `process.argv[2]`.
- `src/testTools.ts` — throwaway script exercising the tools directly, no agent/model involved.
- `src/tracing.ts` — Langfuse/OpenTelemetry callback handler (`langfuseCallbacks`), enabled when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set. `shutdownTracing()` (CLI) fully tears down the SDK; `flushTracing()` (dashboard) just flushes so the long-lived server process keeps running.
- `src/debugLogger.ts` — `AgentDebugLogger`, a `BaseCallbackHandler` gated behind `DEBUG_AGENT=1` (`debugCallbacks`, empty array otherwise). Logs every tool/model call prefixed with which agent is actually running it (`[orchestrator]`, `[jira-analyst]`, `[github-analyst]`), by propagating a label from parent run to child run and re-labeling whenever the `task` tool fires (deepagents' delegation mechanism). Wired into both `src/index.ts` and `src/server/routes.ts`.

### Resolution-time prediction (`src/prediction/`)

A hand-rolled k-NN model (no ML library dependency) predicts how many workdays a Jira issue will take to resolve, exposed both as an agent tool and a dashboard page (`app/components/ResolutionPredictor.tsx`).

- `src/prediction/featureExtraction.ts` — turns a fetched issue + comment count into an `IssueFeatures` vector (`issueType`, `priority`, `storyPoints` — proxied from Jira's Original Estimate ÷ 8h workday, no dedicated Story Points field — `labels`, `assignee`, `dependencyCount`, `commentCount`, `reopenCount`); also `resolutionDaysFor()` for backfill.
- `src/prediction/knn.ts` — the distance function (normalized numeric deltas + categorical mismatches, nulls filled with the pool mean) and `predictResolutionDays()`: weighted k-NN that prefers `source='real'` neighbors, only falling back to the combined real+synthetic pool when nothing real is within `REAL_NEIGHBOR_DISTANCE_THRESHOLD` (hardcoded `1.5`, not env-driven). `usedFallbackToSynthetic` flags when that fallback happened.
- `src/prediction/confidence.ts` — `scoreConfidence()`, scoped to distance-to-closest-**real**-neighbor only; a synthetic-only match is downgraded to `low` regardless of distance.
- `src/prediction/resolutionPrediction.ts` — `predictResolutionTime`, the `tool()` exposing this to the orchestrator (accepts an `issueKey` for a live fetch, or a raw `features` object for an ad hoc what-if). Excludes the target issue from its own candidate pool (leave-one-out) if it's already backfilled into history.
- `src/server/resolutionHistory.ts` — Postgres store for `issue_resolution_history` (real vs synthetic rows, `CHECK` constraint on `source`, unique per `(issue_key, source)`).
- `scripts/generateSyntheticResolutionHistory.ts` (`npm run seed:synthetic-resolution`) — generates ~200 formula-derived synthetic rows to pad the candidate pool and validate k-NN mechanics against known ground truth.
- `scripts/backfillResolutionHistory.ts` — one-off backfill of already-resolved SMA issues as `source='real'` (see the known-broken-import note under Commands above).
- `app/api/digest/_resolutionCollector.ts` — a lazily-started `setInterval` (default every `RESOLUTION_COLLECTOR_INTERVAL_MINUTES=20`, local constant not in `src/config.ts`) that POSTs to the agent server's `/internal/collect-resolution-history` to keep real history fresh as issues get closed.
- `app/api/predict/route.ts` — thin proxy to the agent server's `GET /predict/:issueKey`, used by `ResolutionPredictor.tsx`.
- See `docs/sequence-resolution-prediction.md` for the full backfill/collector/predict sequence diagram.

### Jira comment evaluator (`src/commentEvaluator/`) — implemented, not wired up

A rule-based engine (8 rules in `ruleEngine.ts` — staleness, no-activity-near-end, unassigned, reassigned-no-context, overdue, blocked — via `evaluateTicket()`) that would post an automated nudge comment to Jira, deduped per `(issueKey, ruleId, status)` via a `bot_comments` table (`dedupStore.ts`) so a status change re-enables nudging but nothing else re-triggers it. `evaluator.ts`'s `evaluateAndComment()` orchestrates rule match → dedup check → `postJiraComment` (`jiraClient.ts`, prefixes a hidden bot marker) → record.

**This has no production caller.** It's fully unit-tested (`tests/commentEvaluator/*.test.ts`) but not wired into any route, scheduler, cron, or agent tool — nothing in the repo currently constructs a live `TicketContext` and calls it. Treat it as implemented-but-dormant, not active. If you wire it up, note it would be a second, fully-automated write path distinct from `jira-writer` (which requires human confirmation in chat) — call this out explicitly since it's a deliberate exception to the read-only design below.

### Standalone agent server (`src/server/`)

A hand-rolled Fastify service (no LangGraph Server) that runs the same `createDeepAgent()` in-process and exposes it over HTTP — `GET /health`, `GET /threads/:threadId/history`, `GET /sprint`, `GET /predict/:issueKey`, `POST /internal/collect-resolution-history`, `POST /invoke`, `POST /invoke/stream`, `GET /threads/:threadId/stream`, `POST /threads/:threadId/cancel` — for any application to call, auth'd via a gitignored `api-clients.json` (API key → app name; loaded/cached once per process by `src/server/apiClients.ts`, read by the `requireApiKey` hook in `src/server/auth.ts`). This is now the **only** place in the repo that actually invokes the agent outside the CLI; the dashboard talks to it over HTTP rather than embedding the agent itself. `GET /sprint` and `GET /predict/:issueKey` bypass the orchestrator entirely (direct tool/prediction calls), so they aren't agent invocations at all. See the "Standalone agent server" section in `README.md` for the full contract, env vars, and architecture diagrams.

Two things that make it different from the CLI's one-shot `createSprintManagerAgent()`:
- **`src/server/checkpointer.ts`** wires a Postgres-backed `PostgresSaver` (`@langchain/langgraph-checkpoint-postgres`) into `createDeepAgent({ checkpointer })`, so conversation state per `thread_id` survives restarts and is shared across replicas — not held in process memory.
- **`src/server/locks.ts`** adds a `thread_locks` table as a concurrency guard (replacing what LangGraph Server's `multitaskStrategy: "reject"` would give for free): before invoking the agent for a `thread_id`, the route atomically tries to acquire that thread's lock via a single `INSERT ... ON CONFLICT ... WHERE ... RETURNING`, and returns `409` immediately if it's already held — no queueing. `acquireLockOrReject` now returns `{ acquired, runId }` rather than a bare boolean — a successful acquisition's `locked_by` UUID doubles as the canonical `runId` used to key stream persistence and cancellation.

#### Resumable streaming and cancellation (`runRegistry.ts`, `streamChunks.ts`)

A run's SSE output is no longer tied to the one HTTP connection that started it, so a page refresh mid-answer can reattach to the same run instead of losing it, and a run can be stopped explicitly instead of only by disconnecting.

- **Client disconnect no longer aborts the run.** `POST /invoke/stream`'s `request.raw.on("close", ...)` used to call `abortController.abort()`; now it only stops writing to the dead reply. The agent keeps running server-side to completion even if nobody is listening.
- **`src/server/streamChunks.ts`** persists every SSE event to a new `stream_chunks` Postgres table (`run_id, seq, thread_id, event JSONB, created_at`, PK `(run_id, seq)`), via `insertStreamChunk`/`readStreamChunks`. This is the durable backlog a resumed stream replays from.
- **`src/server/runRegistry.ts`** is in-memory, same-replica-only bookkeeping: an `AbortController` per `runId` (for cancel) and a set of live chunk listeners per `runId` (for fan-out to whoever's currently watching). Cross-replica coordination (e.g. Postgres `LISTEN`/`NOTIFY`) is not implemented — cancel/resume only work against the replica that owns the run.
- **`src/server/sse.ts`'s `createRunEmitter(threadId, runId)`** wraps every emitted event: fire-and-forget persist to `stream_chunks`, then synchronous local broadcast to any subscribers. Persistence failures are swallowed so they never break the live stream.
- **`GET /threads/:threadId/stream`** — resume endpoint. Looks up the thread's active run from `thread_locks` (`status='running'`, not stale per `lockStaleSeconds`); `204 No Content` if none. Otherwise hijacks the connection, subscribes to live broadcasts *before* reading the backlog (so nothing emitted mid-query is lost), replays `readStreamChunks(runId)` from `seq=0`, then drains anything buffered during that read and continues forwarding live events — deduped by `lastSeqSent`. Same SSE event schema as `/invoke/stream` (see below); this is just a different entry point into it.
- **`POST /threads/:threadId/cancel`** — looks up the thread's active `runId` from `thread_locks` and calls `runRegistry.cancelRun(runId)`, which aborts the registered `AbortController` if one exists locally. Responds `{ cancelled: boolean }`; `false` if the run isn't tracked on this replica.
- **`releaseLock()`** now also sweeps expired `stream_chunks` rows (`created_at` older than `STREAM_CHUNK_TTL_HOURS`, default `12`, from `src/server/config.ts`) every time a lock is released — piggybacking cleanup on the existing per-run lock-release point rather than a separate scheduled job. Cancellation doesn't special-case lock release: aborting just makes the run loop throw, which hits the same `finally`/`releaseLock` path as any other error.
- See `docs/sequence-resume.md` and `docs/sequence-cancel.md` for full sequence diagrams; both flag the same-replica limitation above as a known gap, not yet addressed.

### Dashboard (Next.js, `app/`)

A Next.js app sits on top of the agent for a browser UI — this is newer than the CLI and not the primary architecture described above, but it's a real, maintained part of the repo. **It never calls the agent in-process** — both of its agent-backed routes are thin proxies to the standalone server above, over HTTP, using `AGENT_SERVER_URL` + `AGENT_SERVER_API_KEY`.

- `app/api/chat/history/route.ts` — proxies `GET /api/chat/history?threadId=...` to the agent server's `GET /threads/:threadId/history`, `400` if `threadId` is missing. Used by `ChatPanel.tsx` to reload prior turns on mount, before checking `/api/chat/stream` for an in-flight run to resume.
- `app/api/chat/route.ts` — proxies `POST /api/chat` (`{ threadId, message }` from the client) straight through to the agent server's `POST /invoke/stream`, piping the upstream SSE response body back to the client unmodified. Holds no agent/pumping logic itself — that lives in `src/server/sse.ts` / `src/server/routes.ts` now, so the SSE event schema (`token`, `tool_call`, `tool_result`, `subagent_start`/`subagent_end`, `done`, `error`) is produced once, not duplicated per caller. Note: a client disconnect from this route no longer stops the agent server-side (see resumable streaming above) — the run keeps going and can be reattached to or explicitly cancelled.
- `app/api/chat/stream/route.ts` — proxies `GET /api/chat/stream?threadId=...` to the agent server's `GET /threads/:threadId/stream`. Passes a `204` straight through as-is (nothing to resume); wraps a non-OK upstream response as `{ error }` JSON; otherwise pipes the SSE body through unmodified, same as the send path.
- `app/api/chat/cancel/route.ts` — proxies `POST /api/chat/cancel` (`{ threadId }`) to the agent server's `POST /threads/:threadId/cancel`, passing the `{ cancelled }` JSON response straight through.
- `app/components/ChatPanel.tsx` — client component; generates one `threadId` (`crypto.randomUUID()`) per mounted session and reuses it for every send in that session, so the agent server's checkpointer recalls prior turns without the client resending message history. `fetch("/api/chat", { method: "POST" })`, reads the response as an SSE stream, and renders streamed tokens plus sub-agent/tool activity. A `409` response (a run already in progress for this session's thread) surfaces as "Still working on your last question..." rather than a raw status code. On every mount it also calls `GET /api/chat/stream?threadId=...` to check for (and reattach to) an in-flight run left over from before a refresh — a `204` means nothing to resume and falls back to the existing `/api/chat/history` fetch; resume is entirely server-driven, no run ID is persisted client-side. `handleEvent` (the SSE event switch) and the SSE frame-parsing loop (`consumeSseStream`) are both shared between the fresh-send path and the resume path so they can't drift apart. `cancel()` now also fires `POST /api/chat/cancel` (best-effort) in addition to aborting the local reader, since aborting locally no longer stops the server-side run on its own.
- `app/api/digest/route.ts` / `app/api/digest/_scheduler.ts` — a periodic background job (`ensureDigestScheduler()`), independent of chat, that reruns a fixed "what's at risk" prompt on an interval (`DIGEST_INTERVAL_MINUTES`) and caches the latest result on `globalThis`. Also proxies to the agent server's `POST /invoke` (non-streaming), using a **fresh `threadId` every tick** (`digest-${randomUUID()}`) rather than a stable one — each tick is an independent snapshot, not a growing conversation, and a fresh thread per run means a slow tick can never `409` against its own next one.
- `app/api/sprint/route.ts` — thin proxy to the standalone agent server's `GET /sprint`, same pattern as the chat/digest routes. The actual cross-referencing (calling `getActiveSprint`/`getSprintIssues`/`getOpenPullRequests`/`getRecentCommits` directly and stitching tickets to PRs/commits, bypassing the orchestrator) now lives in `src/server/routes.ts`, not in the dashboard. Used by `app/components/SprintBoard.tsx` for a plain data view, separate from the chat path.
- `app/api/predict/route.ts` — thin proxy to `GET /predict/:issueKey` on the agent server; used by `app/components/ResolutionPredictor.tsx`. See the resolution-prediction section above.

**No dashboard route imports from `dist/` anymore.** Every `app/api/*` route (`chat`, `chat/history`, `sprint`, `digest`, `predict`) is a pure HTTP proxy to the standalone agent server via `agentServerFetch` (`app/api/_lib/agentServer.ts`) — the dashboard has no agent/Jira/GitHub logic of its own left to compile. `digest/_scheduler.ts` imports `DIGEST_PROMPT` directly from `src/prompts/digest.ts` (a plain string constant, safe to import as source) rather than from `dist/`. This means `next dev`/`next build` need no prior `npm run build` step — `tsconfig.json`'s `rootDir: "src"` / `outDir: "dist"` compile is now only relevant to `server:build`/`server:start` (the standalone agent server's own deploy artifact), not the dashboard.

**Dashboard layout (`app/page.tsx` / `app/layout.tsx`)** — `layout.tsx` injects a pre-hydration script that sets the `.dark` class from `localStorage("theme")` (falling back to `prefers-color-scheme`) before paint, then renders `<Header />` above `{children}`. `page.tsx` lays out a tab bar (`app/components/Tabs.tsx`) with three tabs — `"board"` → `SprintBoard`, `"digest"` → `SprintHealthDigest` (alert dot driven by the invisible `DigestAlertTracker`, which polls `/api/digest` and compares against a `localStorage` last-viewed timestamp), `"predict"` → `ResolutionPredictor` — plus a permanently-visible chat `Sidebar` (collapsible, drag-resizable, state in `localStorage`) that is not itself a tab. Dark mode is a plain `.dark` class toggle (`ThemeToggle.tsx` + `useIsDarkMode.ts`), not a React context. `app/lib/fuzzyMatch.ts` and `app/lib/formatDuration.ts` are small helpers used only by `ResolutionPredictor.tsx` (ticket search, workday-duration formatting).

**Only the orchestrator cross-references Jira against GitHub.** Both sub-agents are deliberately kept blind to each other's data — matching happens in the orchestrator via `linkedIssueKey`, which the tools extract from PR titles/bodies and commit messages (regex match against `config.jira.projectKey`, e.g. `SMA-123`). Sub-agents must never be asked to do this cross-referencing themselves.

**Tools return pre-digested facts, not raw API payloads.** Every tool computes `daysSinceUpdate`/`isOverdue`/`ageDays`/`isStale`/`reviewState`/`linkedIssueKey` before returning, so no agent does date math, regex extraction, or ADF (Atlassian Document Format) parsing itself. When adding a new tool, follow this pattern rather than pushing computation into a prompt.

**Everything is read-only by design, with one sanctioned exception.** `READ_ONLY_NOTICE` (`src/prompts/shared.ts`) is included in the orchestrator, `jira-analyst`, and `github-analyst` prompts. `jira-writer` (`src/agents/jiraWriter.ts`) deliberately does not receive it — it's the one write-capable sub-agent, gated by a requirement that the user has already confirmed the exact comment text in chat, not a technical guardrail. Do not add other write/comment/transition tools to `src/tools/` without an explicit request. The dormant `commentEvaluator` rule engine (see above) would be a second, fully-automated write path if it's ever wired up — treat that as a deliberate, separate decision, not an extension of `jira-writer`'s existing scope.

**Model config note:** `src/config.ts` currently configures the model via `ChatAnthropic` pointed at a LiteLLM proxy (`ANTHROPIC_MODEL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`). `.env.example` and `README.md` still describe the earlier Bedrock (`ChatBedrockConverse` / `AGENT_MODEL` / `AWS_*`) setup — treat `config.ts` as the source of truth for what env vars are actually required.

**`STREAM_CHUNK_TTL_HOURS`** (`src/server/config.ts`, default `12`) controls how long `stream_chunks` rows survive before `releaseLock()` sweeps them — not currently listed in `.env.example`; treat `config.ts` as the source of truth here too.

### How `createDeepAgent` actually works (from `node_modules/deepagents/dist/langsmith-DVh4u6Za.js` — the package's public `.d.ts`/README don't spell this out)

`createDeepAgent` (called once, in `src/agent.ts`) builds a fixed middleware stack: `todoListMiddleware → createFilesystemMiddleware → createSubAgentMiddleware → createSummarizationMiddleware → createPatchToolCallsMiddleware`. None of this is configured in this repo beyond passing `subagents`, so all defaults apply:

- **Planning** — `todoListMiddleware()` (from `langchain`, not deepagents) gives the orchestrator an optional `write_todos` tool. The model decides whether to use it; single-shot questions usually skip it, multi-step ones tend to trigger it.
- **Delegation** — `createSubAgentMiddleware` turns each `SubAgent` in `subagents: [jiraAnalyst, githubAnalyst]` into one delegation target, exposed to the orchestrator as a single `task` tool. Calling `task({ subagent_type, description })` *is* the split: `description` is the sub-task instruction the orchestrator's own model turn writes.
- **Filesystem "memory" is virtual, not disk.** `createFilesystemMiddleware` gives `ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep` tools, backed by whatever `backend` is passed to `createDeepAgent` — since `src/agent.ts` doesn't pass one, it defaults to `StateBackend`, an in-memory filesystem living inside LangGraph state. It does **not** persist across process restarts or separate CLI invocations. Real persistence would require explicitly passing `backend: new FilesystemBackend({ rootDir: ... })`.
- **Reflection/review is really `createSummarizationMiddleware`**, not an explicit review step. It wraps every model call and, once the conversation exceeds a token trigger, compresses older messages and writes the evicted history to `/conversation_history/{thread_id}.md` on that same virtual filesystem. It fires silently (no tool call), so it only shows up in `DEBUG_AGENT=1` logs as filesystem writes under `/conversation_history/`, and only on long conversations.

# Fix resumable streaming/cancellation for multi-replica agent-server

## Context

The AWS deployment (already live) deliberately pins the agent-server ECS service to `desiredCount: 1`, specifically because `src/server/runRegistry.ts` tracks in-flight runs (for cancel and for live-resume fan-out) in **plain in-memory Maps**, scoped to a single Node process. `docs/sequence-resume.md` and `docs/sequence-cancel.md`, plus comments in `runRegistry.ts` (lines 5-10) and `routes.ts` (lines 492-494), already flag this explicitly as a known, unfixed gap ("Milestone 2: Postgres LISTEN/NOTIFY"). The user wants to actually close that gap so the agent-server can be scaled to 2+ replicas (and get CPU-based auto-scaling) without silently broken cancel/resume.

**Precise mechanics of the bug** (from code inspection):
- `runId` is a random UUID (`locks.ts:72`) generated per-invoke and stored as `thread_locks.locked_by` — durable in Postgres, replica-agnostic by design.
- `stream_chunks` (Postgres) already durably logs every SSE event per `runId`, replica-agnostic — `readStreamChunks` can replay it from any replica.
- The only replica-local state is `runRegistry.ts`'s `abortControllers` (for cancel) and `subscribers` (for live fan-out during resume) — populated only on the replica that is actually running `pumpRun`/`createRunEmitter` for that `runId`.
- `POST /threads/:threadId/cancel` (`routes.ts:477-497`): finds `runId` fine (from `thread_locks`, replica-agnostic), but `cancelRun(runId)` only succeeds if this replica happens to own it — otherwise silent `{cancelled: false}` even though a run is genuinely active elsewhere.
- `GET /threads/:threadId/stream` (`routes.ts:393-475`): replays the Postgres backlog fine (replica-agnostic), but the *live* tail after that only works via `subscribeToRun`, which is a no-op if this replica isn't the owner — the connection hangs with no further data and no terminal frame.

## Options considered

| Approach | Latency | New infra/risk | Notes |
|---|---|---|---|
| **Postgres polling backstop (recommended)** | ~1-2s bound | None — reuses existing Neon Postgres, no new connections/services | Simple, robust, works identically regardless of Neon's pooled vs. direct connection string |
| Postgres `LISTEN`/`NOTIFY` | Near-instant | Needs a dedicated long-lived connection per replica, reconnect/backoff logic | Neon's pooled connection string (PgBouncer transaction-mode pooling) does **not** support `LISTEN`/`NOTIFY` — would require wiring a second, *unpooled* Neon connection string just for this, adding a config/ops footgun |
| ALB/sticky-session routing | N/A | Doesn't apply | Agent-server sits behind ECS Service Connect, not an ALB — no per-thread session affinity mechanism available there, and it wouldn't survive a task replacement anyway (still needs a durable fallback) |
| Direct replica-to-replica proxying (store each task's private IP, forward the request) | Near-instant | New internal-only HTTP routes, task self-IP-discovery, SSE proxy plumbing | Fastest option but materially more moving parts; worth revisiting only if 1-2s cancel/resume latency proves unacceptable in practice |

Going with the **Postgres polling backstop** — lowest risk, no new infrastructure, and the existing schema already has everything needed except one new column.

## Design

Keep the existing same-replica fast path untouched (instant local `cancelRun`/`broadcastLocal` when the request happens to land on the owning replica) and add a **durable, poll-based fallback** for the cross-replica case, reusing `thread_locks` and `stream_chunks` as the single source of truth — `runRegistry.ts`'s in-memory maps become a same-replica optimization, not the only path.

### 1. Schema: `src/server/locks.ts`
- Add `cancel_requested_at TIMESTAMPTZ NULL` to `thread_locks` (via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, since `CREATE TABLE IF NOT EXISTS` won't retroactively alter the already-live table).
- Add `requestCancel(threadId, runId)` — `UPDATE thread_locks SET cancel_requested_at = now() WHERE thread_id=$1 AND locked_by=$2 AND status='running'` (the `locked_by` match guards against canceling a *newer* run that reused the same thread after the original finished).
- Add `isCancelRequested(threadId, runId)` — reads that column back for the polling check below.

### 2. Owning-replica self-check: wherever `pumpRun`/`createRunEmitter` live (`src/server/sse.ts`)
- On `registerRun`, also start a `setInterval` (~1s) that calls `isCancelRequested(threadId, runId)`; if true, call the existing local `cancelRun(runId)` (no new abort machinery — just a new trigger source for the code that already exists).
- Clear the interval in the same `finally` block that already calls `unregisterRun` (`routes.ts:375`).

### 3. `POST /threads/:threadId/cancel` (`routes.ts`)
- Keep trying local `cancelRun(runId)` first (instant same-replica path).
- **Always** also call `requestCancel(threadId, runId)` (cheap, idempotent) so the owning replica — wherever it is — picks it up on its next poll tick within ~1s.
- Response semantics stay `{ cancelled: true }` once the request is durably recorded (matches today's optimistic contract; it now actually reaches the right replica instead of silently no-op'ing).

### 4. `GET /threads/:threadId/stream` resume (`routes.ts`)
- Keep the existing backlog replay + `subscribeToRun` local fast path unchanged.
- Add a uniform polling backstop after that: every ~1.5-2s, call a new `readStreamChunksSince(runId, lastSeqSent)` (extend `src/server/streamChunks.ts` with `WHERE run_id=$1 AND seq > $2 ORDER BY seq ASC`), forward any new rows the same way as the backlog replay, and update `lastSeqSent`. Runs uniformly on every replica (harmless no-op on the owning replica, since local push already delivered those rows — dedup via `lastSeqSent`).
- Stop the poll (clear interval, end the reply) when a `done`/`error` event is observed, when `thread_locks.status` for that thread is no longer `'running'`, or after `lockStaleSeconds` of no update (treat as abandoned) — reuses data already being read, no new termination signal needed.

### 5. Docs
- Rewrite `docs/sequence-resume.md` / `docs/sequence-cancel.md` to replace the "documented gap" language with the new poll-based cross-replica sequence.
- Update `CLAUDE.md`'s "Resumable streaming and cancellation" section once implemented, so it no longer describes this as an open limitation.

### 6. Once merged and verified
- Safe to raise the agent-server ECS service's `desiredCount` above 1 and add the CPU-based target-tracking auto-scaling discussed earlier (`infra/lib/services-stack.ts`) — no longer blocked by this correctness issue.

## Verification

- Unit tests (extend `tests/server/`): directly test `requestCancel`/`isCancelRequested` and `readStreamChunksSince` against a test Postgres instance; test that the self-check interval calls `cancelRun` once `isCancelRequested` flips true (inject/mock the interval callback rather than waiting on real timers).
- Manual/integration test post-deploy: bump agent-server `desiredCount` to 2 in a test stack, start a long-running chat, identify (via CloudWatch Logs) which task is running it, send `POST /cancel` repeatedly until routed to the *other* task (Service Connect load-balances per-connection), confirm the run actually aborts within ~1s. Same for resume: disconnect and reconnect until routed to the non-owning replica, confirm live tokens keep arriving instead of hanging.

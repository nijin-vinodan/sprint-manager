import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { pool } from "./db.js";
import { serverConfig } from "./config.js";
import { ensureStreamChunksTable } from "./streamChunks.js";

let migrated: Promise<void> | undefined;

async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS thread_locks (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'released',
      locked_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // CREATE TABLE IF NOT EXISTS above won't retroactively add this column to
  // an already-live table, hence the separate ALTER.
  await pool.query(`
    ALTER TABLE thread_locks ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
  `);
}

export async function ensureLocksTable(): Promise<void> {
  if (!migrated) migrated = migrate();
  await migrated;
}

/**
 * Atomically try to acquire the run lock for a thread.
 *
 * This is a single UPSERT statement, not a read-then-write pair — the whole
 * check-and-set happens inside one INSERT ... ON CONFLICT, which Postgres
 * evaluates under a row-level lock it takes on the conflicting row before
 * checking the WHERE predicate. Two replicas racing on the same thread_id
 * serialize on that row lock: whichever commits first flips the row to
 * 'running' and gets a row back from RETURNING; the other's WHERE clause
 * then sees status = 'running' with a fresh updated_at, so its UPDATE
 * matches zero rows and RETURNING gives it nothing. There is no window
 * between a read and a write for both to slip through.
 *
 * A row also becomes reclaimable if it's been 'running' for longer than
 * lockStaleSeconds, so a replica that crashed mid-run (skipping its
 * `finally` release) doesn't leave the thread locked forever.
 */
export async function acquireLock(threadId: string, lockedBy: string): Promise<boolean> {
  await ensureLocksTable();
  const result = await pool.query(
    `
    INSERT INTO thread_locks (thread_id, status, locked_by, updated_at)
    VALUES ($1, 'running', $2, now())
    ON CONFLICT (thread_id) DO UPDATE
      SET status = 'running', locked_by = EXCLUDED.locked_by, updated_at = now()
      WHERE thread_locks.status = 'released'
         OR thread_locks.updated_at < now() - ($3 || ' seconds')::interval
    RETURNING thread_id;
    `,
    [threadId, lockedBy, serverConfig.lockStaleSeconds],
  );
  return result.rowCount === 1;
}

export interface AcquireLockResult {
  acquired: boolean;
  /** The lock-owner UUID, doubling as this run's run_id for stream_chunks — only set when acquired. */
  runId?: string;
}

/**
 * Shared by /invoke and /invoke/stream: generates a lock owner, tries to
 * acquire the thread's lock, and sends the 409 conflict reply itself if it
 * can't. Returns whether the caller now holds the lock (and its run_id) and
 * should proceed.
 */
export async function acquireLockOrReject(threadId: string, reply: FastifyReply): Promise<AcquireLockResult> {
  const lockOwner = randomUUID();
  const acquired = await acquireLock(threadId, lockOwner);
  if (!acquired) {
    reply.code(409).send({ error: "run already in progress for this thread", threadId });
    return { acquired: false };
  }
  return { acquired: true, runId: lockOwner };
}

/**
 * Durably records a cancellation request for a thread's *current* run, so
 * any replica can see it — not just the one that happens to be running the
 * agent loop for it. The locked_by match guards against canceling a newer
 * run that reused the same thread after the original one finished.
 *
 * This is the cross-replica fallback for cancelRun() in runRegistry.ts,
 * which only works when the cancel request happens to land on the replica
 * that owns the run. The owning replica polls isCancelRequested() and calls
 * its own local cancelRun() once it sees this flag set.
 */
export async function requestCancel(threadId: string, runId: string): Promise<void> {
  await ensureLocksTable();
  await pool.query(
    `UPDATE thread_locks SET cancel_requested_at = now()
     WHERE thread_id = $1 AND locked_by = $2 AND status = 'running';`,
    [threadId, runId],
  );
}

/** Polled by the replica actually running a given run to notice a cross-replica cancel request. */
export async function isCancelRequested(threadId: string, runId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM thread_locks
     WHERE thread_id = $1 AND locked_by = $2 AND cancel_requested_at IS NOT NULL;`,
    [threadId, runId],
  );
  return result.rowCount === 1;
}

/**
 * Releases a thread's lock. Safe to call even if the lock was never acquired, or already released.
 *
 * Also sweeps stream_chunks rows older than streamChunkTtlHours — piggybacked
 * here (once per completed run) rather than on a separate scheduler, mirroring
 * how lockStaleSeconds already handles a crashed replica's stale lock rows.
 */
export async function releaseLock(threadId: string): Promise<void> {
  await pool.query(
    `UPDATE thread_locks SET status = 'released', updated_at = now() WHERE thread_id = $1;`,
    [threadId],
  );
  await ensureStreamChunksTable();
  await pool.query(
    `DELETE FROM stream_chunks WHERE created_at < now() - ($1 || ' hours')::interval;`,
    [serverConfig.streamChunkTtlHours],
  );
}

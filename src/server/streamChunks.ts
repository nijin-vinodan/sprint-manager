import type { SseEvent } from "./sse.js";
import { pool } from "./db.js";

let migrated: Promise<void> | undefined;

async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stream_chunks (
      run_id     TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      thread_id  TEXT NOT NULL,
      event      JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS stream_chunks_thread_run_idx ON stream_chunks (thread_id, run_id, seq);
    CREATE INDEX IF NOT EXISTS stream_chunks_created_at_idx ON stream_chunks (created_at);
  `);
}

export async function ensureStreamChunksTable(): Promise<void> {
  if (!migrated) migrated = migrate();
  await migrated;
}

export async function insertStreamChunk(
  runId: string,
  seq: number,
  threadId: string,
  event: SseEvent,
): Promise<void> {
  await ensureStreamChunksTable();
  await pool.query(
    `INSERT INTO stream_chunks (run_id, seq, thread_id, event) VALUES ($1, $2, $3, $4);`,
    [runId, seq, threadId, JSON.stringify(event)],
  );
}

export interface StreamChunkRow {
  seq: number;
  event: SseEvent;
}

/** Reads a run's buffered chunks in order, for a reconnecting client to replay. */
export async function readStreamChunks(runId: string): Promise<StreamChunkRow[]> {
  await ensureStreamChunksTable();
  const result = await pool.query<{ seq: number; event: SseEvent }>(
    `SELECT seq, event FROM stream_chunks WHERE run_id = $1 ORDER BY seq ASC;`,
    [runId],
  );
  return result.rows;
}

/**
 * Polled by a resuming replica that doesn't own the run locally, to tail new
 * chunks a different replica's emitter is writing — the cross-replica
 * fallback for the in-process broadcastLocal() fan-out in runRegistry.ts.
 */
export async function readStreamChunksSince(runId: string, sinceSeq: number): Promise<StreamChunkRow[]> {
  await ensureStreamChunksTable();
  const result = await pool.query<{ seq: number; event: SseEvent }>(
    `SELECT seq, event FROM stream_chunks WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC;`,
    [runId, sinceSeq],
  );
  return result.rows;
}

import { pool } from "./db.js";

let migrated: Promise<void> | undefined;

async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS issue_resolution_history (
      id SERIAL PRIMARY KEY,
      issue_key TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      story_points NUMERIC,
      labels JSONB NOT NULL DEFAULT '[]',
      assignee TEXT,
      dependency_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      reopen_count INTEGER NOT NULL DEFAULT 0,
      resolution_days NUMERIC NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('real', 'synthetic')),
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS issue_resolution_history_issue_key_source_idx
      ON issue_resolution_history (issue_key, source);
  `);
  await pool.query(`
    ALTER TABLE issue_resolution_history
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `);
}

export async function ensureResolutionHistoryTable(): Promise<void> {
  if (!migrated) migrated = migrate();
  await migrated;
}

export interface ResolutionRecord {
  issueKey: string;
  issueType: string;
  priority: string;
  storyPoints: number | null;
  labels: string[];
  assignee: string | null;
  dependencyCount: number;
  commentCount: number;
  reopenCount: number;
  resolutionDays: number;
  source: "real" | "synthetic";
  closedAt: string | null;
}

interface ResolutionHistoryRow {
  issue_key: string;
  issue_type: string;
  priority: string;
  story_points: string | null;
  labels: string[];
  assignee: string | null;
  dependency_count: number;
  comment_count: number;
  reopen_count: number;
  resolution_days: string;
  source: "real" | "synthetic";
  closed_at: string | null;
}

function toResolutionRecord(row: ResolutionHistoryRow): ResolutionRecord {
  return {
    issueKey: row.issue_key,
    issueType: row.issue_type,
    priority: row.priority,
    storyPoints: row.story_points != null ? Number(row.story_points) : null,
    labels: row.labels,
    assignee: row.assignee,
    dependencyCount: row.dependency_count,
    commentCount: row.comment_count,
    reopenCount: row.reopen_count,
    resolutionDays: Number(row.resolution_days),
    source: row.source,
    closedAt: row.closed_at,
  };
}

/** Upserts by (issue_key, source) — safe to re-run for the same issue (backfill re-runs, collector overlap). */
export async function insertResolutionRecord(record: ResolutionRecord): Promise<void> {
  await ensureResolutionHistoryTable();
  await pool.query(
    `
    INSERT INTO issue_resolution_history
      (issue_key, issue_type, priority, story_points, labels, assignee, dependency_count, comment_count, reopen_count, resolution_days, source, closed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (issue_key, source) DO UPDATE SET
      issue_type = EXCLUDED.issue_type,
      priority = EXCLUDED.priority,
      story_points = EXCLUDED.story_points,
      labels = EXCLUDED.labels,
      assignee = EXCLUDED.assignee,
      dependency_count = EXCLUDED.dependency_count,
      comment_count = EXCLUDED.comment_count,
      reopen_count = EXCLUDED.reopen_count,
      resolution_days = EXCLUDED.resolution_days,
      closed_at = EXCLUDED.closed_at,
      updated_at = now();
    `,
    [
      record.issueKey,
      record.issueType,
      record.priority,
      record.storyPoints,
      JSON.stringify(record.labels),
      record.assignee,
      record.dependencyCount,
      record.commentCount,
      record.reopenCount,
      record.resolutionDays,
      record.source,
      record.closedAt,
    ],
  );
}

/** Most recent write across all rows — used to surface "last collector run" in the dashboard. */
export async function getLastResolutionUpdate(): Promise<string | null> {
  await ensureResolutionHistoryTable();
  const result = await pool.query<{ last_updated: string | null }>(
    `SELECT MAX(updated_at) AS last_updated FROM issue_resolution_history;`,
  );
  return result.rows[0]?.last_updated ?? null;
}

/** Scoped to source='synthetic' only — never touches real history. */
export async function deleteSyntheticResolutionHistory(): Promise<number> {
  await ensureResolutionHistoryTable();
  const result = await pool.query(`DELETE FROM issue_resolution_history WHERE source = 'synthetic';`);
  return result.rowCount ?? 0;
}

/** Split by source so callers (knn.ts) decide the real-preferred/synthetic-fallback policy, rather than burying it in SQL. */
export async function getResolutionHistory(): Promise<{ real: ResolutionRecord[]; synthetic: ResolutionRecord[] }> {
  await ensureResolutionHistoryTable();
  const [real, synthetic] = await Promise.all([
    pool.query<ResolutionHistoryRow>(`SELECT * FROM issue_resolution_history WHERE source = 'real';`),
    pool.query<ResolutionHistoryRow>(`SELECT * FROM issue_resolution_history WHERE source = 'synthetic';`),
  ]);
  return {
    real: real.rows.map(toResolutionRecord),
    synthetic: synthetic.rows.map(toResolutionRecord),
  };
}

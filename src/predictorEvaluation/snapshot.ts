import { pool } from "../server/db.js";
import { ensureResolutionHistoryTable, type ResolutionRecord } from "../server/resolutionHistory.js";

interface SnapshotRow {
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

function toRecord(row: SnapshotRow): ResolutionRecord {
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

/**
 * Most recent `limit` rows of issue_resolution_history (real + synthetic),
 * ordered by updated_at DESC — a fixed-size snapshot for the sandboxed
 * evaluation run, independent of the live k-NN pool's own fetch logic.
 */
export async function getEvaluationSnapshot(limit: number): Promise<ResolutionRecord[]> {
  await ensureResolutionHistoryTable();
  const result = await pool.query<SnapshotRow>(
    `SELECT * FROM issue_resolution_history ORDER BY updated_at DESC LIMIT $1;`,
    [limit],
  );
  return result.rows.map(toRecord);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Flattens the snapshot into a CSV buffer for upload into the sandbox. */
export function snapshotToCsv(records: ResolutionRecord[]): Buffer {
  const columns: Array<keyof ResolutionRecord> = [
    "issueKey",
    "issueType",
    "priority",
    "storyPoints",
    "labels",
    "assignee",
    "dependencyCount",
    "commentCount",
    "reopenCount",
    "resolutionDays",
    "source",
    "closedAt",
  ];
  const lines = [columns.join(",")];
  for (const record of records) {
    const row = columns.map((column) => {
      const value = record[column];
      if (value === null || value === undefined) return "";
      if (Array.isArray(value)) return csvEscape(value.join("|"));
      return csvEscape(String(value));
    });
    lines.push(row.join(","));
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

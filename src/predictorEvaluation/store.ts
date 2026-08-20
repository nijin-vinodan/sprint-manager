import { pool } from "../server/db.js";

let migrated: Promise<void> | undefined;

async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS predictor_evaluation_runs (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      sample_size INTEGER NOT NULL,
      algorithms_considered JSONB NOT NULL DEFAULT '[]',
      algorithms_tested JSONB NOT NULL DEFAULT '[]',
      winner TEXT,
      winner_rationale TEXT,
      reasoning_log JSONB NOT NULL DEFAULT '[]',
      artifact_path TEXT,
      error TEXT
    );
  `);
}

export async function ensurePredictorEvaluationTable(): Promise<void> {
  if (!migrated) migrated = migrate();
  await migrated;
}

export interface AlgorithmConsidered {
  name: string;
  chosen: boolean;
  rationale: string;
}

export interface AlgorithmResult {
  name: string;
  rmse: number;
  mae: number;
}

export interface ReasoningLogEntry {
  step: string;
  type: "reasoning" | "tool_call" | "tool_result" | "error";
  content: string;
}

export interface EvaluationReport {
  runId: number;
  sampleSize: number;
  algorithmsConsidered: AlgorithmConsidered[];
  algorithmsTested: AlgorithmResult[];
  winner: string | null;
  winnerRationale: string | null;
  reasoningLog: ReasoningLogEntry[];
  artifactPath: string | null;
}

/** Inserted before the sandbox run starts, so a crash mid-run still leaves an auditable row. */
export async function startEvaluationRun(sampleSize: number): Promise<number> {
  await ensurePredictorEvaluationTable();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO predictor_evaluation_runs (status, sample_size) VALUES ('running', $1) RETURNING id;`,
    [sampleSize],
  );
  return result.rows[0].id;
}

export async function completeEvaluationRun(
  runId: number,
  report: Omit<EvaluationReport, "runId" | "sampleSize">,
): Promise<void> {
  await ensurePredictorEvaluationTable();
  await pool.query(
    `
    UPDATE predictor_evaluation_runs SET
      status = 'completed',
      completed_at = now(),
      algorithms_considered = $2,
      algorithms_tested = $3,
      winner = $4,
      winner_rationale = $5,
      reasoning_log = $6,
      artifact_path = $7
    WHERE id = $1;
    `,
    [
      runId,
      JSON.stringify(report.algorithmsConsidered),
      JSON.stringify(report.algorithmsTested),
      report.winner,
      report.winnerRationale,
      JSON.stringify(report.reasoningLog),
      report.artifactPath,
    ],
  );
}

interface EvaluationRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: "running" | "completed" | "failed";
  sample_size: number;
  algorithms_considered: AlgorithmConsidered[];
  algorithms_tested: AlgorithmResult[];
  winner: string | null;
  winner_rationale: string | null;
  artifact_path: string | null;
  error: string | null;
}

export interface EvaluationRunSummary {
  runId: number;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed";
  sampleSize: number;
  algorithmsConsidered: AlgorithmConsidered[];
  algorithmsTested: AlgorithmResult[];
  winner: string | null;
  winnerRationale: string | null;
  artifactPath: string | null;
  error: string | null;
}

/**
 * Most recent `limit` runs, newest first — deliberately omits reasoning_log
 * (can be large) so a chat-facing status lookup stays concise. Callers that
 * need the full audit trail should query predictor_evaluation_runs directly.
 */
export async function getRecentEvaluationRuns(limit: number): Promise<EvaluationRunSummary[]> {
  await ensurePredictorEvaluationTable();
  const result = await pool.query<EvaluationRunRow>(
    `
    SELECT id, started_at, completed_at, status, sample_size, algorithms_considered,
           algorithms_tested, winner, winner_rationale, artifact_path, error
    FROM predictor_evaluation_runs
    ORDER BY started_at DESC
    LIMIT $1;
    `,
    [limit],
  );
  return result.rows.map((row) => ({
    runId: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    sampleSize: row.sample_size,
    algorithmsConsidered: row.algorithms_considered,
    algorithmsTested: row.algorithms_tested,
    winner: row.winner,
    winnerRationale: row.winner_rationale,
    artifactPath: row.artifact_path,
    error: row.error,
  }));
}

/**
 * Single run by id, full detail (used by predictResolutionTime to look up
 * the winner artifact for a specific evaluation run it was told to use —
 * distinct from getRecentEvaluationRuns, which is for chat-facing summaries).
 */
export async function getEvaluationRunById(runId: number): Promise<EvaluationRunSummary | null> {
  await ensurePredictorEvaluationTable();
  const result = await pool.query<EvaluationRunRow>(
    `
    SELECT id, started_at, completed_at, status, sample_size, algorithms_considered,
           algorithms_tested, winner, winner_rationale, artifact_path, error
    FROM predictor_evaluation_runs
    WHERE id = $1;
    `,
    [runId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    runId: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    sampleSize: row.sample_size,
    algorithmsConsidered: row.algorithms_considered,
    algorithmsTested: row.algorithms_tested,
    winner: row.winner,
    winnerRationale: row.winner_rationale,
    artifactPath: row.artifact_path,
    error: row.error,
  };
}

export async function failEvaluationRun(
  runId: number,
  error: string,
  reasoningLog: ReasoningLogEntry[],
): Promise<void> {
  await ensurePredictorEvaluationTable();
  await pool.query(
    `
    UPDATE predictor_evaluation_runs SET
      status = 'failed',
      completed_at = now(),
      error = $2,
      reasoning_log = $3
    WHERE id = $1;
    `,
    [runId, error, JSON.stringify(reasoningLog)],
  );
}

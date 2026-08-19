import { tool } from "langchain";
import { z } from "zod";
import { runPredictorEvaluation } from "./runEvaluation.js";
import { getRecentEvaluationRuns } from "./store.js";

/**
 * Thin wrapper around runPredictorEvaluation() — no new evaluation logic here,
 * this only exposes the same function scripts/evaluatePredictor.ts and
 * POST /internal/evaluate-predictor already call. Costs real (small) money and
 * cloud compute and takes several minutes; the orchestrator prompt gates
 * calling this behind an explicit user confirmation, same as jira-writer.
 */
export const evaluatePredictor = tool(
  async () => {
    const report = await runPredictorEvaluation();
    // reasoningLog omitted from the chat-facing result — it's persisted in
    // predictor_evaluation_runs for audit, but would bloat the conversation.
    const { reasoningLog: _reasoningLog, ...summary } = report;
    return summary;
  },
  {
    name: "evaluatePredictor",
    description:
      "Runs the predictor evaluation agent: spins up a Modal sandbox, inspects issue_resolution_history, chooses and trains several candidate regression algorithms, and reports RMSE/MAE per candidate plus a recommended winner. Takes several minutes and incurs a small real cost. This is a recommendation only — it never changes the live k-NN predictor. Only call this after the user has explicitly confirmed they want to run it.",
    schema: z.object({}),
  },
);

/** Pure lookup, no confirmation needed — reads predictor_evaluation_runs, never runs anything. */
export const getLatestPredictorEvaluation = tool(
  async ({ limit }) => {
    const runs = await getRecentEvaluationRuns(limit ?? 1);
    return { runs };
  },
  {
    name: "getLatestPredictorEvaluation",
    description:
      "Looks up the most recent predictor evaluation run(s) without starting a new one — status, algorithms considered/tested with RMSE/MAE, winner, and rationale. Returns an empty runs array if none have ever been run. Use this for 'what did the last evaluation find' style questions instead of evaluatePredictor.",
    schema: z.object({
      limit: z.number().optional().describe("How many recent runs to return, most recent first. Defaults to 1."),
    }),
  },
);

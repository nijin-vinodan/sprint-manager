import { tool } from "langchain";
import { z } from "zod";
import { thresholds } from "../config.js";
import { getIssueComments, getIssuePredictionData } from "../commentEvaluator/jiraClient.js";
import { extractFeatures, type IssueFeatures } from "./featureExtraction.js";
import { getCachedResolutionHistory } from "../server/resolutionHistory.js";
import { predictResolutionDays } from "./knn.js";
import { scoreConfidence } from "./confidence.js";
import { formatWorkdayDuration } from "../dateUtils.js";
import { getEvaluationRunById } from "../predictorEvaluation/store.js";
import { predictWithModel, LocalInferenceError, type RawFeatureRow } from "../predictorEvaluation/localInference.js";

const featureInputSchema = z.object({
  issueType: z.string(),
  priority: z.string(),
  storyPoints: z.number().nullable(),
  labels: z.array(z.string()),
  assignee: z.string().nullable(),
  dependencyCount: z.number(),
  commentCount: z.number(),
  reopenCount: z.number(),
});

function toRawFeatureRow(features: IssueFeatures): RawFeatureRow {
  return {
    issueType: features.issueType,
    priority: features.priority,
    storyPoints: features.storyPoints,
    labels: features.labels.join("|"),
    assignee: features.assignee,
    dependencyCount: features.dependencyCount,
    commentCount: features.commentCount,
    reopenCount: features.reopenCount,
  };
}

/**
 * Tries to score via the given evaluation run's winner artifact. Returns
 * null (never throws) whenever that run isn't usable for scoring — no such
 * run, still running/failed, no winner, or no downloaded artifact — so the
 * caller can fall back to k-NN with a clear reason instead of erroring the
 * whole prediction out.
 */
async function tryEvaluationModel(
  evaluationRunId: number,
  features: IssueFeatures,
): Promise<{ predictedDays: number; algorithm: string; rmse: number | null; mae: number | null } | { fallbackReason: string }> {
  const run = await getEvaluationRunById(evaluationRunId);
  if (!run) return { fallbackReason: `No evaluation run #${evaluationRunId} found.` };
  if (run.status !== "completed") return { fallbackReason: `Evaluation run #${evaluationRunId} is '${run.status}', not completed.` };
  if (!run.winner || !run.artifactPath) {
    return { fallbackReason: `Evaluation run #${evaluationRunId} found no candidate that beat the baseline; it saved no winner artifact.` };
  }

  try {
    const [predictedDays] = await predictWithModel(run.artifactPath, [toRawFeatureRow(features)]);
    const winnerResult = run.algorithmsTested.find((a) => a.name === run.winner);
    return {
      predictedDays,
      algorithm: run.winner,
      rmse: winnerResult?.rmse ?? null,
      mae: winnerResult?.mae ?? null,
    };
  } catch (err) {
    const message = err instanceof LocalInferenceError ? err.message : err instanceof Error ? err.message : String(err);
    return { fallbackReason: `Local inference against evaluation run #${evaluationRunId}'s winner failed: ${message}` };
  }
}

export const predictResolutionTime = tool(
  async ({ issueKey, features, evaluationRunId }) => {
    let issueFeatures: IssueFeatures;
    let resolvedIssueKey: string;

    if (issueKey) {
      const [data, comments] = await Promise.all([getIssuePredictionData(issueKey), getIssueComments(issueKey)]);
      issueFeatures = extractFeatures({ issueKey, data, commentCount: comments.length });
      resolvedIssueKey = issueKey;
    } else {
      // features is guaranteed present here by the schema's refine check.
      resolvedIssueKey = "adhoc";
      issueFeatures = { issueKey: resolvedIssueKey, ...features! };
    }

    let evaluationFallbackReason: string | undefined;
    if (evaluationRunId != null) {
      const evalResult = await tryEvaluationModel(evaluationRunId, issueFeatures);
      if (!("fallbackReason" in evalResult)) {
        return {
          issueKey: resolvedIssueKey,
          predictedDays: evalResult.predictedDays,
          predictedDuration: formatWorkdayDuration(evalResult.predictedDays),
          source: "evaluation" as const,
          algorithm: evalResult.algorithm,
          evaluationRunId,
          rmse: evalResult.rmse,
          mae: evalResult.mae,
        };
      }
      // Falls through to k-NN below; evalResult.fallbackReason is reported alongside it.
      evaluationFallbackReason = evalResult.fallbackReason;
    }

    const history = await getCachedResolutionHistory();
    // Leave-one-out: if this issue is already backfilled into
    // issue_resolution_history, it must not be allowed to match itself as a
    // near-zero-distance neighbor (mirrors src/server/routes.ts's /predict route).
    const historyExcludingTarget = issueKey
      ? { real: history.real.filter((r) => r.issueKey !== issueKey), synthetic: history.synthetic }
      : history;
    const prediction = predictResolutionDays(
      issueFeatures,
      historyExcludingTarget,
      thresholds.K_NEIGHBORS,
      thresholds.REAL_NEIGHBOR_DISTANCE_THRESHOLD,
    );
    const confidence = scoreConfidence(prediction.neighbors, thresholds.K_NEIGHBORS);

    return {
      issueKey: resolvedIssueKey,
      predictedDays: prediction.predictedDays,
      predictedDuration: prediction.predictedDays !== null ? formatWorkdayDuration(prediction.predictedDays) : null,
      source: "knn" as const,
      confidence,
      neighbors: prediction.neighbors.map((n) => ({
        issueKey: n.issueKey,
        resolutionDays: n.resolutionDays,
        resolutionDuration: formatWorkdayDuration(n.resolutionDays),
      })),
      usedFallbackToSynthetic: prediction.usedFallbackToSynthetic,
      evaluationFallbackReason,
    };
  },
  {
    name: "predictResolutionTime",
    description:
      "Predict how many days an issue will take to resolve. Pass either issueKey (fetches and extracts features internally) or a raw features object. Returns predictedDays (in 8-hour workdays — do not convert it yourself, e.g. do not multiply by 24) plus predictedDuration, an already human-readable string (e.g. \"1d 2h\") to quote verbatim instead. If evaluationRunId is given and that run has a usable winner artifact, scores via that ported model instead of k-NN — check the returned 'source' field ('evaluation' or 'knn') and relay it, since the two report different trust signals (rmse/mae for 'evaluation', confidence/neighbors for 'knn'). Falls back to k-NN automatically (and reports why via evaluationFallbackReason) if the given run isn't usable.",
    schema: z
      .object({
        issueKey: z
          .string()
          .optional()
          .describe("The Jira issue key to predict for, e.g. SMA-123. Mutually exclusive with features."),
        features: featureInputSchema
          .optional()
          .describe("A raw feature object to predict from directly, bypassing a Jira fetch. Mutually exclusive with issueKey."),
        evaluationRunId: z
          .number()
          .optional()
          .describe(
            "Score via this predictor-evaluation run's winner artifact instead of k-NN, if the orchestrator has already run (or looked up) a fresh evaluation for this request. Omit to use k-NN directly.",
          ),
      })
      .refine((val) => (val.issueKey ? !val.features : !!val.features), {
        message: "Provide exactly one of issueKey or features.",
      }),
  },
);

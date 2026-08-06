import { tool } from "langchain";
import { z } from "zod";
import { thresholds } from "../config.js";
import { getIssueComments, getIssuePredictionData } from "../commentEvaluator/jiraClient.js";
import { extractFeatures, type IssueFeatures } from "./featureExtraction.js";
import { getResolutionHistory } from "../server/resolutionHistory.js";
import { predictResolutionDays } from "./knn.js";
import { scoreConfidence } from "./confidence.js";

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

export const predictResolutionTime = tool(
  async ({ issueKey, features }) => {
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

    const history = await getResolutionHistory();
    const prediction = predictResolutionDays(
      issueFeatures,
      history,
      thresholds.K_NEIGHBORS,
      thresholds.REAL_NEIGHBOR_DISTANCE_THRESHOLD,
    );
    const confidence = scoreConfidence(prediction.neighbors, thresholds.K_NEIGHBORS);

    return {
      issueKey: resolvedIssueKey,
      predictedDays: prediction.predictedDays,
      confidence,
      neighbors: prediction.neighbors.map((n) => ({ issueKey: n.issueKey, resolutionDays: n.resolutionDays })),
      usedFallbackToSynthetic: prediction.usedFallbackToSynthetic,
    };
  },
  {
    name: "predictResolutionTime",
    description:
      "Predict how many days an issue will take to resolve, using k-NN over historically resolved SMA issues. Pass either issueKey (fetches and extracts features internally) or a raw features object. Returns predictedDays, a confidence level/flag, and the neighbor issues used (issueKey + their actual resolutionDays) so the result is explainable, not a black box.",
    schema: z
      .object({
        issueKey: z
          .string()
          .optional()
          .describe("The Jira issue key to predict for, e.g. SMA-123. Mutually exclusive with features."),
        features: featureInputSchema
          .optional()
          .describe("A raw feature object to predict from directly, bypassing a Jira fetch. Mutually exclusive with issueKey."),
      })
      .refine((val) => (val.issueKey ? !val.features : !!val.features), {
        message: "Provide exactly one of issueKey or features.",
      }),
  },
);

import type { SubAgent } from "deepagents";
import { config } from "../config.js";
import { evaluatePredictor, getLatestPredictorEvaluation } from "../predictorEvaluation/tool.js";
import { PREDICTOR_EVALUATOR_PROMPT } from "../prompts/predictorEvaluator.js";

export const predictorEvaluator: SubAgent = {
  name: "predictor-evaluator",
  description:
    "Runs (or looks up past results of) the predictor evaluation agent, which tries multiple ML algorithms in a sandbox and picks the best fit for issue resolution time prediction — its winner is then used live for that request's ETA predictions via predictResolutionTime's evaluationRunId. Running a new evaluation costs real money/compute and takes several minutes — only ever call the evaluate action after the user has explicitly confirmed in chat, whether that's a standalone evaluation request or the first step of a PREDICTION / ETA REQUESTS flow. Looking up past results needs no confirmation.",
  systemPrompt: PREDICTOR_EVALUATOR_PROMPT,
  tools: [evaluatePredictor, getLatestPredictorEvaluation],
  model: config.agent.model,
};

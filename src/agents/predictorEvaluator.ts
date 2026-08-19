import type { SubAgent } from "deepagents";
import { config } from "../config.js";
import { evaluatePredictor, getLatestPredictorEvaluation } from "../predictorEvaluation/tool.js";
import { PREDICTOR_EVALUATOR_PROMPT } from "../prompts/predictorEvaluator.js";

export const predictorEvaluator: SubAgent = {
  name: "predictor-evaluator",
  description:
    "Runs (or looks up past results of) the predictor evaluation agent, which tries multiple ML algorithms in a sandbox and recommends the best fit for issue resolution time prediction. Running a new evaluation costs real money/compute and takes several minutes — only ever call the evaluate action after the user has explicitly confirmed in chat. Looking up past results needs no confirmation.",
  systemPrompt: PREDICTOR_EVALUATOR_PROMPT,
  tools: [evaluatePredictor, getLatestPredictorEvaluation],
  model: config.agent.model,
};

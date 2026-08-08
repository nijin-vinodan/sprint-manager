import "dotenv/config";
import { z } from "zod";
import { LangfuseClient, type Evaluator, type RunEvaluator } from "@langfuse/client";
import { createSprintManagerAgent } from "../src/agent.js";
import { config } from "../src/config.js";
import { langfuseCallbacks, shutdownTracing } from "../src/tracing.js";
import { DATASET_NAME } from "./seedLangfuseDataset.js";

/**
 * Runs the orchestrator agent against the "sprint-manager-orchestrator"
 * Langfuse dataset (see scripts/seedLangfuseDataset.ts) and scores each
 * answer with a keyword-coverage evaluator and an LLM-as-judge evaluator.
 * Every item's trace is linked to the resulting dataset run in the Langfuse UI.
 *
 * Usage:
 *   npx tsx scripts/runLangfuseExperiment.ts
 *   npx tsx scripts/runLangfuseExperiment.ts --name "post-prompt-tweak"
 *
 * Hits live Jira/GitHub data via the real agent (no mocking), same as
 * src/testTools.ts. Requires LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY.
 */

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) opts[key] = value;
  }
  return opts;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block as { text?: string }).text ?? ""))
      .join("");
  }
  return String(content);
}

interface ExpectedOutput {
  keywords: string[];
  /** Free-text ground truth (e.g. pulled from a real ticket) for the LLM-as-judge evaluator to check correctness against. */
  groundTruth?: string;
}

const keywordCoverageEvaluator: Evaluator<{ prompt: string }, ExpectedOutput> = async ({ output, expectedOutput }) => {
  const keywords = expectedOutput?.keywords ?? [];
  if (keywords.length === 0) {
    return { name: "keyword_coverage", value: 1 };
  }
  const haystack = String(output).toLowerCase();
  const matched = keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
  return {
    name: "keyword_coverage",
    value: matched.length / keywords.length,
    comment: matched.length === keywords.length ? undefined : `Missing: ${keywords.filter((k) => !matched.includes(k)).join(", ")}`,
  };
};

const JudgeVerdict = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("0 = does not answer the question or is wrong; 1 = fully and correctly answers it, covering the expected topics"),
  reasoning: z.string().describe("One sentence explaining the score"),
});

const judgeModel = config.agent.model.withStructuredOutput(JudgeVerdict, { name: "judge_verdict" });

const llmJudgeEvaluator: Evaluator<{ prompt: string }, ExpectedOutput> = async ({ input, output, expectedOutput }) => {
  const verdict = await judgeModel.invoke([
    {
      role: "user",
      content: [
        "You are grading an AI sprint-management assistant's answer to a user's question.",
        `Question: ${input.prompt}`,
        `Expected topics the answer should cover: ${(expectedOutput?.keywords ?? []).join(", ") || "(none specified)"}`,
        expectedOutput?.groundTruth
          ? `Known ground truth you can use to check correctness: ${expectedOutput.groundTruth}`
          : null,
        `Answer: ${output}`,
        "Score how well the answer substantively addresses the question, covers the expected topics, and (when ground truth is given) states facts consistent with it, from 0 (fails or contradicts the ground truth) to 1 (fully and correctly addresses it). Do not penalize different wording or phrasing — judge substance, not keyword matching.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]);
  return { name: "llm_judge", value: verdict.score, comment: verdict.reasoning };
};

const RUN_LEVEL_METRICS = ["keyword_coverage", "llm_judge"] as const;

const averageScores: RunEvaluator = async ({ itemResults }) => {
  const evaluations = itemResults.flatMap((result) => result.evaluations);
  return RUN_LEVEL_METRICS.map((name) => {
    const scores = evaluations.filter((evaluation) => evaluation.name === name).map((evaluation) => evaluation.value as number);
    const average = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
    return { name: `avg_${name}`, value: average };
  });
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const langfuse = new LangfuseClient();
  const dataset = await langfuse.dataset.get(DATASET_NAME);
  const agent = createSprintManagerAgent();

  const result = await dataset.runExperiment({
    name: "sprint-manager-orchestrator",
    runName: opts.name,
    task: async ({ input }) => {
      const prompt = (input as { prompt: string }).prompt;
      const response = await agent.invoke(
        { messages: [{ role: "user", content: prompt }] },
        { callbacks: [...langfuseCallbacks] },
      );
      const lastMessage = response.messages[response.messages.length - 1];
      return messageText(lastMessage.content);
    },
    evaluators: [keywordCoverageEvaluator, llmJudgeEvaluator],
    runEvaluators: [averageScores],
    maxConcurrency: 3,
  });

  console.log(await result.format({ includeItemResults: true }));
  if (result.datasetRunUrl) {
    console.log(`\nView in Langfuse: ${result.datasetRunUrl}`);
  }
}

main()
  .catch((err) => {
    console.error("Langfuse experiment run failed:", err);
    process.exitCode = 1;
  })
  .finally(shutdownTracing);

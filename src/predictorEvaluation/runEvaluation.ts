import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeepAgent } from "deepagents";
import { config } from "../config.js";
import { langfuseCallbacks, flushTracing } from "../tracing.js";
import { debugCallbacks } from "../debugLogger.js";
import { extractText } from "../server/sse.js";
import { buildPredictorEvaluationPrompt } from "../prompts/predictorEvaluation.js";
import { getPredictorEvalConfig } from "./config.js";
import { getEvaluationSnapshot, snapshotToCsv } from "./snapshot.js";
import { withSandboxLifecycle } from "./sandboxLifecycle.js";
import { ReasoningLogger } from "./reasoningLogger.js";
import type { ModalSandbox } from "./modalSandbox.js";
import {
  startEvaluationRun,
  completeEvaluationRun,
  failEvaluationRun,
  type EvaluationReport,
  type AlgorithmConsidered,
  type AlgorithmResult,
} from "./store.js";

const SNAPSHOT_PATH = "/data/snapshot.csv";
const MODEL_PATHS = ["/model/winner.joblib", "/model/winner.pkl"];
const ARTIFACT_DIR = path.resolve("predictor-evaluation-artifacts");

// A generous cap on agent turns, on top of the wall-clock timeout and the
// prompt-level "max N algorithms" instruction — three independent layers
// against a runaway run, since a prompt instruction alone isn't a hard stop.
const RECURSION_LIMIT = 60;

interface AgentJsonReport {
  algorithmsConsidered: AlgorithmConsidered[];
  algorithmsTested: AlgorithmResult[];
  winner: string | null;
  winnerRationale: string | null;
}

function parseAgentReport(finalText: string): AgentJsonReport {
  const match = finalText.match(/```json\s*([\s\S]*?)```/);
  if (!match) {
    throw new Error("Predictor evaluation agent did not end with a fenced JSON report block.");
  }
  const parsed = JSON.parse(match[1]) as Partial<AgentJsonReport>;
  return {
    algorithmsConsidered: parsed.algorithmsConsidered ?? [],
    algorithmsTested: parsed.algorithmsTested ?? [],
    winner: parsed.winner ?? null,
    winnerRationale: parsed.winnerRationale ?? null,
  };
}

/**
 * Pulls a fresh issue_resolution_history snapshot, runs a one-off DeepAgent
 * (backed by a Modal sandbox, not the orchestrator's subagents array — this
 * is deliberately never delegated to live) that inspects the data, chooses
 * candidate regressors, trains/scores them, and reports back. Fully isolated
 * from src/prediction/*; never called from the live chat/nudge flow.
 */
export async function runPredictorEvaluation(): Promise<EvaluationReport> {
  const evalConfig = getPredictorEvalConfig();
  const runId = await startEvaluationRun(evalConfig.sampleSize);
  const reasoningLogger = new ReasoningLogger();

  try {
    const snapshot = await getEvaluationSnapshot(evalConfig.sampleSize);
    const csv = snapshotToCsv(snapshot);

    const report = await withSandboxLifecycle(evalConfig, async (sandbox) => {
      const uploadResults = await sandbox.uploadFiles([[SNAPSHOT_PATH, csv]]);
      const uploadFailure = uploadResults.find((result) => result.error !== null);
      if (uploadFailure) {
        throw new Error(`Failed to upload snapshot to sandbox: ${uploadFailure.error}`);
      }

      const evaluationAgent = createDeepAgent({
        model: config.agent.model,
        systemPrompt: buildPredictorEvaluationPrompt(evalConfig.maxAlgorithms),
        backend: sandbox,
      });

      const result = await evaluationAgent.invoke(
        { messages: [{ role: "user", content: "Evaluate candidate regression algorithms against /data/snapshot.csv and report back." }] },
        {
          recursionLimit: RECURSION_LIMIT,
          callbacks: [...langfuseCallbacks, ...debugCallbacks, reasoningLogger],
        },
      );

      const finalMessage = result.messages[result.messages.length - 1];
      const agentReport = parseAgentReport(extractText(finalMessage?.content));

      let artifactPath: string | null = null;
      if (agentReport.winner) {
        artifactPath = await downloadWinnerArtifact(sandbox, runId);
      }

      return { ...agentReport, artifactPath };
    });

    const fullReport: EvaluationReport = {
      runId,
      sampleSize: evalConfig.sampleSize,
      algorithmsConsidered: report.algorithmsConsidered,
      algorithmsTested: report.algorithmsTested,
      winner: report.winner,
      winnerRationale: report.winnerRationale,
      reasoningLog: reasoningLogger.getEntries(),
      artifactPath: report.artifactPath,
    };

    await completeEvaluationRun(runId, fullReport);
    return fullReport;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failEvaluationRun(runId, message, reasoningLogger.getEntries());
    throw err;
  } finally {
    await flushTracing();
  }
}

async function downloadWinnerArtifact(sandbox: ModalSandbox, runId: number): Promise<string | null> {
  const runDir = path.join(ARTIFACT_DIR, String(runId));
  const scratch = await mkdtemp(path.join(tmpdir(), "predictor-eval-download-"));
  try {
    for (const remotePath of MODEL_PATHS) {
      try {
        const localPath = path.join(scratch, path.basename(remotePath));
        await sandbox.downloadToLocal(remotePath, localPath);
        await mkdir(runDir, { recursive: true });
        const finalPath = path.join(runDir, path.basename(remotePath));
        await copyFile(localPath, finalPath);
        return finalPath;
      } catch {
        // Try the next candidate path (joblib vs pkl) before giving up.
        continue;
      }
    }
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

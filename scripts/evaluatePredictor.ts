import "dotenv/config";
import { runPredictorEvaluation } from "../src/predictorEvaluation/runEvaluation.js";
import { pool } from "../src/server/db.js";

/**
 * On-demand run of the predictor evaluation agent. Isolated from the live
 * chat/nudge flow and from src/prediction/* — this only evaluates candidate
 * regressors in a Modal sandbox and reports back; it never serves live
 * predictions or ports anything into production automatically.
 *
 * Usage:
 *   npx tsx scripts/evaluatePredictor.ts
 */
async function main() {
  console.log("Starting predictor evaluation run...");
  const report = await runPredictorEvaluation();

  console.log(`\nRun #${report.runId} — sampled ${report.sampleSize} issue_resolution_history rows.\n`);

  console.log("Algorithms considered:");
  for (const candidate of report.algorithmsConsidered) {
    console.log(`  ${candidate.chosen ? "✅" : "❌"} ${candidate.name} — ${candidate.rationale}`);
  }

  console.log("\nResults:");
  for (const result of report.algorithmsTested) {
    console.log(`  ${result.name}: RMSE=${result.rmse.toFixed(3)}  MAE=${result.mae.toFixed(3)}`);
  }

  console.log(`\nWinner: ${report.winner ?? "none"}`);
  if (report.winnerRationale) console.log(`Rationale: ${report.winnerRationale}`);
  if (report.artifactPath) console.log(`Model artifact saved to: ${report.artifactPath}`);
}

main()
  .catch((err) => {
    console.error("evaluatePredictor failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

import "dotenv/config";

// Deliberately NOT validated at module load (unlike src/config.ts / src/server/config.ts's
// eager requireEnv calls). This feature is opt-in — the CLI, tests, dashboard, and every
// route other than /internal/evaluate-predictor must keep working without Modal credentials
// set. Call getPredictorEvalConfig() lazily, only from inside runPredictorEvaluation().
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface PredictorEvalConfig {
  modal: {
    tokenId: string;
    tokenSecret: string;
  };
  sampleSize: number;
  maxAlgorithms: number;
  timeoutMinutes: number;
}

export function getPredictorEvalConfig(): PredictorEvalConfig {
  return {
    modal: {
      tokenId: requireEnv("MODAL_TOKEN_ID"),
      tokenSecret: requireEnv("MODAL_TOKEN_SECRET"),
    },
    sampleSize: Number(process.env.PREDICTOR_EVAL_SAMPLE_SIZE ?? 500),
    maxAlgorithms: Number(process.env.PREDICTOR_EVAL_MAX_ALGORITHMS ?? 5),
    timeoutMinutes: Number(process.env.PREDICTOR_EVAL_TIMEOUT_MINUTES ?? 15),
  };
}

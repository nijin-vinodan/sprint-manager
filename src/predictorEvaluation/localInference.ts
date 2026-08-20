import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INFER_SCRIPT = path.join(__dirname, "infer.py");

// Guards against a hung/misbehaving python process blocking a live chat
// request indefinitely — inference against an already-loaded model should
// be near-instant, this is generous headroom, not an expected duration.
const INFERENCE_TIMEOUT_MS = 30_000;

export interface RawFeatureRow {
  issueType: string;
  priority: string;
  storyPoints: number | null;
  /** "|"-joined, matching snapshotToCsv's label encoding — see infer.py's docstring. */
  labels: string;
  assignee: string | null;
  dependencyCount: number;
  commentCount: number;
  reopenCount: number;
}

export class LocalInferenceError extends Error {}

/**
 * Scores one or more raw feature rows against a saved winner artifact by
 * shelling out to infer.py. Throws LocalInferenceError on any failure
 * (missing python/deps, incompatible artifact, timeout) — callers (only
 * predictResolutionTime today) must catch this and fall back to k-NN rather
 * than let a ported-model failure break a live prediction request.
 */
export function predictWithModel(artifactPath: string, rows: RawFeatureRow[]): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [INFER_SCRIPT, artifactPath], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LocalInferenceError(`Local inference timed out after ${INFERENCE_TIMEOUT_MS}ms`));
    }, INFERENCE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new LocalInferenceError(`Failed to start local inference process: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const parsedError = tryParseError(stderr);
        reject(new LocalInferenceError(parsedError ?? `Local inference exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { predictions: number[] };
        if (!Array.isArray(parsed.predictions) || parsed.predictions.length !== rows.length) {
          reject(new LocalInferenceError("Local inference returned an unexpected shape"));
          return;
        }
        resolve(parsed.predictions);
      } catch {
        reject(new LocalInferenceError(`Failed to parse local inference output: ${stdout.trim()}`));
      }
    });

    child.stdin.write(JSON.stringify(rows));
    child.stdin.end();
  });
}

function tryParseError(stderr: string): string | null {
  try {
    const parsed = JSON.parse(stderr.trim()) as { error?: string };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

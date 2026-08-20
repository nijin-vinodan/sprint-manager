import { ModalSandbox } from "./modalSandbox.js";
import type { PredictorEvalConfig } from "./config.js";

export class PredictorEvalTimeoutError extends Error {
  constructor(minutes: number) {
    super(`Predictor evaluation exceeded its ${minutes}-minute budget guard and was aborted.`);
    this.name = "PredictorEvalTimeoutError";
  }
}

/**
 * Creates a Modal sandbox, runs `work` against it, and guarantees teardown —
 * even on failure or timeout — via `finally`. Also owns the wall-clock budget
 * guard: one of three independent layers against a runaway run, alongside the
 * prompt-level "max N algorithms" instruction and `invoke()`'s `recursionLimit`.
 */
export async function withSandboxLifecycle<T>(
  config: PredictorEvalConfig,
  work: (sandbox: ModalSandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await ModalSandbox.create(config.modal);
  try {
    const timeoutMs = config.timeoutMinutes * 60_000;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PredictorEvalTimeoutError(config.timeoutMinutes)), timeoutMs);
    });
    try {
      return await Promise.race([work(sandbox), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  } finally {
    await sandbox.terminate().catch((err) => {
      console.error("[predictor-evaluation] failed to terminate Modal sandbox:", err);
    });
  }
}

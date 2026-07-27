import { getSprintManagerAgent } from "../chat/_agent";
import { DIGEST_PROMPT } from "../../../dist/prompts/digest.js";
import { config } from "../../../dist/config.js";
import { langfuseCallbacks, flushTracing } from "../../../dist/tracing.js";
import { debugCallbacks } from "../../../dist/debugLogger.js";

interface DigestResult {
  generatedAt: string;
  text: string;
  error?: string;
}

const globalForDigest = globalThis as unknown as {
  __sprintHealthDigest?: DigestResult;
  __sprintHealthDigestTimer?: ReturnType<typeof setInterval>;
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block as { text?: string }).text ?? ""))
      .join("");
  }
  return String(content);
}

async function runDigest() {
  try {
    const agent = getSprintManagerAgent();
    const result = await agent.invoke(
      { messages: [{ role: "user", content: DIGEST_PROMPT }] },
      { callbacks: [...langfuseCallbacks, ...debugCallbacks] },
    );
    const lastMessage = result.messages[result.messages.length - 1];
    globalForDigest.__sprintHealthDigest = {
      generatedAt: new Date().toISOString(),
      text: messageText(lastMessage?.content),
    };
  } catch (err) {
    globalForDigest.__sprintHealthDigest = {
      generatedAt: new Date().toISOString(),
      text: globalForDigest.__sprintHealthDigest?.text ?? "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    flushTracing().catch(() => {});
  }
}

// Starts a background loop, on first request, that reruns the orchestrator
// on an interval and caches the latest result on globalThis — same pattern
// as getSprintManagerAgent() caching the agent itself, so it survives across
// requests but not server restarts.
export function ensureDigestScheduler(): void {
  if (globalForDigest.__sprintHealthDigestTimer) return;

  const intervalMs = Math.max(1, config.digest.intervalMinutes) * 60_000;
  globalForDigest.__sprintHealthDigestTimer = setInterval(runDigest, intervalMs);
  runDigest();
}

export function getLatestDigest(): DigestResult | null {
  return globalForDigest.__sprintHealthDigest ?? null;
}

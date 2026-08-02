import { randomUUID } from "node:crypto";
import { DIGEST_PROMPT } from "../../../src/prompts/digest";
import { agentServerFetch } from "../_lib/agentServer";

const DIGEST_INTERVAL_MINUTES = Number(process.env.DIGEST_INTERVAL_MINUTES ?? 20);

interface DigestResult {
  generatedAt: string;
  text: string;
  error?: string;
}

const globalForDigest = globalThis as unknown as {
  __sprintHealthDigest?: DigestResult;
  __sprintHealthDigestTimer?: ReturnType<typeof setInterval>;
  __sprintHealthDigestInFlight?: boolean;
};

async function runDigest() {
  // A slow tick (agent server under load, etc.) shouldn't overlap with the
  // next setInterval firing — each tick uses a fresh threadId (below), so
  // the agent server's per-thread lock can't catch concurrent digest runs
  // the way it would for two requests on the same thread.
  if (globalForDigest.__sprintHealthDigestInFlight) return;
  globalForDigest.__sprintHealthDigestInFlight = true;

  try {
    // A fresh threadId per tick: this is a repeated independent snapshot
    // ("what's at risk right now"), not an ongoing conversation, so there's
    // no reason to let the checkpointer accumulate history across runs —
    // and it also means a slow run can never 409 against its own next tick.
    const res = await agentServerFetch("/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: `digest-${randomUUID()}`, prompt: DIGEST_PROMPT }),
    });

    const body = (await res.json()) as { response?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `Agent server responded ${res.status}`);

    globalForDigest.__sprintHealthDigest = {
      generatedAt: new Date().toISOString(),
      text: body.response ?? "",
    };
  } catch (err) {
    globalForDigest.__sprintHealthDigest = {
      generatedAt: new Date().toISOString(),
      text: globalForDigest.__sprintHealthDigest?.text ?? "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    globalForDigest.__sprintHealthDigestInFlight = false;
  }
}

// Starts a background loop, on first request, that reruns the orchestrator
// on an interval and caches the latest result on globalThis — same pattern
// as before, but now calling the standalone agent server over HTTP instead
// of invoking an in-process agent instance directly.
export function ensureDigestScheduler(): void {
  if (globalForDigest.__sprintHealthDigestTimer) return;

  const intervalMs = Math.max(1, DIGEST_INTERVAL_MINUTES) * 60_000;
  globalForDigest.__sprintHealthDigestTimer = setInterval(runDigest, intervalMs);
  runDigest();
}

export function getLatestDigest(): DigestResult | null {
  return globalForDigest.__sprintHealthDigest ?? null;
}

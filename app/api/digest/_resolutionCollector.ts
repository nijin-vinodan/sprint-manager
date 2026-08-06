import { agentServerFetch } from "../_lib/agentServer";

const RESOLUTION_COLLECTOR_INTERVAL_MINUTES = Number(process.env.RESOLUTION_COLLECTOR_INTERVAL_MINUTES ?? 20);

const globalForResolutionCollector = globalThis as unknown as {
  __resolutionCollectorTimer?: ReturnType<typeof setInterval>;
  __resolutionCollectorInFlight?: boolean;
};

async function runCollection() {
  // Same overlap guard as runDigest() in _scheduler.ts — a slow tick
  // shouldn't overlap with the next setInterval firing. The server-side
  // upsert also makes an actual overlap harmless, this just avoids piling
  // up redundant requests.
  if (globalForResolutionCollector.__resolutionCollectorInFlight) return;
  globalForResolutionCollector.__resolutionCollectorInFlight = true;

  try {
    // Lookback is several times the poll interval so a slow/missed tick
    // can't let a newly-Done issue fall through the gap between runs.
    const lookbackHours = Math.max(1, Math.ceil((RESOLUTION_COLLECTOR_INTERVAL_MINUTES * 3) / 60));
    const res = await agentServerFetch("/internal/collect-resolution-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookbackHours }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `Agent server responded ${res.status}`);
    }
  } catch (err) {
    console.error("resolution collector tick failed:", err instanceof Error ? err.message : String(err));
  } finally {
    globalForResolutionCollector.__resolutionCollectorInFlight = false;
  }
}

// Starts a background loop, on first request, that asks the agent server to
// record any newly-Done SMA issues into issue_resolution_history on an
// interval — same lazy-start-on-first-request pattern as ensureDigestScheduler,
// since no cron/webhook infra exists in this repo.
export function ensureResolutionCollectorScheduler(): void {
  if (globalForResolutionCollector.__resolutionCollectorTimer) return;

  const intervalMs = Math.max(1, RESOLUTION_COLLECTOR_INTERVAL_MINUTES) * 60_000;
  globalForResolutionCollector.__resolutionCollectorTimer = setInterval(runCollection, intervalMs);
  runCollection();
}

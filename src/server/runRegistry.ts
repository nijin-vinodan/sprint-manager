import type { SseEvent } from "./sse.js";

type ChunkListener = (seq: number, event: SseEvent) => void;

// Same-replica-only bookkeeping for in-flight runs: which AbortController owns
// a run_id (for explicit /cancel), and which resume subscribers (other
// /threads/:threadId/stream connections tailing this run) should be fanned
// out to as new chunks are emitted. Cross-replica fan-out is a Milestone 2
// concern (Postgres LISTEN/NOTIFY) — this registry only ever sees runs that
// are actually executing on this process.
const abortControllers = new Map<string, AbortController>();
const subscribers = new Map<string, Set<ChunkListener>>();

export function registerRun(runId: string, controller: AbortController): void {
  abortControllers.set(runId, controller);
}

/** Called once a run reaches done/error — clears its cancel handle and forces any still-attached resume subscribers to detach (there's nothing left to tail). */
export function unregisterRun(runId: string): void {
  abortControllers.delete(runId);
  subscribers.delete(runId);
}

/** Returns true if a same-replica run was found and aborted. */
export function cancelRun(runId: string): boolean {
  const controller = abortControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Subscribes to live chunks for a run as they're emitted on this replica. Returns an unsubscribe function. */
export function subscribeToRun(runId: string, listener: ChunkListener): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(listener);
  return () => {
    subscribers.get(runId)?.delete(listener);
  };
}

export function broadcastLocal(runId: string, seq: number, event: SseEvent): void {
  for (const listener of subscribers.get(runId) ?? []) {
    listener(seq, event);
  }
}

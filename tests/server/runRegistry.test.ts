import { describe, expect, it, vi } from "vitest";
import {
  broadcastLocal,
  cancelRun,
  registerRun,
  subscribeToRun,
  unregisterRun,
} from "../../src/server/runRegistry.js";

// Pure in-memory module — no external calls, no mocking needed. Each test
// uses its own unique runId to avoid cross-test interference.

describe("cancelRun", () => {
  it("aborts the registered controller and returns true", () => {
    const runId = "run-cancel-1";
    const controller = new AbortController();
    registerRun(runId, controller);

    const result = cancelRun(runId);

    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    unregisterRun(runId);
  });

  it("returns false for a runId that was never registered", () => {
    expect(cancelRun("never-registered")).toBe(false);
  });

  it("returns false after the run has been unregistered", () => {
    const runId = "run-cancel-2";
    registerRun(runId, new AbortController());
    unregisterRun(runId);

    expect(cancelRun(runId)).toBe(false);
  });
});

describe("subscribeToRun / broadcastLocal", () => {
  it("fans out an emitted event to every subscriber", () => {
    const runId = "run-broadcast-1";
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    subscribeToRun(runId, listenerA);
    subscribeToRun(runId, listenerB);

    broadcastLocal(runId, 0, { type: "token", path: [], text: "hi" });

    expect(listenerA).toHaveBeenCalledWith(0, { type: "token", path: [], text: "hi" });
    expect(listenerB).toHaveBeenCalledWith(0, { type: "token", path: [], text: "hi" });
    unregisterRun(runId);
  });

  it("stops delivering to a listener after it unsubscribes", () => {
    const runId = "run-broadcast-2";
    const listener = vi.fn();
    const unsubscribe = subscribeToRun(runId, listener);

    unsubscribe();
    broadcastLocal(runId, 0, { type: "token", path: [], text: "hi" });

    expect(listener).not.toHaveBeenCalled();
    unregisterRun(runId);
  });

  it("is a no-op when broadcasting to a run with no subscribers", () => {
    expect(() => broadcastLocal("run-with-no-subscribers", 0, { type: "error", message: "x" })).not.toThrow();
  });

  it("unregisterRun clears subscribers so a later broadcast reaches no one", () => {
    const runId = "run-broadcast-3";
    const listener = vi.fn();
    subscribeToRun(runId, listener);

    unregisterRun(runId);
    broadcastLocal(runId, 0, { type: "token", path: [], text: "hi" });

    expect(listener).not.toHaveBeenCalled();
  });
});

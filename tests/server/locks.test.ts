import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";

const queryMock = vi.fn();

vi.mock("../../src/server/db.js", () => ({
  pool: { query: queryMock },
}));

const { acquireLock, acquireLockOrReject, releaseLock } = await import("../../src/server/locks.js");

// locks.ts and streamChunks.ts each memoize their migrate() in a module-level
// promise that only runs once per process — so across tests in this file,
// "CREATE TABLE" may or may not actually reach pool.query depending on test
// order. Routing the mock by SQL content (rather than call sequence/index)
// keeps these tests correct regardless of that memoization.
function routeQueryMock(handlers: { match: RegExp; result: unknown }[]) {
  queryMock.mockImplementation(async (sql: string) => {
    const handler = handlers.find((h) => h.match.test(sql));
    if (!handler) return { rows: [], rowCount: 0 }; // CREATE TABLE / other DDL
    if (handler.result instanceof Error) throw handler.result;
    return handler.result;
  });
}

function fakeReply(): FastifyReply {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply;
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("acquireLock", () => {
  it("returns true when the UPSERT returns a row (lock acquired)", async () => {
    routeQueryMock([{ match: /INSERT INTO thread_locks/, result: { rows: [{ thread_id: "t1" }], rowCount: 1 } }]);

    const acquired = await acquireLock("t1", "owner-1");

    expect(acquired).toBe(true);
    const upsertCall = queryMock.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO thread_locks"));
    expect(upsertCall?.[1]).toEqual(["t1", "owner-1", expect.anything()]);
  });

  it("returns false when the UPSERT matches zero rows (already locked and not stale)", async () => {
    routeQueryMock([{ match: /INSERT INTO thread_locks/, result: { rows: [], rowCount: 0 } }]);

    const acquired = await acquireLock("t1", "owner-2");

    expect(acquired).toBe(false);
  });

  it("propagates a dropped Postgres connection uncaught", async () => {
    routeQueryMock([
      { match: /INSERT INTO thread_locks/, result: new Error("Connection terminated unexpectedly") },
    ]);

    await expect(acquireLock("t1", "owner-1")).rejects.toThrow("Connection terminated unexpectedly");
  });
});

describe("acquireLockOrReject", () => {
  it("returns {acquired: true, runId} and never touches the reply when the lock is free", async () => {
    routeQueryMock([{ match: /INSERT INTO thread_locks/, result: { rows: [{ thread_id: "t1" }], rowCount: 1 } }]);
    const reply = fakeReply();

    const result = await acquireLockOrReject("t1", reply);

    expect(result.acquired).toBe(true);
    expect(typeof result.runId).toBe("string");
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("sends a 409 and returns {acquired: false} when the lock is already held", async () => {
    routeQueryMock([{ match: /INSERT INTO thread_locks/, result: { rows: [], rowCount: 0 } }]);
    const reply = fakeReply();

    const result = await acquireLockOrReject("t1", reply);

    expect(result).toEqual({ acquired: false });
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      error: "run already in progress for this thread",
      threadId: "t1",
    });
  });
});

describe("releaseLock", () => {
  it("issues the UPDATE and the stream_chunks sweep DELETE, in order", async () => {
    routeQueryMock([]);

    await releaseLock("t1");

    const sqlCalls = queryMock.mock.calls.map((c) => c[0] as string);
    const updateIdx = sqlCalls.findIndex((s) => s.includes("UPDATE thread_locks"));
    const deleteIdx = sqlCalls.findIndex((s) => s.includes("DELETE FROM stream_chunks"));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(updateIdx);
  });

  it("propagates a failure from the UPDATE without attempting the sweep", async () => {
    routeQueryMock([{ match: /UPDATE thread_locks/, result: new Error("Connection terminated unexpectedly") }]);

    await expect(releaseLock("t1")).rejects.toThrow("Connection terminated unexpectedly");
    expect(queryMock.mock.calls.some((c) => (c[0] as string).includes("DELETE FROM stream_chunks"))).toBe(
      false,
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SseEvent } from "../../src/server/sse.js";

const queryMock = vi.fn();

vi.mock("../../src/server/db.js", () => ({
  pool: { query: queryMock },
}));

const { insertStreamChunk, readStreamChunks } = await import("../../src/server/streamChunks.js");

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("insertStreamChunk", () => {
  it("inserts with the event JSON-stringified", async () => {
    const event: SseEvent = { type: "token", path: ["orchestrator"], text: "hello" };

    await insertStreamChunk("run-1", 0, "thread-1", event);

    const insertCall = queryMock.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO stream_chunks"));
    expect(insertCall?.[1]).toEqual(["run-1", 0, "thread-1", JSON.stringify(event)]);
  });

  it("propagates a dropped Postgres connection uncaught", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO stream_chunks")) throw new Error("Connection terminated unexpectedly");
      return { rows: [], rowCount: 0 };
    });

    await expect(
      insertStreamChunk("run-1", 0, "thread-1", { type: "done", threadId: "thread-1", response: "ok" }),
    ).rejects.toThrow("Connection terminated unexpectedly");
  });
});

describe("readStreamChunks", () => {
  it("returns rows in the exact {seq, event} shape, ordered by seq", async () => {
    const rows = [
      { seq: 0, event: { type: "token", path: [], text: "a" } },
      { seq: 1, event: { type: "token", path: [], text: "b" } },
    ];
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT seq, event FROM stream_chunks")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    });

    const result = await readStreamChunks("run-1");

    expect(result).toEqual(rows);
    const selectCall = queryMock.mock.calls.find((c) => (c[0] as string).includes("SELECT seq, event"));
    expect(selectCall?.[1]).toEqual(["run-1"]);
  });

  it("returns an empty array when the run has no chunks (not an error)", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT seq, event FROM stream_chunks")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const result = await readStreamChunks("nonexistent-run");

    expect(result).toEqual([]);
  });

  it("propagates a query failure uncaught", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT seq, event FROM stream_chunks")) throw new Error("Connection terminated unexpectedly");
      return { rows: [], rowCount: 0 };
    });

    await expect(readStreamChunks("run-1")).rejects.toThrow("Connection terminated unexpectedly");
  });
});

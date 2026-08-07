import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const getCheckpointerMock = vi.fn();

vi.mock("../../src/server/db.js", () => ({
  pool: { query: queryMock },
}));

vi.mock("../../src/server/checkpointer.js", () => ({
  getCheckpointer: getCheckpointerMock,
}));

const { listThreads } = await import("../../src/server/routes.js");

function fakeCheckpointer(tuplesByThreadId: Record<string, unknown>) {
  return {
    getTuple: vi.fn(async ({ configurable }: { configurable: { thread_id: string } }) => {
      return tuplesByThreadId[configurable.thread_id] ?? null;
    }),
  };
}

function humanMessage(text: string) {
  return { getType: () => "human", content: text };
}

function aiMessage(text: string) {
  return { getType: () => "ai", content: text };
}

beforeEach(() => {
  queryMock.mockReset();
  getCheckpointerMock.mockReset();
});

describe("listThreads", () => {
  it("returns an empty list when there are no threads", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    getCheckpointerMock.mockResolvedValue(fakeCheckpointer({}));

    const result = await listThreads(20, 0);

    expect(result).toEqual({ threads: [], hasMore: false });
  });

  it("orders by most recently active thread and builds a preview from the first user message", async () => {
    queryMock.mockResolvedValue({ rows: [{ thread_id: "t1" }, { thread_id: "t2" }] });
    getCheckpointerMock.mockResolvedValue(
      fakeCheckpointer({
        t1: {
          checkpoint: {
            ts: "2026-08-01T00:00:00.000Z",
            channel_values: { messages: [humanMessage("hello there"), aiMessage("hi!")] },
          },
        },
        t2: {
          checkpoint: {
            ts: "2026-08-02T00:00:00.000Z",
            channel_values: { messages: [humanMessage("what's blocking SMA-42?")] },
          },
        },
      }),
    );

    const { threads, hasMore } = await listThreads(20, 0);

    expect(hasMore).toBe(false);
    expect(threads).toEqual([
      { threadId: "t1", updatedAt: "2026-08-01T00:00:00.000Z", preview: "hello there", messageCount: 2 },
      { threadId: "t2", updatedAt: "2026-08-02T00:00:00.000Z", preview: "what's blocking SMA-42?", messageCount: 1 },
    ]);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/GROUP BY thread_id/);
    expect(sql).toMatch(/ORDER BY MAX\(checkpoint_id\) DESC/);
    expect(params).toEqual([21, 0]);
  });

  it("reports hasMore when the discovery query returns limit+1 rows, and trims the extra row", async () => {
    queryMock.mockResolvedValue({ rows: [{ thread_id: "t1" }, { thread_id: "t2" }] });
    getCheckpointerMock.mockResolvedValue(
      fakeCheckpointer({
        t1: { checkpoint: { ts: null, channel_values: { messages: [humanMessage("a")] } } },
        t2: { checkpoint: { ts: null, channel_values: { messages: [humanMessage("b")] } } },
      }),
    );

    const { threads, hasMore } = await listThreads(1, 0);

    expect(hasMore).toBe(true);
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe("t1");
  });

  it("returns an empty-preview summary instead of throwing when a thread's checkpoint is missing", async () => {
    queryMock.mockResolvedValue({ rows: [{ thread_id: "gone" }] });
    getCheckpointerMock.mockResolvedValue(fakeCheckpointer({}));

    const { threads } = await listThreads(20, 0);

    expect(threads).toEqual([{ threadId: "gone", updatedAt: null, preview: "", messageCount: 0 }]);
  });
});

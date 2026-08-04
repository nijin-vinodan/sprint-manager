import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../src/server/db.js", () => ({
  pool: { query: queryMock },
}));

const { shouldSkip, recordBotComment, getLastBotComment } = await import("../../src/commentEvaluator/dedupStore.js");

// Mirrors tests/server/locks.test.ts: route by SQL content since migrate()
// is memoized per-process, so CREATE TABLE may or may not fire per test.
function routeQueryMock(handlers: { match: RegExp; result: unknown }[]) {
  queryMock.mockImplementation(async (sql: string) => {
    const handler = handlers.find((h) => h.match.test(sql));
    if (!handler) return { rows: [], rowCount: 0 };
    if (handler.result instanceof Error) throw handler.result;
    return handler.result;
  });
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("getLastBotComment", () => {
  it("returns null when no prior comment exists", async () => {
    routeQueryMock([{ match: /SELECT/, result: { rows: [] } }]);
    expect(await getLastBotComment("SMA-1", "overdue")).toBeNull();
  });

  it("returns the mapped record when a prior comment exists", async () => {
    routeQueryMock([
      {
        match: /SELECT/,
        result: {
          rows: [{ comment_id: "10001", posted_at: "2026-08-01T00:00:00.000Z", ticket_status_at_post: "In Progress" }],
        },
      },
    ]);

    expect(await getLastBotComment("SMA-1", "overdue")).toEqual({
      commentId: "10001",
      postedAt: "2026-08-01T00:00:00.000Z",
      ticketStatusAtPost: "In Progress",
    });
  });
});

describe("recordBotComment", () => {
  it("inserts a row with the given issue/rule/comment/status", async () => {
    routeQueryMock([{ match: /INSERT INTO bot_comments/, result: { rows: [], rowCount: 1 } }]);

    await recordBotComment("SMA-1", "overdue", "10001", "In Progress");

    const insertCall = queryMock.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO bot_comments"));
    expect(insertCall?.[1]).toEqual(["SMA-1", "overdue", "10001", "In Progress"]);
  });
});

describe("shouldSkip", () => {
  it("returns false when there is no prior bot comment for this issue/rule", async () => {
    routeQueryMock([{ match: /SELECT/, result: { rows: [] } }]);
    expect(await shouldSkip("SMA-1", "overdue", "In Progress")).toBe(false);
  });

  it("returns true when the ticket status is unchanged since the last bot comment", async () => {
    routeQueryMock([
      {
        match: /SELECT/,
        result: {
          rows: [{ comment_id: "10001", posted_at: "2026-08-01T00:00:00.000Z", ticket_status_at_post: "In Progress" }],
        },
      },
    ]);
    expect(await shouldSkip("SMA-1", "overdue", "In Progress")).toBe(true);
  });

  it("returns false when the ticket status changed since the last bot comment", async () => {
    routeQueryMock([
      {
        match: /SELECT/,
        result: {
          rows: [{ comment_id: "10001", posted_at: "2026-08-01T00:00:00.000Z", ticket_status_at_post: "In Progress" }],
        },
      },
    ]);
    expect(await shouldSkip("SMA-1", "overdue", "Done")).toBe(false);
  });
});

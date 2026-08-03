import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveSprint, getIssueDetails, getSprintIssues } from "../../src/tools/jira.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("getActiveSprint", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the active sprint shape on the happy path", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 7, name: "Board 7" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              id: 101,
              name: "Sprint 12",
              state: "active",
              startDate: "2026-07-27T00:00:00.000Z",
              endDate: "2026-08-10T00:00:00.000Z",
              goal: "Ship the eval framework",
            },
          ],
        }),
      );

    const result = await getActiveSprint.invoke({});

    expect(result).toEqual({
      active: true,
      id: 101,
      name: "Sprint 12",
      goal: "Ship the eval framework",
      startDate: "2026-07-27T00:00:00.000Z",
      endDate: "2026-08-10T00:00:00.000Z",
      daysRemaining: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/rest/agile/1.0/board?projectKeyOrId=SMA");
    expect(fetchMock.mock.calls[1][0]).toContain("/sprint?state=active");
  });

  it("returns active:false with a message when no sprint is active", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 7, name: "Board 7" }] }))
      .mockResolvedValueOnce(jsonResponse({ values: [] }));

    const result = await getActiveSprint.invoke({});

    expect(result).toEqual({ active: false, message: expect.stringContaining("7") });
  });

  it("falls back goal/startDate/endDate to null when absent", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 7, name: "Board 7" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ values: [{ id: 101, name: "Sprint 12", state: "active" }] }),
      );

    const result = await getActiveSprint.invoke({});

    expect(result).toMatchObject({ goal: null, startDate: null, endDate: null, daysRemaining: null });
  });

  it("throws when the project has no board (malformed/empty API response)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await expect(getActiveSprint.invoke({})).rejects.toThrow(/No board found/);
  });

  it("propagates a Jira 404 as a thrown error", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorMessages: ["Not found"] }, 404));

    await expect(getActiveSprint.invoke({})).rejects.toThrow(/Jira API error 404/);
  });

  it("propagates a raw network failure (fetch rejects) uncaught", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(getActiveSprint.invoke({})).rejects.toThrow("ECONNRESET");
  });
});

describe("getSprintIssues", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  const baseIssue = {
    key: "SMA-1",
    fields: {
      summary: "Fix login bug",
      status: { name: "In Progress" },
      assignee: { displayName: "Jane Doe" },
      priority: { name: "High" },
      issuetype: { name: "Bug" },
      updated: "2026-08-01T00:00:00.000Z",
      duedate: "2026-08-05",
    },
  };

  it("returns the exact digested shape the agent reasons over", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [baseIssue], total: 1 }));

    const result = await getSprintIssues.invoke({ sprintId: 101 });

    expect(result).toEqual([
      {
        key: "SMA-1",
        summary: "Fix login bug",
        status: "In Progress",
        assignee: "Jane Doe",
        priority: "High",
        issueType: "Bug",
        updated: "2026-08-01T00:00:00.000Z",
        dueDate: "2026-08-05",
        daysSinceUpdate: expect.any(Number),
        isOverdue: expect.any(Boolean),
      },
    ]);
  });

  it("falls back assignee to 'Unassigned' and priority to 'None' when absent", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const issue = {
      ...baseIssue,
      fields: { ...baseIssue.fields, assignee: null, priority: null },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [issue], total: 1 }));

    const result = await getSprintIssues.invoke({ sprintId: 101 });

    expect(result[0]).toMatchObject({ assignee: "Unassigned", priority: "None" });
  });

  it("walks multiple pages via startAt/total and concatenates results", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ issues: [baseIssue], total: 2 }))
      .mockResolvedValueOnce(
        jsonResponse({ issues: [{ ...baseIssue, key: "SMA-2" }], total: 2 }),
      );

    const result = await getSprintIssues.invoke({ sprintId: 101 });

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.key)).toEqual(["SMA-1", "SMA-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-numeric sprintId at the schema layer before any fetch fires", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    await expect(getSprintIssues.invoke({ sprintId: "not-a-number" as unknown as number })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a Jira 404 for an unknown sprint id (no existence check upstream)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorMessages: ["Sprint not found"] }, 404));

    await expect(getSprintIssues.invoke({ sprintId: 999999 })).rejects.toThrow(/Jira API error 404/);
  });
});

describe("getIssueDetails", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  const issueResponse = {
    key: "SMA-1",
    fields: {
      summary: "Fix login bug",
      status: { name: "In Progress" },
      assignee: { displayName: "Jane Doe" },
      priority: { name: "High" },
      issuetype: { name: "Bug" },
      updated: "2026-08-01T00:00:00.000Z",
      duedate: "2026-08-05",
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Steps to repro..." }] }],
      },
    },
  };

  it("returns issue details with flattened description and comments", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(issueResponse))
      .mockResolvedValueOnce(
        jsonResponse({
          comments: [
            {
              author: { displayName: "Alex" },
              created: "2026-08-02T00:00:00.000Z",
              body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Blocked on infra" }] }] },
            },
          ],
          total: 1,
        }),
      );

    const result = await getIssueDetails.invoke({ issueKey: "SMA-1" });

    expect(result).toEqual({
      key: "SMA-1",
      summary: "Fix login bug",
      status: "In Progress",
      assignee: "Jane Doe",
      priority: "High",
      issueType: "Bug",
      updated: "2026-08-01T00:00:00.000Z",
      dueDate: "2026-08-05",
      daysSinceUpdate: expect.any(Number),
      isOverdue: expect.any(Boolean),
      description: "Steps to repro...",
      comments: [
        {
          author: "Alex",
          created: "2026-08-02T00:00:00.000Z",
          daysSinceComment: expect.any(Number),
          body: "Blocked on infra",
        },
      ],
    });
  });

  it("propagates a Jira 404 for a nonexistent issue key", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorMessages: ["Issue does not exist"] }, 404));

    await expect(getIssueDetails.invoke({ issueKey: "SMA-99999" })).rejects.toThrow(/Jira API error 404/);
  });

  it("accepts a malformed issueKey string unvalidated and lets Jira reject it (no client-side format check)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorMessages: ["Invalid key"] }, 400));

    await expect(getIssueDetails.invoke({ issueKey: "not a real key!!" })).rejects.toThrow(/Jira API error 400/);
    expect(fetchMock.mock.calls[0][0]).toContain("not a real key!!");
  });
});

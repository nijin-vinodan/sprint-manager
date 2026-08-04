import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIssueChangelog,
  getIssueComments,
  hasExistingComment,
  postJiraComment,
} from "../../src/commentEvaluator/jiraClient.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("postJiraComment", () => {
  it("POSTs an ADF body containing the hidden bot marker and returns the comment result", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "10001", created: "2026-08-01T00:00:00.000Z" }),
    );

    const result = await postJiraComment("SMA-1", "stale_in_progress", "Please add a status update.");

    expect(result).toEqual({
      issueKey: "SMA-1",
      ruleId: "stale_in_progress",
      commentId: "10001",
      postedAt: "2026-08-01T00:00:00.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/rest/api/3/issue/SMA-1/comment");
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body);
    expect(sentBody.body.type).toBe("doc");
    const text = sentBody.body.content[0].content.map((n: { text: string }) => n.text).join("");
    expect(text).toContain("[sprint-manager-bot:stale_in_progress]");
    expect(text).toContain("Please add a status update.");
  });
});

describe("getIssueComments", () => {
  it("paginates and flattens ADF comment bodies to plain text", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        total: 1,
        comments: [
          {
            author: { displayName: "Jane Doe" },
            created: "2026-08-01T00:00:00.000Z",
            body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
          },
        ],
      }),
    );

    const comments = await getIssueComments("SMA-1");

    expect(comments).toEqual([{ author: "Jane Doe", created: "2026-08-01T00:00:00.000Z", body: "hello" }]);
  });
});

describe("hasExistingComment", () => {
  it("returns true when a comment contains the rule's marker", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        total: 1,
        comments: [
          {
            author: { displayName: "bot" },
            created: "2026-08-01T00:00:00.000Z",
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "[sprint-manager-bot:overdue] please update" }],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(await hasExistingComment("SMA-1", "overdue")).toBe(true);
  });

  it("returns false when no comment contains the marker", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ total: 0, comments: [] }));

    expect(await hasExistingComment("SMA-1", "overdue")).toBe(false);
  });
});

describe("getIssueChangelog", () => {
  it("extracts assignee-change history and issue links from the changelog/fields payload", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        fields: {
          issuelinks: [
            {
              type: { inward: "is blocked by", outward: "blocks" },
              inwardIssue: { key: "SMA-50", fields: { status: { name: "Open" } } },
            },
          ],
        },
        changelog: {
          histories: [
            {
              created: "2026-07-30T00:00:00.000Z",
              items: [{ field: "assignee", fromString: "Jane Doe", toString: "John Smith" }],
            },
            {
              created: "2026-07-29T00:00:00.000Z",
              items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
            },
          ],
        },
      }),
    );

    const result = await getIssueChangelog("SMA-1");

    expect(result.assigneeHistory).toEqual([
      { fromDisplayName: "Jane Doe", toDisplayName: "John Smith", changedAt: "2026-07-30T00:00:00.000Z" },
    ]);
    expect(result.issueLinks).toEqual([
      { type: "is blocked by", linkedIssueKey: "SMA-50", linkedIssueStatus: "Open" },
    ]);
  });
});

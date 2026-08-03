import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOpenPullRequests, getRecentCommits } from "../../src/tools/github.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("getOpenPullRequests", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  const basePr = {
    number: 42,
    title: "SMA-10: Fix stale ticket detection",
    body: null,
    user: { login: "octocat" },
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    html_url: "https://github.com/test-owner/test-repo/pull/42",
  };

  it("returns the exact digested shape, deriving isStale/reviewState/linkedIssueKey", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse([basePr]))
      .mockResolvedValueOnce(jsonResponse([{ state: "APPROVED", submitted_at: "2026-08-01T01:00:00Z" }]));

    const result = await getOpenPullRequests.invoke({});

    expect(result).toEqual([
      {
        number: 42,
        title: "SMA-10: Fix stale ticket detection",
        author: "octocat",
        url: "https://github.com/test-owner/test-repo/pull/42",
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        ageDays: expect.any(Number),
        daysSinceUpdate: expect.any(Number),
        isStale: expect.any(Boolean),
        reviewState: "approved",
        linkedIssueKey: "SMA-10",
      },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/test-owner/test-repo/pulls?state=open&per_page=100",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/test-owner/test-repo/pulls/42/reviews",
    );
  });

  it("summarizes review state as changes_requested when any review requests changes, even if others approved", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse([basePr]))
      .mockResolvedValueOnce(
        jsonResponse([
          { state: "APPROVED", submitted_at: "2026-07-30T00:00:00Z" },
          { state: "CHANGES_REQUESTED", submitted_at: "2026-08-01T00:00:00Z" },
        ]),
      );

    const result = await getOpenPullRequests.invoke({});
    expect(result[0].reviewState).toBe("changes_requested");
  });

  it("summarizes review state as pending when there are no reviews", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([basePr])).mockResolvedValueOnce(jsonResponse([]));

    const result = await getOpenPullRequests.invoke({});
    expect(result[0].reviewState).toBe("pending");
  });

  it("returns linkedIssueKey null when neither title nor body reference a Jira issue", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const pr = { ...basePr, title: "Fix stale ticket detection", body: "no ticket reference here" };
    fetchMock.mockResolvedValueOnce(jsonResponse([pr])).mockResolvedValueOnce(jsonResponse([]));

    const result = await getOpenPullRequests.invoke({});
    expect(result[0].linkedIssueKey).toBeNull();
  });

  it("falls back to body when the title has no issue key", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const pr = { ...basePr, title: "Fix stale ticket detection", body: "Closes SMA-77" };
    fetchMock.mockResolvedValueOnce(jsonResponse([pr])).mockResolvedValueOnce(jsonResponse([]));

    const result = await getOpenPullRequests.invoke({});
    expect(result[0].linkedIssueKey).toBe("SMA-77");
  });

  it("respects an explicit repo override instead of the configured default", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([])).mockResolvedValueOnce(jsonResponse([]));

    await getOpenPullRequests.invoke({ repo: "other-repo" });

    expect(fetchMock.mock.calls[0][0]).toContain("/repos/test-owner/other-repo/pulls");
  });

  it("propagates a GitHub rate-limit (403) as a thrown error", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "API rate limit exceeded" }, 403),
    );

    await expect(getOpenPullRequests.invoke({})).rejects.toThrow(/GitHub API error 403/);
  });

  it("fails the entire batch if any single PR's review fetch rejects", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse([basePr, { ...basePr, number: 43 }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ message: "not found" }, 404));

    await expect(getOpenPullRequests.invoke({})).rejects.toThrow(/GitHub API error 404/);
  });
});

describe("getRecentCommits", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  const baseCommit = {
    sha: "abcdef1234567890",
    commit: {
      author: { name: "Jane Doe", date: "2026-08-01T00:00:00.000Z" },
      message: "SMA-5: fix flaky test",
    },
  };

  it("returns the exact digested shape with a shortened sha", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([baseCommit]));

    const result = await getRecentCommits.invoke({ days: 7 });

    expect(result).toEqual([
      {
        sha: "abcdef1",
        author: "Jane Doe",
        message: "SMA-5: fix flaky test",
        date: "2026-08-01T00:00:00.000Z",
        daysAgo: expect.any(Number),
        linkedIssueKey: "SMA-5",
      },
    ]);
  });

  it("returns linkedIssueKey null when the commit message has no issue reference", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const commit = { ...baseCommit, commit: { ...baseCommit.commit, message: "fix flaky test" } };
    fetchMock.mockResolvedValueOnce(jsonResponse([commit]));

    const result = await getRecentCommits.invoke({ days: 7 });
    expect(result[0].linkedIssueKey).toBeNull();
  });

  it("accepts a negative `days` unvalidated and still fires a request (no input validation)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await getRecentCommits.invoke({ days: -5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const sinceParam = new URL(calledUrl).searchParams.get("since");
    // A future timestamp results from a negative `days` — proof this reaches the API unvalidated.
    expect(new Date(sinceParam!).getTime()).toBeGreaterThan(Date.now());
  });

  it("propagates a GitHub 500/connection issue as a thrown error", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(getRecentCommits.invoke({ days: 7 })).rejects.toThrow("socket hang up");
  });
});

import { config } from "../config.js";
import { adfToPlainText } from "../dateUtils.js";
import type { AssigneeChange, CommentResult, IssueLink, TicketComment } from "./types.js";

// Same Basic-auth pattern as src/tools/jira.ts — duplicated here rather than
// imported since that module only exports read-only `tool()`s, not the
// underlying fetch helper.
const authHeader = `Basic ${Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64")}`;

async function jiraFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.jira.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira API error ${res.status} for ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function jiraFetchAllPages<T>(
  pathBuilder: (startAt: number) => string,
  itemsField: string,
): Promise<T[]> {
  const items: T[] = [];
  let startAt = 0;
  while (true) {
    const data = await jiraFetch<Record<string, unknown>>(pathBuilder(startAt));
    const page = (data[itemsField] as T[] | undefined) ?? [];
    items.push(...page);
    startAt += page.length;
    const total = typeof data.total === "number" ? data.total : startAt;
    if (page.length === 0 || startAt >= total) break;
  }
  return items;
}

/** The hidden marker prefixed to every bot comment, used to detect our own past comments without full ADF parsing. */
export function botMarker(ruleId: string): string {
  return `[sprint-manager-bot:${ruleId}]`;
}

export async function postJiraComment(issueKey: string, ruleId: string, message: string): Promise<CommentResult> {
  const body = {
    body: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `${botMarker(ruleId)} ` },
            { type: "text", text: message },
          ],
        },
      ],
    },
  };

  const comment = await jiraFetch<{ id: string; created: string }>(`/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    issueKey,
    ruleId,
    commentId: comment.id,
    postedAt: comment.created,
  };
}

export async function getIssueComments(issueKey: string): Promise<TicketComment[]> {
  const comments = await jiraFetchAllPages<{
    author: { displayName: string };
    created: string;
    body: unknown;
  }>((startAt) => `/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}`, "comments");

  return comments.map((c) => ({
    author: c.author.displayName,
    created: c.created,
    body: adfToPlainText(c.body),
  }));
}

export async function hasExistingComment(issueKey: string, ruleId: string): Promise<boolean> {
  const comments = await getIssueComments(issueKey);
  const marker = botMarker(ruleId);
  return comments.some((c) => c.body.includes(marker));
}

interface JiraChangelogItem {
  field: string;
  fromString: string | null;
  toString: string | null;
}

interface JiraChangelogHistory {
  created: string;
  items: JiraChangelogItem[];
}

interface JiraIssueLinkPayload {
  type: { inward: string; outward: string };
  inwardIssue?: { key: string; fields: { status: { name: string } } };
  outwardIssue?: { key: string; fields: { status: { name: string } } };
}

export interface StatusChange {
  fromStatus: string | null;
  toStatus: string;
  changedAt: string;
}

export interface IssuePredictionData {
  issueType: string;
  priority: string;
  labels: string[];
  assignee: string | null;
  /** Original Estimate from Jira's time-tracking field, in seconds — used as the story-points proxy (no dedicated Story Points field configured on this instance). */
  originalEstimateSeconds: number | null;
  /** Logged work (time-tracking "Time Spent"), in seconds — used as the effort-based resolution-time metric when present. Null if no worklog was ever added. */
  timeSpentSeconds: number | null;
  created: string;
  resolutionDate: string | null;
  status: string;
  issueLinks: IssueLink[];
  statusHistory: StatusChange[];
}

export async function getIssueChangelog(
  issueKey: string,
): Promise<{ assigneeHistory: AssigneeChange[]; issueLinks: IssueLink[] }> {
  const issue = await jiraFetch<{
    fields: { issuelinks: JiraIssueLinkPayload[] };
    changelog: { histories: JiraChangelogHistory[] };
  }>(`/rest/api/3/issue/${issueKey}?fields=issuelinks&expand=changelog`);

  const assigneeHistory: AssigneeChange[] = issue.changelog.histories
    .flatMap((history) =>
      history.items
        .filter((item) => item.field === "assignee")
        .map((item) => ({
          fromDisplayName: item.fromString,
          toDisplayName: item.toString,
          changedAt: history.created,
        })),
    )
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));

  const issueLinks: IssueLink[] = issue.fields.issuelinks.map((link) => {
    const related = link.inwardIssue ?? link.outwardIssue;
    const type = link.inwardIssue ? link.type.inward : link.type.outward;
    return {
      type,
      linkedIssueKey: related!.key,
      linkedIssueStatus: related!.fields.status.name,
    };
  });

  return { assigneeHistory, issueLinks };
}

function issueLinksFromPayload(links: JiraIssueLinkPayload[]): IssueLink[] {
  return links.map((link) => {
    const related = link.inwardIssue ?? link.outwardIssue;
    const type = link.inwardIssue ? link.type.inward : link.type.outward;
    return {
      type,
      linkedIssueKey: related!.key,
      linkedIssueStatus: related!.fields.status.name,
    };
  });
}

/** One fetch bundling everything featureExtraction.ts needs beyond what getActiveSprint/getSprintIssues already expose. */
export async function getIssuePredictionData(issueKey: string): Promise<IssuePredictionData> {
  const issue = await jiraFetch<{
    fields: {
      issuetype: { name: string };
      priority: { name: string } | null;
      labels: string[];
      assignee: { displayName: string } | null;
      timetracking?: { originalEstimateSeconds?: number; timeSpentSeconds?: number };
      created: string;
      resolutiondate: string | null;
      status: { name: string };
      issuelinks: JiraIssueLinkPayload[];
    };
    changelog: { histories: JiraChangelogHistory[] };
  }>(
    `/rest/api/3/issue/${issueKey}?fields=issuetype,priority,labels,assignee,timetracking,created,resolutiondate,status,issuelinks&expand=changelog`,
  );

  const f = issue.fields;

  const statusHistory: StatusChange[] = issue.changelog.histories
    .flatMap((history) =>
      history.items
        .filter((item) => item.field === "status")
        .map((item) => ({
          fromStatus: item.fromString,
          toStatus: item.toString ?? "",
          changedAt: history.created,
        })),
    )
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));

  return {
    issueType: f.issuetype.name,
    priority: f.priority?.name ?? "None",
    labels: f.labels,
    assignee: f.assignee?.displayName ?? null,
    originalEstimateSeconds: f.timetracking?.originalEstimateSeconds ?? null,
    timeSpentSeconds: f.timetracking?.timeSpentSeconds ?? null,
    created: f.created,
    resolutionDate: f.resolutiondate,
    status: f.status.name,
    issueLinks: issueLinksFromPayload(f.issuelinks),
    statusHistory,
  };
}

/**
 * JQL-based search. Uses /rest/api/3/search/jql (the replacement for the removed
 * /rest/api/3/search endpoint), which pages via an opaque nextPageToken cursor
 * rather than the startAt/total convention every other list endpoint here uses,
 * so it can't share jiraFetchAllPages. Returns just issue keys — callers fetch
 * full data per key via getIssuePredictionData.
 */
export async function searchIssueKeys(jql: string): Promise<string[]> {
  const keys: string[] = [];
  let nextPageToken: string | undefined;
  while (true) {
    const params = new URLSearchParams({ jql, fields: "key" });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);

    const data = await jiraFetch<{ issues: { key: string }[]; nextPageToken?: string; isLast?: boolean }>(
      `/rest/api/3/search/jql?${params.toString()}`,
    );
    keys.push(...data.issues.map((issue) => issue.key));

    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return keys;
}

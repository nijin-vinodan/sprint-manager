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

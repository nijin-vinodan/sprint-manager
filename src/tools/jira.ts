import { tool } from "langchain";
import { z } from "zod";
import { config } from "../config.js";
import { adfToPlainText, daysSince, daysUntil, isPastDue } from "../dateUtils.js";

// Jira Cloud uses HTTP Basic auth with an API token (not the account password) as the "password".
const authHeader = `Basic ${Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64")}`;

// Thin wrapper around fetch for Jira's REST APIs (both /rest/agile/1.0 and
// /rest/api/3 share the same base URL and auth). Throws on non-2xx so callers
// don't have to check res.ok themselves.
async function jiraFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${config.jira.baseUrl}${path}`, {
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira API error ${res.status} for ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// Jira's search-style endpoints (sprint issues, comments) page results via
// startAt/total instead of returning everything at once. This walks all pages
// and concatenates them so callers never see a silently truncated list.
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

interface JiraBoard {
  id: number;
  name: string;
}

interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
}

interface JiraIssueFields {
  summary: string;
  status: { name: string };
  assignee: { displayName: string } | null;
  priority: { name: string } | null;
  issuetype: { name: string };
  updated: string;
  duedate: string | null;
}

interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

async function findBoardIdForProject(projectKey: string): Promise<number> {
  const data = await jiraFetch<{ values: JiraBoard[] }>(
    `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
  );
  // Assumes a single board per project; if a project has multiple boards, this
  // arbitrarily picks whichever one the API returns first.
  const board = data.values[0];
  if (!board) {
    throw new Error(`No board found for project ${projectKey}`);
  }
  return board.id;
}

export const getActiveSprint = tool(
  async () => {
    const boardId = await findBoardIdForProject(config.jira.projectKey);
    // state=active normally yields at most one sprint per board (Jira boards
    // aren't usually configured for multiple concurrent active sprints).
    const data = await jiraFetch<{ values: JiraSprint[] }>(
      `/rest/agile/1.0/board/${boardId}/sprint?state=active`,
    );
    const sprint = data.values[0];
    if (!sprint) {
      return { active: false as const, message: `No active sprint found for board ${boardId}` };
    }

    // daysUntil is negative once the sprint's end date has passed.
    const daysRemaining = sprint.endDate ? daysUntil(sprint.endDate) : null;

    return {
      active: true as const,
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal ?? null,
      startDate: sprint.startDate ?? null,
      endDate: sprint.endDate ?? null,
      daysRemaining,
    };
  },
  {
    name: "getActiveSprint",
    description:
      "Get the active sprint for the configured Jira project/board: name, goal, start/end date, and days remaining (already computed).",
    schema: z.object({}),
  },
);

export const getSprintIssues = tool(
  async ({ sprintId }) => {
    const issues = await jiraFetchAllPages<JiraIssue>(
      (startAt) =>
        `/rest/agile/1.0/sprint/${sprintId}/issue?fields=summary,status,assignee,priority,issuetype,updated,duedate&startAt=${startAt}`,
      "issues",
    );

    return issues.map((issue) => {
      const f = issue.fields;
      return {
        key: issue.key,
        summary: f.summary,
        status: f.status.name,
        assignee: f.assignee?.displayName ?? "Unassigned",
        priority: f.priority?.name ?? "None",
        issueType: f.issuetype.name,
        updated: f.updated,
        dueDate: f.duedate,
        daysSinceUpdate: daysSince(f.updated),
        isOverdue: isPastDue(f.duedate),
      };
    });
  },
  {
    name: "getSprintIssues",
    description:
      "Get all issues in a given sprint (by sprint ID) with pre-computed staleness/overdue facts: key, summary, status, assignee, priority, issueType, updated, dueDate, daysSinceUpdate, isOverdue.",
    schema: z.object({
      sprintId: z.number().describe("The numeric Jira sprint ID, from getActiveSprint."),
    }),
  },
);

export const getIssueDetails = tool(
  async ({ issueKey }) => {
    // Uses the core issue API (not /rest/agile/1.0) since that's what exposes
    // description and comments; the agile sprint-issue endpoint above doesn't.
    const issue = await jiraFetch<{
      key: string;
      fields: JiraIssueFields & { description: unknown };
    }>(
      `/rest/api/3/issue/${issueKey}?fields=summary,status,assignee,priority,issuetype,updated,duedate,description`,
    );

    const comments = await jiraFetchAllPages<{
      author: { displayName: string };
      created: string;
      body: unknown;
    }>((startAt) => `/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}`, "comments");

    const f = issue.fields;

    return {
      key: issue.key,
      summary: f.summary,
      status: f.status.name,
      assignee: f.assignee?.displayName ?? "Unassigned",
      priority: f.priority?.name ?? "None",
      issueType: f.issuetype.name,
      updated: f.updated,
      dueDate: f.duedate,
      daysSinceUpdate: daysSince(f.updated),
      isOverdue: isPastDue(f.duedate),
      // Jira stores description/comment bodies as Atlassian Document Format
      // (rich-text JSON), so they're flattened to plain text for the agent.
      description: adfToPlainText(f.description),
      comments: comments.map((c) => ({
        author: c.author.displayName,
        created: c.created,
        daysSinceComment: daysSince(c.created),
        body: adfToPlainText(c.body),
      })),
    };
  },
  {
    name: "getIssueDetails",
    description:
      "Get full details for a single Jira issue by key, including its description and comments (so blocker reasons written by the team are visible), plus pre-computed daysSinceUpdate/isOverdue.",
    schema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. SMA-123."),
    }),
  },
);

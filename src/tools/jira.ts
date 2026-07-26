import { tool } from "langchain";
import { z } from "zod";
import { config } from "../config.js";
import { adfToPlainText, daysSince, daysUntil, isPastDue } from "../dateUtils.js";

const authHeader = `Basic ${Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64")}`;

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
  const board = data.values[0];
  if (!board) {
    throw new Error(`No board found for project ${projectKey}`);
  }
  return board.id;
}

export const getActiveSprint = tool(
  async () => {
    const boardId = await findBoardIdForProject(config.jira.projectKey);
    const data = await jiraFetch<{ values: JiraSprint[] }>(
      `/rest/agile/1.0/board/${boardId}/sprint?state=active`,
    );
    const sprint = data.values[0];
    if (!sprint) {
      return { active: false as const, message: `No active sprint found for board ${boardId}` };
    }

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
    const data = await jiraFetch<{ issues: JiraIssue[] }>(
      `/rest/agile/1.0/sprint/${sprintId}/issue?fields=summary,status,assignee,priority,issuetype,updated,duedate`,
    );

    return data.issues.map((issue) => {
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
    const issue = await jiraFetch<{
      key: string;
      fields: JiraIssueFields & { description: unknown };
    }>(
      `/rest/api/3/issue/${issueKey}?fields=summary,status,assignee,priority,issuetype,updated,duedate,description`,
    );

    const commentsData = await jiraFetch<{
      comments: Array<{ author: { displayName: string }; created: string; body: unknown }>;
    }>(`/rest/api/3/issue/${issueKey}/comment`);

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
      description: adfToPlainText(f.description),
      comments: commentsData.comments.map((c) => ({
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

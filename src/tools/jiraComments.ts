import { tool } from "langchain";
import { z } from "zod";
import { config } from "../config.js";

// Jira Cloud uses HTTP Basic auth with an API token (not the account password) as the "password".
const authHeader = `Basic ${Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64")}`;

// Separate from src/tools/jira.ts's GET-only jiraFetch since this one needs
// to send a method/body for the POST below.
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

export const addJiraComment = tool(
  async ({ issueKey, comment }) => {
    const body = {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: comment }],
          },
        ],
      },
    };

    const created = await jiraFetch<{ id: string; created: string }>(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      issueKey,
      commentId: created.id,
      postedAt: created.created,
    };
  },
  {
    name: "addJiraComment",
    description: "Post a comment to a Jira issue, verbatim. This writes to Jira.",
    schema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. SMA-123."),
      comment: z.string().describe("The exact comment text to post, verbatim."),
    }),
  },
);

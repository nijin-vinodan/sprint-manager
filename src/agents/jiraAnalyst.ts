import type { SubAgent } from "deepagents";
import { config } from "../config.js";
import { getActiveSprint, getSprintIssues, getIssueDetails } from "../tools/jira.js";
import { JIRA_ANALYST_PROMPT } from "../prompts/jiraAnalyst.js";

export const jiraAnalyst: SubAgent = {
  name: "jira-analyst",
  description:
    "Fetches Jira sprint and issue data (active sprint, sprint issues, and per-issue details/comments). Read-only, facts only — does not judge sprint health.",
  systemPrompt: JIRA_ANALYST_PROMPT,
  tools: [getActiveSprint, getSprintIssues, getIssueDetails],
  model: config.agent.model,
};

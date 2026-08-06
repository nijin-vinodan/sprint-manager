import type { SubAgent } from "deepagents";
import { config } from "../config.js";
import { getActiveSprint, getSprintIssues, getIssueDetails } from "../tools/jira.js";
import { predictResolutionTime } from "../tools/resolutionPrediction.js";
import { JIRA_ANALYST_PROMPT } from "../prompts/jiraAnalyst.js";

export const jiraAnalyst: SubAgent = {
  name: "jira-analyst",
  description:
    "Fetches Jira sprint and issue data (active sprint, sprint issues, per-issue details/comments) and can predict resolution time for an issue via k-NN over resolution history. Read-only, facts only — does not judge sprint health.",
  systemPrompt: JIRA_ANALYST_PROMPT,
  tools: [getActiveSprint, getSprintIssues, getIssueDetails, predictResolutionTime],
  model: config.agent.model,
};

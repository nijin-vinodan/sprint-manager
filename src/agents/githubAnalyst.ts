import type { SubAgent } from "deepagents";
import { config } from "../config.js";
import { getOpenPullRequests, getRecentCommits } from "../tools/github.js";
import { GITHUB_ANALYST_PROMPT } from "../prompts/githubAnalyst.js";

export const githubAnalyst: SubAgent = {
  name: "github-analyst",
  description:
    "Fetches GitHub activity (open pull requests and recent commits, each with any linked Jira issue key). Read-only, facts only — does not judge sprint health.",
  systemPrompt: GITHUB_ANALYST_PROMPT,
  tools: [getOpenPullRequests, getRecentCommits],
  model: config.agent.model,
};

import type { SubAgent } from "deepagents";
import { config } from "../config.js";
import { addJiraComment } from "../tools/jiraComments.js";
import { JIRA_WRITER_PROMPT } from "../prompts/jiraWriter.js";

export const jiraWriter: SubAgent = {
  name: "jira-writer",
  description:
    "Posts a comment to a Jira issue, verbatim. Only ever call this after the user has explicitly confirmed the exact comment text in chat — never draft or edit the wording yourself.",
  systemPrompt: JIRA_WRITER_PROMPT,
  tools: [addJiraComment],
  model: config.agent.model,
};

import { createDeepAgent } from "deepagents";
import { config } from "./config.js";
import { jiraAnalyst } from "./agents/jiraAnalyst.js";
import { githubAnalyst } from "./agents/githubAnalyst.js";
import { jiraWriter } from "./agents/jiraWriter.js";
import { ORCHESTRATOR_PROMPT } from "./prompts/orchestrator.js";

export function createSprintManagerAgent() {
  return createDeepAgent({
    model: config.agent.model,
    systemPrompt: ORCHESTRATOR_PROMPT,
    subagents: [jiraAnalyst, githubAnalyst, jiraWriter],
  });
}

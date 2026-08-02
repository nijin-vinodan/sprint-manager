import { createDeepAgent } from "deepagents";
import { config } from "../config.js";
import { jiraAnalyst } from "../agents/jiraAnalyst.js";
import { githubAnalyst } from "../agents/githubAnalyst.js";
import { ORCHESTRATOR_PROMPT } from "../prompts/orchestrator.js";
import { getCheckpointer } from "./checkpointer.js";

type SprintManagerAgent = ReturnType<typeof createDeepAgent>;

let agentPromise: Promise<SprintManagerAgent> | undefined;

/**
 * One agent instance per process, built once and reused across every request —
 * this is what makes the service stateless per-process: nothing about a run
 * lives on the instance itself, all durable state goes through the Postgres
 * checkpointer keyed by thread_id.
 */
export async function getAgent(): Promise<SprintManagerAgent> {
  if (!agentPromise) {
    agentPromise = getCheckpointer().then((checkpointer) =>
      createDeepAgent({
        model: config.agent.model,
        systemPrompt: ORCHESTRATOR_PROMPT,
        subagents: [jiraAnalyst, githubAnalyst],
        checkpointer,
      }),
    );
  }
  return agentPromise;
}

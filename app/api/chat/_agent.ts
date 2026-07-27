import { createSprintManagerAgent } from "../../../dist/agent.js";

type SprintManagerAgent = ReturnType<typeof createSprintManagerAgent>;

const globalForAgent = globalThis as unknown as {
  __sprintManagerAgent?: SprintManagerAgent;
};

export function getSprintManagerAgent(): SprintManagerAgent {
  if (!globalForAgent.__sprintManagerAgent) {
    globalForAgent.__sprintManagerAgent = createSprintManagerAgent();
  }
  return globalForAgent.__sprintManagerAgent;
}

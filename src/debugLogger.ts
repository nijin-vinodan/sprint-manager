import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";

// Set DEBUG_AGENT=1 to see how the orchestrator plans, delegates to sub-agents,
// and uses its virtual filesystem. Silent otherwise so normal runs stay clean.
const enabled = process.env.DEBUG_AGENT === "1";

const FILESYSTEM_TOOLS = new Set(["ls", "read_file", "write_file", "edit_file", "glob", "grep"]);
const ROOT_LABEL = "orchestrator";

function truncate(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Tool/subagent results usually arrive as a serialized ToolMessage/Command
// envelope; unwrap to the actual text so logs show the answer, not the wrapper.
function unwrapToolOutput(output: unknown): unknown {
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // ToolMessage instances expose `.content` as a real instance property
    // (the `{lc, kwargs: {...}}` shape only appears via toJSON/stringify).
    if (typeof obj.content === "string" || Array.isArray(obj.content)) return obj.content;
    // Sub-agent results (from the `task` tool) come back as a LangGraph Command
    // whose `.update.messages` holds the sub-agent's final message.
    const messages = (obj.update as Record<string, unknown> | undefined)?.messages;
    if (Array.isArray(messages) && messages.length > 0) return unwrapToolOutput(messages[messages.length - 1]);
  }
  return output;
}

function parseInput(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attributes every tool call / model call to "orchestrator" or the sub-agent
 * that's actually running, by propagating a label from parent run to child run.
 * The `task` tool is deepagents' delegation mechanism — invoking it is how the
 * orchestrator hands work to a sub-agent, so its input names the sub-agent that
 * every run nested under it belongs to.
 */
export class AgentDebugLogger extends BaseCallbackHandler {
  name = "AgentDebugLogger";

  private labels = new Map<string, string>();

  private labelFor(parentRunId?: string): string {
    if (!parentRunId) return ROOT_LABEL;
    return this.labels.get(parentRunId) ?? ROOT_LABEL;
  }

  private propagate(runId: string, parentRunId: string | undefined): string {
    const label = this.labelFor(parentRunId);
    this.labels.set(runId, label);
    return label;
  }

  handleChainStart(_chain: Serialized, _inputs: unknown, runId: string, _runType?: string, _tags?: string[], _metadata?: unknown, _runName?: string, parentRunId?: string) {
    this.propagate(runId, parentRunId);
  }

  handleLLMStart(_llm: Serialized, prompts: string[], runId: string, parentRunId?: string) {
    const label = this.propagate(runId, parentRunId);
    console.log(`[${label}] 🧠 model call (${prompts.length} prompt block(s))`);
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    const label = this.propagate(runId, parentRunId);
    const toolName = runName ?? tool.name ?? "unknown_tool";

    if (toolName === "write_todos") {
      console.log(`[${label}] 📋 PLAN write_todos ->`, truncate(input));
      return;
    }

    if (toolName === "task") {
      const parsed = parseInput(input);
      const subagentName = (parsed?.subagent_type as string) ?? (parsed?.name as string) ?? "unknown-subagent";
      const description = (parsed?.description as string) ?? (parsed?.prompt as string) ?? input;
      console.log(`[${label}] 🚀 DELEGATE -> ${subagentName}:`, truncate(description));
      // Everything nested under this exact tool call belongs to that sub-agent.
      this.labels.set(runId, subagentName);
      return;
    }

    if (FILESYSTEM_TOOLS.has(toolName)) {
      console.log(`[${label}] 🗂️  MEMORY ${toolName} ->`, truncate(input));
      return;
    }

    console.log(`[${label}] 🔧 TOOL ${toolName} ->`, truncate(input));
  }

  handleToolEnd(output: unknown, runId: string) {
    const label = this.labels.get(runId) ?? ROOT_LABEL;
    console.log(`[${label}] ✅ done ->`, truncate(unwrapToolOutput(output)));
  }

  handleToolError(err: unknown, runId: string) {
    const label = this.labels.get(runId) ?? ROOT_LABEL;
    console.log(`[${label}] ❌ tool error ->`, truncate(err instanceof Error ? err.message : err));
  }
}

// Empty array (not undefined) so callers can always spread this into `callbacks`,
// same convention as `langfuseCallbacks` in tracing.ts.
export const debugCallbacks = enabled ? [new AgentDebugLogger()] : [];

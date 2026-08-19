import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ReasoningLogEntry } from "./store.js";

function truncate(value: unknown, max = 2000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Collects an ordered audit trail of the agent's reasoning and tool calls
 * (algorithm choices, Python scripts it runs, results it sees) for
 * predictor_evaluation_runs.reasoning_log — the "log the agent's reasoning,
 * not just the final metrics" requirement. Same BaseCallbackHandler shape as
 * AgentDebugLogger (src/debugLogger.ts), but persisted rather than printed.
 */
export class ReasoningLogger extends BaseCallbackHandler {
  name = "ReasoningLogger";

  private readonly entries: ReasoningLogEntry[] = [];

  getEntries(): ReasoningLogEntry[] {
    return this.entries;
  }

  handleLLMEnd(output: { generations: Array<Array<{ text?: string }>> }) {
    const text = output.generations[0]?.[0]?.text;
    if (text) this.entries.push({ step: `model turn ${this.entries.length + 1}`, type: "reasoning", content: truncate(text) });
  }

  handleToolStart(tool: Serialized, input: string, _runId: string, _parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, runName?: string) {
    const toolName = runName ?? tool.name ?? "unknown_tool";
    this.entries.push({ step: `tool call: ${toolName}`, type: "tool_call", content: truncate(input) });
  }

  handleToolEnd(output: unknown) {
    this.entries.push({ step: "tool result", type: "tool_result", content: truncate(output) });
  }

  handleToolError(err: unknown) {
    this.entries.push({ step: "tool error", type: "error", content: truncate(err instanceof Error ? err.message : err) });
  }
}

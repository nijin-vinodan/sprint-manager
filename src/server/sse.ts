// SSE event schema and pump logic for /invoke/stream. Mirrors the shape any
// caller of a DeepAgent v3 stream needs — subagent delegation, tool calls,
// and orchestrator-level tokens — so the dashboard (or any other consumer)
// gets the same rich event stream whether the agent runs in-process or, as
// now, behind this standalone server.

import { insertStreamChunk } from "./streamChunks.js";
import { broadcastLocal } from "./runRegistry.js";

export type SseEvent =
  | { type: "subagent_start"; path: string[]; name: string }
  | { type: "subagent_end"; path: string[]; name: string; error?: string }
  | { type: "tool_call"; path: string[]; callId: string; name: string; input: unknown }
  | {
      type: "tool_result";
      path: string[];
      callId: string;
      name: string;
      output?: unknown;
      status: "finished" | "error";
      error?: string;
    }
  | { type: "token"; path: string[]; text: string }
  | { type: "done"; threadId: string; response: string }
  | { type: "error"; message: string };

export function sseFrame(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Builds a persisting emit function for a run: every event is durably
 * recorded to stream_chunks (so a reconnecting client can replay it) and
 * fanned out to any same-replica resume subscribers, in addition to whatever
 * the caller does with it (e.g. writing to the owning reply). Ordering is
 * preserved because every event for a run flows through this single function,
 * called synchronously from one run loop — the persist write is
 * fire-and-forget from the caller's perspective, not awaited before the next
 * event is produced.
 */
export function createRunEmitter(threadId: string, runId: string): (event: SseEvent) => void {
  let seq = 0;
  return (event: SseEvent) => {
    const mySeq = seq++;
    void insertStreamChunk(runId, mySeq, threadId, event).catch(() => {
      // Best-effort persistence — a failed write only degrades resume for
      // this event, it must never break the live stream to the owning reply.
    });
    broadcastLocal(runId, mySeq, event);
  };
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Filters a checkpoint's full `messages` channel (every HumanMessage,
 * AIMessage, ToolMessage, and SystemMessage ever appended across every turn)
 * down to what a chat UI should replay: user prompts, and only the AI's
 * final text replies — not intermediate tool-calling steps or tool results.
 */
export function checkpointMessagesToHistory(messages: unknown[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const raw of messages) {
    const msg = raw as {
      getType?: () => string;
      _getType?: () => string;
      content: unknown;
      tool_calls?: unknown[];
    };
    const type = msg.getType?.() ?? msg._getType?.();
    if (type === "human") {
      history.push({ role: "user", content: extractText(msg.content) });
    } else if (type === "ai") {
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      const text = extractText(msg.content);
      if (!hasToolCalls && text.length > 0) {
        history.push({ role: "assistant", content: text });
      }
    }
    // SystemMessage, ToolMessage, and tool-call-only AIMessage are dropped.
  }
  return history;
}

interface ToolCallLike {
  name: string;
  callId: string;
  input: unknown;
  output: Promise<unknown>;
  status: Promise<"running" | "finished" | "error">;
  error: Promise<string | undefined>;
}

interface MessageLike {
  text: AsyncIterable<string>;
}

interface SubagentLike {
  name: string;
  output: Promise<unknown>;
  messages: AsyncIterable<MessageLike>;
  toolCalls: AsyncIterable<ToolCallLike>;
  subagents: AsyncIterable<SubagentLike>;
}

export interface DeepAgentRunLike {
  messages: AsyncIterable<MessageLike>;
  toolCalls: AsyncIterable<ToolCallLike>;
  subagents: AsyncIterable<SubagentLike>;
}

/**
 * Wires up a DeepAgent v3 run's `.messages`/`.toolCalls`/`.subagents` async
 * iterables to `emit`, tracking every spawned pump so the caller can wait for
 * all of them to drain before sending the final `done` event.
 */
export function pumpRun(run: DeepAgentRunLike, emit: (event: SseEvent) => void) {
  const inflight = new Set<Promise<void>>();
  const track = (p: Promise<void>) => {
    inflight.add(p);
    p.catch(() => {}).finally(() => inflight.delete(p));
    return p;
  };

  async function pumpMessages(messages: AsyncIterable<MessageLike>, path: string[]) {
    for await (const msg of messages) {
      for await (const token of msg.text) {
        if (path.length === 0) emit({ type: "token", path, text: token });
      }
    }
  }

  async function pumpToolCalls(toolCalls: AsyncIterable<ToolCallLike>, path: string[]) {
    for await (const call of toolCalls) {
      if (call.name === "task") continue; // delegation tool — represented via subagent_start/end instead
      emit({ type: "tool_call", path, callId: call.callId, name: call.name, input: call.input });
      track(
        (async () => {
          const [status, err] = await Promise.all([call.status, call.error]);
          const output = status === "finished" ? await call.output.catch(() => undefined) : undefined;
          emit({
            type: "tool_result",
            path,
            callId: call.callId,
            name: call.name,
            output,
            status: status === "error" ? "error" : "finished",
            error: err,
          });
        })(),
      );
    }
  }

  async function pumpSubagents(subagents: AsyncIterable<SubagentLike>, path: string[]) {
    for await (const sub of subagents) {
      const subPath = [...path, sub.name];
      emit({ type: "subagent_start", path: subPath, name: sub.name });

      track(pumpMessages(sub.messages, subPath));
      track(pumpToolCalls(sub.toolCalls, subPath));
      track(pumpSubagents(sub.subagents, subPath));

      track(
        sub.output.then(
          () => emit({ type: "subagent_end", path: subPath, name: sub.name }),
          (err) =>
            emit({
              type: "subagent_end",
              path: subPath,
              name: sub.name,
              error: err instanceof Error ? err.message : String(err),
            }),
        ),
      );
    }
  }

  track(pumpMessages(run.messages, []));
  track(pumpToolCalls(run.toolCalls, []));
  track(pumpSubagents(run.subagents, []));

  return {
    /** Resolves once every pump spawned so far (recursively) has settled. */
    async drain() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

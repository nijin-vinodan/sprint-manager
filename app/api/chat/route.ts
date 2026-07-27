import { NextRequest } from "next/server";
import { getSprintManagerAgent } from "./_agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };

interface ChatRequestBody {
  messages: ChatMessage[];
}

type SseEvent =
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
  | { type: "done"; text: string }
  | { type: "error"; message: string };

function sseFrame(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
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

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return new Response("`messages` must be a non-empty array", { status: 400 });
  }

  const agent = getSprintManagerAgent();
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  req.signal.addEventListener("abort", () => abortController.abort(req.signal.reason));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: SseEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          // controller already closed (client disconnected mid-flush)
        }
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // ignore
        }
      }, 15_000);

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

      try {
        const run = await agent.streamEvents(
          { messages: body.messages },
          { version: "v3", signal: abortController.signal },
        );

        track(pumpMessages(run.messages, []));
        track(pumpToolCalls(run.toolCalls, []));
        track(pumpSubagents(run.subagents, []));

        const finalState = await run.output;

        while (inflight.size > 0) {
          await Promise.allSettled([...inflight]);
        }

        const lastMessage = finalState.messages[finalState.messages.length - 1];
        emit({ type: "done", text: extractText(lastMessage?.content) });
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        closed = true;
        clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

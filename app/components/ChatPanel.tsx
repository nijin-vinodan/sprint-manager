"use client";

import { useCallback, useRef, useState } from "react";
import { Markdown } from "./Markdown";

type Role = "user" | "assistant";
interface ChatMessage {
  role: Role;
  content: string;
}

type TodoStatus = "pending" | "in_progress" | "completed";
interface TodoItem {
  content: string;
  status: TodoStatus;
}

const TODO_STATUS_ICON: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
};

type SseEvent =
  | { type: "subagent_start"; path: string[]; name: string }
  | { type: "subagent_end"; path: string[]; name: string; error?: string }
  | { type: "tool_call"; path: string[]; callId: string; name: string; input: unknown }
  | { type: "tool_result"; path: string[]; callId: string; name: string; output?: unknown; status: string; error?: string }
  | { type: "token"; path: string[]; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

interface ActiveSubagent {
  name: string;
  path: string[];
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [activeSubagents, setActiveSubagents] = useState<ActiveSubagent[]>([]);
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const [plan, setPlan] = useState<TodoItem[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (userText: string) => {
      if (!userText.trim() || isStreaming) return;

      const nextHistory: ChatMessage[] = [...messages, { role: "user", content: userText }];
      setMessages(nextHistory);
      setInput("");
      setStreamingText("");
      setActiveSubagents([]);
      setToolActivity([]);
      setPlan([]);
      setError(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      function handleEvent(event: SseEvent) {
        switch (event.type) {
          case "subagent_start":
            setActiveSubagents((prev) => [...prev, { name: event.name, path: event.path }]);
            break;
          case "subagent_end":
            setActiveSubagents((prev) => prev.filter((s) => s.name !== event.name));
            if (event.error) {
              setToolActivity((prev) => [...prev, `${event.name} failed: ${event.error}`]);
            }
            break;
          case "tool_call":
            if (event.name === "write_todos") {
              const todos = (event.input as { todos?: TodoItem[] } | undefined)?.todos;
              if (Array.isArray(todos)) setPlan(todos);
              break;
            } else {
              console.log("No write_todos event, event.input:", event.input);
            }
            setToolActivity((prev) => [
              ...prev,
              `${event.path.join(" > ") || "orchestrator"}: calling ${event.name}`,
            ]);
            break;
          case "tool_result":
            setToolActivity((prev) => [
              ...prev,
              `${event.path.join(" > ") || "orchestrator"}: ${event.name} ${event.status}`,
            ]);
            break;
          case "token":
            if (event.path.length === 0) {
              setStreamingText((prev) => prev + event.text);
            }
            break;
          case "done":
            setMessages((prev) => [...prev, { role: "assistant", content: event.text }]);
            setStreamingText("");
            break;
          case "error":
            setError(event.message);
            break;
        }
      }

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: nextHistory }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Chat request failed: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            const event: SseEvent = JSON.parse(dataLine.slice("data: ".length));
            handleEvent(event);
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIsStreaming(false);
        setActiveSubagents([]);
        abortRef.current = null;
      }
    },
    [messages, isStreaming],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return (
    <div className="flex h-full flex-col gap-3">
      <h2 className="text-lg font-semibold">Chat</h2>

      {activeSubagents.map((s) => (
        <div
          key={s.name}
          className="rounded-md bg-indigo-500/10 px-3 py-1 text-xs text-indigo-700 dark:text-indigo-300"
        >
          Working: {s.name}…
        </div>
      ))}

      {plan.length > 0 && (
        <ul className="rounded-md bg-slate-100 p-2 text-xs dark:bg-slate-900">
          {plan.map((todo, i) => (
            <li
              key={i}
              className={
                todo.status === "completed"
                  ? "text-slate-500 line-through"
                  : todo.status === "in_progress"
                    ? "text-indigo-700 dark:text-indigo-300"
                    : "text-slate-600 dark:text-slate-300"
              }
            >
              {TODO_STATUS_ICON[todo.status]} {todo.content}
            </li>
          ))}
        </ul>
      )}

      <div className="flex-1 overflow-y-auto rounded-md bg-slate-100 p-3 dark:bg-slate-900">
        <div className="flex flex-col gap-3">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="self-end rounded-md bg-indigo-600 px-3 py-2 text-sm text-white">
                {m.content}
              </div>
            ) : (
              <div key={i} className="rounded-md bg-slate-200 px-3 py-2 text-sm dark:bg-slate-800">
                <Markdown text={m.content} />
              </div>
            ),
          )}
          {isStreaming && streamingText && (
            <div className="rounded-md bg-slate-200 px-3 py-2 text-sm dark:bg-slate-800">
              <Markdown text={streamingText} />
            </div>
          )}
        </div>
      </div>

      {toolActivity.length > 0 && (
        <ul className="max-h-24 overflow-y-auto rounded-md bg-slate-200 p-2 font-mono text-xs text-slate-500 dark:bg-slate-950">
          {toolActivity.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}

      {error && (
        <div className="rounded-md bg-red-500/10 p-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the sprint…"
          disabled={isStreaming}
          className="flex-1 rounded-md bg-slate-100 px-3 py-2 text-sm outline-none disabled:opacity-50 dark:bg-slate-900"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={cancel}
            className="rounded-md bg-red-600 px-4 py-2 text-sm hover:bg-red-500"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm hover:bg-indigo-500"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}

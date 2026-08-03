"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

const THREAD_ID_KEY = "sprintmanager.chat.threadId";

// Only called from a useEffect (client-only) — never during SSR, where
// localStorage doesn't exist.
function loadOrCreateThreadId(): string {
  const stored = localStorage.getItem(THREAD_ID_KEY);
  if (stored) return stored;
  const fresh = crypto.randomUUID();
  localStorage.setItem(THREAD_ID_KEY, fresh);
  return fresh;
}

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
  | { type: "done"; threadId: string; response: string }
  | { type: "error"; message: string };

interface ActiveSubagent {
  name: string;
  path: string[];
}

// Shared by a fresh send() and the resume-after-refresh effect below — both
// consume the exact same SSE frame format, so there's one parsing loop rather
// than two copies that could drift.
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
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
      onEvent(event);
    }
  }
}

export function ChatPanel() {
  // threadId persists in localStorage across refreshes, so the standalone
  // agent server's checkpointer can recall prior turns — the message history
  // below is then hydrated from Postgres via that same threadId, not cached
  // client-side, so it survives a refresh without a client-side cache of its own.
  // Starts empty (not read from localStorage directly) since this component
  // renders during SSR, where localStorage doesn't exist — resolved to a real
  // value in the mount effect below, same pattern as ThemeToggle.tsx.
  const [threadId, setThreadId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [activeSubagents, setActiveSubagents] = useState<ActiveSubagent[]>([]);
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const [plan, setPlan] = useState<TodoItem[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setThreadId(loadOrCreateThreadId());
  }, []);

  useEffect(() => {
    if (!threadId) return; // still resolving from localStorage (see mount effect above)
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chat/history?threadId=${encodeURIComponent(threadId)}`);
        if (!res.ok) return; // degrade to empty chat — a history-load hiccup isn't a send failure
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.messages)) {
          setMessages(data.messages);
        }
      } catch {
        // network error / bad JSON — degrade silently to empty chat
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const handleEvent = useCallback((event: SseEvent) => {
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
        setMessages((prev) => [...prev, { role: "assistant", content: event.response }]);
        setStreamingText("");
        break;
      case "error":
        setError(event.message);
        break;
    }
  }, []);

  // Resumes a token-level replay of an in-flight run after a page refresh:
  // the server keeps a disconnected run going and buffers every emitted
  // event, so on remount we just try to reattach — a 204 (no active run)
  // means there's nothing to resume, and the existing history effect above
  // already covers any turn that had already completed.
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/chat/stream?threadId=${encodeURIComponent(threadId)}`, {
          signal: controller.signal,
        });
        if (res.status === 204 || !res.body) return;

        setIsStreaming(true);
        abortRef.current = controller;
        try {
          await consumeSseStream(res.body, handleEvent);
        } finally {
          setIsStreaming(false);
          setActiveSubagents([]);
          abortRef.current = null;
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => controller.abort();
  }, [threadId, handleEvent]);

  const startNewChat = useCallback(() => {
    const fresh = crypto.randomUUID();
    localStorage.setItem(THREAD_ID_KEY, fresh);
    setThreadId(fresh);
    setMessages([]);
    setStreamingText("");
    setActiveSubagents([]);
    setToolActivity([]);
    setPlan([]);
    setError(null);
  }, []);

  const send = useCallback(
    async (userText: string) => {
      if (!userText.trim() || isStreaming || !threadId) return;

      setMessages((prev) => [...prev, { role: "user", content: userText }]);
      setInput("");
      setStreamingText("");
      setActiveSubagents([]);
      setToolActivity([]);
      setPlan([]);
      setError(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, message: userText }),
          signal: controller.signal,
        });
        if (res.status === 409) {
          throw new Error("Still working on your last question for this session — try again in a moment.");
        }
        if (!res.ok || !res.body) {
          throw new Error(`Chat request failed: ${res.status}`);
        }

        await consumeSseStream(res.body, handleEvent);
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
    [threadId, isStreaming, handleEvent],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    if (threadId) {
      fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      }).catch(() => {
        // Best-effort — the local abort above already stops the UI regardless.
      });
    }
  }, [threadId]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Chat</h2>
        <button
          type="button"
          onClick={startNewChat}
          disabled={isStreaming}
          className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-200 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          New chat
        </button>
      </div>

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

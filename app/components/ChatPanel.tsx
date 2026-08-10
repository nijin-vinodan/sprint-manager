"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import { AgentStatusBanner } from "./chat/AgentStatusBanner";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatInputForm } from "./chat/ChatInputForm";
import { MessageList } from "./chat/MessageList";
import { PlanList } from "./chat/PlanList";
import { ToolActivityLog } from "./chat/ToolActivityLog";
import { consumeSseStream } from "./chat/consumeSseStream";
import {
  THREAD_ID_KEY,
  generateId,
  loadOrCreateThreadId,
  type ActiveSubagent,
  type ChatMessage,
  type SseEvent,
  type TodoItem,
} from "./chat/types";

interface ChatPanelProps {
  collapseButton?: React.ReactNode;
}

export function ChatPanel({ collapseButton }: ChatPanelProps) {
  const [threadId, setThreadId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [activeSubagents, setActiveSubagents] = useState<ActiveSubagent[]>([]);
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const [plan, setPlan] = useState<TodoItem[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setThreadId(loadOrCreateThreadId());
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setIsLoadingHistory(true);
    (async () => {
      try {
        const res = await fetch(`/api/chat/history?threadId=${encodeURIComponent(threadId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.messages)) {
          setMessages(
            (data.messages as Omit<ChatMessage, "id">[]).map((m, i) => ({
              ...m,
              id: `history-${i}`,
            })),
          );
        }
      } catch {
        // network error / bad JSON — degrade silently
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
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
        setMessages((prev) => [
          ...prev,
          { id: generateId(), role: "assistant", content: event.response },
        ]);
        setStreamingText("");
        break;
      case "error":
        setError(event.message);
        break;
    }
  }, []);

  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    (async () => {
      setIsResuming(true);
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
      } finally {
        setIsResuming(false);
      }
    })();
    return () => controller.abort();
  }, [threadId, handleEvent]);

  const switchToThread = useCallback((id: string) => {
    abortRef.current?.abort();
    localStorage.setItem(THREAD_ID_KEY, id);
    setThreadId(id);
    setMessages([]);
    setStreamingText("");
    setActiveSubagents([]);
    setToolActivity([]);
    setPlan([]);
    setError(null);
    setIsStreaming(false);
    setShowHistory(false);
  }, []);

  const startNewChat = useCallback(() => switchToThread(generateId()), [switchToThread]);

  const send = useCallback(
    async (userText: string) => {
      if (!userText.trim() || isStreaming || isResuming || !threadId) return;

      setMessages((prev) => [...prev, { id: generateId(), role: "user", content: userText }]);
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
    [threadId, isStreaming, isResuming, handleEvent],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    if (threadId) {
      fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      }).catch(() => {});
    }
  }, [threadId]);

  return (
    <div className="p-6 relative flex h-full flex-col gap-3 overflow-hidden">
      <ChatHeader
        collapseButton={collapseButton}
        isLoadingHistory={isLoadingHistory}
        isStreaming={isStreaming}
        isResuming={isResuming}
        onToggleHistory={() => setShowHistory((v) => !v)}
        onNewChat={startNewChat}
      />

      <ChatHistoryDrawer
        open={showHistory}
        currentThreadId={threadId}
        onSelect={switchToThread}
        onNewChat={startNewChat}
        onClose={() => setShowHistory(false)}
        disabled={isStreaming}
      />

      <AgentStatusBanner activeSubagents={activeSubagents} />

      <PlanList plan={plan} />

      <MessageList
        messages={messages}
        streamingText={streamingText}
        isStreaming={isStreaming}
        isLoadingHistory={isLoadingHistory}
        isResuming={isResuming}
        scrollRef={scrollRef}
      />

      <ToolActivityLog toolActivity={toolActivity} />

      {error && (
        <div className="rounded-md bg-red-500/10 p-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <ChatInputForm
        input={input}
        isStreaming={isStreaming}
        isLoadingHistory={isLoadingHistory}
        isResuming={isResuming}
        textareaRef={textareaRef}
        onInputChange={setInput}
        onSend={send}
        onCancel={cancel}
      />

      <p className="text-center text-xs text-gray-400">
        Sprint Manager can make mistakes. Check important info.
      </p>
    </div>
  );
}

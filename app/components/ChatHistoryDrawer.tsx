"use client";

import { useEffect, useState } from "react";

const DRAWER_WIDTH = 208;

interface ThreadSummary {
  threadId: string;
  updatedAt: string | null;
  preview: string;
  messageCount: number;
}

function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

// Always mounted (just translated off-screen when closed) so the slide-in
// has something to animate from — a conditionally-rendered element can't
// transition in on mount.
export function ChatHistoryDrawer({
  open,
  currentThreadId,
  onSelect,
  onNewChat,
  onClose,
  disabled,
}: {
  open: boolean;
  currentThreadId: string;
  onSelect: (threadId: string) => void;
  onNewChat: () => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat/threads?limit=30");
        if (!res.ok) throw new Error(`Failed to load past chats: ${res.status}`);
        const data = await res.json();
        if (!cancelled) setThreads(Array.isArray(data?.threads) ? data.threads : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch whenever a new chat is created/switched into, so a freshly
    // started thread shows up in the list once it has its first message.
  }, [currentThreadId]);

  return (
    <div
      style={{ width: DRAWER_WIDTH }}
      className={`absolute inset-y-0 right-0 z-10 flex transform flex-col border-l border-slate-200 bg-white shadow-lg transition-transform duration-300 ease-in-out dark:border-slate-800 dark:bg-slate-950 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
        <button
          type="button"
          onClick={onNewChat}
          disabled={disabled}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <NewChatIcon />
          New chat
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat history"
          className="rounded-md px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-800"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && <p className="px-1 text-xs text-slate-400">Loading…</p>}
        {error && <p className="px-1 text-xs text-red-500">{error}</p>}
        {!loading && !error && threads.length === 0 && (
          <p className="px-1 text-xs text-slate-400">No past chats yet.</p>
        )}
        <ul className="flex flex-col gap-0.5">
          {threads.map((t) => (
            <li key={t.threadId}>
              <button
                type="button"
                onClick={() => onSelect(t.threadId)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 ${
                  t.threadId === currentThreadId ? "bg-indigo-500/10" : ""
                }`}
              >
                <div className="truncate text-slate-700 dark:text-slate-200">{t.preview || "(empty chat)"}</div>
                {t.updatedAt && (
                  <div className="text-[10px] text-slate-400">{new Date(t.updatedAt).toLocaleDateString()}</div>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

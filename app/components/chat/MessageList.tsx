import type { RefObject } from "react";
import { Markdown } from "../Markdown";
import { TypingDots } from "./TypingDots";
import type { ChatMessage } from "./types";

interface MessageListProps {
  messages: ChatMessage[];
  streamingText: string;
  isStreaming: boolean;
  isLoadingHistory: boolean;
  isResuming: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function MessageList({
  messages,
  streamingText,
  isStreaming,
  isLoadingHistory,
  isResuming,
  scrollRef,
}: MessageListProps) {
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-md">
      {(isLoadingHistory || isResuming) && (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent dark:border-slate-500" />
          {isResuming ? "Reattaching to in-progress response…" : "Loading conversation…"}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="self-end rounded-md bg-blue-600 px-6 py-6 text-sm text-white">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="rounded-md bg-slate-200 px-6 py-6 text-sm dark:bg-slate-800">
              <Markdown text={m.content} />
            </div>
          ),
        )}
        {isStreaming && streamingText && (
          <div className="rounded-md bg-slate-200 px-6 py-6 text-sm dark:bg-slate-800">
            <Markdown text={streamingText} />
            <TypingDots />
          </div>
        )}
        {isStreaming && !streamingText && (
          <div className="rounded-md bg-slate-200 px-6 py-6 text-sm dark:bg-slate-800">
            <TypingDots />
          </div>
        )}
      </div>
    </div>
  );
}

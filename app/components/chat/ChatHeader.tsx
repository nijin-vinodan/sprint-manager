interface ChatHeaderProps {
  collapseButton?: React.ReactNode;
  isLoadingHistory: boolean;
  isStreaming: boolean;
  isResuming: boolean;
  onToggleHistory: () => void;
  onNewChat: () => void;
}

export function ChatHeader({
  collapseButton,
  isLoadingHistory,
  isStreaming,
  isResuming,
  onToggleHistory,
  onNewChat,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-semibold">Chat</h2>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleHistory}
          disabled={isLoadingHistory}
          className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-200 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          History
        </button>
        <button
          type="button"
          onClick={onNewChat}
          disabled={isStreaming || isLoadingHistory || isResuming}
          className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-200 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          New chat
        </button>
        {collapseButton}
      </div>
    </div>
  );
}

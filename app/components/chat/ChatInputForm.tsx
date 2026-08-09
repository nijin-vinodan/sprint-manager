import type { RefObject } from "react";

interface ChatInputFormProps {
  input: string;
  isStreaming: boolean;
  isLoadingHistory: boolean;
  isResuming: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function ChatInputForm({
  input,
  isStreaming,
  isLoadingHistory,
  isResuming,
  textareaRef,
  onInputChange,
  onSend,
  onCancel,
}: ChatInputFormProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend(input);
      }}
      className="flex items-end gap-2"
    >
      <textarea
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend(input);
          }
        }}
        placeholder="Ask about the sprint…"
        aria-label="Chat message"
        disabled={isStreaming || isLoadingHistory || isResuming}
        rows={1}
        className="flex-1 resize-none rounded-md bg-slate-100 px-3 py-2 text-sm outline-none disabled:opacity-50 dark:bg-slate-900"
        style={{ maxHeight: "10rem" }}
        ref={textareaRef}
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-500"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={isLoadingHistory || isResuming}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          Send
        </button>
      )}
    </form>
  );
}

export const THREAD_ID_KEY = "sprintmanager.chat.threadId";

// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost) —
// falls back to a Math.random-based UUID v4 when served over plain HTTP.
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function loadOrCreateThreadId(): string {
  const stored = localStorage.getItem(THREAD_ID_KEY);
  if (stored) return stored;
  const fresh = generateId();
  localStorage.setItem(THREAD_ID_KEY, fresh);
  return fresh;
}

export type Role = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export const TODO_STATUS_ICON: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
};

export type SseEvent =
  | { type: "subagent_start"; path: string[]; name: string }
  | { type: "subagent_end"; path: string[]; name: string; error?: string }
  | { type: "tool_call"; path: string[]; callId: string; name: string; input: unknown }
  | { type: "tool_result"; path: string[]; callId: string; name: string; output?: unknown; status: string; error?: string }
  | { type: "token"; path: string[]; text: string }
  | { type: "done"; threadId: string; response: string }
  | { type: "error"; message: string };

export interface ActiveSubagent {
  name: string;
  path: string[];
}

import type { SseEvent } from "./types";

export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const event: SseEvent = JSON.parse(dataLine.slice("data: ".length));
          onEvent(event);
        } catch {
          // Malformed SSE frame — skip and keep consuming.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

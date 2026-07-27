import { createSprintManagerAgent } from "./agent.js";
import { langfuseCallbacks, shutdownTracing } from "./tracing.js";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block as { text?: string }).text ?? ""))
      .join("");
  }
  return String(content);
}

async function main() {
  const prompt = process.argv[2] ?? "Give me today's sprint status update";

  const agent = createSprintManagerAgent();
  const result = await agent.invoke(
    { messages: [{ role: "user", content: prompt }] },
    { callbacks: langfuseCallbacks },
  );

  const lastMessage = result.messages[result.messages.length - 1];
  console.log(messageText(lastMessage.content));
}

main()
  .catch((err) => {
    console.error("Sprint Manager agent failed:", err);
    process.exitCode = 1;
  })
  .finally(shutdownTracing);

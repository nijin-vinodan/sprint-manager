import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { serverConfig } from "./config.js";

let checkpointer: PostgresSaver | undefined;
let setupPromise: Promise<void> | undefined;

/**
 * Lazily builds a single PostgresSaver for the process and runs its one-time
 * `.setup()` migration exactly once, no matter how many requests race to call
 * this concurrently on startup.
 */
export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    checkpointer = PostgresSaver.fromConnString(serverConfig.databaseUrl);
  }
  if (!setupPromise) {
    setupPromise = checkpointer.setup();
  }
  await setupPromise;
  return checkpointer;
}

import "dotenv/config";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { CallbackHandler } from "@langfuse/langchain";

const langfuseEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

let callbackHandler: CallbackHandler | undefined;
let spanProcessor: LangfuseSpanProcessor | undefined;
let sdk: NodeSDK | undefined;

if (langfuseEnabled) {
  spanProcessor = new LangfuseSpanProcessor();
  sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
  });
  sdk.start();
  callbackHandler = new CallbackHandler();
}

// Empty array (not undefined) so callers can always spread this into `callbacks`.
export const langfuseCallbacks = callbackHandler ? [callbackHandler] : [];

// The batch span processor buffers spans in memory — short-lived CLI runs must
// flush/shutdown explicitly before exit, or the process ends before anything is sent.
export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
}

// For long-lived processes (the Next.js dashboard server): push buffered spans
// out after each request without tearing down the SDK, so traces show up promptly.
export async function flushTracing(): Promise<void> {
  await spanProcessor?.forceFlush();
}

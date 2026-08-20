import { buildServer } from "./app.js";
import { serverConfig } from "./config.js";
import { shutdownTracing } from "../tracing.js";

async function main() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down`);
    await app.close();
    await shutdownTracing();
    process.exit(signal === "uncaughtException" ? 1 : 0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Background failures (e.g. a Langfuse/OTel span export timing out well
  // after the request that triggered it has finished) must not take down a
  // process serving other in-flight threads/locks/SSE streams. Node's
  // default behavior for an unhandled rejection is to crash the process —
  // log it instead and keep running. `uncaughtException` is left fatal
  // (Node's own recommendation: state after a truly uncaught exception may
  // be corrupt) but still goes through the same graceful shutdown path
  // rather than exiting mid-request.
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "Unhandled promise rejection (process kept alive)");
  });
  process.on("uncaughtException", (err) => {
    app.log.error({ err }, "Uncaught exception, shutting down");
    void shutdown("uncaughtException");
  });

  await app.listen({ port: serverConfig.port, host: serverConfig.host });
}

main().catch((err) => {
  console.error("Sprint Manager server failed to start:", err);
  process.exitCode = 1;
});

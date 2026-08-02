import { buildServer } from "./app.js";
import { serverConfig } from "./config.js";
import { shutdownTracing } from "../tracing.js";

async function main() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down`);
    await app.close();
    await shutdownTracing();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: serverConfig.port, host: serverConfig.host });
}

main().catch((err) => {
  console.error("Sprint Manager server failed to start:", err);
  process.exitCode = 1;
});

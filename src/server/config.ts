import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const serverConfig = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: requireEnv("DATABASE_URL"),
  apiClientsPath: process.env.API_CLIENTS_PATH ?? "./api-clients.json",
  // How long a thread_locks row can be held before a new request is allowed to
  // reclaim it — guards against a lock stuck forever because a replica crashed
  // mid-run and never reached its `finally` release.
  lockStaleSeconds: Number(process.env.LOCK_STALE_SECONDS ?? 600),
  // How long a completed/in-progress run's stream_chunks rows are kept around
  // so a client can resume a token-level replay after a refresh — swept on
  // every releaseLock call rather than via a separate scheduler.
  streamChunkTtlHours: Number(process.env.STREAM_CHUNK_TTL_HOURS ?? 12),
} as const;

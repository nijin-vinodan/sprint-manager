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
} as const;

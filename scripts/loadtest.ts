import "dotenv/config";
import { randomUUID } from "node:crypto";

/**
 * Ad-hoc load/concurrency test for the standalone agent server (src/server/).
 * Not a correctness test suite (see CLAUDE.md: there is no test runner in
 * this repo) — this is a throwaway script for exercising two things that
 * matter under load:
 *
 *   throughput  Many distinct threadIds fired concurrently, to see how the
 *               server + Postgres pool hold up and what the latency/error
 *               distribution looks like.
 *   lock        Many requests racing on the SAME threadId, to verify the
 *               thread_locks UPSERT (src/server/locks.ts) actually
 *               serializes: exactly one 200, the rest 409.
 *
 * Usage:
 *   npx tsx scripts/loadtest.ts throughput --count 50 --concurrency 10
 *   npx tsx scripts/loadtest.ts lock --count 10
 *
 * Reads AGENT_SERVER_URL / AGENT_SERVER_API_KEY from the environment (the
 * same vars app/api/_lib/agentServer.ts uses), so it points at whatever
 * server your .env already configures for the dashboard.
 */

interface RunResult {
  status: number;
  ms: number;
  error?: string;
}

function parseArgs(argv: string[]) {
  const mode = argv[0];
  const opts: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) opts[key] = value;
  }
  return { mode, opts };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function invoke(baseUrl: string, apiKey: string, threadId: string, prompt: string): Promise<RunResult> {
  const start = performance.now();
  try {
    const res = await fetch(new URL("/invoke", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ threadId, prompt }),
    });
    // Drain the body so the connection is freed even though we only need the status.
    await res.text();
    return { status: res.status, ms: performance.now() - start };
  } catch (err) {
    return { status: 0, ms: performance.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runBatches<T>(items: T[], concurrency: number, fn: (item: T) => Promise<RunResult>): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function report(label: string, results: RunResult[], wallMs: number) {
  const byStatus = new Map<number, number>();
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

  const latencies = results.filter((r) => r.status !== 0).map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => r.error);

  console.log(`\n=== ${label} ===`);
  console.log(`total requests : ${results.length}`);
  console.log(`wall time      : ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`throughput     : ${(results.length / (wallMs / 1000)).toFixed(2)} req/s`);
  console.log(`status codes   : ${[...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join(", ")}`);
  if (latencies.length > 0) {
    console.log(`latency (ms)   : min=${latencies[0].toFixed(0)} p50=${percentile(latencies, 50).toFixed(0)} p95=${percentile(latencies, 95).toFixed(0)} max=${latencies[latencies.length - 1].toFixed(0)}`);
  }
  if (errors.length > 0) {
    console.log(`network errors : ${errors.length} (e.g. "${errors[0].error}")`);
  }
}

async function main() {
  const { mode, opts } = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.AGENT_SERVER_URL ?? requireEnv("AGENT_SERVER_URL");
  const apiKey = requireEnv("AGENT_SERVER_API_KEY");
  const prompt = opts.prompt ?? "What's blocking the sprint right now?";
  const count = Number(opts.count ?? 20);
  const concurrency = Number(opts.concurrency ?? 10);

  if (mode === "throughput") {
    const threadIds = Array.from({ length: count }, () => `loadtest-${randomUUID()}`);
    const start = performance.now();
    const results = await runBatches(threadIds, concurrency, (threadId) => invoke(baseUrl, apiKey, threadId, prompt));
    report(`throughput: ${count} requests, concurrency ${concurrency}, distinct threads`, results, performance.now() - start);
  } else if (mode === "lock") {
    const threadId = `loadtest-lock-${randomUUID()}`;
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: count }, () => invoke(baseUrl, apiKey, threadId, prompt)));
    report(`lock: ${count} concurrent requests on one threadId (expect one 200, rest 409)`, results, performance.now() - start);
  } else {
    console.error('Usage: npx tsx scripts/loadtest.ts <throughput|lock> [--count N] [--concurrency N] [--prompt "..."]');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("loadtest failed:", err);
  process.exitCode = 1;
});

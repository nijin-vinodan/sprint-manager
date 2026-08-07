import type { FastifyInstance } from "fastify";
import { getAgent } from "./agentRuntime.js";
import { getCheckpointer } from "./checkpointer.js";
import { pool } from "./db.js";
import { serverConfig } from "./config.js";
import { acquireLockOrReject, releaseLock } from "./locks.js";
import { requireApiKey } from "./auth.js";
import { langfuseCallbacks, flushTracing } from "../tracing.js";
import { debugCallbacks } from "../debugLogger.js";
import { extractText, sseFrame, pumpRun, checkpointMessagesToHistory, createRunEmitter, type SseEvent } from "./sse.js";
import { readStreamChunks } from "./streamChunks.js";
import { registerRun, unregisterRun, cancelRun, subscribeToRun } from "./runRegistry.js";
import { getActiveSprint, getSprintIssues } from "../tools/jira.js";
import { getOpenPullRequests, getRecentCommits } from "../tools/github.js";
import { config } from "../config.js";
import { getIssueComments, getIssuePredictionData, searchIssueKeys } from "../commentEvaluator/jiraClient.js";
import { extractFeatures, resolutionDaysFor } from "../prediction/featureExtraction.js";
import { insertResolutionRecord, getResolutionHistory } from "./resolutionHistory.js";
import { predictResolutionDays } from "../prediction/knn.js";
import { scoreConfidence } from "../prediction/confidence.js";
import { thresholds } from "../config.js";

interface InvokeBody {
  threadId: string;
  prompt: string;
}

function validateInvokeBody(body: unknown): InvokeBody {
  const { threadId, prompt } = (body ?? {}) as Partial<InvokeBody>;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error('"threadId" is required and must be a non-empty string');
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error('"prompt" is required and must be a non-empty string');
  }
  return { threadId, prompt };
}

interface ThreadSummary {
  threadId: string;
  updatedAt: string | null;
  preview: string;
  messageCount: number;
}

async function buildThreadSummary(threadId: string): Promise<ThreadSummary> {
  const checkpointer = await getCheckpointer();
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
  if (!tuple) return { threadId, updatedAt: null, preview: "", messageCount: 0 };
  const rawMessages = (tuple.checkpoint.channel_values.messages as unknown[]) ?? [];
  const history = checkpointMessagesToHistory(rawMessages);
  const firstUser = history.find((m) => m.role === "user");
  const preview = (firstUser?.content ?? history[history.length - 1]?.content ?? "").slice(0, 80);
  return {
    threadId,
    updatedAt: (tuple.checkpoint as { ts?: string }).ts ?? null,
    preview,
    messageCount: history.length,
  };
}

export async function listThreads(
  limit: number,
  offset: number,
): Promise<{ threads: ThreadSummary[]; hasMore: boolean }> {
  const { rows } = await pool.query<{ thread_id: string }>(
    `SELECT thread_id FROM checkpoints
     WHERE checkpoint_ns = ''
     GROUP BY thread_id
     ORDER BY MAX(checkpoint_id) DESC
     LIMIT $1 OFFSET $2`,
    [limit + 1, offset],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const threads = await Promise.all(page.map((r) => buildThreadSummary(r.thread_id)));
  return { threads, hasMore };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (protectedRoutes) => {
    // addHook is fastify's way of adding middleware to a route group; this one checks the x-api-key header.
    protectedRoutes.addHook("onRequest", requireApiKey);

    protectedRoutes.get("/threads", async (request, reply) => {
      const query = request.query as { limit?: string; offset?: string };
      const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 50);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

      try {
        const { threads, hasMore } = await listThreads(limit, offset);
        return reply.send({ threads, limit, offset, hasMore });
      } catch (err) {
        request.log.error({ app: request.apiClient?.appName, err }, "threads: list failed");
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    protectedRoutes.get("/threads/:threadId/history", async (request, reply) => {
      const { threadId } = request.params as { threadId: string };
      if (typeof threadId !== "string" || threadId.length === 0) {
        return reply.code(400).send({ error: '"threadId" is required and must be a non-empty string' });
      }

      try {
        const checkpointer = await getCheckpointer();
        const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
        if (!tuple) {
          return reply.send({ threadId, messages: [] });
        }
        const rawMessages = (tuple.checkpoint.channel_values.messages as unknown[]) ?? [];
        return reply.send({ threadId, messages: checkpointMessagesToHistory(rawMessages) });
      } catch (err) {
        request.log.error(
          { app: request.apiClient?.appName, threadId, err },
          "history: fetch failed",
        );
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Bypasses the orchestrator entirely: calls the Jira/GitHub tools directly
    // and does the ticket/PR/commit cross-referencing here, for a plain data
    // view (the dashboard's SprintBoard) rather than an agent conversation.
    protectedRoutes.get("/sprint", async (request, reply) => {
      try {
        const sprint = await getActiveSprint.invoke({});
        if (!sprint.active) {
          return reply.send({ active: false, message: sprint.message });
        }

        const [tickets, prs, commits] = await Promise.all([
          getSprintIssues.invoke({ sprintId: sprint.id }),
          getOpenPullRequests.invoke({}),
          getRecentCommits.invoke({ days: 7 }),
        ]);

        const ticketsWithLinks = tickets.map((ticket) => ({
          ...ticket,
          linkedPRs: prs.filter((pr) => pr.linkedIssueKey === ticket.key),
          linkedCommits: commits.filter((commit) => commit.linkedIssueKey === ticket.key),
        }));

        return reply.send({ active: true, sprint, tickets: ticketsWithLinks, prs, commits });
      } catch (err) {
        request.log.error({ app: request.apiClient?.appName, err }, "sprint: fetch failed");
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Live view of the existing resolution-time k-NN predictor
    // (src/prediction/knn.ts + issue_resolution_history), for a dashboard page rather
    // than the ad hoc one-off analysis this was previously only available
    // as. Returns the full ranked real+synthetic candidate pool (not just
    // the top-k actually used), so the frontend can render every candidate
    // in a scatter and ring/label just the ones the prediction used.
    protectedRoutes.get("/predict/:issueKey", async (request, reply) => {
      const { issueKey } = request.params as { issueKey: string };
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        return reply.code(400).send({ error: '"issueKey" is required' });
      }

      const query = request.query as { k?: string; pool?: string };

      const kRequested = query.k !== undefined ? Number(query.k) : thresholds.K_NEIGHBORS;
      if (!Number.isInteger(kRequested) || kRequested < 1 || kRequested > 15) {
        return reply.code(400).send({ error: '"k" must be an integer between 1 and 15' });
      }

      const poolMode = query.pool ?? "all";
      if (poolMode !== "all" && poolMode !== "real" && poolMode !== "synthetic") {
        return reply.code(400).send({ error: '"pool" must be one of "all", "real", "synthetic"' });
      }

      try {
        const [data, comments] = await Promise.all([getIssuePredictionData(issueKey), getIssueComments(issueKey)]);
        const issueFeatures = extractFeatures({ issueKey, data, commentCount: comments.length });

        const history = await getResolutionHistory();
        // Leave-one-out: if this issue has already been backfilled into
        // issue_resolution_history (i.e. it's Done and part of the training
        // pool), it must not be allowed to appear as its own nearest
        // neighbor — a near-zero self-distance would otherwise dominate the
        // prediction and make it meaningless as a validation case.
        const historyExcludingTarget = {
          real: poolMode === "synthetic" ? [] : history.real.filter((r) => r.issueKey !== issueKey),
          synthetic: poolMode === "real" ? [] : history.synthetic,
        };
        const prediction = predictResolutionDays(
          issueFeatures,
          historyExcludingTarget,
          kRequested,
          thresholds.REAL_NEIGHBOR_DISTANCE_THRESHOLD,
        );
        const confidence = scoreConfidence(prediction.neighbors, kRequested);

        return reply.send({
          issueKey,
          predictedDays: prediction.predictedDays,
          confidence,
          kRequested,
          poolMode,
          usedFallbackToSynthetic: prediction.usedFallbackToSynthetic,
          usedNeighborKeys: prediction.neighbors.map((n) => n.issueKey),
          allRanked: prediction.rankedCandidates,
        });
      } catch (err) {
        request.log.error({ app: request.apiClient?.appName, issueKey, err }, "predict: fetch failed");
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Called on an interval by app/api/digest's resolution-collector scheduler
    // (no cron/webhook infra exists in this repo — see CLAUDE.md). Finds SMA
    // issues that recently transitioned to Done/Closed and appends them to
    // issue_resolution_history as source='real'. Upsert-based, so an overlap
    // between consecutive ticks re-processing the same issue is harmless.
    protectedRoutes.post("/internal/collect-resolution-history", async (request, reply) => {
      const { lookbackHours } = (request.body ?? {}) as { lookbackHours?: number };
      const hours = typeof lookbackHours === "number" && lookbackHours > 0 ? lookbackHours : 6;

      try {
        const statusList = config.jira.doneStatuses.map((status) => `"${status}"`).join(", ");
        const jql = `project = ${config.jira.projectKey} AND status in (${statusList}) AND statusCategoryChangedDate >= "-${hours}h"`;
        const issueKeys = await searchIssueKeys(jql);

        let inserted = 0;
        for (const issueKey of issueKeys) {
          const [data, comments] = await Promise.all([getIssuePredictionData(issueKey), getIssueComments(issueKey)]);
          const resolutionDays = resolutionDaysFor(data);
          if (resolutionDays === null) continue;

          const features = extractFeatures({ issueKey, data, commentCount: comments.length });
          await insertResolutionRecord({ ...features, resolutionDays, source: "real", closedAt: data.resolutionDate });
          inserted++;
        }

        return reply.send({ inserted, checked: issueKeys.length });
      } catch (err) {
        request.log.error(
          { app: request.apiClient?.appName, err },
          "collect-resolution-history: failed",
        );
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    protectedRoutes.post("/invoke", async (request, reply) => {
      let body: InvokeBody;
      try {
        body = validateInvokeBody(request.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      if (!(await acquireLockOrReject(body.threadId, reply)).acquired) return;

      request.log.info(
        { app: request.apiClient?.appName, threadId: body.threadId },
        "invoke: run started",
      );

      try {
        const agent = await getAgent();
        const result = await agent.invoke(
          { messages: [{ role: "user", content: body.prompt }] },
          {
            configurable: { thread_id: body.threadId },
            callbacks: [...langfuseCallbacks, ...debugCallbacks],
          },
        );
        const lastMessage = result.messages[result.messages.length - 1];
        return reply.send({ threadId: body.threadId, response: extractText(lastMessage?.content) });
      } catch (err) {
        request.log.error(
          { app: request.apiClient?.appName, threadId: body.threadId, err },
          "invoke: run failed",
        );
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        await releaseLock(body.threadId);
        await flushTracing();
      }
    });

    protectedRoutes.post("/invoke/stream", async (request, reply) => {
      let body: InvokeBody;
      try {
        body = validateInvokeBody(request.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      const lockResult = await acquireLockOrReject(body.threadId, reply);
      if (!lockResult.acquired) return;
      const runId = lockResult.runId!;

      request.log.info(
        { app: request.apiClient?.appName, threadId: body.threadId, runId },
        "invoke/stream: run started",
      );

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Persists every event to stream_chunks and fans it out to any
      // same-replica resume subscribers, in addition to writing it to this
      // (the original) reply below.
      const persist = createRunEmitter(body.threadId, runId);

      let closed = false;
      const emit = (event: SseEvent) => {
        persist(event);
        if (!closed) reply.raw.write(sseFrame(event));
      };

      const heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(`: heartbeat\n\n`);
      }, 15_000);

      // The run itself is no longer tied to this reply's lifecycle: a client
      // disconnect (e.g. a page refresh) only stops writes to this dead
      // socket below — the agent keeps running to completion server-side so
      // a reconnecting client can resume it via GET /threads/:threadId/stream.
      // The abort controller/signal stays wired up for the explicit
      // /threads/:threadId/cancel path instead.
      const abortController = new AbortController();
      registerRun(runId, abortController);
      request.raw.on("close", () => {
        closed = true;
      });

      try {
        const agent = await getAgent();
        const run = await agent.streamEvents(
          { messages: [{ role: "user", content: body.prompt }] },
          {
            version: "v3",
            configurable: { thread_id: body.threadId },
            signal: abortController.signal,
            callbacks: [...langfuseCallbacks, ...debugCallbacks],
          },
        );

        const { drain } = pumpRun(run, emit);
        const finalState = await run.output;
        await drain();

        const lastMessage = finalState.messages[finalState.messages.length - 1];
        emit({ type: "done", threadId: body.threadId, response: extractText(lastMessage?.content) });
      } catch (err) {
        request.log.error(
          { app: request.apiClient?.appName, threadId: body.threadId, err },
          "invoke/stream: run failed",
        );
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(heartbeat);
        unregisterRun(runId);
        // A tracing/lock-release failure (e.g. Langfuse unreachable) must never
        // prevent reply.raw.end() below — otherwise the chunked response is left
        // open forever and the client's fetch stream never resolves.
        try {
          await releaseLock(body.threadId);
        } catch (err) {
          request.log.error({ app: request.apiClient?.appName, threadId: body.threadId, err }, "invoke/stream: releaseLock failed");
        }
        try {
          await flushTracing();
        } catch (err) {
          request.log.error({ app: request.apiClient?.appName, threadId: body.threadId, err }, "invoke/stream: flushTracing failed");
        }
        reply.raw.end();
      }
    });

    protectedRoutes.get("/threads/:threadId/stream", async (request, reply) => {
      const { threadId } = request.params as { threadId: string };
      if (typeof threadId !== "string" || threadId.length === 0) {
        return reply.code(400).send({ error: '"threadId" is required and must be a non-empty string' });
      }

      const lockRow = await pool.query<{ locked_by: string }>(
        `SELECT locked_by FROM thread_locks
         WHERE thread_id = $1 AND status = 'running' AND updated_at > now() - ($2 || ' seconds')::interval;`,
        [threadId, serverConfig.lockStaleSeconds],
      );
      const runId = lockRow.rows[0]?.locked_by;
      if (!runId) {
        // No active run for this thread — nothing to resume; the client
        // falls back to its existing completed-turn history fetch.
        return reply.code(204).send();
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let closed = false;
      let lastSeqSent = -1;
      const buffered: Array<{ seq: number; event: SseEvent }> = [];
      let live = false;

      const writeEvent = (event: SseEvent) => {
        if (closed) return;
        reply.raw.write(sseFrame(event));
        if (event.type === "done" || event.type === "error") {
          closed = true;
          unsubscribe();
          reply.raw.end();
        }
      };

      // Subscribe before reading the backlog so any chunk emitted while the
      // backlog query is in flight is buffered here rather than lost.
      const unsubscribe = subscribeToRun(runId, (seq, event) => {
        if (!live) {
          buffered.push({ seq, event });
          return;
        }
        if (seq <= lastSeqSent) return;
        lastSeqSent = seq;
        writeEvent(event);
      });

      request.raw.on("close", () => {
        closed = true;
        unsubscribe();
      });

      try {
        const backlog = await readStreamChunks(runId);
        for (const row of backlog) {
          if (row.seq <= lastSeqSent) continue;
          lastSeqSent = row.seq;
          writeEvent(row.event);
          if (closed) return;
        }
        live = true;
        for (const row of buffered) {
          if (row.seq <= lastSeqSent) continue;
          lastSeqSent = row.seq;
          writeEvent(row.event);
          if (closed) return;
        }
      } catch (err) {
        request.log.error(
          { app: request.apiClient?.appName, threadId, err },
          "stream (resume): backlog read failed",
        );
        if (!closed) {
          writeEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    protectedRoutes.post("/threads/:threadId/cancel", async (request, reply) => {
      const { threadId } = request.params as { threadId: string };
      if (typeof threadId !== "string" || threadId.length === 0) {
        return reply.code(400).send({ error: '"threadId" is required and must be a non-empty string' });
      }

      const lockRow = await pool.query<{ locked_by: string }>(
        `SELECT locked_by FROM thread_locks WHERE thread_id = $1 AND status = 'running';`,
        [threadId],
      );
      const runId = lockRow.rows[0]?.locked_by;
      if (!runId) {
        return reply.send({ cancelled: false, reason: "no active run for this thread" });
      }

      // Same-replica only in Milestone 1 — if the run lives on a different
      // replica this is a documented no-op (Milestone 2 adds a pg_notify
      // fallback for cross-replica cancel).
      const cancelled = cancelRun(runId);
      return reply.send({ cancelled });
    });
  });
}

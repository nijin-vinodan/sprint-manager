import type { FastifyInstance } from "fastify";
import { getAgent } from "./agentRuntime.js";
import { getCheckpointer } from "./checkpointer.js";
import { acquireLockOrReject, releaseLock } from "./locks.js";
import { requireApiKey } from "./auth.js";
import { langfuseCallbacks, flushTracing } from "../tracing.js";
import { debugCallbacks } from "../debugLogger.js";
import { extractText, sseFrame, pumpRun, checkpointMessagesToHistory } from "./sse.js";
import { getActiveSprint, getSprintIssues } from "../tools/jira.js";
import { getOpenPullRequests, getRecentCommits } from "../tools/github.js";

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

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook("onRequest", requireApiKey);

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

    protectedRoutes.post("/invoke", async (request, reply) => {
      let body: InvokeBody;
      try {
        body = validateInvokeBody(request.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      if (!(await acquireLockOrReject(body.threadId, reply))) return;

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

      if (!(await acquireLockOrReject(body.threadId, reply))) return;

      request.log.info(
        { app: request.apiClient?.appName, threadId: body.threadId },
        "invoke/stream: run started",
      );

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let closed = false;
      const emit = (event: Parameters<typeof sseFrame>[0]) => {
        if (closed) return;
        reply.raw.write(sseFrame(event));
      };

      const heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(`: heartbeat\n\n`);
      }, 15_000);

      const abortController = new AbortController();
      request.raw.on("close", () => abortController.abort());

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
        closed = true;
        clearInterval(heartbeat);
        await releaseLock(body.threadId);
        await flushTracing();
        reply.raw.end();
      }
    });
  });
}

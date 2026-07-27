# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # runs the agent with the default prompt (tsx src/index.ts)
npm run dev -- "What's blocking SMA-42?"   # runs with a custom prompt
npm run build          # tsc -p tsconfig.json
npm run typecheck      # tsc --noEmit
npx tsx src/testTools.ts   # sanity-check the Jira/GitHub tools directly against real data, no model call

npm run dashboard:dev    # builds dist/, then starts the Next.js dashboard (next dev)
npm run dashboard:build  # builds dist/, then next build
npm run dashboard:start  # next start (assumes dashboard:build already ran)

DEBUG_AGENT=1 npm run dev -- "..."   # same CLI run, with per-agent tool/delegation logging (see Debugging below)
```

There is no test runner configured (no `test` script, no test files) — `src/testTools.ts` is the only verification harness, and it hits the real Jira/GitHub APIs using the credentials in `.env`.

## Architecture

This is a multi-agent [DeepAgents](https://github.com/langchain-ai/deepagentsjs) system: an orchestrator with no tools of its own, delegating to two read-only sub-agents.

- `src/agent.ts` — `createSprintManagerAgent()` builds the orchestrator via `createDeepAgent`, wired with `ORCHESTRATOR_PROMPT` and the two sub-agents below. It holds no Jira/GitHub tools directly.
- `src/agents/jiraAnalyst.ts` / `src/agents/githubAnalyst.ts` — `SubAgent` definitions (name, system prompt, tools, model). Each is facts-only: it fetches and reports data but never judges sprint health or cross-references the other's data.
- `src/prompts/` — one file per agent's system prompt (`orchestrator.ts`, `jiraAnalyst.ts`, `githubAnalyst.ts`), plus `shared.ts` for the `READ_ONLY_NOTICE` all three prompts include.
- `src/tools/jira.ts` / `src/tools/github.ts` — Zod-typed `langchain` `tool()` wrappers around the Jira Cloud REST/Agile API and the GitHub REST API.
- `src/config.ts` — required env vars (throws at startup if missing) plus the `thresholds` object (`STALE_TICKET_DAYS`, `STALE_PR_DAYS`) used by the tools.
- `src/dateUtils.ts` — shared helpers (`daysSince`, `daysUntil`, `isPastDue`, `extractIssueKey`, `adfToPlainText`) used by both tool files.
- `src/index.ts` — CLI entry point; takes an optional prompt as `process.argv[2]`.
- `src/testTools.ts` — throwaway script exercising the tools directly, no agent/model involved.
- `src/tracing.ts` — Langfuse/OpenTelemetry callback handler (`langfuseCallbacks`), enabled when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set. `shutdownTracing()` (CLI) fully tears down the SDK; `flushTracing()` (dashboard) just flushes so the long-lived server process keeps running.
- `src/debugLogger.ts` — `AgentDebugLogger`, a `BaseCallbackHandler` gated behind `DEBUG_AGENT=1` (`debugCallbacks`, empty array otherwise). Logs every tool/model call prefixed with which agent is actually running it (`[orchestrator]`, `[jira-analyst]`, `[github-analyst]`), by propagating a label from parent run to child run and re-labeling whenever the `task` tool fires (deepagents' delegation mechanism). Wired into both `src/index.ts` and `app/api/chat/route.ts`.

### Dashboard (Next.js, `app/`)

A Next.js app sits on top of the agent for a browser UI — this is newer than the CLI and not the primary architecture described above, but it's a real, maintained part of the repo.

- `app/api/chat/route.ts` — SSE endpoint. Calls `agent.streamEvents({ messages }, { version: "v3", callbacks: [...langfuseCallbacks, ...debugCallbacks] })` and pumps `run.messages`/`run.toolCalls`/`run.subagents` into hand-rolled SSE frames (`token`, `tool_call`, `tool_result`, `subagent_start`/`subagent_end`, `done`, `error`).
- `app/api/chat/_agent.ts` — lazily builds one `createSprintManagerAgent()` instance and caches it on `globalThis`, so it survives across requests in the same server process.
- `app/components/ChatPanel.tsx` — client component; `fetch("/api/chat", { method: "POST" })`, reads the response as an SSE stream, and renders streamed tokens plus sub-agent/tool activity.
- `app/api/sprint/route.ts` — **does not go through the agent at all.** It calls the compiled Jira/GitHub tools directly (`getActiveSprint`, `getSprintIssues`, `getOpenPullRequests`, `getRecentCommits`) and does the ticket/PR/commit cross-referencing itself in the route handler, bypassing the orchestrator. Used by `app/components/SprintBoard.tsx` for a plain data view, separate from the chat path.

**The dashboard imports from `dist/`, not `src/`.** `tsconfig.json` has `rootDir: "src"` / `outDir: "dist"`, so `dist/agent.js`, `dist/tools/jira.js`, etc. are a 1:1 `tsc` compile of `src/`. The `predashboard:dev`/`predashboard:build` npm scripts run `npm run build` first, so going through those scripts keeps `dist/` fresh — but editing `src/*.ts` and just restarting `next dev` directly (without rebuilding) will silently keep running the old compiled behavior.

**Only the orchestrator cross-references Jira against GitHub.** Both sub-agents are deliberately kept blind to each other's data — matching happens in the orchestrator via `linkedIssueKey`, which the tools extract from PR titles/bodies and commit messages (regex match against `config.jira.projectKey`, e.g. `SMA-123`). Sub-agents must never be asked to do this cross-referencing themselves.

**Tools return pre-digested facts, not raw API payloads.** Every tool computes `daysSinceUpdate`/`isOverdue`/`ageDays`/`isStale`/`reviewState`/`linkedIssueKey` before returning, so no agent does date math, regex extraction, or ADF (Atlassian Document Format) parsing itself. When adding a new tool, follow this pattern rather than pushing computation into a prompt.

**Everything is read-only by design.** `READ_ONLY_NOTICE` (`src/prompts/shared.ts`) is included in all three system prompts. Do not add write/comment/transition tools to `src/tools/` without an explicit request — the whole system assumes no agent can mutate Jira or GitHub state.

**Model config note:** `src/config.ts` currently configures the model via `ChatAnthropic` pointed at a LiteLLM proxy (`ANTHROPIC_MODEL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`). `.env.example` and `README.md` still describe the earlier Bedrock (`ChatBedrockConverse` / `AGENT_MODEL` / `AWS_*`) setup — treat `config.ts` as the source of truth for what env vars are actually required.

**README.md is stale on architecture** — it describes a single-agent v0 ("one agent, all tools, no sub-agents"); the code has since moved to the orchestrator + sub-agent structure described above.

### How `createDeepAgent` actually works (from `node_modules/deepagents/dist/langsmith-DVh4u6Za.js` — the package's public `.d.ts`/README don't spell this out)

`createDeepAgent` (called once, in `src/agent.ts`) builds a fixed middleware stack: `todoListMiddleware → createFilesystemMiddleware → createSubAgentMiddleware → createSummarizationMiddleware → createPatchToolCallsMiddleware`. None of this is configured in this repo beyond passing `subagents`, so all defaults apply:

- **Planning** — `todoListMiddleware()` (from `langchain`, not deepagents) gives the orchestrator an optional `write_todos` tool. The model decides whether to use it; single-shot questions usually skip it, multi-step ones tend to trigger it.
- **Delegation** — `createSubAgentMiddleware` turns each `SubAgent` in `subagents: [jiraAnalyst, githubAnalyst]` into one delegation target, exposed to the orchestrator as a single `task` tool. Calling `task({ subagent_type, description })` *is* the split: `description` is the sub-task instruction the orchestrator's own model turn writes.
- **Filesystem "memory" is virtual, not disk.** `createFilesystemMiddleware` gives `ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep` tools, backed by whatever `backend` is passed to `createDeepAgent` — since `src/agent.ts` doesn't pass one, it defaults to `StateBackend`, an in-memory filesystem living inside LangGraph state. It does **not** persist across process restarts or separate CLI invocations. Real persistence would require explicitly passing `backend: new FilesystemBackend({ rootDir: ... })`.
- **Reflection/review is really `createSummarizationMiddleware`**, not an explicit review step. It wraps every model call and, once the conversation exceeds a token trigger, compresses older messages and writes the evicted history to `/conversation_history/{thread_id}.md` on that same virtual filesystem. It fires silently (no tool call), so it only shows up in `DEBUG_AGENT=1` logs as filesystem writes under `/conversation_history/`, and only on long conversations.

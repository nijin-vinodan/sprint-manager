# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # runs the agent with the default prompt (tsx src/index.ts)
npm run dev -- "What's blocking SMA-42?"   # runs with a custom prompt
npm run build          # tsc -p tsconfig.json
npm run typecheck      # tsc --noEmit
npx tsx src/testTools.ts   # sanity-check the Jira/GitHub tools directly against real data, no model call
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

**Only the orchestrator cross-references Jira against GitHub.** Both sub-agents are deliberately kept blind to each other's data — matching happens in the orchestrator via `linkedIssueKey`, which the tools extract from PR titles/bodies and commit messages (regex match against `config.jira.projectKey`, e.g. `SMA-123`). Sub-agents must never be asked to do this cross-referencing themselves.

**Tools return pre-digested facts, not raw API payloads.** Every tool computes `daysSinceUpdate`/`isOverdue`/`ageDays`/`isStale`/`reviewState`/`linkedIssueKey` before returning, so no agent does date math, regex extraction, or ADF (Atlassian Document Format) parsing itself. When adding a new tool, follow this pattern rather than pushing computation into a prompt.

**Everything is read-only by design.** `READ_ONLY_NOTICE` (`src/prompts/shared.ts`) is included in all three system prompts. Do not add write/comment/transition tools to `src/tools/` without an explicit request — the whole system assumes no agent can mutate Jira or GitHub state.

**Model config note:** `src/config.ts` currently configures the model via `ChatAnthropic` pointed at a LiteLLM proxy (`ANTHROPIC_MODEL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`). `.env.example` and `README.md` still describe the earlier Bedrock (`ChatBedrockConverse` / `AGENT_MODEL` / `AWS_*`) setup — treat `config.ts` as the source of truth for what env vars are actually required.

**README.md is stale on architecture** — it describes a single-agent v0 ("one agent, all tools, no sub-agents"); the code has since moved to the orchestrator + sub-agent structure described above.

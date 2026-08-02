# Sprint Manager Agent

A multi-agent [DeepAgents](https://github.com/langchain-ai/deepagentsjs) system that reads live data
from a Jira Cloud project (`SMA`) and a GitHub repo, and produces a sprint status/risk summary —
flagging blocked or stalled tickets, PRs that have sat unreviewed, and anything overdue.

An orchestrator with no tools of its own delegates to two read-only, facts-only sub-agents (Jira,
GitHub); only the orchestrator cross-references the two data sources.

## Architecture

```mermaid
flowchart TB
    subgraph CLI["CLI"]
        idx["src/index.ts<br/>(entry point, takes a prompt arg)"]
    end

    subgraph Orchestrator["src/agent.ts"]
        da["createDeepAgent()<br/>ORCHESTRATOR_PROMPT + subagents<br/>(no tools of its own)"]
    end

    subgraph SubAgents["Sub-agents (src/agents/), each facts-only, blind to the other's data"]
        direction TB
        subgraph JiraAgent["jiraAnalyst.ts"]
            ja["jira-analyst<br/>JIRA_ANALYST_PROMPT"]
        end
        subgraph GitHubAgent["githubAnalyst.ts"]
            ga["github-analyst<br/>GITHUB_ANALYST_PROMPT"]
        end
    end

    subgraph Tools["Tools (Zod-typed, langchain tool())"]
        direction TB
        subgraph JiraTools["src/tools/jira.ts"]
            t1["getActiveSprint()"]
            t2["getSprintIssues(sprintId)"]
            t3["getIssueDetails(issueKey)"]
        end
        subgraph GitHubTools["src/tools/github.ts"]
            t4["getOpenPullRequests(repo?)"]
            t5["getRecentCommits(repo?, days)"]
        end
    end

    subgraph Shared["Shared"]
        cfg["src/config.ts<br/>(env vars + thresholds)"]
        du["src/dateUtils.ts<br/>(daysSince / isOverdue / adfToPlainText / extractIssueKey)"]
    end

    subgraph External["External APIs"]
        jira[("Jira Cloud REST API v3 +<br/>Agile API")]
        gh[("GitHub REST API")]
        model[("Claude via LiteLLM proxy<br/>(ChatAnthropic)")]
    end

    idx --> da
    da -->|delegates| ja
    da -->|delegates| ga
    da <-->|reasoning, cross-references<br/>linkedIssueKey| model

    ja -->|tool calls| t1 & t2 & t3
    ga -->|tool calls| t4 & t5

    t1 & t2 & t3 --> jira
    t4 & t5 --> gh

    t1 & t2 & t3 -.uses.-> cfg
    t4 & t5 -.uses.-> cfg
    t1 & t2 & t3 -.uses.-> du
    t4 & t5 -.uses.-> du
```

**Design principles**

- Tools return **pre-digested, computed facts** (`daysSinceUpdate`, `isOverdue`, `ageDays`,
  `isStale`, `reviewState`, `linkedIssueKey`) — no agent does date math or regex extraction
  itself.
- Thresholds (`STALE_TICKET_DAYS`, `STALE_PR_DAYS`) live in one place: `src/config.ts`.
- The two sub-agents are **read-only and facts-only** — they fetch and report data but never
  judge sprint health or look at each other's data.
- **Only the orchestrator cross-references Jira against GitHub**, matching via `linkedIssueKey`
  (extracted from PR titles/bodies and commit messages) rather than trusting Jira status at
  face value (e.g. a ticket "In Review" with no recent PR review activity is a risk, not a
  healthy ticket), and it grounds every claim in a specific issue key or PR number.

## Setup

```bash
npm install
cp .env.example .env   # fill in Jira + GitHub credentials
npm run dev            # runs with the default prompt
npm run dev -- "What's blocking SMA-42?"
```

Required environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `JIRA_BASE_URL` | e.g. `https://your-domain.atlassian.net` |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` | Jira Basic auth |
| `JIRA_PROJECT_KEY` | Defaults to `SMA` |
| `GITHUB_TOKEN` | GitHub PAT |
| `GITHUB_OWNER` / `GITHUB_REPO` | Target repo |
| `ANTHROPIC_MODEL` | Model id passed to the LiteLLM proxy, e.g. `claude-sonnet-4-5-20250929` |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` | Auth token + base URL for the LiteLLM proxy (speaks the Anthropic-compatible API) |

## Project structure

```
src/
  config.ts         env vars + thresholds
  dateUtils.ts      shared date/text helpers used by both tool files
  tools/jira.ts     getActiveSprint, getSprintIssues, getIssueDetails
  tools/github.ts   getOpenPullRequests, getRecentCommits
  agents/           jiraAnalyst.ts / githubAnalyst.ts sub-agent definitions
  prompts/          one system prompt per agent, plus shared.ts + digest.ts
  agent.ts          createDeepAgent orchestrator wiring
  index.ts          CLI entry point
  server/           standalone Fastify agent server (see below)
```

## Standalone agent server (`src/server/`)

A hand-rolled [Fastify](https://fastify.dev/) service that runs the same agent from `src/agent.ts`
in-process, for other applications to call over HTTP — no LangGraph Server involved. It exists so
that the dashboard and any other caller talk to one shared, independently-deployable agent process
instead of each embedding the agent themselves.

- **Persistence**: [`@langchain/langgraph-checkpoint-postgres`](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres)'s
  `PostgresSaver` is passed to `createDeepAgent({ checkpointer })`, so conversation/thread state
  (LangGraph checkpoints) lives in Postgres, not in process memory — it survives restarts and is
  shared across replicas. Wired in `src/server/checkpointer.ts` / `src/server/agentRuntime.ts`.
- **Concurrency guard**: a `thread_locks` table (`src/server/locks.ts`) replaces the full LangGraph
  Server's `multitaskStrategy: "reject"`. Before invoking the agent for a `threadId`, the route
  handler atomically tries to acquire that thread's lock; if it's already held, the request is
  rejected outright with `409 Conflict` — no queueing, no interrupting the in-flight run.
- **Auth**: a gitignored `api-clients.json` (path via `API_CLIENTS_PATH`, default `./api-clients.json`)
  maps API key → calling application. `src/server/auth.ts` validates the `x-api-key` header on every
  request before any route handler runs, and every log line records which app made the call.
- **Stateless per process**: nothing needed across requests lives in memory — threads and locks are
  both in Postgres, so any number of replicas can sit behind a load balancer as long as they point
  at the same database and the same `api-clients.json` content.

### Request flow

```mermaid
flowchart TB
    subgraph Callers["Calling applications"]
        dashboard["Dashboard<br/>(app/components/ChatPanel.tsx)"]
        other["Any other app<br/>(own API key)"]
    end

    subgraph Server["src/server/ (Fastify, stateless per process)"]
        direction TB
        health["GET /health<br/>(no auth)"]

        subgraph Protected["Auth-gated routes"]
            direction TB
            auth["auth.ts: requireApiKey<br/>onRequest hook — 401 if missing/invalid x-api-key"]
            invoke["POST /invoke<br/>routes.ts"]
            stream["POST /invoke/stream<br/>routes.ts (SSE via streamEvents)"]
        end

        locks["locks.ts: acquireLock / releaseLock<br/>409 if thread already running"]
        runtime["agentRuntime.ts: getAgent()<br/>one createDeepAgent() instance per process"]
        ckpt["checkpointer.ts: getCheckpointer()<br/>PostgresSaver, .setup() once per process"]
    end

    subgraph Orchestrator["Same orchestrator as the CLI/dashboard (src/agent.ts logic)"]
        da["ORCHESTRATOR_PROMPT + subagents<br/>(jira-analyst, github-analyst)"]
    end

    subgraph DB["Postgres (docker-compose.yml)"]
        direction TB
        tl[("thread_locks<br/>thread_id, status, locked_by, updated_at")]
        cp[("checkpoints / checkpoint_blobs /<br/>checkpoint_writes<br/>(conversation state per thread_id)")]
    end

    dashboard -->|x-api-key| auth
    other -->|x-api-key| auth
    dashboard -.-> health
    auth --> invoke
    auth --> stream

    invoke --> locks
    stream --> locks
    locks -->|acquire/release| tl
    locks -->|409 Conflict<br/>if already locked| invoke
    locks -->|409 Conflict<br/>if already locked| stream

    invoke -->|lock acquired| runtime
    stream -->|lock acquired| runtime
    runtime --> ckpt
    ckpt <-->|load/save checkpoint<br/>by thread_id| cp
    runtime -->|configurable: thread_id| da
    da -->|Jira + GitHub tools,<br/>model calls| model[("Claude via LiteLLM proxy")]
```

### Concurrency guard, under a race

This is the sequence two replicas hitting the same `threadId` within milliseconds of each other actually go through — the single atomic `INSERT ... ON CONFLICT ... WHERE ... RETURNING` in `locks.ts` is what guarantees exactly one of them proceeds:

```mermaid
sequenceDiagram
    participant R1 as Replica A
    participant R2 as Replica B
    participant PG as Postgres (thread_locks)
    participant Agent as Agent + Checkpointer

    R1->>PG: INSERT ... ON CONFLICT DO UPDATE WHERE released/stale RETURNING
    R2->>PG: INSERT ... ON CONFLICT DO UPDATE WHERE released/stale RETURNING
    Note over PG: Postgres locks the conflicting row for whichever<br/>statement arrives first — the second blocks until it commits
    PG-->>R1: 1 row returned (status now 'running')
    PG-->>R2: 0 rows returned (WHERE false: already 'running' + fresh)
    R1->>Agent: invoke(threadId) — proceeds
    R2--xR2: 409 Conflict ("run already in progress")
    Agent-->>R1: response (success or error)
    R1->>PG: UPDATE status = 'released' (finally block — runs on either outcome)
```

### Running it

```bash
npm install
cp .env.example .env                  # Jira/GitHub/model credentials, as above
cp api-clients.json.example api-clients.json   # then replace with real keys — gitignored
echo "DATABASE_URL=postgresql://postgres:postgres@localhost:5434/sprint_manager" >> .env

docker compose up -d                  # starts just Postgres (see docker-compose.yml)
npm run server:dev                    # tsx watch src/server/index.ts, listens on :8787

# production:
npm run server:build                  # tsc -> dist/
npm run server:start                  # node dist/server/index.js
```

Additional env vars (on top of the ones above):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgresql://postgres:postgres@localhost:5434/sprint_manager` |
| `PORT` / `HOST` | Fastify listen address. Defaults `8787` / `0.0.0.0` |
| `API_CLIENTS_PATH` | Path to the API-key-to-app-name config. Defaults `./api-clients.json` |
| `LOCK_STALE_SECONDS` | How long a `thread_locks` row can stay `running` before a new request may reclaim it (guards against a lock stuck by a crashed replica). Defaults `600` |

**Running multiple replicas**: every replica must point at the *same* Postgres instance (same
`DATABASE_URL`) and be deployed with the *same* `api-clients.json` content. The file is read once
at process startup and cached — it does not hot-reload, so adding or revoking an API key means
redeploying every replica.

### API contract

Base URL: `http://<host>:<port>` (no path prefix). All routes except `/health` require an
`x-api-key` header.

```bash
curl -X POST http://localhost:8787/invoke \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <your-api-key>' \
  -d '{"threadId": "dashboard-session-42", "prompt": "What'\''s blocking SMA-42?"}'
# => { "threadId": "dashboard-session-42", "response": "..." }
```

```bash
curl -N -X POST http://localhost:8787/invoke/stream \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <your-api-key>' \
  -d '{"threadId": "dashboard-session-42", "prompt": "Give me today'\''s sprint status update"}'
# => text/event-stream: a `token` event per streamed chunk, then one `done` event
#    with the full response, or an `error` event if the run failed.
```

`GET /health` takes no auth and returns `{ "status": "ok" }` — a plain liveness check, not a
readiness check (it doesn't touch Postgres or the model).

`threadId` is any string the caller chooses to identify a conversation — reuse it to continue the
same thread (the checkpointer keys conversation history by it); use a new one to start fresh.

**Handling `409 Conflict`**: means a run is already in progress for that exact `threadId`. This is
a *reject*, not a queue — the request was not accepted and will not run later on its own. Callers
should surface this to the end user (e.g. "still working on your last question") and retry only if
the user re-submits, not in an automatic tight loop.

Example prompts the agent understands (facts-based sprint status/risk questions, since both
sub-agents are read-only):

- `"Give me today's sprint status update"`
- `"What's blocking SMA-42?"`
- `"Which PRs have been open longest without review?"`
- `"Are there any tickets marked In Progress with no recent commits?"`

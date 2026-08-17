# SprintManager — Project Analysis for Presentation

## Context

This is not a code-change plan — it's a research deliverable. The user wants a
comprehensive analysis of the SprintManager project (what's built, what
decisions were made and why, and the full current feature set) to prepare a
presentation. No implementation is required; this document is itself the
output. Compiled from CLAUDE.md, docs/, git history, and direct code
inspection (via two Explore agents).

---

## 1. What SprintManager Is

A multi-agent AI system (built on LangChain's **DeepAgents** framework) that
answers questions about sprint health by reading Jira and GitHub, cross
references the two, and can (with human confirmation) write a comment back to
Jira. It's exposed three ways: a CLI, a standalone HTTP agent server, and a
Next.js dashboard that talks to that server.

**Core design principle: read-only by design, with one sanctioned exception.**
Two sub-agents (`jira-analyst`, `github-analyst`) only fetch and report facts —
they never judge sprint health or cross-reference each other's data. Only the
orchestrator cross-references Jira against GitHub (matching PRs/commits to
issues via a `linkedIssueKey` regex against the Jira project key). The one
write path (`jira-writer` posting a Jira comment) requires the user to
explicitly confirm exact comment text in chat first — a prompt-level
guardrail, not a technical one.

---

## 2. Key Architecture Decisions (for the "decisions we made" slide)

### AgentCore vs. ECS Fargate (headline decision)
- **SM-52** (`f8a86ad`) produced `docs/agentcore-deployment.md` — an explicit
  *feasibility spike*, not a commitment: "not a full implementation. Validate
  the approach before starting code changes." It evaluated AWS Bedrock
  AgentCore Runtime: serverless per-session microVMs, ARM64-only, requires a
  new Dockerfile + `/ping`/`/invocations` contract.
- Key finding that steered the decision: *"the existing resumable-streaming/
  cancellation design (`runRegistry.ts`, `stream_chunks` table) is more
  capable than what Runtime gives you for free... so there's no clear win in
  ripping it out."*
- **SM-31** (`64f98cf`, one day later) shipped the actual path instead: an AWS
  CDK stack (`infra/`) with 4 stacks (`NetworkStack`, `EcrStack`,
  `DatabaseStack`, `ServicesStack`) running both the agent server and
  dashboard on **ECS Fargate** — reusing the existing Fastify routes/container
  contract as-is, no ARM64/rewrite constraints.
- Tradeoff accepted knowingly: the live ECS service is pinned to
  `desiredCount: 1` because `runRegistry.ts` tracks in-flight runs in
  in-process memory — a single-replica constraint that would disappear with
  true horizontal scaling, but wasn't worth the AgentCore rewrite cost yet.

### Independent scaling of agent runtime (SM-21)
Split the agent server out from the Next.js frontend early on specifically so
each could scale independently — this is the foundational decision that made
the later Fargate deployment (two separate services) straightforward.

### Concurrency control: Postgres locks over LangGraph Server (SM-27)
Built a custom `thread_locks` table with atomic `INSERT ... ON CONFLICT`
locking rather than adopting LangGraph Server's built-in
`multitaskStrategy: "reject"` — because this is a hand-rolled Fastify service,
not LangGraph Server.

### Resumable streaming: Postgres polling over LISTEN/NOTIFY or replica proxying (SM-22)
For cross-replica stream resume/cancel, chose ~1–1.5s Postgres polling
(`readStreamChunksSince`, `cancel_requested_at`) over:
- Postgres `LISTEN/NOTIFY` — rejected because the pooled Postgres connection
  doesn't support it.
- Direct replica-to-replica proxying — rejected as too much new surface for
  the latency need (1–2s is acceptable).

### Client disconnect no longer kills the run
Changed `POST /invoke/stream` so a dropped HTTP connection stops writing to
the dead response but the agent keeps running server-side to completion —
enabling the resume-after-refresh feature.

### Hand-rolled k-NN instead of an ML library
The resolution-time predictor is a from-scratch k-NN (distance function +
weighted averaging), not a scikit-learn/ML-library dependency — deliberately
simple, with explicit real-vs-synthetic-data fallback logic so early (thin)
real data doesn't produce untrustworthy predictions.

### Comment evaluator built but deliberately left unwired
`src/commentEvaluator/` — a rule-based auto-nudge engine (8 rules), fully
unit-tested — was built but never wired into any route/scheduler/cron. It's a
distinct, more automated write path from `jira-writer` (no human confirmation
step) and wiring it up is called out as a deliberate future decision, not an
oversight.

---

## 3. Full Current Feature Set (for the "what we've built" slide)

### Jira tools (read-only)
- **Get active sprint** — name, goal, dates, days remaining.
- **Get sprint issues** — full ticket list with status/assignee/priority +
  computed staleness/overdue flags.
- **Get issue details** — description + comments (ADF parsed to plain text),
  staleness/overdue.

### GitHub tools (read-only)
- **Get open PRs** — age, staleness, review state (approved/changes-requested/
  pending), auto-extracted linked Jira key.
- **Get recent commits** — commits in the last N days with linked Jira key.

### Write capability (human-gated)
- **Add Jira comment** — the only write tool in the system; requires the user
  to confirm exact text in chat first.

### Resolution-time prediction
- k-NN model predicting workdays-to-resolve for any issue, using issue type,
  priority, story points (proxied from Original Estimate), labels, assignee,
  dependency count, comment count, reopen count.
- Confidence scoring (high/medium/low) based on distance to nearest **real**
  (not synthetic) historical neighbor.
- Exposed as an agent tool (ad hoc "what-if" predictions) and a dashboard tab
  with fuzzy issue search + neighbor visualization.
- Background collector keeps real historical data fresh every 20 minutes as
  tickets close; synthetic seed data pads the pool early on.

### Dashboard (Next.js)
- **Board tab** — sprint tickets cross-referenced with linked PRs/commits,
  overdue/stale flags.
- **Digest tab** — auto-refreshing (60s poll) AI-generated sprint risk summary,
  with an unread-alert indicator.
- **Predict tab** — resolution-time predictor UI.
- **Persistent chat sidebar** — collapsible/resizable, streams agent
  responses live (SSE), shows the agent's live plan/todos, active sub-agents,
  and tool-call activity; supports cancel, new chat, and resuming history
  across page refreshes; chat history drawer to revisit past threads.
- Light/dark theme toggle (persisted).

### Standalone agent server (HTTP API)
- Health check, thread listing/history, direct (non-agent) sprint snapshot,
  prediction endpoint, resolution-history collector + status, non-streaming
  and streaming agent invocation, stream resume, and run cancellation —
  covering both the "ask the agent" and "just get me the data" use cases.

### Automated periodic digest
- A scheduled background job reruns a fixed "what's at risk" prompt on an
  interval, independent of any chat session, cached for the dashboard to poll.

### Built but dormant (worth flagging as "future work," not "shipped")
- **Comment evaluator** — 8-rule engine (staleness, no-activity-near-end,
  unassigned, reassigned-no-context, overdue, blocked) that could
  auto-generate nudge comments with per-rule dedup, fully tested but not
  connected to anything live.
- **`scripts/backfillResolutionHistory.ts`** — has a known-broken import path,
  not wired into `package.json` scripts.

---

## 4. Suggested Presentation Structure

1. **Problem/goal** — one-liner on what SprintManager does for the team.
2. **Architecture overview** — orchestrator + 3 sub-agents diagram (jira-
   analyst, github-analyst, jira-writer), read-only-by-default principle.
3. **Feature walkthrough** — Board / Digest / Predict / Chat, one slide each,
   pulling from section 3 above.
4. **Key decisions & tradeoffs** — AgentCore-vs-Fargate as the headline
   story (spike → pragmatic ship), plus the concurrency/streaming decisions.
5. **What's built but not live yet** — comment evaluator, as a roadmap item.
6. **Deployment/infra snapshot** — Docker + ECS Fargate + CDK, single-replica
   constraint called out honestly as a known tradeoff.

## Verification
This is a documentation/analysis task with no code changes — nothing to test
or run. The user should sanity-check section 2 against `docs/agentcore-
deployment.md` and the `.claude/plans/now-let-s-plan-to-purring-narwhal.md`
plan doc directly if they want to quote exact language in slides.

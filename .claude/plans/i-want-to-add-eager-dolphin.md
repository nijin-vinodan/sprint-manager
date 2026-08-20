# Make the predictor evaluation agent reachable from chat

## Context

`src/predictorEvaluation/` (built in a prior session) runs a sandboxed ML evaluation agent that tries multiple regressors against `issue_resolution_history` and reports back RMSE/MAE + a recommendation, via a Modal sandbox. It was deliberately kept **out** of the live chat/orchestrator flow — only reachable via `npm run eval:predictor` or `POST /internal/evaluate-predictor`. The user now wants it reachable from chat too — e.g. "run a predictor evaluation" or "what did the last evaluation find?" — without changing how the underlying evaluation itself works, and without touching the live k-NN predictor (`src/prediction/`) or its own chat-facing tool (`predictResolutionTime`), which stay completely separate and unaffected.

Decisions confirmed with the user:
- **Confirm before running.** A run costs real (small) money and cloud compute and takes several minutes — the orchestrator must explain what it's about to do and get explicit confirmation first, the same pattern already used for `jira-writer` (`src/prompts/orchestrator.ts`'s `# COMMENT WORKFLOW` + the guardrail "never delegate to jira-writer without an explicit prior confirmation message").
- **Block and wait.** The chat turn stays open until the run completes and reports the full result — no background-kickoff/poll-later flow. This works today with zero extra plumbing: the Fastify server has no request timeout (confirmed in the prior session), and the app's existing resumable-stream/reconnect support (`src/server/streamChunks.ts`, `runRegistry.ts`, `GET /threads/:threadId/stream`) already handles a page refresh mid-run for exactly this kind of long-running turn.
- **Add a status/history lookup tool** so the user can ask about the last run's results without paying for a new one.

## New pieces

**`src/predictorEvaluation/tool.ts`** — two LangChain `tool()` wrappers, colocated with the module they wrap (same precedent as `predictResolutionTime` living in `src/prediction/resolutionPrediction.ts` rather than `src/tools/`):
- `evaluatePredictor` — thin wrapper around the existing `runPredictorEvaluation()` (`src/predictorEvaluation/runEvaluation.ts`), zero params, returns the same `EvaluationReport` shape already used by the CLI/route. No new evaluation logic — this only exposes what already exists.
- `getLatestPredictorEvaluation` — reads the most recent row(s) from `predictor_evaluation_runs` via a new `getRecentEvaluationRuns(limit)` function added to `src/predictorEvaluation/store.ts` (same file, alongside `startEvaluationRun`/`completeEvaluationRun`/`failEvaluationRun`). Returns status, algorithms considered/tested, winner, rationale, artifact path — omits the full `reasoning_log` by default (could be large) to keep chat responses concise; a `runId` is still included so a user could ask to see fuller detail if genuinely needed later.

**`src/agents/predictorEvaluator.ts`** — a new `SubAgent`, following the exact shape of `src/agents/jiraWriter.ts` (`name`, `description`, `systemPrompt`, `tools: [evaluatePredictor, getLatestPredictorEvaluation]`, `model: config.agent.model`). This is the second deliberate exception to the read-only design, alongside `jira-writer` — its prompt (`src/prompts/predictorEvaluator.ts`, same file-per-agent convention as `jiraWriter.ts`) does **not** import `READ_ONLY_NOTICE`, and states plainly: only call `evaluatePredictor` when the orchestrator's request says the user has already confirmed; `getLatestPredictorEvaluation` needs no confirmation since it's a pure lookup.

**`src/agent.ts`** — add `predictorEvaluator` to the `subagents: [...]` array (currently `[jiraAnalyst, githubAnalyst, jiraWriter]`).

**`src/prompts/orchestrator.ts`** — three additions, mirroring how `jira-writer`/`# COMMENT WORKFLOW` are already handled:
1. Add `predictor-evaluator` to the `# SUB-AGENTS AVAILABLE` list.
2. New `# PREDICTOR EVALUATION WORKFLOW` section:
   - A request to see/check past results → delegate to `predictor-evaluator` for `getLatestPredictorEvaluation`, no confirmation needed.
   - A request to run/trigger a new evaluation → first explain what will happen (spins up a cloud sandbox, trains up to a handful of candidate regressors, takes several minutes, incurs a small real cost) and ask the user to explicitly confirm. Do not call the task tool for the evaluate action in that same turn.
   - Only once the user confirms in a later message, delegate to `predictor-evaluator` for `evaluatePredictor` and wait for the result.
   - Relay the report as-is (algorithms considered + rationale, tested results, winner + rationale, artifact path if any) — and always state plainly that this is a recommendation only; it does not change the live predictor, which someone has to port manually.
3. `# DELEGATION RULES` / `# GUARDRAILS` — add the same "never call `predictor-evaluator`'s evaluate action without an explicit prior confirmation message from the user in this conversation" guardrail already written for `jira-writer`.

## Explicitly unchanged

- `src/predictorEvaluation/runEvaluation.ts`, `modalSandbox.ts`, `sandboxLifecycle.ts`, `snapshot.ts`, `reasoningLogger.ts` — no changes; `evaluatePredictor` is a pure wrapper.
- `src/prediction/*` and the existing `predictResolutionTime` tool/`# PREDICTION / ETA REQUESTS` workflow — untouched, stays the live-prediction path used for normal "how long will X take" questions.
- `scripts/evaluatePredictor.ts` and `POST /internal/evaluate-predictor` — still work exactly as before; chat becomes a third caller of the same `runPredictorEvaluation()`, not a replacement for the other two.
- No scheduling/cron changes.

## Verification

1. `npm run typecheck` / `npm run build` / `npm test` — clean, no regressions (same bar as the prior session).
2. `npm run dev -- "what did the last predictor evaluation find?"` before ever running one — confirm it delegates to `predictor-evaluator` → `getLatestPredictorEvaluation` and reports "no runs yet" gracefully rather than erroring.
3. `npm run dev -- "run a predictor evaluation"` — confirm the orchestrator explains cost/time and asks for confirmation, does **not** call `evaluatePredictor` in that turn.
4. Confirm in a follow-up turn (e.g. `npm run dev -- "yes, go ahead"` in the same thread via the server's `/invoke` with a shared `threadId`, or the dashboard chat) — confirm it now delegates to `evaluatePredictor`, blocks for the run, and relays the full report.
5. Re-ask "what did the last evaluation find?" — confirm it now reports the run that just completed via `getLatestPredictorEvaluation`, not a fresh run.
6. Ask an unrelated ETA question ("how long will SMA-42 take?") in the same session — confirm it still goes through `jira-analyst`/`predictResolutionTime`, not `predictor-evaluator`.

# Wire predictor evaluation into chat, with a concise chat summary

## Context

Earlier in this session we ran `npm run eval:predictor` directly (bypassing
chat entirely) to test the dynamic-algorithm-selection / Modal-sandbox
scenario for SM-58. That worked end-to-end (Ridge won, RMSE 8.76/MAE 2.84
over 4 trained candidates out of 9 considered).

The user now wants this triggerable **from an actual chat conversation**
instead of the standalone script, with the chat reply confirming multiple
algorithms were tried before landing on an answer.

Investigation found the orchestrator prompt (`src/prompts/orchestrator.ts`)
and the `predictor-evaluator` sub-agent (`src/agents/predictorEvaluator.ts`,
`src/prompts/predictorEvaluator.ts`) are **already fully built** for this —
confirmation gating, delegation rules, and relay instructions all exist. But
there's one hard blocker: the sub-agent is registered in the CLI's agent
(`src/agent.ts`) and **not** in the server's agent
(`src/server/agentRuntime.ts`) — which is the one actually serving chat
traffic from the dashboard/API (`/invoke`, `/invoke/stream`, etc., via
`getAgent()`). So today, asking the deployed chat to run an evaluation would
fail with "subagent not found" even though the CLI works.

Separately, the orchestrator's current relay instruction (step 4 of
"PREDICTOR EVALUATION WORKFLOW") tells it to relay the *full* report —
every considered/rejected algorithm with rationale, every tested RMSE/MAE.
The user picked **"Summary only"** when asked how much detail the chat reply
should carry: something like "tried N algorithms, X won with RMSE=Y", with
full detail available on request via `getLatestPredictorEvaluation` (not
dumped by default). The prompt needs a small edit to match.

## Changes

### 1. Register `predictor-evaluator` in the server's agent — `src/server/agentRuntime.ts`

Mirror what `src/agent.ts` already does:

```ts
import { predictorEvaluator } from "../agents/predictorEvaluator.js";
...
subagents: [jiraAnalyst, githubAnalyst, jiraWriter, predictorEvaluator],
```

This is the actual unblocking change — everything else (confirmation
workflow, tool wiring, `/internal/evaluate-predictor` HTTP route as a
non-chat alternative) already works. No other file needs to change for the
"can I trigger this from chat" half of the ask.

### 2. Make the chat-facing summary concise — `src/prompts/orchestrator.ts`

Edit step 4 of "# PREDICTOR EVALUATION WORKFLOW" (currently instructs a full
relay of every candidate + rationale) to instead produce a short summary:
how many algorithms were tried, the winner, and its headline RMSE/MAE —
still always stating it's a recommendation only, and still pointing the user
at `getLatestPredictorEvaluation` (step 1) if they want the full
considered/rejected breakdown. Apply the same "keep it short" framing to
step 1's relay-of-past-results instruction, since it currently says "relay
the report as reported" too.

Example replacement text for step 4 (adjust to match surrounding prose
style):

```
4. Relay a concise summary, not the full report: how many algorithms were
   tried, the winner's name, and its headline RMSE/MAE. State plainly that
   this is a recommendation only — it does not change the live predictor;
   someone has to port a winning approach manually. If the user wants the
   full breakdown (every candidate considered, rejected candidates'
   rationale, every tested result), say they can ask for it — a later
   getLatestPredictorEvaluation lookup already returns the complete stored
   report.
```

No changes needed to `src/prompts/predictorEvaluator.ts` (the sub-agent
prompt) — it should keep reporting full detail *up to the orchestrator*
("don't summarize away specific numbers... the orchestrator relays your
report to the user"). The summarization only happens at the final
orchestrator → user hop, which is the right layer for it.

### Nothing else changes
- `src/predictorEvaluation/tool.ts`, `store.ts`, `runEvaluation.ts`,
  `sandboxLifecycle.ts`, `modalSandbox.ts` — untouched, already correct.
- `src/server/routes.ts`'s `POST /internal/evaluate-predictor` — untouched,
  stays as the non-chat/manual HTTP entry point.
- The `flushTracing()`-masking-a-successful-run bug and the missing
  `libgomp1` LightGBM dependency (found during the earlier live test) are
  separate, already-flagged issues — out of scope here unless you want them
  folded in.

## Verification

1. `npm run typecheck` — confirm the new import/subagent wiring compiles.
2. Start the agent server (`npm run server:dev` or however it's normally
   run locally) and the dashboard, or use a direct HTTP call to
   `POST /invoke/stream` with a fresh `threadId`.
3. Send: *"Can you evaluate whether a different algorithm would beat our
   current predictor?"* — confirm the orchestrator explains cost/time and
   asks for confirmation, and does **not** call the task tool yet.
4. Reply confirming — confirm it now delegates to `predictor-evaluator`
   (`subagent_start` with path `["predictor-evaluator"]` in the SSE stream),
   waits (this takes minutes, same as the direct script run), and the final
   chat reply is a short summary (algorithm count, winner name, RMSE/MAE) —
   not a full table dump.
5. Cross-check the summary's numbers against the full row in
   `predictor_evaluation_runs` (Postgres) to confirm nothing was
   misreported, just condensed.
6. Separately ask *"what did the last predictor evaluation find?"* and
   confirm it delegates to `getLatestPredictorEvaluation` with no
   confirmation prompt, and again replies with a concise summary rather than
   the full considered/rejected list.

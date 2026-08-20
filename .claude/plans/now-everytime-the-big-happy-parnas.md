# Tune dashboard-chat summarization to reduce fidelity loss

## Context

`createDeepAgent` (used by both `src/agent.ts` and `src/server/agentRuntime.ts`, the latter backing the dashboard's long-lived chat threads) auto-wires a `createSummarizationMiddleware({ backend })` with **no options overridden** — confirmed via `grep -rn "createSummarizationMiddleware\|summaryPrompt" src/` returning nothing. Investigating `deepagents`' bundled source (`node_modules/deepagents/dist/langsmith-DVh4u6Za.js`) shows what that default actually does:

- **Trigger/keep**: since every model here is `ChatAnthropic` (exposes `profile.maxInputTokens: 200000`), the lazy default is `trigger: { type: "fraction", value: 0.85 }`, `keep: { type: "fraction", value: 0.10 }` — compress once the prompt hits ~170k tokens, keep only the most recent ~20k tokens' worth of raw messages.
- **Prompt**: the library's generic `DEFAULT_SUMMARY_PROMPT` ("summarize main topics, key decisions, important context") — not tuned to this project's content (ticket keys, PR numbers, specific decisions).
- **Summarizer model**: reuses `request.model` — i.e. the same orchestrator model, not a separate cheap one.
- **Mechanism (already good news)**: `performSummarization` never issues `RemoveMessage` on the `messages` state key — it only returns a `_summarizationEvent` used to build a *compacted view* for the next model call (`getEffectiveMessages`). The full raw message list stays in LangGraph state untouched. On the dashboard, that state is the Postgres `checkpoints` table (`src/server/checkpointer.ts`'s `PostgresSaver`), and `GET /threads/:threadId/history` (`src/server/routes.ts:102-123`) already reads `channel_values.messages` straight from Postgres — so **the full, unsummarized history is already durably preserved today, independent of what gets fed to the model.**

So "zero information loss" already holds at the storage layer. What's actually tunable — and worth tuning — is the *compaction quality* of what gets sent back to the model on long threads: a generic prose summary can blur out specifics (ticket keys, exact numbers, decisions) that matter for this domain, and the 10% "keep" window is fairly aggressive.

`mergeMiddlewareStack` (confirmed at `node_modules/deepagents/dist/langsmith-DVh4u6Za.js:3596-3606`) replaces same-`name` entries: passing a custom `createSummarizationMiddleware(...)` via the `middleware: [...]` option overrides the built-in one (matched on the fixed `name: "SummarizationMiddleware"`), so no fork/patch of the library is needed.

## Design

Add one small factory so both call sites share the same tuned config rather than duplicating it:

**New file: `src/middleware/summarization.ts`**
```ts
import { createSummarizationMiddleware } from "deepagents";

export function createTunedSummarizationMiddleware() {
  return createSummarizationMiddleware({
    // Keep more recent raw turns before falling back to the summary, so
    // fewer live details get folded into prose in the first place.
    keep: { type: "fraction", value: 0.2 },
    // Domain-specific prompt: preserve concrete facts verbatim instead of
    // a generic prose recap, so ticket keys/PR numbers/decisions survive
    // compaction rather than getting blurred into "discussed some tickets".
    summaryPrompt: SPRINT_MANAGER_SUMMARY_PROMPT,
  });
}

const SPRINT_MANAGER_SUMMARY_PROMPT = `...instructs the model to produce a
structured recap: bullet list of Jira issue keys / PR numbers referenced,
decisions made, open questions, and any numbers (estimates, story points,
dates) mentioned — verbatim where possible — rather than paraphrased prose.
Preserve exact identifiers and figures; only compress narrative/explanatory
text.`;
```

Wire it into both agent construction sites:
- `src/agent.ts:10-14` — add `middleware: [createTunedSummarizationMiddleware()]` to the `createDeepAgent({...})` call.
- `src/server/agentRuntime.ts:22-27` — same addition (this is the one that actually matters for the "big chat conversation" case, since it's the dashboard's persistent-thread path).

Leave `trigger` at its default (`0.85` of the model's 200k budget) — bumping `keep` already gives more headroom, and there's no reason to compress earlier than necessary. Leave `historyPathPrefix`/`model` (summarizer model) at defaults — reusing the conversation's own model keeps summary quality consistent with the rest of the conversation; swapping in a cheaper model is a separate cost-optimization decision, not part of this "avoid info loss" ask.

Not in scope: `src/agents/*.ts` sub-agent specs get their own `createSummarizationMiddleware({ backend })` instance too (line ~6026 in the bundle), scoped per sub-agent call — sub-agent turns are short-lived, single-delegation calls that don't accumulate long history the way the orchestrator's main thread does, so leaving those at default is fine.

## Verification

1. `npm run typecheck` — confirms the new middleware wiring compiles against `deepagents`' types.
2. `DEBUG_AGENT=1 npm run dashboard:dev` (server) + drive a long conversation through the dashboard chat until it crosses the token trigger — `AgentDebugLogger` (`src/debugLogger.ts`) will surface the middleware's virtual-filesystem write under the `🗂️ MEMORY write_file -> {"file_path":"/conversation_history/..."}` log line, confirming it fired and confirming (from the write) that specific identifiers survived into the summary text.
3. Confirm no information loss at rest: call `GET /threads/:threadId/history` before and after the summarization trigger fires — message count/content from Postgres should be unaffected either way, since the middleware never removes messages from state.

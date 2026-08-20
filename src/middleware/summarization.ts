import {
  createSummarizationMiddleware,
  StateBackend,
  type BackendFactory,
} from "deepagents";

// deepagents' default summarization prompt asks for a generic prose recap
// ("main topics discussed", "key decisions") tuned for nothing in
// particular. For sprint-management conversations, that kind of paraphrase
// tends to blur out exactly the details that matter on the next turn —
// which Jira issue/PR was being discussed, what number was agreed on, what
// is still open. This prompt asks for the same recap but structured so
// concrete facts survive compaction verbatim instead of being summarized
// away.
const SPRINT_MANAGER_SUMMARY_PROMPT = `You are summarizing part of an ongoing sprint-management conversation so it can continue with a compacted context window. Produce a structured recap with these sections (omit a section if it has nothing to report):

- Issue/PR references: every Jira issue key (e.g. SMA-123) and GitHub PR/commit reference mentioned, verbatim, with a one-line note of what was said about each.
- Decisions & conclusions: what was decided or concluded, stated plainly.
- Figures: any numbers mentioned — estimates, story points, dates, days-until-due, k-NN predictions, thresholds — copied verbatim rather than rounded or paraphrased.
- Open questions / next steps: anything still unresolved or pending follow-up.
- Other context: only what's needed to continue the conversation coherently; skip pleasantries and narrative filler.

Do not paraphrase identifiers or numbers — copy them exactly as they appeared. Only the surrounding narrative/explanatory text should be compressed.

Conversation to summarize:
{conversation}

Summary:`;

/**
 * The orchestrator's summarization middleware, tuned for this project.
 * deepagents auto-wires `createSummarizationMiddleware({ backend })` with no
 * other options; passing this in via `middleware: [...]` on `createDeepAgent`
 * overrides it (same `name: "SummarizationMiddleware"`, so
 * `mergeMiddlewareStack` replaces rather than appends it — see
 * node_modules/deepagents/dist/langsmith-DVh4u6Za.js:3596-3606).
 *
 * Only `keep` and `summaryPrompt` are overridden:
 * - `keep` is bumped from the library default (10% of the model's input
 *   budget) to 20%, so more recent raw turns stay live before falling back
 *   to the summary at all.
 * - `summaryPrompt` asks for a structured recap that preserves concrete
 *   facts (ticket keys, PR numbers, figures) verbatim rather than folding
 *   them into generic prose.
 *
 * `trigger` is left at the library default (compress at 85% of the model's
 * input budget) — there's no reason to compress earlier than necessary.
 * Note this doesn't affect durability: the checkpointed `messages` state in
 * Postgres is never mutated by this middleware regardless of these options
 * (see `src/server/routes.ts`'s `GET /threads/:threadId/history`), so this
 * only tunes what gets fed back to the model on long threads, not what's
 * retained at rest.
 */
export function createTunedSummarizationMiddleware() {
  return createSummarizationMiddleware({
    // `backend` is required by the library's types but not otherwise
    // customized here — this matches createDeepAgent's own default
    // (node_modules/deepagents/dist/langsmith-DVh4u6Za.js:5987) so
    // conversation-history offload still lands on the same virtual
    // filesystem the rest of the agent uses.
    backend: ((runtimeConfig) =>
      new StateBackend(runtimeConfig)) satisfies BackendFactory,
    keep: { type: "fraction", value: 0.2 },
    summaryPrompt: SPRINT_MANAGER_SUMMARY_PROMPT,
  });
}

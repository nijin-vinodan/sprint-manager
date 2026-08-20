# Add cache-hit visibility for Anthropic prompt caching

## Context

The user asked to enable Anthropic prompt caching (`cache_control: { type: "ephemeral" }`) for the direct-Anthropic model path added in `src/config.ts`. Investigation found this is **already enabled automatically** — no code change is required to turn caching on:

- `deepagents`' `createDeepAgent()` (used by `src/agent.ts`) detects any `ChatAnthropic` model (`model.getName() === "ChatAnthropic"` — true for both the `litellm` and new `anthropic` providers in `src/config.ts`) and unconditionally wires in `anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore", minMessagesToCache: 1 })` plus its own `createCacheBreakpointMiddleware()` into the orchestrator's middleware stack **and** every sub-agent's middleware stack (`jiraAnalyst`, `githubAnalyst`, `jiraWriter`, `predictorEvaluator`).
- This sets the top-level `cache_control: { type: "ephemeral", ttl: "5m" }` request field (a GA feature in `@langchain/anthropic@1.5.2`, confirmed via `dist/chat_models.d.ts` and `CHANGELOG.md`) and tags the last block of the assembled system prompt, covering `src/prompts/orchestrator.ts` and each sub-agent's prompt file plus their injected tool schemas.

What's actually missing is **visibility**: nothing in the repo today logs whether caching is hitting. `src/debugLogger.ts` (`DEBUG_AGENT=1`) logs model/tool/delegate call boundaries but not token usage, so there's no way to confirm cache writes/reads are happening or measure savings — especially useful to verify against the `litellm` proxy path, which must forward the `cache_control` field through to Anthropic unmodified for caching to actually take effect there.

This plan adds that visibility: log cache-related token usage (`cache_creation_input_tokens` / `cache_read_input_tokens`, surfaced by `@langchain/anthropic` as `usage_metadata.input_token_details.cache_creation` / `.cache_read`) per model call, attributed to the same `[orchestrator]` / `[sub-agent-name]` labels the rest of `AgentDebugLogger` already uses.

## Change

**File: `src/debugLogger.ts`**

Add a `handleLLMEnd(output: LLMResult, runId: string)` method to `AgentDebugLogger`:

- Reuse the existing `this.labels.get(runId) ?? ROOT_LABEL` pattern (same as `handleToolEnd`/`handleToolError`) to attribute the log line.
- Pull `output.generations[0][0].message?.usage_metadata` (or the plain `.generations[0][0]` shape when `message` isn't present — `LLMResult.generations` entries are `Generation | ChatGeneration`, so guard with an `as` cast the same way the file already does defensive `typeof`/`Array.isArray` checks elsewhere).
- If `usage_metadata` is present, log a compact line, e.g.:
  ```
  [orchestrator] 💾 cache: read=1024 write=0 in=1180 out=42
  ```
  reading `input_token_details?.cache_read`, `input_token_details?.cache_creation`, `input_tokens`, `output_tokens` — default missing fields to `0`/omit rather than throwing, since the Gemini provider path won't populate `input_token_details` at all (guard so this silently no-ops for non-Anthropic models rather than logging misleading zeros every call).
- Keep it silent (no line at all) when `usage_metadata` is entirely absent, so Gemini runs stay clean.

No other files change. This is additive logging behind the existing `DEBUG_AGENT=1` gate (`debugCallbacks` stays `[]` unless that env var is set), so normal runs and existing tests are unaffected.

**Docs:** add a one-line note to the `DEBUG_AGENT`/debug-logging mention in `CLAUDE.md`'s `src/debugLogger.ts` bullet (and/or `README.md` if it separately documents `DEBUG_AGENT`) that it now also prints per-call cache read/write token counts when available — confirming this is where to look to verify caching is actually hitting.

## Verification

1. `npm run typecheck` — confirm the new `handleLLMEnd` signature matches `BaseCallbackHandler`'s and compiles.
2. `DEBUG_AGENT=1 MODEL_PROVIDER=anthropic npm run dev -- "What's blocking SMA-42?"` (with `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` set) and confirm:
   - First call in a session shows `write` tokens > 0 (cache miss, prompt written to cache).
   - A second call in the same run (e.g. sub-agent delegation reusing the same static prefix) shows `read` tokens > 0 (cache hit).
3. Re-run once against `MODEL_PROVIDER=litellm` to sanity-check whether the proxy forwards cache tokens through (if `read`/`write` stay `0` there while the direct-Anthropic run shows nonzero, that's evidence the proxy isn't passing `cache_control` through — worth flagging back to the user rather than silently treating as "not enabled").
4. `npm test` — confirm no regression (no existing test currently covers `debugLogger.ts`, so this is just a safety net).

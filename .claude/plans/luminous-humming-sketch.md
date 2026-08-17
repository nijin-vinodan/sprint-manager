# Add Gemini as an alternate model provider alongside LiteLLM/Anthropic

## Context

`src/config.ts` currently hardcodes `config.agent.model` to a `ChatAnthropic` instance pointed at a LiteLLM proxy (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`). The user has a free Gemini API key and wants the option to run the agent against Gemini instead, without losing the existing LiteLLM path. Confirmed via research (background agent) that `config.agent.model` is consumed everywhere purely as a generic LangChain `BaseChatModel` (`createDeepAgent({ model: ... })`, `SubAgent.model`, `.withStructuredOutput()`) — no `ChatAnthropic`-specific behavior anywhere, so swapping the implementation is safe and confined to `src/config.ts`.

## Approach

Add an explicit `MODEL_PROVIDER` env var toggle (`litellm` | `gemini`, default `litellm` for backward compatibility) and construct the appropriate LangChain chat model accordingly, using the official `@langchain/google-genai` package (API-key based, matches the user's free Gemini key — not Vertex AI).

## Changes

1. **`package.json`** — add `@langchain/google-genai` to `dependencies` (`npm install @langchain/google-genai`).

2. **`src/config.ts`**
   - Import `ChatGoogleGenerativeAI` from `@langchain/google-genai`.
   - Read `MODEL_PROVIDER` (default `"litellm"`).
   - Branch model construction:
     - `"litellm"` (existing behavior, unchanged): `ChatAnthropic` with `ANTHROPIC_MODEL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`.
     - `"gemini"`: `ChatGoogleGenerativeAI` with `model: requireEnv("GEMINI_MODEL")`, `apiKey: requireEnv("GEMINI_API_KEY")`.
   - Throw a clear error for any other `MODEL_PROVIDER` value.
   - Keep `config.agent.model` as the single exported model, same shape as today — no changes needed in `src/agent.ts`, `src/agents/*.ts`, `src/server/agentRuntime.ts`, or `scripts/runLangfuseExperiment.ts`.

3. **`.env` / `.env.example`** — add:
   ```
   # Model provider: "litellm" (default, Claude via LiteLLM proxy) or "gemini"
   MODEL_PROVIDER=litellm

   # Gemini (only required when MODEL_PROVIDER=gemini)
   GEMINI_API_KEY=your-gemini-api-key
   GEMINI_MODEL=gemini-2.5-flash
   ```
   Leave existing `ANTHROPIC_*` vars untouched.

4. **`CLAUDE.md`** — update the "Model config note" under Architecture to describe the provider toggle instead of only the LiteLLM path.

## Verification

- `npm run typecheck` — confirms the new branch compiles and `ChatGoogleGenerativeAI` satisfies the same type used elsewhere.
- With `MODEL_PROVIDER=litellm` (or unset): `npm run dev -- "What's blocking SMA-42?"` still works exactly as before.
- With `MODEL_PROVIDER=gemini` and a real `GEMINI_API_KEY`/`GEMINI_MODEL` set: `npm run dev -- "..."` runs the same orchestrator/sub-agent flow against Gemini instead.
- Omitting `GEMINI_API_KEY`/`GEMINI_MODEL` while `MODEL_PROVIDER=gemini` should fail fast at startup via `requireEnv`, same pattern as the other required vars.

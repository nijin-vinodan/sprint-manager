# Review and fix frontend code with react-code-reviewer

## Context
The user wants the `react-code-reviewer` agent to review the Next.js dashboard code and apply fixes. The dashboard (`app/`) is a real, maintained part of the repo (see CLAUDE.md) sitting on top of the agent server, but it hasn't had a dedicated frontend code review pass. Scope, per user selection: the entire `app/` directory.

## Scope
28 files, ~2,541 lines total:
- **API routes** (`app/api/**`, 13 files) — thin HTTP proxies to the standalone agent server
- **Components** (`app/components/*.tsx`, 11 files) — including two large ones: `ChatPanel.tsx` (464 ln) and `ResolutionPredictor.tsx` (770 ln)
- **Hooks/lib** (`app/hooks/useIsDarkMode.ts`, `app/lib/formatDuration.ts`, `app/lib/fuzzyMatch.ts`)
- **Root** (`app/layout.tsx`, `app/page.tsx`)

## Approach
Invoke the `react-code-reviewer` subagent (has Read/Grep/Glob/Edit/Write/Bash) to review and fix the code directly, since it's a review-and-fix agent, not a read-only reviewer.

1. **Single Agent call** targeting `react-code-reviewer` with the full `app/` directory as scope, since the codebase is small enough (2,541 lines) for one focused pass. Prompt will:
   - Point at `app/` as the review root, and list the file breakdown above so it doesn't need to rediscover structure.
   - Call out `ChatPanel.tsx` and `ResolutionPredictor.tsx` as the largest/most complex files warranting closer attention (state management, effect cleanup, streaming logic).
   - Ask it to fix issues directly (not just report them) — consistent with typical usage per its description ("review and refactor React/Next/frontend components").
   - Note relevant existing patterns from CLAUDE.md so it doesn't flag them as bugs: dashboard routes are intentionally thin proxies (no agent logic of their own), SSE proxying pipes bodies through unmodified, `threadId` generated client-side once per session, dark mode is a plain `.dark` class toggle (not context).

2. Run in foreground (not background) so the results/diff can be checked before reporting done, per house rules on trusting-but-verifying agent work.

3. After the agent finishes, read its diff (`git diff` on touched files) to confirm the fixes are sound before summarizing to the user — do not just relay the agent's self-report.

## Verification
- `npm run typecheck` (tsc, includes `app/`)
- `npm run dashboard:build` (next build) to catch build-breaking issues
- Manually diff each changed file to confirm fixes match the agent's stated findings and don't alter intended behavior (e.g., proxy routes must stay thin proxies)

# General sprint-timing reasoning (not per-question hardcoding)

## Context

Asking "What all tickets will be pending when the sprint ends" hits
nothing today — the orchestrator has the raw pieces
(`getActiveSprint`/`getSprintIssues` for sprint end date, days
remaining, per-issue status/dueDate; `predictResolutionTime` for a
k-NN prediction of one issue's resolution workdays) but nothing wires
them together, and `PREDICTION / ETA REQUESTS` in
[orchestrator.ts](src/prompts/orchestrator.ts#L51-L71) only covers a
single named issue.

The first pass at this plan enumerated four scenarios (spillover,
due-date risk, what-if, capacity) and proposed a dedicated tool +
dedicated prompt section per scenario. **That doesn't generalize** — a
real user will phrase this a dozen different ways ("what's going to
slip", "will we hit the deadline", "who's overloaded", "if we moved
this to Priya would it still make it", "how confident are we in the
forecast"), and a system that only answers the exact phrasings someone
thought to enumerate breaks on the next one.

The fix is architectural: stop trying to pre-classify the *question*
and instead give the orchestrator (a) the couple of raw capabilities
it's currently missing — batched prediction, and override-based
what-if — and (b) general reasoning principles for combining
predicted-days with dates, the same way `JUDGMENT RULES` in
[orchestrator.ts](src/prompts/orchestrator.ts#L104-L117) already
teaches it to reason about staleness/silence as risk signals instead
of hardcoding "if no commit in exactly N days, say X." The model
already does open-ended reasoning well when given facts + principles;
it doesn't need a bespoke code path per question shape. This matches
the codebase's existing division of labor: tools pre-digest *objective*
facts (date math, ADF parsing — things that are wrong if the LLM does
them ad hoc); *judgment* (is this a risk, is this someone overloaded)
stays with the orchestrator's reasoning, not baked into a tool as a
fixed boolean threshold.

**Caveat that must reach the model, not just docs:** `predictedDays`
is total resolution effort in 8-hour workdays
([dateUtils.ts:19-37](src/dateUtils.ts#L19-L37)); `daysRemaining` is
calendar days to sprint end
([jira.ts:101-102](src/tools/jira.ts#L101-L102)). Comparing them is
always an approximation (no calendar/workday conversion, no accounting
for effort already spent on an in-progress ticket). This has to live
in the tool description and a reasoning principle, not in a
one-off prompt section, so it surfaces no matter how the question is
phrased.

## Design

### 1. The one real gap: batched prediction

Today `predictResolutionTime` is one issue per call, so any question
touching multiple tickets ("what's pending at sprint end," "who's
overloaded," "rank tickets by risk") would force the orchestrator into
N sequential `task` delegations — slow, and nowhere in the delegation
rules today, so it likely won't happen reliably. This is a genuine
missing primitive, not a missing workflow.

Extend `predictResolutionTime` ([resolutionPrediction.ts](src/prediction/resolutionPrediction.ts))
to accept a list:
- `issueKeys?: string[]` — new, alongside existing `issueKey`/`features`
  (still mutually exclusive as a group: exactly one of `issueKey`,
  `issueKeys`, or `features`).
- Returns an array of the same per-issue shape it returns today
  (`issueKey`, `predictedDays`, `predictedDuration`, `confidence`,
  `neighbors`, `usedFallbackToSynthetic`) when `issueKeys` is used, a
  single object otherwise (unchanged for existing callers).
- Internally, fan the existing single-issue logic out with
  `Promise.all`, reusing `extractFeatures`/`predictResolutionDays`/
  `scoreConfidence` exactly as today — no new prediction logic, just
  batched I/O.
- Tool description gains one line: "For a question about multiple or
  all sprint tickets, call with `issueKeys` once rather than calling
  this tool once per issue."

### 2. What-if: `overrides`, general-purpose

Add an optional `overrides` (partial `IssueFeatures`) usable with
`issueKey` (mutually exclusive with `features`, not with `issueKeys` —
`overrides` only makes sense for a single real issue): fetches real
features for `issueKey`, shallow-merges `overrides` on top before
calling `predictResolutionDays`. This isn't scenario-specific — it
answers "what if reassigned," "what if priority changed," "what if
this label were added," or anything else expressible as a feature
change, without a dedicated code path per hypothetical.

Brand-new hypothetical ticket ("if we added a ticket like this, would
it fit") is already covered by the existing bare `features` input —
no change needed there.

### 3. No new bundled "sprint forecast" tool, no hardcoded flags

Explicitly **not** building a `predictSprintForecast` tool that
precomputes `likelySpillover`/`dueDateRisk`/`overloaded` booleans.
Baking a threshold ("spillover = predictedDays > daysRemaining") into
a tool return value is exactly the per-scenario hardcoding this
redesign is moving away from — it answers today's four scenarios and
nothing else. Instead, jira-analyst reports the raw facts it already
has (`daysRemaining`, `dueDate`, `assignee` from `getSprintIssues`)
alongside the batched predictions, and the orchestrator does the
comparison itself as part of its existing judgment layer — visibly,
so the user sees the reasoning rather than a silent boolean.

### 4. Prompt changes — principles, not new per-question sections

**`jiraAnalyst.ts` prompt**: document the `issueKeys` batch mode and
`overrides` mode next to the existing `predictResolutionTime` guidance
(same rules apply: never convert `predictedDays` yourself; always
report confidence per issue, not just once for the batch).

**`orchestrator.ts` prompt**: fold into the existing sections rather
than adding a parallel structure per scenario:
- Rewrite `PREDICTION / ETA REQUESTS` to cover one issue *or many* —
  "when the user asks about timing, completion, or risk for one or
  more issues (a single ETA, which tickets will still be open at
  sprint end, who's likely to miss a due date, whether an assignee is
  overloaded, or a hypothetical change) delegate to jira-analyst for
  the relevant issue keys' predictions in a single batched call,
  alongside sprint/issue data if the question needs `daysRemaining` or
  `dueDate` to compare against."
- Add to `JUDGMENT RULES` (not a new section): a principle for
  reasoning about predicted-days-vs-dates — state the workday/calendar
  approximation once when doing this kind of comparison, show the
  actual numbers being compared (predictedDays and daysRemaining or
  days-to-due-date) rather than asserting a verdict, and treat it as
  the same kind of inference `JUDGMENT RULES` already tells it to
  label as inference, not fact.
- Add one line to `DELEGATION RULES`: predictions for multiple issues
  in the same turn must go through one batched `issueKeys` call, never
  a loop of single-issue calls.
- No changes to `OUTPUT FORMAT` — existing ranked/bulleted structure
  already fits an arbitrary list of at-risk tickets, overloaded
  assignees, or a what-if answer.

This means the *same* prompt machinery handles all four originally
enumerated scenarios plus whatever else gets asked, because none of
them are special-cased — they're all "timing questions over facts +
predictions," which is now a first-class thing the orchestrator knows
how to do.

### 5. Tests

- Extend whatever test file currently covers `predictResolutionTime`
  (check its exact location before adding — not yet confirmed) with
  cases for: `issueKeys` batch mode (multiple issues, per-issue
  leave-one-out still applies), `overrides` merge mode, and that
  `issueKey`/`issueKeys`/`features` remain mutually exclusive (schema
  `refine` update).
- No new aggregation module/tests needed since there's no new
  aggregation logic — the comparison logic intentionally lives in the
  orchestrator's reasoning, not in code.

## Verification

- `npm test` — updated tests pass.
- `npx tsx src/testTools.ts` (or a small ad hoc script) exercising
  `predictResolutionTime` with `issueKeys` and with `overrides`
  directly, no model call.
- `npm run dev -- "..."` with a spread of phrasings — "What all
  tickets will be pending when the sprint ends?", "Which tickets are
  at risk of missing their due date?", "What if SMA-42 were reassigned
  to <name>?", "Is anyone overloaded this sprint?", and one phrasing
  not on this list — confirm all route through the same batched-
  prediction path and the response shows its work (numbers compared,
  approximation caveat stated) rather than a flat assertion.
- `DEBUG_AGENT=1 npm run dev -- "..."` to confirm a single batched
  `predictResolutionTime` call (not N single-issue calls) fires for
  multi-ticket questions.

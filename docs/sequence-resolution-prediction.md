# Issue resolution history & prediction

Three independent flows around `issue_resolution_history`: two that populate
it (a one-time manual backfill, and an ongoing background collector) and one
that reads it (the orchestrator's resolution-time prediction, via a k-NN
lookup over that table). None of these share a request path with
[Chat](sequence-chat.md)/[Sprint](sequence-sprint.md) beyond the prediction
flow being one thing the orchestrator can call into during a chat turn.

## 1. Manual backfill (`scripts/backfillResolutionHistory.ts`)

Run once (or re-run any time) by hand, directly against Jira and Postgres —
no agent server involved. Upserts by `(issue_key, source)`, so re-running is
always safe.

```mermaid
sequenceDiagram
    participant Operator
    participant Script as backfillResolutionHistory.ts<br/>(scripts)
    participant JiraClient as jiraClient.ts<br/>(src/commentEvaluator)
    participant Jira as Jira Cloud API
    participant FeatureExtraction as featureExtraction.ts<br/>(src)
    participant ResolutionHistory as resolutionHistory.ts<br/>(src/server)
    participant DB as Postgres<br/>issue_resolution_history

    Operator->>Script: npx tsx scripts/backfillResolutionHistory.ts
    Script->>JiraClient: searchIssueKeys(jql)<br/>project=SM AND status in (doneStatuses)
    JiraClient->>Jira: GET /rest/api/3/search/jql<br/>(paged via nextPageToken)
    Jira-->>JiraClient: issue keys
    JiraClient-->>Script: issueKeys[]

    loop each issueKey
        Script->>JiraClient: getIssuePredictionData(issueKey)
        Script->>JiraClient: getIssueComments(issueKey)
        JiraClient->>Jira: GET /rest/api/3/issue/:key<br/>(fields + changelog)
        JiraClient->>Jira: GET /rest/api/3/issue/:key/comment
        Jira-->>JiraClient: issue fields, changelog, comments
        JiraClient-->>Script: IssuePredictionData, comments
        Script->>FeatureExtraction: resolutionDaysFor(data)
        FeatureExtraction-->>Script: days (timeSpentSeconds / 8h workday,<br/>0 if no worklog, null if unresolved)
        Script->>FeatureExtraction: extractFeatures({issueKey, data, commentCount})
        FeatureExtraction-->>Script: IssueFeatures
        Script->>ResolutionHistory: insertResolutionRecord({...features, resolutionDays, source:"real"})
        ResolutionHistory->>DB: INSERT ... ON CONFLICT (issue_key, source) DO UPDATE
    end
    Script-->>Operator: "Done. Inserted/updated N, skipped M."
```

## 2. Background collector (dashboard scheduler → agent server)

Started lazily on the dashboard's first request (same pattern as the digest
scheduler — no cron/webhook infra exists in this repo), then reruns on
`RESOLUTION_COLLECTOR_INTERVAL_MINUTES` (default 20 minutes, matching the
Sprint Health Digest's cadence). Looks back several intervals (3x, so ~1h by
default) so a slow/missed tick can't let a newly-Done issue fall through the
gap.

```mermaid
sequenceDiagram
    participant Timer as setInterval<br/>(app/api/digest/_resolutionCollector.ts)
    participant NextRoute as agentServerFetch()<br/>(app/api/_lib)
    participant AgentAuth as auth.ts<br/>(src/server)
    participant Routes as routes.ts<br/>(src/server)
    participant JiraClient as jiraClient.ts<br/>(src/commentEvaluator)
    participant Jira as Jira Cloud API
    participant FeatureExtraction as featureExtraction.ts<br/>(src)
    participant ResolutionHistory as resolutionHistory.ts<br/>(src/server)
    participant DB as Postgres<br/>issue_resolution_history

    Timer->>NextRoute: POST /internal/collect-resolution-history<br/>{ lookbackHours }
    NextRoute->>Routes: header: x-api-key
    Routes->>AgentAuth: requireApiKey() [onRequest hook]
    AgentAuth-->>Routes: 401 if invalid/missing key
    Routes->>JiraClient: searchIssueKeys(jql)<br/>status in (doneStatuses) AND statusCategoryChangedDate >= "-Nh"
    JiraClient->>Jira: GET /rest/api/3/search/jql
    Jira-->>JiraClient: recently-Done issue keys
    JiraClient-->>Routes: issueKeys[]

    loop each issueKey
        Routes->>JiraClient: getIssuePredictionData(issueKey)
        Routes->>JiraClient: getIssueComments(issueKey)
        JiraClient->>Jira: GET /rest/api/3/issue/:key (fields + changelog + comments)
        Jira-->>JiraClient: data, comments
        Routes->>FeatureExtraction: resolutionDaysFor(data)
        FeatureExtraction-->>Routes: days (null skips this issue)
        Routes->>FeatureExtraction: extractFeatures(...)
        Routes->>ResolutionHistory: insertResolutionRecord({..., source:"real"})
        ResolutionHistory->>DB: INSERT ... ON CONFLICT DO UPDATE
    end
    Routes-->>NextRoute: { inserted, checked }
```

## 3. Live prediction (chat → orchestrator → jiraAnalyst)

Triggered whenever a user asks something like "how long will SMA-42 take?"
during a normal [chat](sequence-chat.md) turn — this is the orchestrator
delegating to the `jira-analyst` sub-agent via deepagents' `task` tool, one
step inside that larger flow, not a separate HTTP route.

```mermaid
sequenceDiagram
    participant Orchestrator as orchestrator<br/>(src/agent.ts)
    participant JiraAnalyst as jira-analyst sub-agent<br/>(src/agents/jiraAnalyst.ts)
    participant PredictTool as predictResolutionTime<br/>(src/tools/resolutionPrediction.ts)
    participant JiraClient as jiraClient.ts<br/>(src/commentEvaluator)
    participant Jira as Jira Cloud API
    participant ResolutionHistory as resolutionHistory.ts<br/>(src/server)
    participant DB as Postgres<br/>issue_resolution_history
    participant KNN as knn.ts + confidence.ts<br/>(src)

    Orchestrator->>JiraAnalyst: task({subagent_type:"jira-analyst",<br/>description:"estimate resolution time for SMA-42"})
    JiraAnalyst->>PredictTool: predictResolutionTime.invoke({issueKey:"SMA-42"})
    PredictTool->>JiraClient: getIssuePredictionData + getIssueComments
    JiraClient->>Jira: GET /rest/api/3/issue/:key
    Jira-->>JiraClient: issue data, comments
    JiraClient-->>PredictTool: IssuePredictionData, comments
    PredictTool->>PredictTool: extractFeatures(...)
    PredictTool->>ResolutionHistory: getResolutionHistory()
    ResolutionHistory->>DB: SELECT * WHERE source='real'<br/>SELECT * WHERE source='synthetic'
    DB-->>ResolutionHistory: real[], synthetic[]
    ResolutionHistory-->>PredictTool: { real, synthetic }
    PredictTool->>KNN: predictResolutionDays(features, history, K_NEIGHBORS, threshold)
    KNN->>KNN: distance() per candidate<br/>(prefers real neighbors,<br/>falls back to synthetic if none close)
    KNN-->>PredictTool: { predictedDays, neighbors, usedFallbackToSynthetic }
    PredictTool->>KNN: scoreConfidence(neighbors, K_NEIGHBORS)
    KNN-->>PredictTool: { level, closestDistance }
    PredictTool-->>JiraAnalyst: { issueKey, predictedDays, confidence, neighbors, usedFallbackToSynthetic }
    JiraAnalyst-->>Orchestrator: predictedDays + confidence level +<br/>neighbor issues (verbatim, not re-judged)
```

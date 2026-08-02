# Sprint data view (no agent involved)

`SprintBoard.tsx` bypasses the orchestrator entirely — this is a plain data
fetch-and-join, not a conversation, so there's no lock/checkpoint/model call
anywhere in the path.

See also: [Chat](sequence-chat.md), [Thread history](sequence-history.md).

```mermaid
sequenceDiagram
    participant Browser
    participant SprintBoard as SprintBoard.tsx<br/>(app/components)
    participant NextRoute as route.ts<br/>(app/api/sprint)
    participant AgentAuth as auth.ts<br/>(src/server)
    participant Routes as routes.ts<br/>(src/server)
    participant JiraTools as tools/jira.ts<br/>(src)
    participant GithubTools as tools/github.ts<br/>(src)
    participant Jira as Jira Cloud API
    participant GitHub as GitHub API

    Browser->>SprintBoard: page loads
    SprintBoard->>NextRoute: GET /api/sprint<br/>(no api key)
    NextRoute->>Routes: GET /sprint<br/>header: x-api-key
    Routes->>AgentAuth: requireApiKey() [onRequest hook]
    AgentAuth-->>Routes: 401 if invalid/missing key
    Routes->>JiraTools: getActiveSprint.invoke({})
    JiraTools->>Jira: fetch active sprint
    Jira-->>JiraTools: sprint data
    JiraTools-->>Routes: { active, id, ... } (or active:false)
    Routes->>JiraTools: getSprintIssues.invoke({ sprintId })
    Routes->>GithubTools: getOpenPullRequests.invoke({})
    Routes->>GithubTools: getRecentCommits.invoke({ days: 7 })
    JiraTools->>Jira: fetch sprint issues
    GithubTools->>GitHub: fetch open PRs, recent commits
    Jira-->>JiraTools: tickets
    GitHub-->>GithubTools: prs, commits
    Routes->>Routes: cross-reference by linkedIssueKey<br/>(tickets <-> prs/commits)
    Routes-->>NextRoute: { active, sprint, tickets, prs, commits }
    NextRoute-->>SprintBoard: JSON passthrough
    SprintBoard->>SprintBoard: render sprint board
    SprintBoard-->>Browser: sprint health view
```

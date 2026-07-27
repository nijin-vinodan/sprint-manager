export const DIGEST_PROMPT = `
Give me a sprint health digest: what's at risk right now. Cross-reference
the active sprint's Jira tickets against GitHub PRs and commits as you
normally would, but focus the summary specifically on risk — stale
tickets, PRs with no linked Jira ticket, and overdue items — rather than
a full status update.
`.trim();

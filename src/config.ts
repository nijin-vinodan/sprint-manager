import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  jira: {
    baseUrl: requireEnv("JIRA_BASE_URL").replace(/\/+$/, ""),
    email: requireEnv("JIRA_EMAIL"),
    apiToken: requireEnv("JIRA_API_TOKEN"),
    projectKey: process.env.JIRA_PROJECT_KEY ?? "SMA",
  },
  github: {
    token: requireEnv("GITHUB_TOKEN"),
    owner: requireEnv("GITHUB_OWNER"),
    repo: requireEnv("GITHUB_REPO"),
  },
  agent: {
    // "bedrock:<model-id>" resolves through initChatModel to ChatBedrockConverse
    // (@langchain/aws), which reads AWS credentials/region from the standard
    // AWS SDK chain (env vars, shared config/profile, SSO, instance role, etc).
    model: process.env.AGENT_MODEL ?? "bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
} as const;

// Thresholds used to pre-digest "is this stale/overdue/risky" facts inside
// the tools, so the agent never has to do date math itself.
export const thresholds = {
  STALE_TICKET_DAYS: 3,
  STALE_PR_DAYS: 2,
} as const;

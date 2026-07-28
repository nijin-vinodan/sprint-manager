import "dotenv/config";
import { ChatAnthropic } from "@langchain/anthropic";

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
    // Claude via a LiteLLM proxy speaking the Anthropic-compatible API,
    // instead of talking to Bedrock directly with AWS credentials.
    model: new ChatAnthropic({
      model: requireEnv("ANTHROPIC_MODEL"),
      apiKey: requireEnv("ANTHROPIC_AUTH_TOKEN"),
      anthropicApiUrl: requireEnv("ANTHROPIC_BASE_URL"),
    }),
  },
  digest: {
    intervalMinutes: Number(process.env.DIGEST_INTERVAL_MINUTES ?? 20),
  },
} as const;

// Thresholds used to pre-digest "is this stale/overdue/risky" facts inside
// the tools, so the agent never has to do date math itself.
export const thresholds = {
  STALE_TICKET_DAYS: 3,
  STALE_PR_DAYS: 2,
} as const;

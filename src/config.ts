import "dotenv/config";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const modelProvider = process.env.MODEL_PROVIDER ?? "litellm";

function buildModel() {
  switch (modelProvider) {
    case "litellm":
      // Claude via a LiteLLM proxy speaking the Anthropic-compatible API,
      // instead of talking to Bedrock directly with AWS credentials.
      return new ChatAnthropic({
        model: requireEnv("ANTHROPIC_MODEL"),
        apiKey: requireEnv("ANTHROPIC_AUTH_TOKEN"),
        anthropicApiUrl: requireEnv("ANTHROPIC_BASE_URL"),
      });
    case "gemini":
      return new ChatGoogleGenerativeAI({
        model: requireEnv("GEMINI_MODEL"),
        apiKey: requireEnv("GEMINI_API_KEY"),
      });
    default:
      throw new Error(
        `Unknown MODEL_PROVIDER: ${modelProvider} (expected "litellm" or "gemini")`,
      );
  }
}

export const config = {
  jira: {
    baseUrl: requireEnv("JIRA_BASE_URL").replace(/\/+$/, ""),
    email: requireEnv("JIRA_EMAIL"),
    apiToken: requireEnv("JIRA_API_TOKEN"),
    projectKey: process.env.JIRA_PROJECT_KEY ?? "SMA",
    doneStatuses: ["Done", "Closed"] as const,
  },
  github: {
    token: requireEnv("GITHUB_TOKEN"),
    owner: requireEnv("GITHUB_OWNER"),
    repo: requireEnv("GITHUB_REPO"),
  },
  agent: {
    model: buildModel(),
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
  K_NEIGHBORS: Number(process.env.K_NEIGHBORS ?? 3),
  REAL_NEIGHBOR_DISTANCE_THRESHOLD: 1.5,
} as const;

// Unit tests never hit real Jira/GitHub/Postgres/Anthropic, but src/config.ts
// and src/server/config.ts throw at *import time* if their required env vars
// are missing. This runs before any test file's imports (Vitest guarantee),
// so by the time a test imports a tool module, these are already set.
// dotenv's config() (loaded inside config.ts) never overrides vars already
// present in process.env, so these values win over anything in a real .env.
process.env.JIRA_BASE_URL ??= "https://test-jira.example.com";
process.env.JIRA_EMAIL ??= "test@example.com";
process.env.JIRA_API_TOKEN ??= "test-jira-token";
process.env.JIRA_PROJECT_KEY ??= "SMA";
process.env.GITHUB_TOKEN ??= "test-github-token";
process.env.GITHUB_OWNER ??= "test-owner";
process.env.GITHUB_REPO ??= "test-repo";
process.env.ANTHROPIC_MODEL ??= "test-model";
process.env.ANTHROPIC_AUTH_TOKEN ??= "test-anthropic-key";
process.env.ANTHROPIC_BASE_URL ??= "https://test-anthropic.example.com";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

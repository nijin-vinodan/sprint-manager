import { tool } from "langchain";
import { z } from "zod";
import { config, thresholds } from "../config.js";
import { daysSince, extractIssueKey } from "../dateUtils.js";

const GITHUB_API_BASE = "https://api.github.com";

async function githubFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status} for ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubReview {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submitted_at: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    author: { name: string; date: string };
    message: string;
  };
}

type ReviewState = "approved" | "changes_requested" | "pending";

function summarizeReviewState(reviews: GitHubReview[]): ReviewState {
  if (reviews.some((r) => r.state === "CHANGES_REQUESTED")) return "changes_requested";
  if (reviews.some((r) => r.state === "APPROVED")) return "approved";
  return "pending";
}

export const getOpenPullRequests = tool(
  async ({ repo }) => {
    const targetRepo = repo ?? config.github.repo;
    const prs = await githubFetch<GitHubPullRequest[]>(
      `/repos/${config.github.owner}/${targetRepo}/pulls?state=open&per_page=100`,
    );

    const enriched = await Promise.all(
      prs.map(async (pr) => {
        const reviews = await githubFetch<GitHubReview[]>(
          `/repos/${config.github.owner}/${targetRepo}/pulls/${pr.number}/reviews`,
        );
        const daysSinceUpdate = daysSince(pr.updated_at);
        const linkedIssueKey =
          extractIssueKey(pr.title, config.jira.projectKey) ??
          extractIssueKey(pr.body, config.jira.projectKey);

        return {
          number: pr.number,
          title: pr.title,
          author: pr.user.login,
          url: pr.html_url,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          ageDays: daysSince(pr.created_at),
          daysSinceUpdate,
          isStale: daysSinceUpdate >= thresholds.STALE_PR_DAYS,
          reviewState: summarizeReviewState(reviews),
          linkedIssueKey,
        };
      }),
    );

    return enriched;
  },
  {
    name: "getOpenPullRequests",
    description:
      "Get all open pull requests for a GitHub repo, with pre-computed age in days, staleness (based on days since last update), summarized review state (approved/changes_requested/pending), and any linked Jira issue key extracted from the title/body.",
    schema: z.object({
      repo: z
        .string()
        .optional()
        .describe("Repo name (defaults to the configured GITHUB_REPO if omitted)."),
    }),
  },
);

export const getRecentCommits = tool(
  async ({ repo, days }) => {
    const targetRepo = repo ?? config.github.repo;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const commits = await githubFetch<GitHubCommit[]>(
      `/repos/${config.github.owner}/${targetRepo}/commits?since=${since}&per_page=100`,
    );

    return commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      author: c.commit.author.name,
      message: c.commit.message,
      date: c.commit.author.date,
      daysAgo: daysSince(c.commit.author.date),
      linkedIssueKey: extractIssueKey(c.commit.message, config.jira.projectKey),
    }));
  },
  {
    name: "getRecentCommits",
    description:
      "Get commits from a GitHub repo in the last N days, with pre-computed days-ago and any linked Jira issue key extracted from the commit message.",
    schema: z.object({
      repo: z
        .string()
        .optional()
        .describe("Repo name (defaults to the configured GITHUB_REPO if omitted)."),
      days: z.number().describe("How many days back to look for commits."),
    }),
  },
);

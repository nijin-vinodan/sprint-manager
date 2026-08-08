import "dotenv/config";
import { LangfuseClient } from "@langfuse/client";
import { getActiveSprint, getSprintIssues } from "../src/tools/jira.js";
import { thresholds } from "../src/config.js";

/**
 * Seeds the Langfuse dataset used by `npm run eval:langfuse` to regression-test
 * the orchestrator's answers to sprint questions. Two kinds of items:
 *
 *   generic  Hand-authored, evergreen questions with approximate keyword
 *            checks (SEED_ITEMS below) — always valid, never need refreshing.
 *   ticket   Generated from the real, currently active sprint (via the same
 *            getActiveSprint/getSprintIssues tools the agent itself uses, no
 *            mocking). expectedOutput.groundTruth is the tool's own
 *            pre-computed facts for that ticket, so correctness is checked
 *            against reality rather than a guess.
 *
 * Ticket items are id'd `ticket-<key>` and upserted on every run to refresh
 * their ground truth. Tickets that were previously included but have since
 * left the active sprint's issue list are archived (status: ARCHIVED) rather
 * than left behind with stale facts.
 *
 * Idempotent: the dataset is created once (skipped if it already exists), and
 * each item is upserted by its stable `id` — safe to re-run any time,
 * including on a schedule, to keep ticket items current.
 *
 * Usage:
 *   npx tsx scripts/seedLangfuseDataset.ts
 *
 * Requires LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY, plus the Jira env vars
 * src/config.ts requires, in the environment.
 */

export const DATASET_NAME = "sprint-manager-orchestrator";

const MAX_TICKET_ITEMS = 5;

interface SeedItem {
  id: string;
  prompt: string;
  /** Keywords the orchestrator's answer should mention; scored by scripts/runLangfuseExperiment.ts. */
  expectedKeywords: string[];
  /** Free-text ground truth for the LLM-as-judge evaluator to check the answer against. */
  groundTruth?: string;
  metadata?: Record<string, unknown>;
}

const SEED_ITEMS: SeedItem[] = [
  {
    id: "sprint-status-overview",
    prompt: "Give me today's sprint status update",
    expectedKeywords: ["sprint", "story points", "blocked"],
  },
  {
    id: "stale-tickets",
    prompt: "Are there any stale tickets in the current sprint?",
    expectedKeywords: ["stale", "days"],
  },
  {
    id: "overdue-tickets",
    prompt: "Which tickets are overdue in the current sprint?",
    expectedKeywords: ["overdue", "due"],
  },
  {
    id: "open-prs-review",
    prompt: "What pull requests are open and waiting on review?",
    expectedKeywords: ["pull request", "review"],
  },
  {
    id: "unassigned-tickets",
    prompt: "Are there any unassigned tickets in the sprint?",
    expectedKeywords: ["unassigned"],
  },
  {
    id: "at-risk-summary",
    prompt: "What's at risk in the current sprint and why?",
    expectedKeywords: ["risk"],
  },
];

interface SprintIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  priority: string;
  issueType: string;
  updated: string;
  dueDate: string | null;
  daysSinceUpdate: number;
  isOverdue: boolean;
}

// Prioritizes tickets that exercise a specific fact (overdue, stale,
// unassigned) so the generated set is more informative than a random sample,
// then fills any remaining slots with whatever's left.
function selectTicketIssues(issues: SprintIssue[], max: number): SprintIssue[] {
  const overdue = issues.filter((i) => i.isOverdue);
  const stale = issues.filter((i) => !i.isOverdue && i.daysSinceUpdate >= thresholds.STALE_TICKET_DAYS);
  const unassigned = issues.filter((i) => i.assignee === "Unassigned" && !i.isOverdue);
  const rest = issues.filter((i) => !overdue.includes(i) && !stale.includes(i) && !unassigned.includes(i));

  const picked: SprintIssue[] = [];
  const seen = new Set<string>();
  for (const bucket of [overdue, stale, unassigned, rest]) {
    for (const issue of bucket) {
      if (picked.length >= max) return picked;
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      picked.push(issue);
    }
  }
  return picked;
}

function toSeedItem(issue: SprintIssue): SeedItem {
  const groundTruth = [
    `${issue.key} ("${issue.summary}") is currently in status "${issue.status}".`,
    `Assignee: ${issue.assignee}.`,
    `Last updated ${issue.daysSinceUpdate} day(s) ago.`,
    `Due date: ${issue.dueDate ?? "not set"}.`,
    `It is ${issue.isOverdue ? "overdue" : "not overdue"}.`,
  ].join(" ");

  return {
    id: `ticket-${issue.key}`,
    prompt: `What's the current status of ${issue.key}, including who it's assigned to and whether it's overdue?`,
    expectedKeywords: [issue.key, issue.assignee],
    groundTruth,
    metadata: { source: "ticket", issueKey: issue.key },
  };
}

async function buildTicketItems(): Promise<SeedItem[]> {
  const sprint = await getActiveSprint.invoke({});
  if (!sprint.active) {
    console.warn(`No active sprint — skipping ticket-derived dataset items (${sprint.message}).`);
    return [];
  }

  const issues = (await getSprintIssues.invoke({ sprintId: sprint.id })) as SprintIssue[];
  const selected = selectTicketIssues(issues, MAX_TICKET_ITEMS);
  return selected.map(toSeedItem);
}

async function main() {
  const langfuse = new LangfuseClient();

  try {
    await langfuse.api.datasets.get(DATASET_NAME);
    console.log(`Dataset "${DATASET_NAME}" already exists.`);
  } catch {
    await langfuse.api.datasets.create({
      name: DATASET_NAME,
      description: "Representative sprint questions (generic + real-ticket-derived) for regression-testing the orchestrator agent.",
    });
    console.log(`Created dataset "${DATASET_NAME}".`);
  }

  const ticketItems = await buildTicketItems();
  const allItems = [...SEED_ITEMS, ...ticketItems];

  for (const item of allItems) {
    await langfuse.dataset.createItem({
      id: item.id,
      datasetName: DATASET_NAME,
      input: { prompt: item.prompt },
      expectedOutput: { keywords: item.expectedKeywords, groundTruth: item.groundTruth },
      metadata: item.metadata,
    });
    console.log(`Upserted item "${item.id}"`);
  }

  // Archive ticket items from a previous run whose ticket is no longer
  // in the active sprint's issue list, so ground truth never goes stale.
  const currentTicketIds = new Set(ticketItems.map((item) => item.id));
  const existing = await langfuse.dataset.get(DATASET_NAME);
  const orphaned = existing.items.filter(
    (item) => item.id.startsWith("ticket-") && item.status === "ACTIVE" && !currentTicketIds.has(item.id),
  );
  for (const item of orphaned) {
    await langfuse.dataset.createItem({
      id: item.id,
      datasetName: DATASET_NAME,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata,
      status: "ARCHIVED",
    });
    console.log(`Archived stale ticket item "${item.id}" (no longer in the active sprint)`);
  }

  console.log(`Seeded ${SEED_ITEMS.length} generic + ${ticketItems.length} ticket-derived items into "${DATASET_NAME}".`);
}

main().catch((err) => {
  console.error("Seeding Langfuse dataset failed:", err);
  process.exitCode = 1;
});

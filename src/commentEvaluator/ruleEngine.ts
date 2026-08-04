import { daysSince, daysUntil, isPastDue } from "../dateUtils.js";
import { commentTemplates } from "./commentTemplates.js";
import type { RuleMatch, TicketContext } from "./types.js";

// Default inactivity/lookahead window (days) for the staleness rules below.
// Kept local to the comment evaluator rather than reusing config.thresholds,
// since those tune tool-reported facts, not nudge-comment timing.
export const STALENESS_THRESHOLD_DAYS = 2;

type Rule = (ticket: TicketContext) => RuleMatch | null;

const stale_in_progress: Rule = (t) => {
  if (t.status !== "In Progress") return null;
  const days = daysSince(t.updatedDate);
  if (days <= STALENESS_THRESHOLD_DAYS) return null;
  return { ruleId: "stale_in_progress", message: commentTemplates.stale_in_progress(days) };
};

const stale_in_review: Rule = (t) => {
  if (t.status !== "In Review") return null;
  const days = daysSince(t.updatedDate);
  if (days <= STALENESS_THRESHOLD_DAYS) return null;
  return { ruleId: "stale_in_review", message: commentTemplates.stale_in_review(days) };
};

const stale_todo: Rule = (t) => {
  if (t.status !== "To Do" || !t.sprintStartDate) return null;
  const days = daysSince(t.sprintStartDate);
  if (days <= STALENESS_THRESHOLD_DAYS) return null;
  return { ruleId: "stale_todo", message: commentTemplates.stale_todo(days) };
};

const no_activity_near_end: Rule = (t) => {
  if (t.comments.length > 0 || !t.sprintEndDate) return null;
  const daysRemaining = daysUntil(t.sprintEndDate);
  if (daysRemaining < 0 || daysRemaining > STALENESS_THRESHOLD_DAYS) return null;
  return { ruleId: "no_activity_near_end", message: commentTemplates.no_activity_near_end(daysRemaining) };
};

const unassigned_active: Rule = (t) => {
  if (t.assignee !== null || t.status === "To Do") return null;
  return { ruleId: "unassigned_active", message: commentTemplates.unassigned_active(t.status) };
};

const reassigned_no_context: Rule = (t) => {
  if (t.assigneeHistory.length === 0) return null;
  const lastChange = t.assigneeHistory[t.assigneeHistory.length - 1];
  const hasHandoffComment = t.comments.some((c) => c.created > lastChange.changedAt);
  if (hasHandoffComment) return null;
  return {
    ruleId: "reassigned_no_context",
    message: commentTemplates.reassigned_no_context(
      lastChange.fromDisplayName ?? "Unassigned",
      lastChange.toDisplayName ?? "Unassigned",
    ),
  };
};

const overdue: Rule = (t) => {
  if (t.status === "Done" || !isPastDue(t.dueDate)) return null;
  return { ruleId: "overdue", message: commentTemplates.overdue(t.dueDate as string, t.status) };
};

const blocked_ticket_stale: Rule = (t) => {
  const openBlocker = t.issueLinks.find(
    (link) => link.type === "is blocked by" && link.linkedIssueStatus !== "Done",
  );
  if (!openBlocker) return null;
  return {
    ruleId: "blocked_ticket_stale",
    message: commentTemplates.blocked_ticket_stale(openBlocker.linkedIssueKey),
  };
};

// Highest-priority group first. When a ticket trips multiple rules in the
// same cycle, only the match from the earliest-listed group is kept.
export const PRIORITY_ORDER: string[][] = [
  ["stale_in_progress", "stale_in_review", "stale_todo", "no_activity_near_end"],
  ["unassigned_active", "reassigned_no_context"],
  ["overdue", "blocked_ticket_stale"],
];

const RULES: Rule[] = [
  stale_in_progress,
  stale_in_review,
  stale_todo,
  no_activity_near_end,
  unassigned_active,
  reassigned_no_context,
  overdue,
  blocked_ticket_stale,
];

/**
 * Runs every rule against the ticket, drops matches already posted this
 * cycle (per the caller's state-transition dedup check), and returns the
 * single highest-priority remaining match, or null if none apply.
 */
export function evaluateTicket(ticket: TicketContext, alreadyPosted: Set<string> = new Set()): RuleMatch | null {
  const matches = RULES.map((rule) => rule(ticket)).filter(
    (m): m is RuleMatch => m !== null && !alreadyPosted.has(m.ruleId),
  );
  if (matches.length === 0) return null;

  for (const group of PRIORITY_ORDER) {
    const match = matches.find((m) => group.includes(m.ruleId));
    if (match) return match;
  }
  return matches[0];
}

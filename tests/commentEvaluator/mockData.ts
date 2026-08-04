import type { TicketContext } from "../../src/commentEvaluator/types.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function baseTicket(overrides: Partial<TicketContext>): TicketContext {
  return {
    key: "SMA-1",
    status: "In Progress",
    assignee: "Jane Doe",
    createdDate: isoDaysAgo(10),
    updatedDate: isoDaysAgo(0),
    dueDate: null,
    sprintStartDate: isoDaysAgo(0),
    sprintEndDate: null,
    comments: [{ author: "Jane Doe", created: isoDaysAgo(0), body: "Working on it." }],
    assigneeHistory: [],
    issueLinks: [],
    ...overrides,
  };
}

export const happyPathTicket = baseTicket({ key: "SMA-100" });

export const staleInProgressTicket = baseTicket({
  key: "SMA-101",
  status: "In Progress",
  updatedDate: isoDaysAgo(5),
});

export const staleInReviewTicket = baseTicket({
  key: "SMA-102",
  status: "In Review",
  updatedDate: isoDaysAgo(5),
});

export const staleTodoTicket = baseTicket({
  key: "SMA-103",
  status: "To Do",
  updatedDate: isoDaysAgo(0),
  sprintStartDate: isoDaysAgo(5),
  comments: [],
});

export const noActivityNearEndTicket = baseTicket({
  key: "SMA-104",
  status: "In Progress",
  updatedDate: isoDaysAgo(0),
  sprintEndDate: isoDaysFromNow(1),
  comments: [],
});

export const unassignedActiveTicket = baseTicket({
  key: "SMA-105",
  status: "In Progress",
  assignee: null,
});

export const reassignedNoContextTicket = baseTicket({
  key: "SMA-106",
  status: "In Progress",
  comments: [{ author: "Jane Doe", created: isoDaysAgo(4), body: "Starting work." }],
  assigneeHistory: [
    { fromDisplayName: "Jane Doe", toDisplayName: "John Smith", changedAt: isoDaysAgo(3) },
  ],
});

export const overdueTicket = baseTicket({
  key: "SMA-107",
  status: "In Progress",
  dueDate: isoDaysAgo(2).slice(0, 10),
});

export const blockedTicketStaleTicket = baseTicket({
  key: "SMA-108",
  status: "In Progress",
  issueLinks: [{ type: "is blocked by", linkedIssueKey: "SMA-50", linkedIssueStatus: "Open" }],
});

// Trips both stale_in_progress (staleness group) and overdue (planning-hygiene
// group) at once — used to assert priority ordering picks the staleness match.
export const staleAndOverdueTicket = baseTicket({
  key: "SMA-109",
  status: "In Progress",
  updatedDate: isoDaysAgo(5),
  dueDate: isoDaysAgo(2).slice(0, 10),
});

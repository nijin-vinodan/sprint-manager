import { describe, expect, it } from "vitest";
import { evaluateTicket } from "../../src/commentEvaluator/ruleEngine.js";
import {
  blockedTicketStaleTicket,
  happyPathTicket,
  noActivityNearEndTicket,
  overdueTicket,
  reassignedNoContextTicket,
  staleAndOverdueTicket,
  staleInProgressTicket,
  staleInReviewTicket,
  staleTodoTicket,
  unassignedActiveTicket,
} from "./mockData.js";

describe("evaluateTicket", () => {
  it("returns null for a ticket that trips no rules", () => {
    expect(evaluateTicket(happyPathTicket)).toBeNull();
  });

  it("fires stale_in_progress for a stale In Progress ticket", () => {
    const match = evaluateTicket(staleInProgressTicket);
    expect(match?.ruleId).toBe("stale_in_progress");
    expect(match?.message).toContain("in progress");
  });

  it("fires stale_in_review for a stale In Review ticket", () => {
    const match = evaluateTicket(staleInReviewTicket);
    expect(match?.ruleId).toBe("stale_in_review");
    expect(match?.message).toContain("in review");
  });

  it("fires stale_todo for a To Do ticket stale since sprint start", () => {
    const match = evaluateTicket(staleTodoTicket);
    expect(match?.ruleId).toBe("stale_todo");
    expect(match?.message).toContain("To Do");
  });

  it("fires no_activity_near_end for a never-commented ticket near sprint end", () => {
    const match = evaluateTicket(noActivityNearEndTicket);
    expect(match?.ruleId).toBe("no_activity_near_end");
    expect(match?.message).toContain("sprint ends");
  });

  it("fires unassigned_active for an unassigned non-To-Do ticket", () => {
    const match = evaluateTicket(unassignedActiveTicket);
    expect(match?.ruleId).toBe("unassigned_active");
    expect(match?.message).toContain("no assignee");
  });

  it("fires reassigned_no_context when no comment followed the reassignment", () => {
    const match = evaluateTicket(reassignedNoContextTicket);
    expect(match?.ruleId).toBe("reassigned_no_context");
    expect(match?.message).toContain("Jane Doe");
    expect(match?.message).toContain("John Smith");
  });

  it("does not fire reassigned_no_context when a comment followed the reassignment", () => {
    const ticket = {
      ...reassignedNoContextTicket,
      comments: [
        ...reassignedNoContextTicket.comments,
        { author: "John Smith", created: new Date().toISOString(), body: "Got it, taking over." },
      ],
    };
    expect(evaluateTicket(ticket)).toBeNull();
  });

  it("fires overdue for a past-due ticket that isn't Done", () => {
    const match = evaluateTicket(overdueTicket);
    expect(match?.ruleId).toBe("overdue");
    expect(match?.message).toContain("due date");
  });

  it("does not fire overdue for a past-due ticket that is Done", () => {
    expect(evaluateTicket({ ...overdueTicket, status: "Done" })).toBeNull();
  });

  it("fires blocked_ticket_stale when blocked by a still-open ticket", () => {
    const match = evaluateTicket(blockedTicketStaleTicket);
    expect(match?.ruleId).toBe("blocked_ticket_stale");
    expect(match?.message).toContain("SMA-50");
  });

  it("does not fire blocked_ticket_stale once the blocking ticket is Done", () => {
    const ticket = {
      ...blockedTicketStaleTicket,
      issueLinks: [{ type: "is blocked by", linkedIssueKey: "SMA-50", linkedIssueStatus: "Done" }],
    };
    expect(evaluateTicket(ticket)).toBeNull();
  });

  it("prefers the staleness-group match over a planning-hygiene match on the same ticket", () => {
    const match = evaluateTicket(staleAndOverdueTicket);
    expect(match?.ruleId).toBe("stale_in_progress");
  });

  it("drops matches already posted this cycle", () => {
    const match = evaluateTicket(staleInProgressTicket, new Set(["stale_in_progress"]));
    expect(match).toBeNull();
  });
});

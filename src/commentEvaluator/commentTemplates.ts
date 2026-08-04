export const commentTemplates = {
  stale_in_progress: (days: number) =>
    `This ticket has been in progress for ${days} days with no updates. Please add a status on what is happening in the ticket.`,

  stale_in_review: (days: number) =>
    `This ticket has been in review for ${days} days with no comment activity. Can someone check if this is blocked on something?`,

  stale_todo: (days: number) =>
    `This ticket has been in To Do for ${days} days since the sprint started. Is this still planned for this sprint?`,

  no_activity_near_end: (days: number) =>
    `This ticket hasn't had any updates yet and the sprint ends in ${days} days. Can someone share where things stand?`,

  unassigned_active: (status: string) =>
    `This ticket is ${status} but has no assignee. Can someone confirm who owns this?`,

  reassigned_no_context: (oldOwner: string, newOwner: string) =>
    `This ticket was reassigned from ${oldOwner} to ${newOwner}, with no handoff comment. Can the new assignee confirm they have the context to pick this up?`,

  overdue: (dueDate: string, status: string) =>
    `This ticket's due date (${dueDate}) has passed and the status is still ${status}. Can someone update the status or revise the timeline?`,

  blocked_ticket_stale: (blockingTicket: string) =>
    `This ticket is marked as blocked by ${blockingTicket}, which is still open. Is this still a blocker?`,
} as const;

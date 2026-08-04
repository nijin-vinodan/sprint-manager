import { shouldSkip, recordBotComment } from "./dedupStore.js";
import { postJiraComment } from "./jiraClient.js";
import { evaluateTicket } from "./ruleEngine.js";
import type { CommentResult, TicketContext } from "./types.js";

/**
 * Evaluates one ticket against every rule, skips re-posting if the matching
 * rule already fired while the ticket was in its current status, and posts
 * + records a nudge comment otherwise. Returns null when nothing was posted.
 */
export async function evaluateAndComment(ticket: TicketContext): Promise<CommentResult | null> {
  const match = evaluateTicket(ticket);
  if (!match) return null;

  if (await shouldSkip(ticket.key, match.ruleId, ticket.status)) return null;

  const result = await postJiraComment(ticket.key, match.ruleId, match.message);
  await recordBotComment(ticket.key, match.ruleId, result.commentId, ticket.status);
  return result;
}

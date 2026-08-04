import { pool } from "../server/db.js";

let migrated: Promise<void> | undefined;

async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_comments (
      id SERIAL PRIMARY KEY,
      issue_key TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ticket_status_at_post TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS bot_comments_issue_rule_idx ON bot_comments (issue_key, rule_id, posted_at DESC);
  `);
}

export async function ensureBotCommentsTable(): Promise<void> {
  if (!migrated) migrated = migrate();
  await migrated;
}

export interface BotCommentRecord {
  commentId: string;
  postedAt: string;
  ticketStatusAtPost: string;
}

export async function recordBotComment(
  issueKey: string,
  ruleId: string,
  commentId: string,
  ticketStatusAtPost: string,
): Promise<void> {
  await ensureBotCommentsTable();
  await pool.query(
    `INSERT INTO bot_comments (issue_key, rule_id, comment_id, ticket_status_at_post) VALUES ($1, $2, $3, $4);`,
    [issueKey, ruleId, commentId, ticketStatusAtPost],
  );
}

export async function getLastBotComment(issueKey: string, ruleId: string): Promise<BotCommentRecord | null> {
  await ensureBotCommentsTable();
  const result = await pool.query(
    `SELECT comment_id, posted_at, ticket_status_at_post FROM bot_comments
     WHERE issue_key = $1 AND rule_id = $2
     ORDER BY posted_at DESC LIMIT 1;`,
    [issueKey, ruleId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    commentId: row.comment_id,
    postedAt: row.posted_at,
    ticketStatusAtPost: row.ticket_status_at_post,
  };
}

/**
 * True iff a bot comment for this issue+rule was already posted while the
 * ticket was in its current status — i.e. nothing has changed since, so
 * re-posting would just be noise. A status change since the last comment
 * (even a reversal) clears this and allows a fresh nudge.
 */
export async function shouldSkip(issueKey: string, ruleId: string, currentStatus: string): Promise<boolean> {
  const last = await getLastBotComment(issueKey, ruleId);
  if (!last) return false;
  return last.ticketStatusAtPost === currentStatus;
}

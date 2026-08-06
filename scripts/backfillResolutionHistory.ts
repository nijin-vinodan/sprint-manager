import "dotenv/config";
import { config } from "../src/config.js";
import { getIssueComments, getIssuePredictionData, searchIssueKeys } from "../src/commentEvaluator/jiraClient.js";
import { extractFeatures, resolutionDaysFor } from "../src/featureExtraction.js";
import { insertResolutionRecord } from "../src/server/resolutionHistory.js";
import { pool } from "../src/server/db.js";

/**
 * Backfills issue_resolution_history from currently-Done/Closed SMA issues,
 * as source='real'. Skips (and logs) any issue missing a resolution date
 * rather than failing the whole run.
 *
 * Usage:
 *   npx tsx scripts/backfillResolutionHistory.ts
 */
async function main() {
  const statusList = config.jira.doneStatuses.map((status) => `"${status}"`).join(", ");
  const jql = `project = ${config.jira.projectKey} AND status in (${statusList})`;

  const issueKeys = await searchIssueKeys(jql);
  console.log(`Found ${issueKeys.length} resolved ${config.jira.projectKey} issues.`);

  let inserted = 0;
  let skipped = 0;

  for (const issueKey of issueKeys) {
    try {
      const [data, comments] = await Promise.all([getIssuePredictionData(issueKey), getIssueComments(issueKey)]);
      const resolutionDays = resolutionDaysFor(data);
      if (resolutionDays === null) {
        console.warn(`Skipping ${issueKey}: no resolution date set.`);
        skipped++;
        continue;
      }

      const features = extractFeatures({ issueKey, data, commentCount: comments.length });
      await insertResolutionRecord({
        ...features,
        resolutionDays,
        source: "real",
        closedAt: data.resolutionDate,
      });
      inserted++;
      console.log(`Recorded ${issueKey}: ${resolutionDays} days.`);
    } catch (err) {
      console.warn(`Skipping ${issueKey}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  console.log(`Done. Inserted/updated ${inserted}, skipped ${skipped}.`);
}

main()
  .catch((err) => {
    console.error("backfillResolutionHistory failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

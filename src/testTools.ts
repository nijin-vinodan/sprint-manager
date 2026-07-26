/**
 * Throwaway script to sanity-check the Jira/GitHub tools against real data,
 * without spinning up the agent or calling a model. Not part of the CLI.
 *
 * Usage: npx tsx src/testTools.ts
 */
import { getActiveSprint, getSprintIssues, getIssueDetails } from "./tools/jira.js";
import { getOpenPullRequests, getRecentCommits } from "./tools/github.js";

function print(label: string, data: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const sprint = await getActiveSprint.invoke({});
  print("getActiveSprint", sprint);

  if ("active" in sprint && sprint.active) {
    const issues = await getSprintIssues.invoke({ sprintId: sprint.id });
    print("getSprintIssues", issues);

    if (issues.length > 0) {
      const details = await getIssueDetails.invoke({ issueKey: issues[0].key });
      print(`getIssueDetails (${issues[0].key})`, details);
    }
  }

  const prs = await getOpenPullRequests.invoke({});
  print("getOpenPullRequests", prs);

  const commits = await getRecentCommits.invoke({ days: 7 });
  print("getRecentCommits (last 7 days)", commits);
}

main().catch((err) => {
  console.error("Tool test failed:", err);
  process.exit(1);
});

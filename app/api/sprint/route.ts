import { getActiveSprint, getSprintIssues } from "../../../dist/tools/jira.js";
import { getOpenPullRequests, getRecentCommits } from "../../../dist/tools/github.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sprint = await getActiveSprint.invoke({});

  if (!sprint.active) {
    return Response.json({ active: false, message: sprint.message });
  }

  const [tickets, prs, commits] = await Promise.all([
    getSprintIssues.invoke({ sprintId: sprint.id }),
    getOpenPullRequests.invoke({}),
    getRecentCommits.invoke({ days: 7 }),
  ]);

  const ticketsWithLinks = tickets.map((ticket) => ({
    ...ticket,
    linkedPRs: prs.filter((pr) => pr.linkedIssueKey === ticket.key),
    linkedCommits: commits.filter((commit) => commit.linkedIssueKey === ticket.key),
  }));

  return Response.json({
    active: true,
    sprint,
    tickets: ticketsWithLinks,
    prs,
    commits,
  });
}

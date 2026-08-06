import type { IssuePredictionData } from "./commentEvaluator/jiraClient.js";
import { config } from "./config.js";

export interface IssuePredictionInput {
  issueKey: string;
  data: IssuePredictionData;
  commentCount: number;
}

export interface IssueFeatures {
  issueKey: string;
  issueType: string;
  priority: string;
  storyPoints: number | null;
  labels: string[];
  assignee: string | null;
  dependencyCount: number;
  commentCount: number;
  reopenCount: number;
}

// No dedicated Story Points field is configured on this Jira instance, so
// Original Estimate (time tracking) is used as the size proxy instead,
// converted from seconds to 8-hour workdays.
const SECONDS_PER_WORKDAY = 8 * 60 * 60;

function countReopens(statusHistory: IssuePredictionData["statusHistory"]): number {
  const doneStatuses = new Set<string>(config.jira.doneStatuses);
  return statusHistory.filter(
    (change) => change.fromStatus !== null && doneStatuses.has(change.fromStatus) && !doneStatuses.has(change.toStatus),
  ).length;
}

/** Converts a fetched Jira issue (core fields + changelog + comment count) into the feature vector used by both the backfill script and live prediction. */
export function extractFeatures(input: IssuePredictionInput): IssueFeatures {
  const { issueKey, data, commentCount } = input;
  return {
    issueKey,
    issueType: data.issueType,
    priority: data.priority,
    storyPoints: data.originalEstimateSeconds != null ? data.originalEstimateSeconds / SECONDS_PER_WORKDAY : null,
    labels: data.labels,
    assignee: data.assignee,
    dependencyCount: data.issueLinks.length,
    commentCount,
    reopenCount: countReopens(data.statusHistory),
  };
}

/**
 * Backfill-only: how long an issue took to complete, in 8-hour workdays of logged work
 * (same unit as the storyPoints proxy above). Null if the issue isn't actually resolved yet.
 * 0 if it was resolved but no worklog was ever added — this is an effort metric, not a
 * calendar one, so "no logged time" isn't a fallback case, it's a real answer.
 */
export function resolutionDaysFor(data: IssuePredictionData): number | null {
  if (!data.resolutionDate) return null;
  return (data.timeSpentSeconds ?? 0) / SECONDS_PER_WORKDAY;
}

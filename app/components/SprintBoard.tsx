"use client";

import { useCallback, useEffect, useState } from "react";

interface Ticket {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  priority: string;
  issueType: string;
  daysSinceUpdate: number;
  isOverdue: boolean;
  linkedPRs: PullRequest[];
  linkedCommits: { sha: string }[];
}

interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  daysSinceUpdate: number;
  isStale: boolean;
  reviewState: "approved" | "changes_requested" | "pending";
  linkedIssueKey: string | null;
}

interface SprintData {
  active: boolean;
  message?: string;
  sprint?: { name: string; goal: string | null; daysRemaining: number | null };
  tickets?: Ticket[];
  prs?: PullRequest[];
}

const REVIEW_BADGE: Record<PullRequest["reviewState"], string> = {
  approved: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  changes_requested: "bg-red-500/20 text-red-700 dark:text-red-300",
  pending: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
};

export function SprintBoard() {
  const [data, setData] = useState<SprintData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sprint");
      if (!res.ok) throw new Error(`Failed to load sprint data: ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sprint Board</h2>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-md bg-slate-200 px-3 py-1 text-sm hover:bg-slate-300 disabled:opacity-50 dark:bg-slate-800 dark:hover:bg-slate-700"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}

      {data && !data.active && (
        <div className="rounded-md bg-slate-100 p-4 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          {data.message}
        </div>
      )}

      {data?.active && data.sprint && (
        <div className="rounded-md bg-slate-100 p-4 dark:bg-slate-900">
          <div className="text-base font-medium">{data.sprint.name}</div>
          {data.sprint.goal && (
            <div className="text-sm text-slate-500 dark:text-slate-400">{data.sprint.goal}</div>
          )}
          {data.sprint.daysRemaining !== null && (
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-500">
              {data.sprint.daysRemaining} days remaining
            </div>
          )}
        </div>
      )}

      {data?.active && data.tickets && (
        <div className="overflow-x-auto rounded-md bg-slate-100 dark:bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead className="text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-2">Key</th>
                <th className="p-2">Summary</th>
                <th className="p-2">Status</th>
                <th className="p-2">Assignee</th>
              </tr>
            </thead>
            <tbody>
              {data.tickets.map((t) => (
                <tr key={t.key} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="p-2 font-mono text-xs">{t.key}</td>
                  <td className="p-2">{t.summary}</td>
                  <td className="p-2">
                    {t.status}
                    {t.isOverdue && (
                      <span className="ml-2 text-xs text-red-600 dark:text-red-400">overdue</span>
                    )}
                  </td>
                  <td className="p-2">{t.assignee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.active && data.prs && (
        <div className="rounded-md bg-slate-100 p-4 dark:bg-slate-900">
          <div className="mb-2 text-sm font-medium text-slate-600 dark:text-slate-300">
            Open Pull Requests
          </div>
          <ul className="flex flex-col gap-2">
            {data.prs.map((pr) => (
              <li key={pr.number} className="flex items-center justify-between text-sm">
                <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">
                  #{pr.number} {pr.title}
                </a>
                <div className="flex items-center gap-2">
                  {pr.linkedIssueKey && (
                    <span className="font-mono text-xs text-slate-500">{pr.linkedIssueKey}</span>
                  )}
                  {pr.isStale && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">stale</span>
                  )}
                  <span className={`rounded px-1.5 py-0.5 text-xs ${REVIEW_BADGE[pr.reviewState]}`}>
                    {pr.reviewState}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

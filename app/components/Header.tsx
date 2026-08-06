"use client";

import { useCallback, useEffect, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

interface SprintMeta {
  name: string;
  goal: string | null;
  daysRemaining: number | null;
}

export function Header() {
  const [sprint, setSprint] = useState<SprintMeta | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sprint");
      if (!res.ok) return;
      const data: { active: boolean; sprint?: SprintMeta } = await res.json();
      if (data.active && data.sprint) setSprint(data.sprint);
    } catch {
      // non-critical header decoration: no chips shown on transient failure
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <header className="flex w-full items-center justify-between bg-white px-6 py-3 shadow-[0_1px_3px_0_rgba(0,0,0,0.06)] dark:border-b dark:border-slate-800/60 dark:bg-slate-950">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">Sprint Manager</h1>
        {sprint && (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {sprint.name}
            </span>
            {sprint.goal && <span className="hidden max-w-xs truncate sm:inline">{sprint.goal}</span>}
            {sprint.daysRemaining !== null && (
              <span className="rounded-md bg-indigo-500/10 px-2 py-1 text-indigo-700 dark:text-indigo-300">
                {sprint.daysRemaining}d left
              </span>
            )}
          </div>
        )}
      </div>
      <ThemeToggle />
    </header>
  );
}

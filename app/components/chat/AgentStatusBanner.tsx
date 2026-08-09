import type { ActiveSubagent } from "./types";

interface AgentStatusBannerProps {
  activeSubagents: ActiveSubagent[];
}

export function AgentStatusBanner({ activeSubagents }: AgentStatusBannerProps) {
  if (activeSubagents.length === 0) return null;
  return (
    <>
      {activeSubagents.map((s) => (
        <div
          key={s.name}
          className="rounded-md bg-blue-500/10 px-3 py-1 text-xs text-blue-700 dark:text-blue-300"
        >
          Working: {s.name}…
        </div>
      ))}
    </>
  );
}

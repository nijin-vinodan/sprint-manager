interface ToolActivityLogProps {
  toolActivity: string[];
}

export function ToolActivityLog({ toolActivity }: ToolActivityLogProps) {
  if (toolActivity.length === 0) return null;
  return (
    <ul className="max-h-24 overflow-y-auto rounded-md bg-slate-200 p-2 font-mono text-xs text-slate-500 dark:bg-slate-950">
      {toolActivity.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

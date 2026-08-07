"use client";

export interface TabDef {
  id: string;
  label: string;
  content: React.ReactNode;
  showAlertDot?: boolean;
}

interface TabListProps {
  tabs: TabDef[];
  activeId: string;
  onChange: (id: string) => void;
}

export function TabList({ tabs, activeId, onChange }: TabListProps) {
  return (
    <div role="tablist" className="inline-flex self-start gap-1 rounded-full bg-slate-100 p-1 dark:bg-slate-900">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          onClick={() => onChange(t.id)}
          className={`relative cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-150 ${
            t.id === activeId
              ? "bg-white text-indigo-600 shadow-sm dark:bg-slate-700 dark:text-indigo-300"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          {t.label}
          {t.showAlertDot && (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-indigo-500 dark:bg-indigo-300" />
          )}
        </button>
      ))}
    </div>
  );
}

interface TabPanelProps {
  tabs: TabDef[];
  activeId: string;
}

export function TabPanel({ tabs, activeId }: TabPanelProps) {
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  return <div className="min-h-0 h-full overflow-y-auto">{active?.content}</div>;
}

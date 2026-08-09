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
          id={`tab-${t.id}`}
          aria-selected={t.id === activeId}
          aria-controls={`tabpanel-${t.id}`}
          onClick={() => onChange(t.id)}
          className={`relative cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-150 ${
            t.id === activeId
              ? "bg-white text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-300"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          {t.label}
          {t.showAlertDot && (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-blue-300" aria-hidden="true" />
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
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${active?.id}`}
      aria-labelledby={`tab-${active?.id}`}
      className="min-h-0 h-full overflow-y-auto"
    >
      {active?.content}
    </div>
  );
}

import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  return (
    <header className="flex w-full items-center justify-between border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-950">
      <h1 className="text-xl font-semibold">Sprint Manager</h1>
      <ThemeToggle />
    </header>
  );
}

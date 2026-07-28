"use client";

import { useEffect, useState } from "react";

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("theme", dark ? "dark" : "light");
}

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !isDark;
    setIsDark(next);
    applyTheme(next);
  };

  return (
    <button
      onClick={toggle}
      aria-label="Toggle light and dark theme"
      className="rounded-md bg-slate-200 px-2.5 py-1.5 text-base hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700"
    >
      {isDark ? "☀️" : "🌙"}
    </button>
  );
}

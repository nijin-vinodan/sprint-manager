"use client";

import { useEffect, useState } from "react";

// There's no theme context in this app (see ThemeToggle.tsx) — dark/light is
// just a `.dark` class on <html>. Components that need actual color *values*
// (not Tailwind `dark:` classes), like canvas/SVG-drawn graphics, need a live
// subscription to that class instead of a one-time read.
export function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));

    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => observer.disconnect();
  }, []);

  return isDark;
}

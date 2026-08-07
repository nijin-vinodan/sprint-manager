"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const COLLAPSED_KEY = "sprintmanager.sidebar.collapsed";
const WIDTH_KEY = "sprintmanager.sidebar.width";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 300;
const MAX_WIDTH = 640;
const COLLAPSED_STRIP_WIDTH = 44;

interface SidebarProps {
  children: (collapseButton: React.ReactNode) => React.ReactNode;
}

export function Sidebar({ children }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const draggingRef = useRef(false);

  useEffect(() => {
    const storedCollapsed = localStorage.getItem(COLLAPSED_KEY);
    const storedWidth = localStorage.getItem(WIDTH_KEY);
    if (storedCollapsed === "true") setCollapsed(true);
    if (storedWidth) {
      const n = Number(storedWidth);
      if (!Number.isNaN(n)) setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n)));
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startWidth = width;

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startX - ev.clientX;
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
        setWidth(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setWidth((w) => {
          localStorage.setItem(WIDTH_KEY, String(w));
          return w;
        });
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width],
  );

  if (collapsed) {
    return (
      <div
        style={{ width: COLLAPSED_STRIP_WIDTH }}
        className="my-6 flex h-[calc(100%-3rem)] flex-col items-center gap-2 bg-slate-50 py-3 shadow-[-8px_0_24px_-12px_rgba(15,23,42,0.15)] dark:border-l dark:border-slate-800/60 dark:bg-slate-900"
      >
        <button
          onClick={toggleCollapsed}
          aria-label="Expand chat panel"
          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>
    );
  }

  const collapseButton = (
    <button
      onClick={toggleCollapsed}
      aria-label="Collapse chat panel"
      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );

  return (
    <div className="relative flex" style={{ width }}>
      <div
        onMouseDown={onDragStart}
        className="absolute -left-1 top-0 h-full w-2 cursor-col-resize"
        role="separator"
        aria-orientation="vertical"
      />
      <div className="flex h-full min-h-0 w-full flex-col shadow-[-8px_0_24px_-12px_rgba(15,23,42,0.15)] dark:border-l dark:border-slate-800/60 dark:pl-3">
        <div className="min-h-0 flex-1">{children(collapseButton)}</div>
      </div>
    </div>
  );
}

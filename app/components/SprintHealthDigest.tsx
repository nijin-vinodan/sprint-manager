"use client";

import { useCallback, useEffect, useState } from "react";
import { Markdown } from "./Markdown";

interface DigestState {
  status: "pending" | "ok" | "error";
  generatedAt?: string;
  text?: string;
  error?: string;
}

const POLL_INTERVAL_MS = 60_000;

export function SprintHealthDigest() {
  const [digest, setDigest] = useState<DigestState | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/digest");
      if (!res.ok) return;
      setDigest(await res.json());
    } catch {
      // keep showing the last known digest on a transient fetch failure
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sprint Health Digest</h2>
        {digest?.generatedAt && (
          <span className="text-xs text-slate-500">
            Updated {new Date(digest.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="rounded-md bg-slate-100 p-4 dark:bg-slate-900">
        {!digest || digest.status === "pending" ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Generating first digest…
          </div>
        ) : digest.status === "error" ? (
          <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            {digest.error}
          </div>
        ) : (
          <div className="text-sm">
            <Markdown text={digest.text ?? ""} />
          </div>
        )}
      </div>
    </div>
  );
}

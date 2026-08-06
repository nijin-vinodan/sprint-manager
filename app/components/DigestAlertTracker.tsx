"use client";

import { useCallback, useEffect } from "react";

const LAST_VIEWED_KEY = "sprintmanager.digest.lastViewedAt";
const POLL_INTERVAL_MS = 60_000;

interface DigestAlertTrackerProps {
  onHasNewDigestChange: (hasNew: boolean) => void;
}

export function DigestAlertTracker({ onHasNewDigestChange }: DigestAlertTrackerProps) {
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/digest");
      if (!res.ok) return;
      const data: { status: string; generatedAt?: string } = await res.json();
      if (data.status !== "ok" || !data.generatedAt) return;
      const lastViewed = localStorage.getItem(LAST_VIEWED_KEY);
      const hasNew = !lastViewed || new Date(data.generatedAt) > new Date(lastViewed);
      onHasNewDigestChange(hasNew);
    } catch {
      // transient failure: keep last known alert state, same philosophy as SprintHealthDigest
    }
  }, [onHasNewDigestChange]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return null;
}

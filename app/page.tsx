"use client";

import { useCallback, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SprintBoard } from "./components/SprintBoard";
import { SprintHealthDigest } from "./components/SprintHealthDigest";
import { ResolutionPredictor } from "./components/ResolutionPredictor";
import { Sidebar } from "./components/Sidebar";
import { Tabs, type TabDef } from "./components/Tabs";
import { DigestAlertTracker } from "./components/DigestAlertTracker";

const LAST_VIEWED_KEY = "sprintmanager.digest.lastViewedAt";

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState("board");
  const [hasNewDigest, setHasNewDigest] = useState(false);

  const handleTabChange = useCallback((id: string) => {
    setActiveTab(id);
    if (id === "digest") {
      localStorage.setItem(LAST_VIEWED_KEY, new Date().toISOString());
      setHasNewDigest(false);
    }
  }, []);

  const tabs: TabDef[] = [
    { id: "board", label: "Board", content: <SprintBoard /> },
    { id: "digest", label: "Digest", content: <SprintHealthDigest />, showAlertDot: hasNewDigest },
    { id: "predict", label: "Predict", content: <ResolutionPredictor /> },
  ];

  return (
    <main className="mx-auto flex h-full w-[95%] gap-4 p-6">
      <DigestAlertTracker onHasNewDigestChange={setHasNewDigest} />
      <div className="min-h-0 flex-1">
        <Tabs tabs={tabs} activeId={activeTab} onChange={handleTabChange} />
      </div>
      <Sidebar>
        <ChatPanel />
      </Sidebar>
    </main>
  );
}

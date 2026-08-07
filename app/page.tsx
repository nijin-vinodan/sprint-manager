"use client";

import { useCallback, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SprintBoard } from "./components/SprintBoard";
import { SprintHealthDigest } from "./components/SprintHealthDigest";
import { ResolutionPredictor } from "./components/ResolutionPredictor";
import { Sidebar } from "./components/Sidebar";
import { TabList, TabPanel, type TabDef } from "./components/Tabs";
import { DigestAlertTracker } from "./components/DigestAlertTracker";
import { Header } from "./components/Header";

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
    <div className="flex h-full w-full flex-col">
      <Header>
        <TabList tabs={tabs} activeId={activeTab} onChange={handleTabChange} />
      </Header>
      <main className="flex min-h-0 flex-1 w-full gap-4">
        <DigestAlertTracker onHasNewDigestChange={setHasNewDigest} />
        <div className="min-h-0 flex-1 py-6 pl-6">
          <TabPanel tabs={tabs} activeId={activeTab} />
        </div>
        <Sidebar>{(collapseButton) => <ChatPanel collapseButton={collapseButton} />}</Sidebar>
      </main>
    </div>
  );
}

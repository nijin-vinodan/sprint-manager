import { ChatPanel } from "./components/ChatPanel";
import { SprintBoard } from "./components/SprintBoard";
import { SprintHealthDigest } from "./components/SprintHealthDigest";

export default function DashboardPage() {
  return (
    <main className="mx-auto grid h-full w-[95%] grid-cols-1 gap-6 p-6 lg:grid-cols-3">
      <div className="min-h-0 overflow-y-auto">
        <SprintBoard />
      </div>
      <div className="min-h-0 overflow-y-auto">
        <SprintHealthDigest />
      </div>
      <div className="min-h-0">
        <ChatPanel />
      </div>
    </main>
  );
}

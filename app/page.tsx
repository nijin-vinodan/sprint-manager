import { ChatPanel } from "./components/ChatPanel";
import { SprintBoard } from "./components/SprintBoard";
import { SprintHealthDigest } from "./components/SprintHealthDigest";

export default function DashboardPage() {
  return (
    <main className="mx-auto grid h-screen max-w-7xl grid-cols-1 gap-6 p-6 lg:grid-cols-2">
      <div className="flex flex-col gap-6 overflow-y-auto">
        <SprintHealthDigest />
        <SprintBoard />
      </div>
      <div className="min-h-0">
        <ChatPanel />
      </div>
    </main>
  );
}

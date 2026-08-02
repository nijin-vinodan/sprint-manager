import { agentServerFetch } from "../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin proxy to the standalone agent server's GET /sprint — same pattern as
// chat/route.ts and chat/history/route.ts.
export async function GET() {
  const upstream = await agentServerFetch("/sprint");
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

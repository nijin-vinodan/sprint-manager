import { NextRequest } from "next/server";
import { agentServerFetch } from "../../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin proxy to the standalone agent server's GET /threads/:threadId/history —
// same pattern as ../route.ts, kept in a separate file since this is a GET/JSON
// handler, not a POST/SSE one.
export async function GET(req: NextRequest) {
  const threadId = req.nextUrl.searchParams.get("threadId");
  if (!threadId) {
    return new Response(JSON.stringify({ error: '"threadId" query param is required' }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const upstream = await agentServerFetch(`/threads/${encodeURIComponent(threadId)}/history`, {
    signal: req.signal,
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

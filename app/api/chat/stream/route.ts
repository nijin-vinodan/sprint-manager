import { NextRequest } from "next/server";
import { agentServerFetch } from "../../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin proxy to the standalone agent server's GET /threads/:threadId/stream —
// used on ChatPanel mount to resume a token-level replay of an in-flight run
// after a page refresh. A 204 means no active run for this thread; the client
// falls back to its existing /api/chat/history fetch in that case.
export async function GET(req: NextRequest) {
  const threadId = req.nextUrl.searchParams.get("threadId");
  if (!threadId) {
    return new Response(JSON.stringify({ error: '"threadId" query param is required' }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const upstream = await agentServerFetch(`/threads/${encodeURIComponent(threadId)}/stream`, {
    signal: req.signal,
  });

  if (upstream.status === 204) {
    return new Response(null, { status: 204 });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(JSON.stringify({ error: text || `Agent server responded ${upstream.status}` }), {
      status: upstream.status || 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

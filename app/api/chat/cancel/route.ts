import { NextRequest } from "next/server";
import { agentServerFetch } from "../../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CancelRequestBody {
  threadId: string;
}

// Thin proxy to the standalone agent server's POST /threads/:threadId/cancel.
// Needed because removing the abort-on-disconnect wiring in /invoke/stream
// (so a run survives a page refresh for resume) means the Stop button can no
// longer cancel a run just by aborting its own fetch — it must ask the
// server explicitly.
export async function POST(req: NextRequest) {
  let body: CancelRequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (typeof body?.threadId !== "string" || body.threadId.length === 0) {
    return new Response('"threadId" must be a non-empty string', { status: 400 });
  }

  const upstream = await agentServerFetch(`/threads/${encodeURIComponent(body.threadId)}/cancel`, {
    method: "POST",
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

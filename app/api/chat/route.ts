import { NextRequest } from "next/server";
import { agentServerFetch } from "../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  threadId: string;
  message: string;
}

// Thin proxy to the standalone agent server (src/server/) — this route holds no
// agent logic itself. It exists only to keep the calling app's API key out of
// the browser: the browser talks to this same-origin route with no secret,
// and this route attaches the real x-api-key server-side before forwarding.
export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (typeof body?.threadId !== "string" || body.threadId.length === 0) {
    return new Response('"threadId" must be a non-empty string', { status: 400 });
  }
  if (typeof body?.message !== "string" || body.message.length === 0) {
    return new Response('"message" must be a non-empty string', { status: 400 });
  }

  const upstream = await agentServerFetch("/invoke/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: body.threadId, prompt: body.message }),
    signal: req.signal,
  });

  // The agent server's concurrency guard rejects a second run for the same
  // thread outright — pass its 409 straight through rather than retrying or
  // queueing on the caller's behalf.
  if (upstream.status === 409) {
    return new Response(upstream.body, {
      status: 409,
      headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
    });
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

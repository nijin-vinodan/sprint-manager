import { NextRequest } from "next/server";
import { agentServerFetch } from "../../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin proxy to the standalone agent server's GET /threads — same pattern as ../history/route.ts.
export async function GET(req: NextRequest) {
  const limit = req.nextUrl.searchParams.get("limit") ?? "20";
  const offset = req.nextUrl.searchParams.get("offset") ?? "0";

  const upstream = await agentServerFetch(
    `/threads?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
    { signal: req.signal },
  );

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

import { agentServerFetch } from "../../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin proxy to the standalone agent server's GET /internal/collect-resolution-history/status —
// same pattern as app/api/predict/route.ts.
export async function GET() {
  const upstream = await agentServerFetch("/internal/collect-resolution-history/status");
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

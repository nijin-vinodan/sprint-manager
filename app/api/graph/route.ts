import { agentServerFetch } from "../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin proxy to the standalone agent server's GET /graph, forwarding the
// `refresh` query param through — same pattern as app/api/sprint/route.ts.
export async function GET(request: Request) {
  const { search } = new URL(request.url);
  const upstream = await agentServerFetch(`/graph${search}`);
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

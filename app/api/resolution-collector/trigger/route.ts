import { agentServerFetch } from "../../_lib/agentServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual trigger for the resolution-history collector, proxying to the
// standalone agent server's POST /internal/collect-resolution-history — the
// same route the background scheduler (app/api/digest/_resolutionCollector.ts)
// calls on an interval. Uses a generous lookback since a manual trigger should
// catch anything missed, not just what the short interval-based lookback covers.
export async function POST() {
  const upstream = await agentServerFetch("/internal/collect-resolution-history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lookbackHours: 24 }),
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

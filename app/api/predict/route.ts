import { agentServerFetch } from "../_lib/agentServer";
import { ensureResolutionCollectorScheduler } from "../digest/_resolutionCollector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin proxy to the standalone agent server's GET /predict/:issueKey — same
// pattern as app/api/sprint/route.ts and app/api/graph/route.ts.
export async function GET(request: Request) {
  // Idempotent (guarded by globalThis in _resolutionCollector.ts) — ensures the
  // background collector runs even if the Digest tab (its other starting point)
  // is never opened.
  ensureResolutionCollectorScheduler();

  const { searchParams } = new URL(request.url);
  const issueKey = searchParams.get("issueKey");
  if (!issueKey) {
    return new Response(JSON.stringify({ error: '"issueKey" query param is required' }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const forwarded = new URLSearchParams();
  const k = searchParams.get("k");
  const pool = searchParams.get("pool");
  if (k) forwarded.set("k", k);
  if (pool) forwarded.set("pool", pool);
  const qs = forwarded.toString();

  const upstream = await agentServerFetch(`/predict/${encodeURIComponent(issueKey)}${qs ? `?${qs}` : ""}`);
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

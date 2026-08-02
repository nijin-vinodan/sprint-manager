function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shared by every Next.js route that proxies to the standalone agent server
// (chat/route.ts, chat/history/route.ts, digest/_scheduler.ts): looks up
// AGENT_SERVER_URL/AGENT_SERVER_API_KEY, attaches x-api-key, and normalizes
// env/network failures into a Response so callers don't each re-implement it.
// Callers still own status-code/body handling for the success path, since
// that differs per caller (streaming passthrough, JSON passthrough, etc).
export async function agentServerFetch(path: string, init?: RequestInit): Promise<Response> {
  let url: string;
  let apiKey: string;
  try {
    url = requireEnv("AGENT_SERVER_URL");
    apiKey = requireEnv("AGENT_SERVER_API_KEY");
  } catch (err) {
    return jsonError(500, err instanceof Error ? err.message : String(err));
  }

  try {
    return await fetch(new URL(path, url), {
      ...init,
      headers: { ...init?.headers, "x-api-key": apiKey },
    });
  } catch (err) {
    return jsonError(502, `Could not reach agent server: ${err instanceof Error ? err.message : String(err)}`);
  }
}

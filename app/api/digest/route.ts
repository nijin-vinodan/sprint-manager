import { ensureDigestScheduler, getLatestDigest } from "./_scheduler";
import { ensureResolutionCollectorScheduler } from "./_resolutionCollector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureDigestScheduler();
  ensureResolutionCollectorScheduler();

  const digest = getLatestDigest();
  if (!digest) {
    return Response.json({ status: "pending" });
  }

  return Response.json({
    status: digest.error ? "error" : "ok",
    generatedAt: digest.generatedAt,
    text: digest.text,
    error: digest.error,
  });
}

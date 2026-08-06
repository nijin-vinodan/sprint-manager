import type { Neighbor } from "./knn.js";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceResult {
  level: ConfidenceLevel;
  closestDistance: number | null;
}

const LEVELS: [threshold: number, level: ConfidenceLevel][] = [
  [0.5, "high"],
  [1.5, "medium"],
];

function downgrade(level: ConfidenceLevel): ConfidenceLevel {
  if (level === "high") return "medium";
  return "low";
}

/**
 * Confidence reflects how close the nearest REAL neighbor actually is — a
 * synthetic-only match, or a distant real one, should never present as a
 * bare confident number.
 */
export function scoreConfidence(neighbors: Neighbor[], kRequested: number): ConfidenceResult {
  const closestReal = neighbors.filter((n) => n.source === "real").sort((a, b) => a.distance - b.distance)[0];

  if (!closestReal) {
    return { level: "low", closestDistance: neighbors[0]?.distance ?? null };
  }

  let level: ConfidenceLevel = "low";
  for (const [threshold, candidateLevel] of LEVELS) {
    if (closestReal.distance <= threshold) {
      level = candidateLevel;
      break;
    }
  }

  if (neighbors.length < kRequested) {
    level = downgrade(level);
  }

  return { level, closestDistance: closestReal.distance };
}

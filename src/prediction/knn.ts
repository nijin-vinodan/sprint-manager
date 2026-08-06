import type { IssueFeatures } from "./featureExtraction.js";
import type { ResolutionRecord } from "../server/resolutionHistory.js";

export interface Neighbor {
  issueKey: string;
  resolutionDays: number;
  distance: number;
  source: "real" | "synthetic";
}

export interface PredictionResult {
  predictedDays: number | null;
  neighbors: Neighbor[];
  // Every real+synthetic candidate, scored and sorted (same tie-break as
  // `neighbors`), before the top-k slice — added for callers that need to
  // visualize/explain the full candidate pool (e.g. a nearest-neighbor
  // scatter), not just the ones actually averaged.
  rankedCandidates: Neighbor[];
  usedFallbackToSynthetic: boolean;
}

// Small edge subtracted from a real neighbor's distance when ranking a
// combined real+synthetic pool, so a real row wins ties against an
// equally-distant synthetic one.
const REAL_SOURCE_BONUS = 0.1;
const EPSILON = 0.01;

function numericRange(values: number[]): number {
  if (values.length === 0) return 1;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max - min || 1;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// A null numeric feature is substituted with the candidate pool's mean
// rather than 0, so a missing value doesn't look like a spuriously perfect
// match against another missing value.
function resolveNullableNumeric(value: number | null, poolValues: number[]): number {
  return value ?? mean(poolValues);
}

function jaccardMismatch(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = [...setA].filter((label) => setB.has(label)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : 1 - intersection / union;
}

function buildDistanceFn(pool: ResolutionRecord[]): (target: IssueFeatures, candidate: ResolutionRecord) => number {
  const storyPointsPool = pool.map((r) => r.storyPoints).filter((v): v is number => v != null);
  const dependencyPool = pool.map((r) => r.dependencyCount);
  const commentPool = pool.map((r) => r.commentCount);
  const reopenPool = pool.map((r) => r.reopenCount);

  const storyPointsRange = numericRange(storyPointsPool);
  const dependencyRange = numericRange(dependencyPool);
  const commentRange = numericRange(commentPool);
  const reopenRange = numericRange(reopenPool);

  return function distance(target: IssueFeatures, candidate: ResolutionRecord): number {
    const targetStoryPoints = resolveNullableNumeric(target.storyPoints, storyPointsPool);
    const candidateStoryPoints = resolveNullableNumeric(candidate.storyPoints, storyPointsPool);

    const numeric =
      Math.abs(targetStoryPoints - candidateStoryPoints) / storyPointsRange +
      Math.abs(target.dependencyCount - candidate.dependencyCount) / dependencyRange +
      Math.abs(target.commentCount - candidate.commentCount) / commentRange +
      Math.abs(target.reopenCount - candidate.reopenCount) / reopenRange;

    const categorical =
      (target.issueType !== candidate.issueType ? 1 : 0) +
      (target.priority !== candidate.priority ? 1 : 0) +
      jaccardMismatch(target.labels, candidate.labels) +
      (target.assignee !== candidate.assignee ? 0.5 : 0);

    return numeric + categorical;
  };
}

function toNeighbor(candidate: ResolutionRecord, distance: number): Neighbor {
  return { issueKey: candidate.issueKey, resolutionDays: candidate.resolutionDays, distance, source: candidate.source };
}

function weightedAverage(neighbors: Neighbor[]): number {
  const weights = neighbors.map((n) => 1 / (n.distance + EPSILON));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const weightedSum = neighbors.reduce((sum, n, i) => sum + weights[i] * n.resolutionDays, 0);
  return weightedSum / totalWeight;
}

/**
 * Hand-rolled k-NN: prefers real neighbors, only falling back to a
 * real+synthetic combined pool when no real row is within
 * realDistanceThreshold. Deliberately dependency-light and readable so it's
 * easy to reason about — and easy to swap out later for a different backend
 * without changing this function's input/output contract.
 */
export function predictResolutionDays(
  target: IssueFeatures,
  history: { real: ResolutionRecord[]; synthetic: ResolutionRecord[] },
  k = 3,
  realDistanceThreshold = 1.5,
): PredictionResult {
  const distance = buildDistanceFn([...history.real, ...history.synthetic]);

  // Every candidate is scored regardless of which branch below ends up
  // being used, so `rankedCandidates` is always the complete real+synthetic
  // pool — not just whichever subset the fallback logic happened to touch.
  const realNeighbors = history.real
    .map((candidate) => toNeighbor(candidate, distance(target, candidate)))
    .sort((a, b) => a.distance - b.distance);
  const syntheticNeighbors = history.synthetic.map((candidate) => toNeighbor(candidate, distance(target, candidate)));

  const rankScore = (n: Neighbor) => (n.source === "real" ? n.distance - REAL_SOURCE_BONUS : n.distance);
  const rankedCandidates = [...realNeighbors, ...syntheticNeighbors].sort((a, b) => rankScore(a) - rankScore(b));

  const hasCloseReal = realNeighbors.some((n) => n.distance <= realDistanceThreshold);

  let neighbors: Neighbor[];
  let usedFallbackToSynthetic: boolean;

  if (hasCloseReal || history.synthetic.length === 0) {
    neighbors = realNeighbors.slice(0, k);
    usedFallbackToSynthetic = false;
  } else {
    neighbors = rankedCandidates.slice(0, k);
    usedFallbackToSynthetic = true;
  }

  return {
    predictedDays: neighbors.length > 0 ? weightedAverage(neighbors) : null,
    neighbors,
    rankedCandidates,
    usedFallbackToSynthetic,
  };
}

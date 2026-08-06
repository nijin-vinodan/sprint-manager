import { describe, expect, it } from "vitest";
import { predictResolutionDays } from "../src/knn.js";
import type { IssueFeatures } from "../src/featureExtraction.js";
import type { ResolutionRecord } from "../src/server/resolutionHistory.js";

function target(overrides: Partial<IssueFeatures> = {}): IssueFeatures {
  return {
    issueKey: "SMA-100",
    issueType: "Bug",
    priority: "High",
    storyPoints: 3,
    labels: ["backend"],
    assignee: "Jane Doe",
    dependencyCount: 1,
    commentCount: 2,
    reopenCount: 0,
    ...overrides,
  };
}

function record(overrides: Partial<ResolutionRecord> = {}): ResolutionRecord {
  return {
    issueKey: "SMA-1",
    issueType: "Bug",
    priority: "High",
    storyPoints: 3,
    labels: ["backend"],
    assignee: "Jane Doe",
    dependencyCount: 1,
    commentCount: 2,
    reopenCount: 0,
    resolutionDays: 2,
    source: "real",
    closedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("predictResolutionDays", () => {
  it("uses only real neighbors when a close real match exists, even with synthetic candidates present", () => {
    const real = [record({ issueKey: "SMA-1", resolutionDays: 2 }), record({ issueKey: "SMA-2", resolutionDays: 4 })];
    const synthetic = [record({ issueKey: "SYN-1", source: "synthetic", resolutionDays: 99, issueType: "Task", priority: "Low", labels: [] })];

    const result = predictResolutionDays(target(), { real, synthetic }, 3, 1.5);

    expect(result.usedFallbackToSynthetic).toBe(false);
    expect(result.neighbors.every((n) => n.source === "real")).toBe(true);
    expect(result.predictedDays).not.toBeNull();
  });

  it("still scores synthetic candidates into rankedCandidates even when the real branch is used", () => {
    const real = [record({ issueKey: "SMA-1", resolutionDays: 2 })];
    const synthetic = [record({ issueKey: "SYN-1", source: "synthetic", resolutionDays: 99 })];

    const result = predictResolutionDays(target(), { real, synthetic }, 3, 1.5);

    expect(result.rankedCandidates).toHaveLength(2);
    expect(result.rankedCandidates.map((n) => n.issueKey).sort()).toEqual(["SMA-1", "SYN-1"]);
  });

  it("falls back to the combined pool when no real candidate is within the distance threshold", () => {
    const real = [
      record({ issueKey: "SMA-1", resolutionDays: 2, issueType: "Task", priority: "Low", storyPoints: 13, labels: ["frontend"], dependencyCount: 4, reopenCount: 3 }),
    ];
    const synthetic = [record({ issueKey: "SYN-1", source: "synthetic", resolutionDays: 5 })];

    const result = predictResolutionDays(target(), { real, synthetic }, 3, 0.01);

    expect(result.usedFallbackToSynthetic).toBe(true);
    expect(result.neighbors.some((n) => n.source === "synthetic")).toBe(true);
  });

  it("never falls back when there are no synthetic candidates at all", () => {
    const real = [
      record({ issueKey: "SMA-1", resolutionDays: 2, issueType: "Task", priority: "Low", storyPoints: 13, labels: ["frontend"], dependencyCount: 4, reopenCount: 3 }),
    ];

    const result = predictResolutionDays(target(), { real, synthetic: [] }, 3, 0.01);

    expect(result.usedFallbackToSynthetic).toBe(false);
    expect(result.rankedCandidates).toHaveLength(1);
  });

  it("rankedCandidates is sorted ascending by the same tie-broken score as neighbors", () => {
    const real = [record({ issueKey: "SMA-1", resolutionDays: 2 }), record({ issueKey: "SMA-2", resolutionDays: 4, dependencyCount: 3 })];
    const synthetic = [record({ issueKey: "SYN-1", source: "synthetic", resolutionDays: 5, dependencyCount: 2 })];

    const result = predictResolutionDays(target(), { real, synthetic }, 3, 1.5);

    const distances = result.rankedCandidates.map((n) => n.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("returns null predictedDays and empty lists when there is no history at all", () => {
    const result = predictResolutionDays(target(), { real: [], synthetic: [] }, 3, 1.5);

    expect(result.predictedDays).toBeNull();
    expect(result.neighbors).toEqual([]);
    expect(result.rankedCandidates).toEqual([]);
    expect(result.usedFallbackToSynthetic).toBe(false);
  });
});

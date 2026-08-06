import "dotenv/config";
import { deleteSyntheticResolutionHistory, insertResolutionRecord } from "../src/server/resolutionHistory.js";
import { pool } from "../src/server/db.js";

/**
 * Generates ~200 synthetic issue_resolution_history rows (source='synthetic')
 * from a known ground-truth formula + noise, so the k-NN module's mechanics
 * (distance weighting, real/synthetic fallback, confidence scoring) can be
 * validated against a formula we understand rather than opaque real data.
 *
 * Formula (base_days before noise):
 *   base = 1
 *        + story_points * 0.6
 *        + priority_weight        (Critical=3, High=1.5, Medium=0.5, Low=0)
 *        + issue_type_weight      (Bug=-0.5, Spike=1, Story=0, Task=0)
 *        + dependency_count * 0.8
 *        + reopen_count * 1.2
 *   resolution_days = base * noiseFactor, noiseFactor ~ Normal(1, 0.125) (±2σ ≈ ±25%)
 *
 * ~7% of rows ignore the formula entirely and get a random outlier value instead.
 *
 * Usage:
 *   npx tsx scripts/generateSyntheticResolutionHistory.ts --dry-run   // print distribution summary only, no DB writes
 *   npx tsx scripts/generateSyntheticResolutionHistory.ts             // wipe existing synthetic rows and insert a fresh batch
 */

const TOTAL_ROWS = 200;
const OUTLIER_RATE = 0.07;
const MIN_ROWS_PER_COMBO = 5;

const PRIORITIES = ["Critical", "High", "Medium", "Low"];
const ISSUE_TYPES = ["Bug", "Task"];

const PRIORITY_WEIGHTS: Record<string, number> = { Critical: 3, High: 1.5, Medium: 0.5, Low: 0 };
const ISSUE_TYPE_WEIGHTS: Record<string, number> = { Bug: -0.5, Task: 0 };

const PRIORITY_DIST: Array<[string, number]> = [
  ["Critical", 0.1],
  ["High", 0.25],
  ["Medium", 0.5],
  ["Low", 0.15],
];
const ISSUE_TYPE_DIST: Array<[string, number]> = [
  ["Bug", 0.55],
  ["Task", 0.45],
];
const STORY_POINTS_DIST: Array<[number, number]> = [
  [1, 0.2],
  [2, 0.25],
  [3, 0.25],
  [5, 0.2],
  [8, 0.07],
  [13, 0.03],
];
const DEPENDENCY_COUNT_DIST: Array<[number, number]> = [
  [0, 0.5],
  [1, 0.25],
  [2, 0.15],
  [3, 0.07],
  [4, 0.03],
];
const REOPEN_COUNT_DIST: Array<[number, number]> = [
  [0, 0.75],
  [1, 0.15],
  [2, 0.07],
  [3, 0.03],
];

function weightedChoice<T>(options: Array<[T, number]>): T {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [value, weight] of options) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return options[options.length - 1][0];
}

function gaussianNoise(): number {
  // Box-Muller transform, standard normal.
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

interface SyntheticFeatures {
  issueType: string;
  priority: string;
  storyPoints: number;
  dependencyCount: number;
  reopenCount: number;
}

interface SyntheticRow extends SyntheticFeatures {
  issueKey: string;
  resolutionDays: number;
  isOutlier: boolean;
}

function randomFeatures(overrides: Partial<SyntheticFeatures> = {}): SyntheticFeatures {
  return {
    issueType: overrides.issueType ?? weightedChoice(ISSUE_TYPE_DIST),
    priority: overrides.priority ?? weightedChoice(PRIORITY_DIST),
    storyPoints: overrides.storyPoints ?? weightedChoice(STORY_POINTS_DIST),
    dependencyCount: overrides.dependencyCount ?? weightedChoice(DEPENDENCY_COUNT_DIST),
    reopenCount: overrides.reopenCount ?? weightedChoice(REOPEN_COUNT_DIST),
  };
}

function baseDays(features: SyntheticFeatures): number {
  return (
    1 +
    features.storyPoints * 0.6 +
    PRIORITY_WEIGHTS[features.priority] +
    ISSUE_TYPE_WEIGHTS[features.issueType] +
    features.dependencyCount * 0.8 +
    features.reopenCount * 1.2
  );
}

function resolutionDaysFor(features: SyntheticFeatures): { resolutionDays: number; isOutlier: boolean } {
  if (Math.random() < OUTLIER_RATE) {
    return { resolutionDays: Number(randomBetween(0.5, 45).toFixed(2)), isOutlier: true };
  }
  const noiseFactor = Math.max(0.5, Math.min(1.5, 1 + gaussianNoise() * 0.125));
  const days = Math.max(0.1, baseDays(features) * noiseFactor);
  return { resolutionDays: Number(days.toFixed(2)), isOutlier: false };
}

function generateRows(): SyntheticRow[] {
  const featureRows: SyntheticFeatures[] = [];

  // Guarantee coverage: at least MIN_ROWS_PER_COMBO rows per issueType x priority combo.
  for (const issueType of ISSUE_TYPES) {
    for (const priority of PRIORITIES) {
      for (let i = 0; i < MIN_ROWS_PER_COMBO; i++) {
        featureRows.push(randomFeatures({ issueType, priority }));
      }
    }
  }

  // Fill the rest via weighted distributions.
  while (featureRows.length < TOTAL_ROWS) {
    featureRows.push(randomFeatures());
  }

  return featureRows.map((features, index) => {
    const { resolutionDays, isOutlier } = resolutionDaysFor(features);
    return {
      ...features,
      issueKey: `SYN-${String(index + 1).padStart(4, "0")}`,
      resolutionDays,
      isOutlier,
    };
  });
}

function printSummary(rows: SyntheticRow[]) {
  console.log(`Generated ${rows.length} synthetic rows.\n`);

  console.log("Rows per issue_type x priority combo:");
  for (const issueType of ISSUE_TYPES) {
    const line = PRIORITIES.map((priority) => {
      const count = rows.filter((r) => r.issueType === issueType && r.priority === priority).length;
      return `${priority}=${count}`;
    }).join("  ");
    console.log(`  ${issueType.padEnd(6)} ${line}`);
  }

  const outlierCount = rows.filter((r) => r.isOutlier).length;
  const resolutionDays = rows.map((r) => r.resolutionDays);
  const mean = resolutionDays.reduce((sum, d) => sum + d, 0) / resolutionDays.length;
  const variance = resolutionDays.reduce((sum, d) => sum + (d - mean) ** 2, 0) / resolutionDays.length;
  const stddev = Math.sqrt(variance);

  console.log(`\nOutliers: ${outlierCount} (${((outlierCount / rows.length) * 100).toFixed(1)}%)`);
  console.log(`resolution_days: mean=${mean.toFixed(2)}, stddev=${stddev.toFixed(2)}, min=${Math.min(...resolutionDays).toFixed(2)}, max=${Math.max(...resolutionDays).toFixed(2)}`);

  console.log("\nSample rows:");
  for (const row of rows.slice(0, 5)) {
    console.log(`  ${row.issueKey}: ${JSON.stringify(row)}`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rows = generateRows();
  printSummary(rows);

  if (dryRun) {
    console.log("\n--dry-run: no DB writes performed.");
    return;
  }

  const deleted = await deleteSyntheticResolutionHistory();
  console.log(`\nDeleted ${deleted} existing synthetic rows.`);

  for (const row of rows) {
    await insertResolutionRecord({
      issueKey: row.issueKey,
      issueType: row.issueType,
      priority: row.priority,
      storyPoints: row.storyPoints,
      labels: [],
      assignee: null,
      dependencyCount: row.dependencyCount,
      commentCount: 0,
      reopenCount: row.reopenCount,
      resolutionDays: row.resolutionDays,
      source: "synthetic",
      closedAt: null,
    });
  }

  console.log(`Inserted ${rows.length} synthetic rows.`);
}

main()
  .catch((err) => {
    console.error("generateSyntheticResolutionHistory failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());

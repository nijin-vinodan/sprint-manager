// Hand-rolled fuzzy matching — no dependency, ticket keys/summaries are short
// strings and sprint sizes are small, so a substring-first, Levenshtein-
// fallback scorer is enough.

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Lower is better. Returns null if target doesn't match query at all.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (q.length === 0) return null;

  const index = t.indexOf(q);
  if (index !== -1) {
    // Earlier matches and tighter length ratios score better.
    return index + t.length / (q.length + 1);
  }

  const distance = levenshtein(q, t);
  const threshold = Math.max(2, Math.ceil(q.length * 0.4));
  return distance <= threshold ? 100 + distance : null;
}

export function fuzzySearch<T>(query: string, items: T[], getText: (item: T) => string[], limit = 8): T[] {
  if (query.trim().length === 0) return [];

  return items
    .map((item) => {
      const best = getText(item)
        .map((text) => fuzzyScore(query, text))
        .filter((score): score is number => score !== null)
        .sort((a, b) => a - b)[0];
      return { item, score: best };
    })
    .filter((entry): entry is { item: T; score: number } => entry.score !== undefined)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

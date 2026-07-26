export function daysBetween(from: Date, to: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((to.getTime() - from.getTime()) / msPerDay);
}

export function daysSince(dateStr: string, now: Date = new Date()): number {
  return daysBetween(new Date(dateStr), now);
}

export function daysUntil(dateStr: string, now: Date = new Date()): number {
  return daysBetween(now, new Date(dateStr));
}

export function isPastDue(dueDateStr: string | null, now: Date = new Date()): boolean {
  if (!dueDateStr) return false;
  return daysUntil(dueDateStr, now) < 0;
}

/** Extracts a linked issue key (e.g. SMA-123) from text, matching the given project key. */
export function extractIssueKey(text: string | null | undefined, projectKey: string): string | null {
  if (!text) return null;
  const match = text.match(new RegExp(`\\b${projectKey}-\\d+\\b`));
  return match ? match[0] : null;
}

/** Flattens Atlassian Document Format (ADF) content into plain text. */
export function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";

  const collect = (node: any): string => {
    if (!node) return "";
    if (node.type === "text") return node.text ?? "";
    const children: string = Array.isArray(node.content)
      ? node.content.map(collect).join("")
      : "";
    if (node.type === "paragraph" || node.type === "heading") return `${children}\n`;
    return children;
  };

  return collect(adf).trim();
}

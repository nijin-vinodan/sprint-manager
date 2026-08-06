const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 8; // matches the "workdays (8h)" convention used elsewhere

export function formatWorkdayDuration(days: number): string {
  const totalMinutes = Math.round(days * HOURS_PER_DAY * MINUTES_PER_HOUR);
  if (totalMinutes <= 0) return "0m";

  const d = Math.floor(totalMinutes / (HOURS_PER_DAY * MINUTES_PER_HOUR));
  const remAfterDays = totalMinutes % (HOURS_PER_DAY * MINUTES_PER_HOUR);
  const h = Math.floor(remAfterDays / MINUTES_PER_HOUR);
  const m = remAfterDays % MINUTES_PER_HOUR;

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

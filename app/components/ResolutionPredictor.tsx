"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsDarkMode } from "../hooks/useIsDarkMode";
import { fuzzySearch } from "../lib/fuzzyMatch";

interface RankedCandidate {
  issueKey: string;
  resolutionDays: number;
  distance: number;
  source: "real" | "synthetic";
}

interface PredictionData {
  issueKey: string;
  predictedDays: number | null;
  confidence: { level: "high" | "medium" | "low"; closestDistance: number | null };
  kRequested: number;
  poolMode: PoolMode;
  usedFallbackToSynthetic: boolean;
  usedNeighborKeys: string[];
  allRanked: RankedCandidate[];
}

interface SprintTicket {
  key: string;
  summary: string;
}

interface SprintData {
  active: boolean;
  tickets?: SprintTicket[];
}

type FilterMode = "all" | "real" | "used";
type PoolMode = "all" | "real" | "synthetic";

const VIEWPORT_WIDTH = 920;
const VIEWPORT_HEIGHT = 460;
const MARGIN = { top: 24, right: 28, bottom: 44, left: 52 };
const PLOT_WIDTH = VIEWPORT_WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = VIEWPORT_HEIGHT - MARGIN.top - MARGIN.bottom;
const Y_TICKS = [0, 1, 2, 4, 8, 16, 32, 45];

const CONFIDENCE_COLOR: Record<PredictionData["confidence"]["level"], string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-red-600 dark:text-red-400",
};

const LIGHT_COLORS = {
  gridLine: "#e2e8f0",
  axisLine: "#cbd5e1",
  mutedText: "#64748b",
  labelText: "#0f172a",
  refLine: "#475569",
  tooltipBg: "#ffffff",
  tooltipBorder: "#e2e8f0",
  real: "#4f46e5",
  synthetic: "#d97706",
};

const DARK_COLORS = {
  gridLine: "#1e293b",
  axisLine: "#334155",
  mutedText: "#94a3b8",
  labelText: "#f1f5f9",
  refLine: "#94a3b8",
  tooltipBg: "#1e293b",
  tooltipBorder: "#334155",
  real: "#818cf8",
  synthetic: "#fbbf24",
};

export function ResolutionPredictor() {
  const [sprintData, setSprintData] = useState<SprintData | null>(null);
  const [data, setData] = useState<PredictionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [targetKey, setTargetKey] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [kValue, setKValue] = useState(3);
  const [poolMode, setPoolMode] = useState<PoolMode>("all");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  const isDark = useIsDarkMode();
  const colors = isDark ? DARK_COLORS : LIGHT_COLORS;

  useEffect(() => {
    fetch("/api/sprint")
      .then((res) => (res.ok ? res.json() : null))
      .then(setSprintData)
      .catch(() => setSprintData(null));
  }, []);

  const predict = useCallback(async (issueKey: string, k: number, pool: PoolMode) => {
    if (!issueKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ issueKey: issueKey.trim(), k: String(k), pool });
      const res = await fetch(`/api/predict?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Failed to predict: ${res.status}`);
      setData(body);
      setTargetKey(issueKey.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-run the same target ticket whenever k or the candidate pool changes,
  // so the chart/table/prediction all reflect the newly selected params
  // without the user having to re-search.
  const recalculate = useCallback(
    (nextK: number, nextPool: PoolMode) => {
      if (!targetKey) return;
      predict(targetKey, nextK, nextPool);
    },
    [targetKey, predict],
  );

  const sprintTickets = sprintData?.tickets ?? [];
  const searchResults = useMemo(
    () => fuzzySearch(searchQuery, sprintTickets, (t) => [t.key, t.summary]),
    [searchQuery, sprintTickets],
  );

  const usedSet = useMemo(() => new Set(data?.usedNeighborKeys ?? []), [data]);
  const visibleCandidates = useMemo(() => {
    if (!data) return [];
    if (filterMode === "all") return data.allRanked;
    if (filterMode === "real") return data.allRanked.filter((c) => c.source === "real");
    return data.allRanked.filter((c) => usedSet.has(c.issueKey));
  }, [data, filterMode, usedSet]);

  const realCount = data?.allRanked.filter((c) => c.source === "real").length ?? 0;
  const syntheticCount = (data?.allRanked.length ?? 0) - realCount;

  const scales = useMemo(() => {
    if (!data || data.allRanked.length === 0) return null;
    const maxDistance = Math.max(...data.allRanked.map((c) => c.distance));
    const xMax = Math.ceil(maxDistance) + 0.3;
    const xScale = (d: number) => MARGIN.left + (d / xMax) * PLOT_WIDTH;

    const maxDays = Math.max(...data.allRanked.map((c) => c.resolutionDays), data.predictedDays ?? 0);
    const yDomainMax = Math.max(45, maxDays);
    const ySqrtMax = Math.sqrt(yDomainMax);
    const yScale = (d: number) => MARGIN.top + PLOT_HEIGHT - (Math.sqrt(Math.max(d, 0)) / ySqrtMax) * PLOT_HEIGHT;

    return { xScale, yScale, xMax };
  }, [data]);

  const hovered = hoveredKey ? data?.allRanked.find((c) => c.issueKey === hoveredKey) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Resolution-time prediction · k-NN neighbor map
        </p>
        <h2 className="text-lg font-semibold">What predicts a ticket&apos;s estimate</h2>
        <p className="mt-0.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">
          Every historical ticket in issue_resolution_history, plotted by distance from the target ticket
          (x) and how long it actually took to resolve (y). The neighbors actually averaged are ringed and
          labeled.
        </p>
      </div>

      <div className="relative flex flex-wrap items-center gap-2">
        <div className="relative">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchQuery.trim()) predict(searchQuery.trim(), kValue, poolMode);
            }}
            placeholder="Ticket key or summary, e.g. SM-29…"
            className="w-72 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          {searchResults.length > 0 && (
            <ul className="absolute z-10 mt-1 w-80 max-h-60 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {searchResults.map((t) => (
                <li key={t.key}>
                  <button
                    onClick={() => {
                      setSearchQuery("");
                      predict(t.key, kValue, poolMode);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span className="font-mono text-xs text-slate-500">{t.key}</span> {t.summary}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          onClick={() => predict(searchQuery, kValue, poolMode)}
          disabled={loading || searchQuery.trim().length === 0}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? "Predicting…" : "Predict"}
        </button>

        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          k =
          <input
            type="number"
            min={1}
            max={15}
            value={kValue}
            onChange={(e) => {
              const next = Math.min(15, Math.max(1, Number(e.target.value) || 1));
              setKValue(next);
              recalculate(next, poolMode);
            }}
            className="w-14 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
          />
        </label>

        <div className="flex gap-1.5" role="group" aria-label="Candidate pool">
          {(["all", "real", "synthetic"] as PoolMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                setPoolMode(mode);
                recalculate(kValue, mode);
              }}
              aria-pressed={poolMode === mode}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${
                poolMode === mode
                  ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}

      {!data && !error && !loading && (
        <div className="rounded-md bg-slate-100 p-4 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          Search for a ticket above to see what predicted (or would predict) its resolution time.
        </div>
      )}

      {data && scales && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-800">
            <div className="flex flex-col gap-1 bg-white p-3 dark:bg-slate-900">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Predicted
              </span>
              <span className="text-xl font-bold tabular-nums">
                {data.predictedDays !== null ? data.predictedDays.toFixed(2) : "—"}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">workdays (8h)</span>
            </div>
            <div className="flex flex-col gap-1 bg-white p-3 dark:bg-slate-900">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Confidence
              </span>
              <span className={`text-xl font-bold capitalize ${CONFIDENCE_COLOR[data.confidence.level]}`}>
                {data.confidence.level}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                closest real: {data.confidence.closestDistance?.toFixed(2) ?? "—"}
              </span>
            </div>
            <div className="flex flex-col gap-1 bg-white p-3 dark:bg-slate-900">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Candidates
              </span>
              <span className="text-xl font-bold tabular-nums">{data.allRanked.length}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {realCount} real, {syntheticCount} synthetic
              </span>
            </div>
            <div className="flex flex-col gap-1 bg-white p-3 dark:bg-slate-900">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Fallback used
              </span>
              <span className="text-xl font-bold tabular-nums">{data.usedFallbackToSynthetic ? "Yes" : "No"}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">no real match within threshold</span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Distance vs. actual resolution time</h3>
              <p className="text-xs text-slate-400 dark:text-slate-500">y-axis uses a √ scale</p>
            </div>

            <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter candidates">
              {(["all", "real", "used"] as FilterMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setFilterMode(mode)}
                  aria-pressed={filterMode === mode}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                    filterMode === mode
                      ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {mode === "all" ? "All candidates" : mode === "real" ? "Real tickets only" : "Used neighbors only"}
                </button>
              ))}
            </div>

            <div className="relative">
              <svg viewBox={`0 0 ${VIEWPORT_WIDTH} ${VIEWPORT_HEIGHT}`} width="100%" height={VIEWPORT_HEIGHT}>
                {Y_TICKS.map((t) => {
                  const y = scales.yScale(t);
                  return (
                    <g key={`y-${t}`}>
                      <line x1={MARGIN.left} x2={VIEWPORT_WIDTH - MARGIN.right} y1={y} y2={y} stroke={colors.gridLine} strokeWidth={1} />
                      <text x={MARGIN.left - 8} y={y + 3} fontSize={11} fill={colors.mutedText} textAnchor="end">
                        {t}
                      </text>
                    </g>
                  );
                })}
                <text
                  x={14}
                  y={MARGIN.top + PLOT_HEIGHT / 2}
                  fontSize={11}
                  fontWeight={600}
                  fill={colors.mutedText}
                  textAnchor="middle"
                  transform={`rotate(-90, 14, ${MARGIN.top + PLOT_HEIGHT / 2})`}
                >
                  Actual resolution (days, √ scale)
                </text>

                {Array.from({ length: Math.floor(scales.xMax) + 1 }, (_, d) => d).map((d) => {
                  const x = scales.xScale(d);
                  return (
                    <g key={`x-${d}`}>
                      <line x1={x} x2={x} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} stroke={colors.gridLine} strokeWidth={1} />
                      <text x={x} y={MARGIN.top + PLOT_HEIGHT + 18} fontSize={11} fill={colors.mutedText} textAnchor="middle">
                        {d}
                      </text>
                    </g>
                  );
                })}
                <text
                  x={MARGIN.left + PLOT_WIDTH / 2}
                  y={VIEWPORT_HEIGHT - 8}
                  fontSize={11}
                  fontWeight={600}
                  fill={colors.mutedText}
                  textAnchor="middle"
                >
                  Feature-space distance from {targetKey} (closer = more similar)
                </text>

                <line
                  x1={MARGIN.left}
                  x2={VIEWPORT_WIDTH - MARGIN.right}
                  y1={MARGIN.top + PLOT_HEIGHT}
                  y2={MARGIN.top + PLOT_HEIGHT}
                  stroke={colors.axisLine}
                  strokeWidth={1}
                />
                <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} stroke={colors.axisLine} strokeWidth={1} />

                <line
                  x1={scales.xScale(0)}
                  x2={scales.xScale(0)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + PLOT_HEIGHT}
                  stroke={colors.refLine}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                />
                <text x={scales.xScale(0) + 6} y={MARGIN.top + 12} fontSize={11} fontWeight={600} fill={colors.refLine}>
                  {targetKey} (target)
                </text>

                {data.predictedDays !== null && (
                  <>
                    <line
                      x1={MARGIN.left}
                      x2={VIEWPORT_WIDTH - MARGIN.right}
                      y1={scales.yScale(data.predictedDays)}
                      y2={scales.yScale(data.predictedDays)}
                      stroke={colors.refLine}
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                    />
                    <text
                      x={VIEWPORT_WIDTH - MARGIN.right - 4}
                      y={scales.yScale(data.predictedDays) - 6}
                      fontSize={11}
                      fontWeight={600}
                      fill={colors.refLine}
                      textAnchor="end"
                    >
                      predicted → {data.predictedDays.toFixed(2)}d
                    </text>
                  </>
                )}

                {visibleCandidates.map((c) => {
                  const used = usedSet.has(c.issueKey);
                  const cx = scales.xScale(c.distance);
                  const cy = scales.yScale(c.resolutionDays);
                  const r = used ? 7 : c.source === "real" ? 5 : 4;
                  return (
                    <g key={c.issueKey}>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={r}
                        fill={c.source === "real" ? colors.real : colors.synthetic}
                        fillOpacity={used ? 1 : c.source === "real" ? 0.9 : 0.55}
                        stroke={used ? colors.labelText : "none"}
                        strokeWidth={used ? 2 : 0}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() => setHoveredKey(c.issueKey)}
                        onMouseLeave={() => setHoveredKey((k) => (k === c.issueKey ? null : k))}
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                          if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                        }}
                      />
                      {used && (
                        <text x={cx + r + 5} y={cy - r} fontSize={11} fontWeight={700} fill={colors.labelText}>
                          {c.issueKey}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              {hovered && (
                <div
                  className="pointer-events-none absolute z-10 max-w-xs -translate-x-1/2 -translate-y-full rounded-md border px-2.5 py-1.5 text-xs shadow-md"
                  style={{
                    left: pointer.x,
                    top: pointer.y - 10,
                    background: colors.tooltipBg,
                    borderColor: colors.tooltipBorder,
                    color: colors.labelText,
                  }}
                >
                  <div className="font-semibold">{hovered.issueKey}</div>
                  <div>distance: {hovered.distance.toFixed(2)}</div>
                  <div>resolution: {hovered.resolutionDays.toFixed(2)}d</div>
                  <div className="text-slate-400">
                    {hovered.source}
                    {usedSet.has(hovered.issueKey) ? " · used in prediction" : ""}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors.real }} />
                Real ticket
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors.synthetic }} />
                Synthetic ticket
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: colors.labelText }} />
                Used in prediction (k={data.kRequested})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-4 border-t-2 border-dashed" style={{ borderColor: colors.refLine }} />
                {targetKey} / predicted
              </span>
            </div>
          </div>

          <details className="rounded-lg border border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer select-none py-3 text-sm font-semibold text-slate-600 dark:text-slate-300">
              Table view — top 15 nearest candidates
            </summary>
            <div className="overflow-x-auto pb-4">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-slate-400 dark:text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide">Rank</th>
                    <th className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide">Issue</th>
                    <th className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide">Source</th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide">Distance</th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide">
                      Resolution (days)
                    </th>
                    <th className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide">Used?</th>
                  </tr>
                </thead>
                <tbody>
                  {data.allRanked.slice(0, 15).map((c, i) => (
                    <tr
                      key={c.issueKey}
                      className={`border-t border-slate-100 dark:border-slate-800 ${
                        usedSet.has(c.issueKey) ? "font-semibold" : ""
                      }`}
                    >
                      <td className="px-2 py-1.5 text-right tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1.5 font-mono text-xs">{c.issueKey}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            c.source === "real"
                              ? "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                              : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          }`}
                        >
                          {c.source}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.distance.toFixed(3)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.resolutionDays.toFixed(3)}</td>
                      <td className="px-2 py-1.5">{usedSet.has(c.issueKey) ? "✓ used" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <p className="text-xs leading-relaxed text-slate-400 dark:text-slate-500">
            Distance is the hand-rolled k-NN metric from{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-slate-800">
              src/knn.ts
            </code>{" "}
            — normalized story-points/dependency/comment/reopen deltas plus issue-type, priority,
            label-Jaccard, and assignee mismatch. Real neighbors get a small ranking bonus over synthetic
            ones at equal distance; synthetic rows only enter the pool when no real ticket is close enough.
            Confidence (
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-slate-800">
              src/confidence.ts
            </code>
            ) reflects the closest real neighbor&apos;s distance. If the target ticket is already resolved
            and part of the training history, it&apos;s excluded from its own candidate pool.
          </p>
        </div>
      )}
    </div>
  );
}

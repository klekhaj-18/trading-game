import { useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { TEAM_COLOR_META, type TeamColor } from "shared/auth";
import type { LeaderboardEquitySeries } from "shared/leaderboard";

export type EquityChartMode = "percent" | "equity";

interface Props {
  series: LeaderboardEquitySeries[];
  height?: number;
  mode?: EquityChartMode;
}

export function EquityChart({ series, height = 260, mode = "percent" }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (plotRef.current) {
      plotRef.current.destroy();
      plotRef.current = null;
    }
    if (series.length === 0) return;

    const effectiveMode: EquityChartMode =
      mode === "percent" && series.every((s) => s.baselineEquity == null) ? "equity" : mode;

    const data = buildAlignedData(series, effectiveMode);
    if (!data || data[0].length === 0) return;

    const opts: Options = {
      width: host.clientWidth,
      height,
      scales: { x: { time: true }, y: { auto: true } },
      cursor: { drag: { x: true, y: false } },
      legend: { show: true, markers: { show: true }, live: true },
      axes: [
        {
          stroke: "#6b6b74",
          grid: { stroke: "#1f1f23" },
          ticks: { stroke: "#1f1f23" },
        },
        {
          stroke: "#6b6b74",
          grid: { stroke: "#1f1f23" },
          ticks: { stroke: "#1f1f23" },
          values: (_u, splits) =>
            splits.map((v) => (effectiveMode === "percent" ? fmtPctCompact(v) : fmtUsdCompact(v))),
        },
      ],
      series: [
        { label: "time" },
        ...series.map((s) => {
          const hex = TEAM_COLOR_META[s.teamColor as TeamColor]?.hex ?? "#888";
          return {
            label: s.displayName,
            stroke: hex,
            width: 2,
            points: { show: false },
            value: (_u: uPlot, v: number | null) =>
              v == null ? "—" : effectiveMode === "percent" ? fmtSignedPct(v) : fmtUsd(v),
          };
        }),
      ],
    };

    const plot = new uPlot(opts, data, host);
    plotRef.current = plot;

    const onResize = () => plot.setSize({ width: host.clientWidth, height });
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [series, height, mode]);

  return <div ref={hostRef} className="w-full" style={{ minHeight: height }} />;
}

function buildAlignedData(
  series: LeaderboardEquitySeries[],
  mode: EquityChartMode,
): AlignedData | null {
  const xs = new Set<number>();
  for (const s of series) for (const p of s.points) xs.add(p.t);
  const xArr = Array.from(xs).sort((a, b) => a - b);

  const rows: (number | null)[][] = series.map((s) => {
    const baseline = s.baselineEquity;
    const transform = (equity: number): number | null => {
      if (mode === "equity") return equity;
      if (baseline == null || baseline <= 0) return null;
      return ((equity - baseline) / baseline) * 100;
    };
    const byT = new Map(s.points.map((p) => [p.t, transform(p.equity)]));
    let lastSeen: number | null = null;
    return xArr.map((t) => {
      if (byT.has(t)) {
        lastSeen = byT.get(t) ?? null;
        return lastSeen;
      }
      return lastSeen;
    });
  });

  return [xArr, ...rows] as AlignedData;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtUsdCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtSignedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

function fmtPctCompact(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const digits = abs >= 10 ? 0 : 1;
  return `${sign}${abs.toFixed(digits)}%`;
}

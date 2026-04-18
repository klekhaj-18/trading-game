import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type EquityPoint, type RoutineRunSummary } from "../lib/api";
import { cn } from "../lib/utils";

type Range = "24h" | "7d" | "30d";

export function PitWallPage() {
  const [range, setRange] = useState<Range>("24h");
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me });
  const posQ = useQuery({ queryKey: ["me", "positions"], queryFn: api.mePositions, refetchInterval: 30_000 });
  const equityQ = useQuery({
    queryKey: ["me", "equity", range],
    queryFn: () => api.meEquitySeries(range),
  });
  const runsQ = useQuery({ queryKey: ["me", "routine-runs"], queryFn: api.meRoutineRuns });

  const points = equityQ.data?.points ?? [];
  const latest = points[points.length - 1];
  const first = points[0];
  const equity = latest?.equity ?? 0;
  const changeAbs = latest && first ? latest.equity - first.equity : 0;
  const changePct = first && first.equity > 0 ? (changeAbs / first.equity) * 100 : 0;
  const positions = posQ.data?.positions ?? [];
  const dayPl = positions.reduce((s, p) => s + p.unrealizedPl, 0);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Pit wall</div>
        <div className="text-2xl font-black tracking-tight mt-1">
          {meQ.data?.user.displayName ?? "—"}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat label="Equity" value={fmtUsd(equity)} />
        <Stat
          label={`Change (${range})`}
          value={fmtPct(changePct)}
          sub={fmtUsdSigned(changeAbs)}
          tone={changePct > 0 ? "up" : changePct < 0 ? "down" : "flat"}
        />
        <Stat
          label="Day unrealized P&L"
          value={fmtUsdSigned(dayPl)}
          tone={dayPl > 0 ? "up" : dayPl < 0 ? "down" : "flat"}
        />
      </div>

      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase">Equity curve</div>
          <div className="flex gap-1 text-[10px]">
            {(["24h", "7d", "30d"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "rounded px-2 py-0.5 uppercase tracking-wider",
                  range === r ? "bg-zinc-100 text-zinc-900 font-semibold" : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <Sparkline points={points} />
        {points.length === 0 && (
          <div className="text-xs text-zinc-600 text-center py-8">
            No equity snapshots yet. The 5-min cron will populate this during market hours.
          </div>
        )}
      </div>

      <div>
        <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase mb-3">Positions</div>
        <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] overflow-hidden">
          {positions.length === 0 ? (
            <div className="text-sm text-zinc-500 text-center py-8">No open positions.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-black/40 text-[10px] tracking-wider text-zinc-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-right px-4 py-2">Qty</th>
                  <th className="text-right px-4 py-2">Avg entry</th>
                  <th className="text-right px-4 py-2">Current</th>
                  <th className="text-right px-4 py-2">Market value</th>
                  <th className="text-right px-4 py-2">Unrealized P&L</th>
                </tr>
              </thead>
              <tbody className="tabular-digits">
                {positions.map((p) => (
                  <tr key={p.symbol} className="border-t border-zinc-900">
                    <td className="px-4 py-2 font-bold">{p.symbol}</td>
                    <td className="px-4 py-2 text-right">{p.qty}</td>
                    <td className="px-4 py-2 text-right">${p.avgEntry.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right">${p.current.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right">${p.marketValue.toFixed(2)}</td>
                    <td
                      className={cn(
                        "px-4 py-2 text-right",
                        p.unrealizedPl > 0 ? "text-emerald-400" : p.unrealizedPl < 0 ? "text-red-400" : "text-zinc-400",
                      )}
                    >
                      {fmtUsdSigned(p.unrealizedPl)} ({p.unrealizedPlPct.toFixed(2)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase mb-3">
          Radio messages (recent routine runs)
        </div>
        <RoutineList runs={runsQ.data?.runs ?? []} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down" | "flat";
}) {
  const color =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4">
      <div className="text-[10px] tracking-wider text-zinc-500 uppercase">{label}</div>
      <div className={cn("text-2xl font-bold tabular-digits mt-1", color)}>{value}</div>
      {sub && <div className="text-xs text-zinc-500 tabular-digits mt-0.5">{sub}</div>}
    </div>
  );
}

function Sparkline({ points }: { points: EquityPoint[] }) {
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const w = 1000;
    const h = 120;
    const pad = 4;
    const xs = points.map((p) => p.t);
    const ys = points.map((p) => p.equity);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeY = maxY - minY || 1;
    const path = points
      .map((p, i) => {
        const x = pad + ((p.t - minX) / (maxX - minX || 1)) * (w - 2 * pad);
        const y = pad + (1 - (p.equity - minY) / rangeY) * (h - 2 * pad);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const last = points[points.length - 1]!;
    const first = points[0]!;
    const up = last.equity >= first.equity;
    return { path, w, h, color: up ? "#34d399" : "#f87171" };
  }, [points]);

  if (!geometry) return <div className="h-[120px]" />;
  return (
    <svg viewBox={`0 0 ${geometry.w} ${geometry.h}`} className="w-full h-[120px]">
      <path d={geometry.path} fill="none" stroke={geometry.color} strokeWidth={1.5} />
    </svg>
  );
}

function RoutineList({ runs }: { runs: RoutineRunSummary[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
        No routine runs yet.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {runs.slice(0, 15).map((r) => (
        <RoutineRow key={r.id} run={r} />
      ))}
    </div>
  );
}

function RoutineRow({ run }: { run: RoutineRunSummary }) {
  const [open, setOpen] = useState(false);
  const started = new Date(run.startedAt * 1000);
  const statusClass =
    run.status === "succeeded"
      ? "text-emerald-300"
      : run.status === "partial"
        ? "text-amber-300"
        : run.status === "validation_failed"
          ? "text-red-300"
          : run.status === "error"
            ? "text-red-300"
            : "text-zinc-400";
  return (
    <div className="rounded border border-zinc-800 bg-[var(--color-race-panel)] text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-baseline justify-between gap-3 px-3 py-2"
      >
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[10px] tracking-wider text-zinc-500 uppercase font-mono">
            {run.scheduledSlot ?? "on-demand"}
          </span>
          <span className={cn("text-[10px] font-bold uppercase tracking-wider", statusClass)}>
            {run.status}
          </span>
          <span className="text-[10px] text-zinc-600 tabular-digits">
            {started.toLocaleTimeString()}
          </span>
          <span className="text-[10px] text-zinc-600">{run.kind}</span>
          {run.orders.length > 0 && (
            <span className="text-[10px] text-emerald-400">{run.orders.length} order(s)</span>
          )}
        </div>
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>
      {open && run.claudeReasoning && (
        <div className="px-3 py-2 border-t border-zinc-900 text-xs text-zinc-400 whitespace-pre-wrap">
          {run.claudeReasoning}
        </div>
      )}
    </div>
  );
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtUsdSigned(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type EquityPoint, type OpenOrderSummary, type PositionSummary, type RoutineRunSummary } from "../lib/api";
import { cn } from "../lib/utils";

type Range = "24h" | "7d" | "30d";

export function PitWallPage() {
  const [range, setRange] = useState<Range>("24h");
  const qc = useQueryClient();
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["me"] });
  }, [qc]);
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me });
  const posQ = useQuery({ queryKey: ["me", "positions"], queryFn: api.mePositions, refetchInterval: 30_000 });
  const ordersQ = useQuery({ queryKey: ["me", "open-orders"], queryFn: api.meOpenOrders, refetchInterval: 30_000 });
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
        <PositionsTable positions={positions} />
      </div>

      <div>
        <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase mb-3">
          Open orders
        </div>
        <OpenOrdersTable orders={ordersQ.data?.orders ?? []} />
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

function OpenOrdersTable({ orders }: { orders: OpenOrderSummary[] }) {
  if (orders.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] text-sm text-zinc-500 text-center py-8">
        No open orders.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-black/40 text-[10px] tracking-wider text-zinc-500 uppercase">
          <tr>
            <th className="text-left px-4 py-2">Symbol</th>
            <th className="text-left px-4 py-2">Side</th>
            <th className="text-right px-4 py-2">Qty</th>
            <th className="text-left px-4 py-2">Type</th>
            <th className="text-right px-4 py-2">Limit</th>
            <th className="text-left px-4 py-2">TIF</th>
            <th className="text-left px-4 py-2">Status</th>
            <th className="text-right px-4 py-2">Submitted</th>
            <th className="text-right px-4 py-2">Actions</th>
          </tr>
        </thead>
        <tbody className="tabular-digits">
          {orders.map((o) => (
            <OpenOrderRow key={o.id} order={o} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpenOrderRow({ order }: { order: OpenOrderSummary }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState<string>(String(order.qty));
  const [limit, setLimit] = useState<string>(
    order.limitPrice != null ? order.limitPrice.toFixed(2) : "",
  );
  const [tif, setTif] = useState<"day" | "gtc">(
    order.timeInForce === "gtc" ? "gtc" : "day",
  );
  const [errText, setErrText] = useState<string | null>(null);

  const ORDERS_KEY = ["me", "open-orders"] as const;

  const removeLocallyById = (id: string) => {
    qc.setQueryData<{ orders: OpenOrderSummary[] } | undefined>(ORDERS_KEY, (old) => {
      if (!old) return old;
      return { ...old, orders: old.orders.filter((o) => o.id !== id) };
    });
  };

  const invalidateAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ORDERS_KEY }),
      qc.invalidateQueries({ queryKey: ["me", "positions"] }),
    ]);

  const replaceM = useMutation({
    mutationFn: (input: {
      qty?: number;
      limit_price?: number;
      time_in_force?: "day" | "gtc";
    }) => api.meReplaceOrder(order.id, input),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ORDERS_KEY });
      const prev = qc.getQueryData<{ orders: OpenOrderSummary[] }>(ORDERS_KEY);
      removeLocallyById(order.id);
      return { prev };
    },
    onSuccess: () => {
      setEditing(false);
      setErrText(null);
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ORDERS_KEY, ctx.prev);
      setErrText(err instanceof ApiError ? err.message : "Replace failed");
    },
    onSettled: invalidateAll,
  });

  const cancelM = useMutation({
    mutationFn: () => api.meCancelOrder(order.id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ORDERS_KEY });
      const prev = qc.getQueryData<{ orders: OpenOrderSummary[] }>(ORDERS_KEY);
      removeLocallyById(order.id);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ORDERS_KEY, ctx.prev);
      setErrText(err instanceof ApiError ? err.message : "Cancel failed");
    },
    onSettled: invalidateAll,
  });

  const startEdit = () => {
    setQty(String(order.qty));
    setLimit(order.limitPrice != null ? order.limitPrice.toFixed(2) : "");
    setTif(order.timeInForce === "gtc" ? "gtc" : "day");
    setErrText(null);
    setEditing(true);
  };

  const saveEdit = () => {
    const body: { qty?: number; limit_price?: number; time_in_force?: "day" | "gtc" } = {};
    const qNum = Number(qty);
    const lNum = Number(limit);
    if (Number.isFinite(qNum) && qNum > 0 && qNum !== order.qty) body.qty = qNum;
    if (order.orderType === "limit" && Number.isFinite(lNum) && lNum > 0 && lNum !== order.limitPrice) {
      body.limit_price = lNum;
    }
    if (tif !== order.timeInForce) body.time_in_force = tif;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    replaceM.mutate(body);
  };

  const submitted = new Date(order.submittedAt * 1000);
  const busy = replaceM.isPending || cancelM.isPending;

  if (!editing) {
    return (
      <tr className="border-t border-zinc-900">
        <td className="px-4 py-2 font-bold">{order.symbol}</td>
        <td
          className={cn(
            "px-4 py-2 text-xs uppercase tracking-wider",
            order.side === "buy" ? "text-emerald-400" : "text-red-400",
          )}
        >
          {order.side}
        </td>
        <td className="px-4 py-2 text-right">
          {order.filledQty > 0 ? `${order.filledQty}/${order.qty}` : order.qty}
        </td>
        <td className="px-4 py-2 text-xs uppercase tracking-wider text-zinc-400">
          {order.orderType}
        </td>
        <td className="px-4 py-2 text-right">
          {order.limitPrice != null ? `$${order.limitPrice.toFixed(2)}` : "—"}
        </td>
        <td className="px-4 py-2 text-xs uppercase tracking-wider text-zinc-500">
          {order.timeInForce}
        </td>
        <td className="px-4 py-2 text-xs uppercase tracking-wider text-amber-300">
          {order.status}
        </td>
        <td className="px-4 py-2 text-right text-xs text-zinc-500">
          {submitted.toLocaleTimeString()}
        </td>
        <td className="px-4 py-2 text-right">
          <div className="flex justify-end gap-2">
            <button
              onClick={startEdit}
              disabled={busy}
              className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Edit
            </button>
            <button
              onClick={() => {
                if (confirm(`Cancel ${order.side} ${order.qty} ${order.symbol}?`)) {
                  cancelM.mutate();
                }
              }}
              disabled={busy}
              className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-red-900/60 text-red-300 hover:bg-red-950/40 disabled:opacity-40"
            >
              {cancelM.isPending ? "…" : "Cancel"}
            </button>
          </div>
          {errText && <div className="mt-1 text-[10px] text-red-400">{errText}</div>}
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-zinc-900 bg-zinc-950/60">
      <td className="px-4 py-2 font-bold">{order.symbol}</td>
      <td
        className={cn(
          "px-4 py-2 text-xs uppercase tracking-wider",
          order.side === "buy" ? "text-emerald-400" : "text-red-400",
        )}
      >
        {order.side}
      </td>
      <td className="px-4 py-2 text-right">
        <input
          type="number"
          step="1"
          min="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="w-16 rounded bg-black/60 border border-zinc-700 px-1.5 py-0.5 text-right tabular-digits text-xs"
        />
      </td>
      <td className="px-4 py-2 text-xs uppercase tracking-wider text-zinc-400">
        {order.orderType}
      </td>
      <td className="px-4 py-2 text-right">
        {order.orderType === "limit" ? (
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="w-20 rounded bg-black/60 border border-zinc-700 px-1.5 py-0.5 text-right tabular-digits text-xs"
          />
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <select
          value={tif}
          onChange={(e) => setTif(e.target.value as "day" | "gtc")}
          className="rounded bg-black/60 border border-zinc-700 px-1 py-0.5 uppercase tracking-wider text-[10px]"
        >
          <option value="day">day</option>
          <option value="gtc">gtc</option>
        </select>
      </td>
      <td className="px-4 py-2 text-xs uppercase tracking-wider text-amber-300">
        {order.status}
      </td>
      <td className="px-4 py-2 text-right text-xs text-zinc-500">
        {submitted.toLocaleTimeString()}
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex justify-end gap-2">
          <button
            onClick={saveEdit}
            disabled={busy}
            className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {replaceM.isPending ? "…" : "Save"}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setErrText(null);
            }}
            disabled={busy}
            className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
        {errText && <div className="mt-1 text-[10px] text-red-400">{errText}</div>}
      </td>
    </tr>
  );
}

function PositionsTable({ positions }: { positions: PositionSummary[] }) {
  if (positions.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] text-sm text-zinc-500 text-center py-8">
        No open positions.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-black/40 text-[10px] tracking-wider text-zinc-500 uppercase">
          <tr>
            <th className="text-left px-4 py-2">Symbol</th>
            <th className="text-right px-4 py-2">Qty</th>
            <th className="text-right px-4 py-2">Avg entry</th>
            <th className="text-right px-4 py-2">Current</th>
            <th className="text-right px-4 py-2">Market value</th>
            <th className="text-right px-4 py-2">Unrealized P&L</th>
            <th className="text-right px-4 py-2">Actions</th>
          </tr>
        </thead>
        <tbody className="tabular-digits">
          {positions.map((p) => (
            <PositionRow key={p.symbol} position={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionRow({ position: p }: { position: PositionSummary }) {
  const qc = useQueryClient();
  const [errText, setErrText] = useState<string | null>(null);
  const POS_KEY = ["me", "positions"] as const;
  const closeM = useMutation({
    mutationFn: () => api.meClosePosition(p.symbol),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: POS_KEY });
      const prev = qc.getQueryData<{ positions: PositionSummary[] }>(POS_KEY);
      qc.setQueryData<{ positions: PositionSummary[] } | undefined>(POS_KEY, (old) => {
        if (!old) return old;
        return { ...old, positions: old.positions.filter((x) => x.symbol !== p.symbol) };
      });
      return { prev };
    },
    onSuccess: () => setErrText(null),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(POS_KEY, ctx.prev);
      setErrText(err instanceof ApiError ? err.message : "Close failed");
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: POS_KEY }),
        qc.invalidateQueries({ queryKey: ["me", "open-orders"] }),
      ]),
  });

  return (
    <tr className="border-t border-zinc-900">
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
      <td className="px-4 py-2 text-right">
        <button
          onClick={() => {
            if (confirm(`Close full position: ${p.qty} ${p.symbol} at market?`)) {
              closeM.mutate();
            }
          }}
          disabled={closeM.isPending}
          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-red-900/60 text-red-300 hover:bg-red-950/40 disabled:opacity-40"
        >
          {closeM.isPending ? "…" : "Close"}
        </button>
        {errText && <div className="mt-1 text-[10px] text-red-400">{errText}</div>}
      </td>
    </tr>
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

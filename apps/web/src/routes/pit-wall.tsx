import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlaybookCurrentResponse } from "shared/playbook";
import { ApiError, api, type EquityPoint, type OpenOrderSummary, type PositionSummary, type RoutineRunSummary } from "../lib/api";
import { cn } from "../lib/utils";

type Range = "24h" | "7d" | "30d";

export function PitWallPage() {
  const [range, setRange] = useState<Range>("24h");
  const [showDirectOrder, setShowDirectOrder] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["me"] });
  }, [qc]);
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me });
  const pbQ = useQuery({ queryKey: ["playbook"], queryFn: api.playbookCurrent });
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

      <StrategyStatusStrip data={pbQ.data} />

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
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase">Open orders</div>
          <button
            onClick={() => setShowDirectOrder((v) => !v)}
            className="text-[10px] rounded border border-zinc-700 px-2 py-1 uppercase tracking-wider text-zinc-300 hover:text-white hover:border-zinc-500"
          >
            {showDirectOrder ? "Cancel" : "+ Direct order"}
          </button>
        </div>
        {showDirectOrder && <DirectOrderComposer onDone={() => setShowDirectOrder(false)} />}
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
    <>
      <div className="sm:hidden space-y-3">
        {orders.map((o) => (
          <OpenOrderCard key={o.id} order={o} />
        ))}
      </div>
      <div className="hidden sm:block rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] overflow-hidden">
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
    </>
  );
}

function OpenOrderCard({ order }: { order: OpenOrderSummary }) {
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

  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold">{order.symbol}</span>
          <span
            className={cn(
              "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded",
              order.side === "buy"
                ? "bg-emerald-950/60 text-emerald-300 border border-emerald-900/60"
                : "bg-red-950/60 text-red-300 border border-red-900/60",
            )}
          >
            {order.side}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-amber-300">
            {order.status}
          </span>
        </div>
        <span className="text-[10px] text-zinc-500 tabular-digits">
          {submitted.toLocaleTimeString()}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3 text-xs tabular-digits">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Qty</div>
          {editing ? (
            <input
              type="number"
              step="1"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-0.5 w-full rounded bg-black/60 border border-zinc-700 px-2 py-1 tabular-digits text-xs"
            />
          ) : (
            <div className="mt-0.5">
              {order.filledQty > 0 ? `${order.filledQty}/${order.qty}` : order.qty}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Type</div>
          <div className="mt-0.5 uppercase">{order.orderType}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Limit</div>
          {editing && order.orderType === "limit" ? (
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="mt-0.5 w-full rounded bg-black/60 border border-zinc-700 px-2 py-1 tabular-digits text-xs"
            />
          ) : (
            <div className="mt-0.5">
              {order.limitPrice != null ? `$${order.limitPrice.toFixed(2)}` : "—"}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">TIF</div>
          {editing ? (
            <select
              value={tif}
              onChange={(e) => setTif(e.target.value as "day" | "gtc")}
              className="mt-0.5 w-full rounded bg-black/60 border border-zinc-700 px-2 py-1 uppercase text-xs"
            >
              <option value="day">day</option>
              <option value="gtc">gtc</option>
            </select>
          ) : (
            <div className="mt-0.5 uppercase">{order.timeInForce}</div>
          )}
        </div>
      </div>

      {errText && <div className="mt-2 text-[11px] text-red-400">{errText}</div>}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {editing ? (
          <>
            <button
              onClick={saveEdit}
              disabled={busy}
              className="py-2 rounded bg-emerald-600 text-white text-xs uppercase tracking-wider font-semibold disabled:opacity-40"
            >
              {replaceM.isPending ? "…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setErrText(null);
              }}
              disabled={busy}
              className="py-2 rounded border border-zinc-700 text-zinc-300 text-xs uppercase tracking-wider disabled:opacity-40"
            >
              Cancel edit
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                setQty(String(order.qty));
                setLimit(order.limitPrice != null ? order.limitPrice.toFixed(2) : "");
                setTif(order.timeInForce === "gtc" ? "gtc" : "day");
                setErrText(null);
                setEditing(true);
              }}
              disabled={busy}
              className="py-2 rounded border border-zinc-700 text-zinc-200 text-xs uppercase tracking-wider disabled:opacity-40"
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
              className="py-2 rounded border border-red-900/60 text-red-300 bg-red-950/30 text-xs uppercase tracking-wider disabled:opacity-40"
            >
              {cancelM.isPending ? "…" : "Cancel order"}
            </button>
          </>
        )}
      </div>
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
    <>
      <div className="sm:hidden space-y-3">
        {positions.map((p) => (
          <PositionCard key={p.symbol} position={p} />
        ))}
      </div>
      <div className="hidden sm:block rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] overflow-hidden">
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
    </>
  );
}

function PositionCard({ position: p }: { position: PositionSummary }) {
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
  const plColor =
    p.unrealizedPl > 0 ? "text-emerald-400" : p.unrealizedPl < 0 ? "text-red-400" : "text-zinc-400";
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-base font-bold">{p.symbol}</span>
        <span className={cn("text-sm font-semibold tabular-digits", plColor)}>
          {fmtUsdSigned(p.unrealizedPl)} ({p.unrealizedPlPct.toFixed(2)}%)
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3 text-xs tabular-digits">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Qty</div>
          <div className="mt-0.5">{p.qty}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Avg entry</div>
          <div className="mt-0.5">${p.avgEntry.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Current</div>
          <div className="mt-0.5">${p.current.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Market value</div>
          <div className="mt-0.5">${p.marketValue.toFixed(2)}</div>
        </div>
      </div>
      {errText && <div className="mt-2 text-[11px] text-red-400">{errText}</div>}
      <button
        onClick={() => {
          if (confirm(`Close full position: ${p.qty} ${p.symbol} at market?`)) {
            closeM.mutate();
          }
        }}
        disabled={closeM.isPending}
        className="mt-3 w-full py-2 rounded border border-red-900/60 text-red-300 bg-red-950/30 text-xs uppercase tracking-wider disabled:opacity-40"
      >
        {closeM.isPending ? "…" : "Close position"}
      </button>
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

function StrategyStatusStrip({ data }: { data: PlaybookCurrentResponse | undefined }) {
  if (!data?.playbook) return null;
  const plan = data.plan;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-race-border)] bg-[var(--color-race-panel)] px-3 py-2">
      <div className="text-xs text-zinc-400 min-w-0">
        <span className="text-zinc-200 font-semibold">Strategy v{data.playbook.version}</span>
        {plan?.approvalState === "approved" && plan.approvedAt != null && (
          <> · approved {fmtDate(plan.approvedAt)}</>
        )}
        {plan?.approvalState === "pending" && (
          <> · <span className="text-amber-400">pending review</span></>
        )}
        <span className="hidden sm:inline text-zinc-500"> · runs as-is for all 5 daily slots</span>
      </div>
      <Link
        to="/playbook"
        className="shrink-0 text-[10px] rounded border border-zinc-700 px-2 py-1 uppercase tracking-wider text-zinc-300 hover:text-white hover:border-zinc-500"
      >
        Revise →
      </Link>
    </div>
  );
}

function fmtDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function DirectOrderComposer({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("");
  const [type, setType] = useState<"market" | "limit">("market");
  const [tif, setTif] = useState<"day" | "gtc">("day");
  const [limitPrice, setLimitPrice] = useState("");

  const placeM = useMutation({
    mutationFn: () =>
      api.meDirectOrder({
        symbol: symbol.trim().toUpperCase(),
        side,
        qty: Number(qty),
        type,
        time_in_force: tif,
        limit_price: type === "limit" ? Number(limitPrice) : undefined,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me", "open-orders"] });
      await qc.invalidateQueries({ queryKey: ["me", "positions"] });
      onDone();
    },
  });

  const err = placeM.error as ApiError | null;
  const qtyNum = Number(qty);
  const lpNum = Number(limitPrice);
  const canSubmit =
    symbol.trim().length > 0 &&
    Number.isFinite(qtyNum) &&
    qtyNum > 0 &&
    Number.isInteger(qtyNum) &&
    (type === "market" || (Number.isFinite(lpNum) && lpNum > 0));

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 mb-3 space-y-3">
      <div className="text-[10px] tracking-wider text-amber-400 uppercase">
        Direct order — bypasses the AI strategy. Only buying-power and tradability checks apply.
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="AAPL"
          className="col-span-2 sm:col-span-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 uppercase font-semibold tracking-wide"
        />
        <select
          value={side}
          onChange={(e) => setSide(e.target.value as "buy" | "sell")}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
        >
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="Qty"
          inputMode="numeric"
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "market" | "limit")}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
        >
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
        {type === "limit" ? (
          <input
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder="Limit $"
            inputMode="decimal"
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
          />
        ) : (
          <div className="hidden sm:block" />
        )}
        <select
          value={tif}
          onChange={(e) => setTif(e.target.value as "day" | "gtc")}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
        >
          <option value="day">Day</option>
          <option value="gtc">GTC</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-red-400 min-h-[1em]">
          {err ? err.message : ""}
        </div>
        <button
          onClick={() => placeM.mutate()}
          disabled={!canSubmit || placeM.isPending}
          className="text-xs rounded border border-amber-400 bg-amber-500/20 px-3 py-1.5 uppercase tracking-wider font-semibold text-amber-100 hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {placeM.isPending ? "Placing…" : `Place ${side}`}
        </button>
      </div>
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

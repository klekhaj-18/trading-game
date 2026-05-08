import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntentSummary } from "shared/intent";
import type { PlaybookCurrentResponse } from "shared/playbook";
import type { RoutineDecision } from "shared/routine";
import {
  ApiError,
  api,
  type AccountContext,
  type EquityPoint,
  type MarketSnapshot,
  type OpenOrderSummary,
  type PlanUniverseEntry,
  type PositionSummary,
  type RecentFillSummary,
  type RoutineRunDetail,
  type RoutineRunSummary,
  type SentimentLabel,
  type SnapshotRegimeCard,
  type SnapshotSymbol,
} from "../lib/api";
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
  const fillsQ = useQuery({ queryKey: ["me", "recent-fills"], queryFn: api.meRecentFills, refetchInterval: 60_000 });
  const intentsQ = useQuery({ queryKey: ["me", "intents"], queryFn: api.meIntents, refetchInterval: 60_000 });
  const pnlQ = useQuery({ queryKey: ["me", "pnl-split"], queryFn: api.mePnlSplit, refetchInterval: 60_000 });
  const raceQ = useQuery({ queryKey: ["race"], queryFn: api.raceState, refetchInterval: 60_000 });
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

      <PnlSplitRow
        strategyNet={pnlQ.data?.strategy.netRealized ?? 0}
        strategyCount={pnlQ.data?.strategy.tradeCount ?? 0}
        directNet={pnlQ.data?.direct.netRealized ?? 0}
        directCount={pnlQ.data?.direct.tradeCount ?? 0}
      />

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
        {posQ.isError ? (
          <FetchErrorBanner
            label="positions"
            message={posQ.error instanceof Error ? posQ.error.message : "Couldn't load from Alpaca"}
          />
        ) : (
          <PositionsTable positions={positions} />
        )}
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
        {ordersQ.isError ? (
          <FetchErrorBanner
            label="open orders"
            message={ordersQ.error instanceof Error ? ordersQ.error.message : "Couldn't load from Alpaca"}
          />
        ) : (
          <OpenOrdersTable orders={ordersQ.data?.orders ?? []} />
        )}
      </div>

      <RecentFillsSection fillsQ={fillsQ} />

      <IntentsSection
        pending={intentsQ.data?.pending ?? []}
        recent={intentsQ.data?.recent ?? []}
        hasRunningRoutine={(() => {
          const staleCutoff = Math.floor(Date.now() / 1000) - 600;
          return (runsQ.data?.runs ?? []).some(
            (r) => r.status === "running" && r.startedAt > staleCutoff,
          );
        })()}
        raceState={raceQ.data?.state ?? null}
      />

      <div>
        <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase mb-3">
          Radio messages (recent routine runs)
        </div>
        <RoutineList runs={runsQ.data?.runs ?? []} />
      </div>
    </div>
  );
}

function RecentFillsSection({
  fillsQ,
}: {
  fillsQ: { data?: { fills: RecentFillSummary[] }; isError: boolean; error: unknown };
}) {
  const [open, setOpen] = useState(false);
  const fills = fillsQ.data?.fills ?? [];
  const count = fills.length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 mb-3 text-left"
      >
        <span className="text-xs tracking-[0.25em] text-zinc-500 group-hover:text-zinc-300 uppercase">
          Recent fills
        </span>
        <span className="text-[10px] text-zinc-500 tabular-digits rounded border border-zinc-800 px-1.5 py-0.5">
          {fillsQ.isError ? "error" : count}
        </span>
        <span className="ml-auto text-[10px] text-zinc-500 group-hover:text-zinc-300 uppercase tracking-wider">
          {open ? "Hide" : "Show"} {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        fillsQ.isError ? (
          <FetchErrorBanner
            label="recent fills"
            message={fillsQ.error instanceof Error ? fillsQ.error.message : "Couldn't load from Alpaca"}
          />
        ) : (
          <RecentFillsTable fills={fills} />
        )
      )}
    </div>
  );
}

function RecentFillsTable({ fills }: { fills: RecentFillSummary[] }) {
  if (fills.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] text-sm text-zinc-500 text-center py-8">
        No recent fills.
      </div>
    );
  }
  return (
    <>
      <div className="sm:hidden space-y-3">
        {fills.map((f) => (
          <RecentFillCard key={f.id} fill={f} />
        ))}
      </div>
      <div className="hidden sm:block rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-black/40 text-[10px] tracking-wider text-zinc-500 uppercase">
            <tr>
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-left px-4 py-2">Side</th>
              <th className="text-right px-4 py-2">Filled qty</th>
              <th className="text-right px-4 py-2">Avg price</th>
              <th className="text-right px-4 py-2">Notional</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2">When</th>
            </tr>
          </thead>
          <tbody className="tabular-digits">
            {fills.map((f) => (
              <RecentFillRow key={f.id} fill={f} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RecentFillRow({ fill: f }: { fill: RecentFillSummary }) {
  const notional = f.filledAvgPrice != null ? f.filledQty * f.filledAvgPrice : null;
  const sideTone = f.side === "buy" ? "text-emerald-300" : "text-amber-300";
  const statusTone = f.status === "filled"
    ? "text-emerald-400"
    : f.status === "canceled" || f.status === "expired" || f.status === "rejected"
      ? "text-zinc-500"
      : "text-zinc-300";
  const whenSec = f.filledAt ?? f.submittedAt;
  return (
    <tr className="border-t border-zinc-900">
      <td className="px-4 py-2 font-bold">{f.symbol}</td>
      <td className={cn("px-4 py-2 uppercase text-xs", sideTone)}>{f.side}</td>
      <td className="px-4 py-2 text-right">{f.filledQty}</td>
      <td className="px-4 py-2 text-right">
        {f.filledAvgPrice != null ? `$${f.filledAvgPrice.toFixed(2)}` : "—"}
      </td>
      <td className="px-4 py-2 text-right">{notional != null ? fmtUsd(notional) : "—"}</td>
      <td className={cn("px-4 py-2 text-xs uppercase tracking-wider", statusTone)}>{f.status}</td>
      <td className="px-4 py-2 text-right text-xs text-zinc-500">{fmtTime(whenSec)}</td>
    </tr>
  );
}

function RecentFillCard({ fill: f }: { fill: RecentFillSummary }) {
  const notional = f.filledAvgPrice != null ? f.filledQty * f.filledAvgPrice : null;
  const sideTone = f.side === "buy" ? "text-emerald-300" : "text-amber-300";
  const whenSec = f.filledAt ?? f.submittedAt;
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-base font-bold">{f.symbol}</span>
        <span className={cn("text-xs uppercase font-semibold", sideTone)}>{f.side}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2 text-xs tabular-digits">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Filled qty</div>
          <div className="mt-0.5">{f.filledQty}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Avg price</div>
          <div className="mt-0.5">{f.filledAvgPrice != null ? `$${f.filledAvgPrice.toFixed(2)}` : "—"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Notional</div>
          <div className="mt-0.5">{notional != null ? fmtUsd(notional) : "—"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Status</div>
          <div className="mt-0.5 uppercase">{f.status}</div>
        </div>
      </div>
      <div className="mt-2 text-[10px] text-zinc-500">{fmtTime(whenSec)}</div>
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

function FetchErrorBanner({ label, message }: { label: string; message: string }) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-200">
      <div className="font-semibold">Couldn't load {label} from Alpaca.</div>
      <div className="text-xs text-red-300/80 mt-1 font-mono break-all">{message}</div>
      <div className="text-[11px] text-zinc-400 mt-2">
        Don't trust this section right now — your real Alpaca state may differ. Ask the admin to "Resync Alpaca" from the paddock, or retry shortly.
      </div>
    </div>
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
        qc.invalidateQueries({ queryKey: ["me", "recent-fills"] }),
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
        qc.invalidateQueries({ queryKey: ["me", "recent-fills"] }),
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

// =====================================================================
// Routine row — V5 layout
//
// Header row (always visible) is a thin one-liner: slot · status · time ·
// counts. Expanding lazily fetches /api/me/routine-runs/:id which includes
// the parsed marketSnapshotJson + accountContextJson + planUniverse from
// the active operationalPlan. Each decision becomes a 3-line decision card
// (action, qty/type, rationale) with a collapsible Details footer that
// pulls per-symbol context from the snapshot. A routine-level macro regime
// card sits above the cards.
// =====================================================================

const ACTION_ICON: Record<RoutineDecision["action"], string> = {
  buy: "▲",
  sell: "▼",
  plan: "◇",
  hold: "○",
};

const ACTION_TEXT_CLASS: Record<RoutineDecision["action"], string> = {
  buy: "text-emerald-400",
  sell: "text-red-400",
  plan: "text-amber-400",
  hold: "text-zinc-500",
};

const ACTION_BG_CLASS: Record<RoutineDecision["action"], string> = {
  buy: "bg-emerald-950/20 border-emerald-900/40",
  sell: "bg-red-950/20 border-red-900/40",
  plan: "bg-amber-950/20 border-amber-900/40",
  hold: "bg-zinc-900/40 border-zinc-800",
};

type DecisionOutcome =
  | { kind: "filled"; label: string; className: string }
  | { kind: "rejected"; label: string; reason: string; className: string }
  | { kind: "noop"; label: string; className: string }
  | null;

function outcomeFor(run: RoutineRunSummary, idx: number): DecisionOutcome {
  const order = run.orders.find((o) => o.decisionIndex === idx);
  if (order) {
    return {
      kind: "filled",
      label: `✓ ${order.orderStatus.toUpperCase()}${order.filledAvgPrice ? ` $${order.filledAvgPrice}` : ""}`,
      className: "text-emerald-300 border-emerald-700 bg-emerald-950/40",
    };
  }
  const failure = run.validationFailures.find((f) => f.decisionIndex === idx);
  if (failure) {
    return {
      kind: "rejected",
      label: "✗ REJECTED",
      reason: failure.reason,
      className: "text-red-300 border-red-700 bg-red-950/40",
    };
  }
  const action = run.decisions?.[idx]?.action;
  if (action === "plan" || action === "hold") {
    return {
      kind: "noop",
      label: action === "plan" ? "PLAN ONLY" : "HOLD",
      className: "text-zinc-500 border-zinc-800 bg-zinc-900/30",
    };
  }
  return null;
}

function RoutineRow({ run }: { run: RoutineRunSummary }) {
  const [open, setOpen] = useState(false);
  const detailQ = useQuery({
    queryKey: ["me", "routine-runs", run.id],
    queryFn: () => api.meRoutineRun(run.id),
    enabled: open,
    staleTime: 60_000,
  });
  const started = new Date(run.startedAt * 1000);
  const statusClass =
    run.status === "succeeded"
      ? "text-emerald-300 border-emerald-900/60 bg-emerald-950/30"
      : run.status === "partial"
        ? "text-amber-300 border-amber-900/60 bg-amber-950/30"
        : run.status === "running"
          ? "text-amber-200 border-amber-700 bg-amber-950/30"
          : run.status === "validation_failed"
            ? "text-red-300 border-red-900/60 bg-red-950/30"
            : run.status === "error"
              ? "text-red-200 border-red-900/80 bg-red-950/50"
              : "text-zinc-400 border-zinc-800 bg-black/40";

  return (
    <div className="rounded border border-zinc-800 bg-[var(--color-race-panel)] p-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-baseline justify-between gap-3 text-left"
      >
        <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
          <span className="text-xs tracking-wider text-zinc-500 uppercase font-mono">
            {run.scheduledSlot ?? "on-demand"}
          </span>
          <span
            className={cn(
              "text-[10px] font-bold uppercase tracking-wider rounded px-2 py-0.5 border",
              statusClass,
            )}
          >
            {run.status}
          </span>
          <span className="text-[10px] text-zinc-600 tabular-digits">
            {started.toLocaleTimeString()}
          </span>
          <span className="text-[10px] text-zinc-600">{run.kind}</span>
          {run.orders.length > 0 && (
            <span className="text-[10px] text-emerald-400">
              {run.orders.length} order{run.orders.length === 1 ? "" : "s"}
            </span>
          )}
          {run.validationFailures.length > 0 && (
            <span className="text-[10px] text-red-400">
              {run.validationFailures.length} failure{run.validationFailures.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>

      {open && <RoutineDetail run={run} detail={detailQ.data?.run ?? null} loading={detailQ.isLoading} />}
    </div>
  );
}

function RoutineDetail({
  run,
  detail,
  loading,
}: {
  run: RoutineRunSummary;
  detail: RoutineRunDetail | null;
  loading: boolean;
}) {
  // detail is what we display from once it's loaded; until then we fall back
  // to the summary row so users don't see a blank expanded panel.
  const source = detail ?? run;
  const snapshot = detail?.marketSnapshot ?? null;
  const account = detail?.accountContext ?? null;
  const planUniverse = detail?.planUniverse ?? [];

  const symbolMap = useMemo(() => {
    const m = new Map<string, SnapshotSymbol>();
    for (const s of snapshot?.symbols ?? []) m.set(s.symbol.toUpperCase(), s);
    return m;
  }, [snapshot]);

  const planMap = useMemo(() => {
    const m = new Map<string, PlanUniverseEntry>();
    for (const p of planUniverse) m.set(p.symbol.toUpperCase(), p);
    return m;
  }, [planUniverse]);

  const positionMap = useMemo(() => {
    const m = new Map<string, AccountContext["positions"][number]>();
    for (const p of account?.positions ?? []) m.set(p.symbol.toUpperCase(), p);
    return m;
  }, [account]);

  return (
    <div className="mt-3 space-y-3 text-sm">
      {source.errorText && (
        <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-200">
          <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1">Error</div>
          {source.errorText}
        </div>
      )}

      {source.oneShotInstruction && (
        <div>
          <div className="text-[10px] tracking-wider text-zinc-500 uppercase mb-1">
            Your instruction
          </div>
          <div className="rounded bg-black/60 px-3 py-2 text-zinc-300 whitespace-pre-wrap">
            {source.oneShotInstruction}
          </div>
        </div>
      )}

      {/* Macro regime — once per routine, above the decision cards */}
      {detail ? (
        snapshot?.regime ? (
          <RegimeCard regime={snapshot.regime} />
        ) : (
          <div className="rounded border border-zinc-800 bg-black/30 px-3 py-2 text-[11px] text-zinc-500">
            Macro regime not captured for this run.
          </div>
        )
      ) : loading ? (
        <DetailSkeleton lines={2} />
      ) : null}

      {source.claudeReasoning && (
        <div>
          <div className="text-[10px] tracking-wider text-zinc-500 uppercase mb-1">
            Claude's reasoning
            {source.claudeModel && <span className="text-zinc-600"> · {source.claudeModel}</span>}
          </div>
          <blockquote className="rounded border-l-2 border-amber-700/60 bg-black/60 pl-3 pr-3 py-2 italic text-zinc-300 whitespace-pre-wrap leading-relaxed">
            {source.claudeReasoning}
          </blockquote>
          <div className="mt-2 text-[10px] text-zinc-600 tabular-digits">
            tokens: input={source.tokens.input ?? 0}  output={source.tokens.output ?? 0}  cache_read=
            {source.tokens.cacheRead ?? 0}  cache_write={source.tokens.cacheWrite ?? 0}
          </div>
        </div>
      )}

      {source.decisions && source.decisions.length > 0 && (
        <div>
          <div className="text-[10px] tracking-wider text-zinc-500 uppercase mb-1">
            Decisions ({source.decisions.length})
          </div>
          <div className="space-y-2">
            {source.decisions.map((d, i) => (
              <DecisionCard
                key={i}
                d={d}
                outcome={outcomeFor(source, i)}
                symbol={symbolMap.get(d.symbol.toUpperCase()) ?? null}
                position={positionMap.get(d.symbol.toUpperCase()) ?? null}
                planEntry={planMap.get(d.symbol.toUpperCase()) ?? null}
                account={account}
                detailLoaded={detail != null}
                loading={loading}
                order={source.orders.find((o) => o.decisionIndex === i) ?? null}
              />
            ))}
          </div>
        </div>
      )}

      {/* Validation failures whose decisionIndex didn't match any decision (rare)
         still surface so they aren't silently dropped. */}
      {source.validationFailures.some(
        (f) => !source.decisions || f.decisionIndex < 0 || f.decisionIndex >= source.decisions.length,
      ) && (
        <div>
          <div className="text-[10px] tracking-wider text-red-400 uppercase mb-1">
            Other validation failures
          </div>
          <div className="space-y-1 text-xs">
            {source.validationFailures
              .filter(
                (f) =>
                  !source.decisions ||
                  f.decisionIndex < 0 ||
                  f.decisionIndex >= source.decisions.length,
              )
              .map((f, i) => (
                <div key={i} className="rounded bg-red-950/30 border border-red-900/40 px-3 py-2">
                  <span className="font-mono font-bold text-red-300">{f.symbol}</span>
                  <span className="text-zinc-400"> — {f.reason}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionCard({
  d,
  outcome,
  symbol,
  position,
  planEntry,
  account,
  detailLoaded,
  loading,
  order,
}: {
  d: RoutineDecision;
  outcome: DecisionOutcome;
  symbol: SnapshotSymbol | null;
  position: AccountContext["positions"][number] | null;
  planEntry: PlanUniverseEntry | null;
  account: AccountContext | null;
  detailLoaded: boolean;
  loading: boolean;
  order: RoutineRunSummary["orders"][number] | null;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const orderTypeLabel =
    d.order_type === "limit" && d.limit_price != null ? `LMT $${d.limit_price.toFixed(2)}` : "MKT";

  return (
    <div className={cn("rounded border px-3 py-2.5 text-sm", ACTION_BG_CLASS[d.action])}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 font-mono min-w-0">
          <span className={cn("font-bold uppercase shrink-0", ACTION_TEXT_CLASS[d.action])}>
            {ACTION_ICON[d.action]} {d.action}
          </span>
          <span className="font-bold text-zinc-100 truncate">{d.symbol}</span>
        </div>
        {outcome && (
          <span
            className={cn(
              "text-[10px] font-bold uppercase tracking-wider rounded px-2 py-0.5 border whitespace-nowrap shrink-0",
              outcome.className,
            )}
          >
            {outcome.label}
          </span>
        )}
      </div>

      {d.action !== "plan" && d.action !== "hold" && (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 font-mono text-[12px] text-zinc-400">
          <span className="tabular-digits text-zinc-300">qty {d.qty}</span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-300">{orderTypeLabel}</span>
          <span className="text-zinc-600">·</span>
          <span className="uppercase">{d.time_in_force}</span>
        </div>
      )}

      <div className="mt-1.5 text-zinc-300 text-[13px] leading-snug">{d.rationale}</div>

      {outcome?.kind === "rejected" && outcome.reason && (
        <div className="mt-1.5 rounded bg-red-950/40 border border-red-900/60 px-2 py-1 text-[11px] text-red-300">
          ✗ {outcome.reason}
        </div>
      )}

      <button
        onClick={() => setShowDetails((v) => !v)}
        className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300 uppercase tracking-wider"
      >
        {showDetails ? "▾" : "▸"} Details
      </button>
      {showDetails && (
        <div className="mt-2 space-y-3 border-t border-zinc-800/60 pt-2">
          <DecisionDetails
            d={d}
            outcome={outcome}
            symbol={symbol}
            position={position}
            planEntry={planEntry}
            account={account}
            detailLoaded={detailLoaded}
            loading={loading}
            order={order}
          />
        </div>
      )}
    </div>
  );
}

function DecisionDetails({
  d,
  outcome,
  symbol,
  position,
  planEntry,
  account,
  detailLoaded,
  loading,
  order,
}: {
  d: RoutineDecision;
  outcome: DecisionOutcome;
  symbol: SnapshotSymbol | null;
  position: AccountContext["positions"][number] | null;
  planEntry: PlanUniverseEntry | null;
  account: AccountContext | null;
  detailLoaded: boolean;
  loading: boolean;
  order: RoutineRunSummary["orders"][number] | null;
}) {
  if (!detailLoaded) {
    return loading ? (
      <DetailSkeleton lines={4} />
    ) : (
      <div className="text-[11px] text-zinc-500">Detail unavailable.</div>
    );
  }

  const tech = symbol?.technicals ?? null;
  const bid = symbol?.lastQuote?.bid ?? null;
  const ask = symbol?.lastQuote?.ask ?? null;
  const bars = symbol?.dailyBars ?? [];
  const todayBar = bars[bars.length - 1] ?? null;
  const earnings = symbol?.earnings ?? null;
  const sentiment = symbol?.sentiment ?? null;
  const headlines = symbol?.news ?? [];
  const headlineLabelLookup = new Map<string, { label: SentimentLabel; score: number; rationale: string }>();
  if (sentiment?.topHeadlines) {
    for (const h of sentiment.topHeadlines) {
      headlineLabelLookup.set(h.headline, { label: h.label, score: h.score, rationale: h.rationale });
    }
  }

  const epsSurprisePct =
    earnings?.epsActual != null && earnings.epsEstimate != null && earnings.epsEstimate !== 0
      ? ((earnings.epsActual - earnings.epsEstimate) / Math.abs(earnings.epsEstimate)) * 100
      : null;
  const revSurprisePct =
    earnings?.revActual != null && earnings.revEstimate != null && earnings.revEstimate !== 0
      ? ((earnings.revActual - earnings.revEstimate) / Math.abs(earnings.revEstimate)) * 100
      : null;
  const epsBeat = epsSurprisePct != null && epsSurprisePct >= 0;
  const revBeat = revSurprisePct != null && revSurprisePct >= 0;

  return (
    <>
      {/* From your playbook — universe entry from the active operational plan */}
      {planEntry && planEntry.rationale && (
        <Section label="From your playbook">
          <DetailRow
            label="Rationale"
            value={<span className="text-zinc-300 italic">"{planEntry.rationale}"</span>}
          />
        </Section>
      )}

      {/* Market context Claude saw */}
      {symbol ? (
        <Section label="Market context Claude saw">
          {bid != null && ask != null && (
            <DetailRow label="Quote" value={`bid ${bid.toFixed(2)} / ask ${ask.toFixed(2)}`} />
          )}
          {todayBar && (
            <DetailRow
              label="Day OHLC"
              value={`O ${todayBar.open.toFixed(2)} · H ${todayBar.high.toFixed(2)} · L ${todayBar.low.toFixed(2)}`}
            />
          )}
          {todayBar && tech?.avgVolume30d != null && (
            <DetailRow
              label="Volume"
              value={`${formatVolume(todayBar.volume)} / ${formatVolume(tech.avgVolume30d)} avg`}
            />
          )}
          {tech?.rsi14 != null && <DetailRow label="RSI 14" value={rsiBadge(tech.rsi14)} />}
          {(tech?.sma20 != null || tech?.sma50 != null || tech?.sma200 != null) && (
            <DetailRow
              label="SMA stack"
              value={
                <span className="font-mono">
                  {tech?.sma20 != null ? `20: $${tech.sma20.toFixed(2)}` : "20: —"} ·{" "}
                  {tech?.sma50 != null ? `50: $${tech.sma50.toFixed(2)}` : "50: —"} ·{" "}
                  {tech?.sma200 != null ? `200: $${tech.sma200.toFixed(2)}` : "200: —"}
                </span>
              }
            />
          )}
          {tech?.pricePosVsSma50Pct != null && (
            <DetailRow label="vs 50d SMA" value={signedPct(tech.pricePosVsSma50Pct)} />
          )}
          {tech?.fiftyTwoWeekHigh != null && (
            <DetailRow
              label="52w high"
              value={
                <span>
                  ${tech.fiftyTwoWeekHigh.toFixed(2)}{" "}
                  {tech.pctFromFiftyTwoWeekHigh != null && (
                    <span className="text-zinc-500">({signedPct(tech.pctFromFiftyTwoWeekHigh)})</span>
                  )}
                </span>
              }
            />
          )}
          {tech?.fiftyTwoWeekLow != null && (
            <DetailRow
              label="52w low"
              value={
                <span>
                  ${tech.fiftyTwoWeekLow.toFixed(2)}{" "}
                  {tech.pctFromFiftyTwoWeekLow != null && (
                    <span className="text-zinc-500">(+{tech.pctFromFiftyTwoWeekLow.toFixed(1)}%)</span>
                  )}
                </span>
              }
            />
          )}
          {tech?.atr14PctOfPrice != null && (
            <DetailRow label="ATR %" value={`${tech.atr14PctOfPrice.toFixed(2)}%`} />
          )}
          {tech?.relativeVolume30d != null && (
            <DetailRow label="Rel vol 30d" value={`${tech.relativeVolume30d.toFixed(2)}×`} />
          )}
        </Section>
      ) : (
        <Section label="Market context Claude saw">
          <div className="text-zinc-500 text-[11px]">No snapshot captured for {d.symbol}.</div>
        </Section>
      )}

      {/* Last 5 sessions */}
      {bars.length > 0 && (
        <Section label="Last 5 sessions">
          <div className="overflow-x-auto -mx-1">
            <table className="w-full font-mono text-[11px] tabular-digits">
              <thead>
                <tr className="text-zinc-500 text-[9px] uppercase tracking-wider">
                  <th className="text-left font-medium px-1 py-0.5">Date</th>
                  <th className="text-right font-medium px-1 py-0.5">O</th>
                  <th className="text-right font-medium px-1 py-0.5">H</th>
                  <th className="text-right font-medium px-1 py-0.5">L</th>
                  <th className="text-right font-medium px-1 py-0.5">C</th>
                  <th className="text-right font-medium px-1 py-0.5">Vol</th>
                </tr>
              </thead>
              <tbody>
                {[...bars]
                  .slice(-5)
                  .reverse()
                  .map((b, i) => {
                    const up = b.close >= b.open;
                    return (
                      <tr key={i} className="border-t border-zinc-900/60">
                        <td className="px-1 py-0.5 text-zinc-500">{shortDate(b.date)}</td>
                        <td className="px-1 py-0.5 text-right text-zinc-400">{b.open.toFixed(2)}</td>
                        <td className="px-1 py-0.5 text-right text-zinc-400">{b.high.toFixed(2)}</td>
                        <td className="px-1 py-0.5 text-right text-zinc-400">{b.low.toFixed(2)}</td>
                        <td
                          className={cn(
                            "px-1 py-0.5 text-right font-bold",
                            up ? "text-emerald-300" : "text-red-300",
                          )}
                        >
                          {b.close.toFixed(2)}
                        </td>
                        <td className="px-1 py-0.5 text-right text-zinc-500">
                          {formatVolume(b.volume)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Earnings card */}
      {earnings && (earnings.epsActual != null || earnings.revActual != null || earnings.date) && (
        <Section label={`Earnings · ${earnings.date}${earnings.hour ? ` (${earnings.hour})` : ""}`}>
          {earnings.epsActual != null && earnings.epsEstimate != null && (
            <DetailRow
              label="EPS"
              value={
                <span className="font-mono">
                  <span className={cn(epsBeat ? "text-emerald-400" : "text-red-400")}>
                    ${earnings.epsActual.toFixed(2)}
                  </span>{" "}
                  <span className="text-zinc-500">vs ${earnings.epsEstimate.toFixed(2)} est</span>
                  {epsSurprisePct != null && (
                    <>
                      {" "}
                      <span
                        className={cn(
                          "font-mono text-[10px]",
                          epsBeat ? "text-emerald-400" : "text-red-400",
                        )}
                      >
                        ({epsBeat ? "+" : ""}
                        {epsSurprisePct.toFixed(1)}%)
                      </span>
                    </>
                  )}
                </span>
              }
            />
          )}
          {earnings.revActual != null && earnings.revEstimate != null && (
            <DetailRow
              label="Revenue"
              value={
                <span className="font-mono">
                  <span className={cn(revBeat ? "text-emerald-400" : "text-red-400")}>
                    {formatRevenue(earnings.revActual)}
                  </span>{" "}
                  <span className="text-zinc-500">vs {formatRevenue(earnings.revEstimate)} est</span>
                  {revSurprisePct != null && (
                    <>
                      {" "}
                      <span
                        className={cn(
                          "font-mono text-[10px]",
                          revBeat ? "text-emerald-400" : "text-red-400",
                        )}
                      >
                        ({revBeat ? "+" : ""}
                        {revSurprisePct.toFixed(1)}%)
                      </span>
                    </>
                  )}
                </span>
              }
            />
          )}
          {(earnings.quarter != null || earnings.hour) && (
            <DetailRow
              label="Quarter"
              value={`${earnings.quarter != null ? `Q${earnings.quarter}` : "—"}${earnings.hour ? ` · ${earnings.hour}` : ""}`}
            />
          )}
        </Section>
      )}

      {/* News & sentiment */}
      {(headlines.length > 0 || sentiment) && (
        <Section
          label={`News & sentiment${sentiment ? ` (${headlines.length} headlines, ${sentiment.scoredCount} scored)` : ""}`}
        >
          {sentiment && (
            <DetailRow
              label="Mood"
              value={
                <span className="flex items-baseline gap-1.5 flex-wrap">
                  <span
                    className={cn(
                      "font-bold uppercase",
                      sentimentMood(sentiment) === "bullish" && "text-emerald-400",
                      sentimentMood(sentiment) === "bearish" && "text-red-400",
                      sentimentMood(sentiment) === "neutral" && "text-zinc-400",
                      sentimentMood(sentiment) === "mixed" && "text-amber-400",
                    )}
                  >
                    {sentimentMood(sentiment)}
                  </span>
                  {sentiment.averageScore != null && (
                    <span className="font-mono text-zinc-300">
                      · score{" "}
                      <span className={cn(sentiment.averageScore > 0 ? "text-emerald-400" : "text-red-400")}>
                        {sentiment.averageScore > 0 ? "+" : ""}
                        {sentiment.averageScore.toFixed(2)}
                      </span>
                    </span>
                  )}
                  <span className="text-zinc-600 text-[10px]">
                    {sentiment.bullishCount} bull · {sentiment.neutralCount} neutral ·{" "}
                    {sentiment.bearishCount} bear
                  </span>
                </span>
              }
            />
          )}
          {headlines.length > 0 && (
            <div className="mt-1 space-y-1">
              {headlines.slice(0, 5).map((h, i) => {
                const lab = headlineLabelLookup.get(h.headline);
                return (
                  <HeadlineRow
                    key={i}
                    headline={h.headline}
                    source={h.source}
                    label={lab?.label}
                    score={lab?.score}
                    rationale={lab?.rationale}
                  />
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* Position context at decision time */}
      <Section label="Your position at decision time">
        {account == null ? (
          <div className="text-zinc-500 text-[11px]">
            Position context not captured for this run.
          </div>
        ) : (
          <>
            {position ? (
              <>
                <DetailRow
                  label="Holding"
                  value={
                    <span className="font-mono">
                      {position.qty} sh · avg ${position.avgEntry.toFixed(2)}
                    </span>
                  }
                />
                <DetailRow
                  label="Unrealized"
                  value={
                    <span
                      className={cn(
                        "font-mono",
                        position.unrealizedPl > 0 ? "text-emerald-400" : "text-red-400",
                      )}
                    >
                      {position.unrealizedPl > 0 ? "+" : ""}${position.unrealizedPl.toFixed(2)} (
                      {signedPct(position.unrealizedPlPct)})
                    </span>
                  }
                />
                {account.equity > 0 && (
                  <DetailRow
                    label="Book weight"
                    value={
                      <span className="font-mono">
                        {((position.qty * position.current) / account.equity * 100).toFixed(1)}%
                      </span>
                    }
                  />
                )}
              </>
            ) : (
              <div className="text-zinc-500 text-[11px]">Not currently held — fresh entry</div>
            )}
            <DetailRow label="Cash" value={`$${account.cash.toLocaleString()}`} />
            <DetailRow label="Buying power" value={`$${account.buyingPower.toLocaleString()}`} />
          </>
        )}
      </Section>

      {/* Outcome */}
      <Section label="Outcome">
        {outcome?.kind === "filled" && order ? (
          <>
            <DetailRow
              label="Order status"
              value={
                <span className="font-mono">
                  {order.orderStatus.toLowerCase()} · qty {order.qty}
                </span>
              }
            />
            {order.filledAvgPrice && <DetailRow label="Avg fill" value={`$${order.filledAvgPrice}`} />}
            <DetailRow
              label="Order id"
              value={<span className="font-mono text-zinc-400">{order.alpacaOrderId.slice(0, 8)}…</span>}
            />
          </>
        ) : outcome?.kind === "rejected" ? (
          <DetailRow
            label="Validation"
            value={<span className="text-red-300">{outcome.reason}</span>}
          />
        ) : outcome?.kind === "noop" ? (
          <div className="text-zinc-500 text-[11px]">No order placed (plan/hold).</div>
        ) : (
          <div className="text-zinc-500 text-[11px]">No order placed.</div>
        )}
        {d.intent_id && (
          <DetailRow
            label="From intent"
            value={
              <span className="font-mono text-amber-300">{String(d.intent_id).slice(0, 8)}…</span>
            }
          />
        )}
      </Section>
    </>
  );
}

function RegimeCard({ regime }: { regime: SnapshotRegimeCard }) {
  const vixTone =
    regime.vixLevel == null
      ? "text-zinc-500"
      : regime.vixLevel < 18
        ? "text-emerald-400"
        : regime.vixLevel > 25
          ? "text-red-400"
          : "text-amber-400";
  const vixTag =
    regime.vixLevel == null
      ? null
      : regime.vixLevel < 18
        ? "low vol"
        : regime.vixLevel > 25
          ? "high vol"
          : "elevated";
  const yieldTone =
    regime.yieldSpread10y2y == null
      ? "text-zinc-500"
      : regime.yieldSpread10y2y < 0
        ? "text-red-400"
        : "text-emerald-400";
  const yieldTag =
    regime.yieldSpread10y2y == null ? null : regime.yieldSpread10y2y < 0 ? "inverted" : "normal";

  // Top/bottom sectors by 20d return.
  const ranked = [...regime.sectorMomentum]
    .filter((s) => s.return20dPct != null)
    .sort((a, b) => (b.return20dPct ?? 0) - (a.return20dPct ?? 0));
  const top = ranked.slice(0, 3);
  const bot = ranked.slice(-3).reverse();

  return (
    <div className="rounded border border-amber-900/40 bg-amber-950/10 px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400 mb-1.5">
        Macro regime · what Claude saw
      </div>
      <div className="space-y-0.5 font-mono text-[11px]">
        <DetailRow
          label="VIX"
          value={
            regime.vixLevel != null ? (
              <span className="font-mono">
                <span className={vixTone}>{regime.vixLevel.toFixed(1)}</span>
                {vixTag && <span className="text-zinc-500 text-[10px]"> ({vixTag})</span>}
              </span>
            ) : (
              <span className="text-zinc-600">—</span>
            )
          }
        />
        <DetailRow
          label="Yield 10y-2y"
          value={
            regime.yieldSpread10y2y != null ? (
              <span className="font-mono">
                <span className={yieldTone}>
                  {regime.yieldSpread10y2y > 0 ? "+" : ""}
                  {regime.yieldSpread10y2y.toFixed(2)}%
                </span>
                {yieldTag && <span className="text-zinc-500 text-[10px]"> ({yieldTag})</span>}
              </span>
            ) : (
              <span className="text-zinc-600">—</span>
            )
          }
        />
        <DetailRow
          label="DXY"
          value={
            regime.dxy != null ? regime.dxy.toFixed(2) : <span className="text-zinc-600">—</span>
          }
        />
        {top.length > 0 && (
          <DetailRow
            label="Top sectors"
            value={
              <span className="text-emerald-400">
                {top.map((s) => s.label).join(" · ")}
              </span>
            }
          />
        )}
        {bot.length > 0 && (
          <DetailRow
            label="Bot sectors"
            value={<span className="text-red-400">{bot.map((s) => s.label).join(" · ")}</span>}
          />
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">{label}</div>
      <div className="space-y-0.5 font-mono text-[11px]">{children}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-24 shrink-0">
        {label}
      </span>
      <span className="text-zinc-300 break-words flex-1">{value}</span>
    </div>
  );
}

function HeadlineRow({
  headline,
  source,
  label,
  rationale,
  score,
}: {
  headline: string;
  source: string;
  label?: SentimentLabel;
  rationale?: string;
  score?: number;
}) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="text-zinc-600 mt-0.5">•</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          {label && (
            <span
              className={cn(
                "text-[9px] font-bold uppercase tracking-wider rounded px-1 py-px border whitespace-nowrap",
                label === "bullish" && "text-emerald-300 border-emerald-900/60 bg-emerald-950/40",
                label === "bearish" && "text-red-300 border-red-900/60 bg-red-950/40",
                label === "neutral" && "text-zinc-400 border-zinc-700 bg-zinc-900/40",
                label === "mixed" && "text-amber-300 border-amber-900/60 bg-amber-950/40",
              )}
            >
              {label}
              {score != null && (
                <span className="ml-1 font-mono">
                  {score > 0 ? "+" : ""}
                  {score.toFixed(1)}
                </span>
              )}
            </span>
          )}
          <span className="text-zinc-300 leading-snug">{headline}</span>
        </div>
        <div className="text-[10px] text-zinc-600 mt-0.5">{source}</div>
        {rationale && (
          <div className="text-[10px] text-zinc-500 italic mt-0.5">↳ {rationale}</div>
        )}
      </div>
    </div>
  );
}

function DetailSkeleton({ lines }: { lines: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3 rounded bg-zinc-900/60 animate-pulse" />
      ))}
    </div>
  );
}

function rsiBadge(rsi: number) {
  const tone = rsi >= 70 || rsi <= 30 ? "text-amber-300" : "text-zinc-300";
  const tag = rsi >= 70 ? "overbought" : rsi <= 30 ? "oversold" : "neutral";
  return (
    <span className={cn("font-mono", tone)}>
      {rsi.toFixed(0)} <span className="text-zinc-500 text-[10px]">({tag})</span>
    </span>
  );
}

function signedPct(pct: number) {
  const cls = pct > 0 ? "text-emerald-400" : pct < 0 ? "text-red-400" : "text-zinc-400";
  return (
    <span className={cn("font-mono", cls)}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function formatVolume(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function formatRevenue(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  return `$${v.toLocaleString()}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sentimentMood(s: NonNullable<SnapshotSymbol["sentiment"]>): SentimentLabel {
  if (s.averageScore != null) {
    if (s.averageScore > 0.2) return "bullish";
    if (s.averageScore < -0.2) return "bearish";
  }
  if (s.bullishCount > s.bearishCount && s.bullishCount > s.neutralCount) return "bullish";
  if (s.bearishCount > s.bullishCount && s.bearishCount > s.neutralCount) return "bearish";
  if (s.bullishCount > 0 && s.bearishCount > 0) return "mixed";
  return "neutral";
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

function fmtTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${fmtDate(unixSec)} ${time}`;
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
      await qc.invalidateQueries({ queryKey: ["me", "recent-fills"] });
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

function PnlSplitRow({
  strategyNet,
  strategyCount,
  directNet,
  directCount,
}: {
  strategyNet: number;
  strategyCount: number;
  directNet: number;
  directCount: number;
}) {
  if (strategyCount === 0 && directCount === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="rounded border border-zinc-800 bg-[var(--color-race-panel)] px-3 py-2">
        <div className="text-[10px] tracking-wider text-zinc-500 uppercase">AI strategy</div>
        <div className={cn("font-semibold tabular-digits", strategyNet > 0 ? "text-emerald-400" : strategyNet < 0 ? "text-red-400" : "text-zinc-300")}>
          {fmtUsdSigned(strategyNet)}
        </div>
        <div className="text-[10px] text-zinc-500">{strategyCount} trade{strategyCount === 1 ? "" : "s"}</div>
      </div>
      <div className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <div className="text-[10px] tracking-wider text-amber-400 uppercase">Discretionary</div>
        <div className={cn("font-semibold tabular-digits", directNet > 0 ? "text-emerald-400" : directNet < 0 ? "text-red-400" : "text-zinc-300")}>
          {fmtUsdSigned(directNet)}
        </div>
        <div className="text-[10px] text-zinc-500">{directCount} trade{directCount === 1 ? "" : "s"}</div>
      </div>
    </div>
  );
}

function IntentsSection({
  pending,
  recent,
  hasRunningRoutine,
  raceState,
}: {
  pending: IntentSummary[];
  recent: IntentSummary[];
  hasRunningRoutine: boolean;
  raceState: "pre_race" | "in_race" | "post_race" | null;
}) {
  const [showComposer, setShowComposer] = useState(false);
  const [firedRunId, setFiredRunId] = useState<string | null>(null);
  const [quotaAfterFire, setQuotaAfterFire] = useState<{
    hourRemaining: number;
    dayRemaining: number;
  } | null>(null);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase">Player intents</div>
        <button
          onClick={() => setShowComposer((v) => !v)}
          className="text-[10px] rounded border border-zinc-700 px-2 py-1 uppercase tracking-wider text-zinc-300 hover:text-white hover:border-zinc-500"
        >
          {showComposer ? "Cancel" : "+ I want…"}
        </button>
      </div>
      {showComposer && (
        <IntentComposer
          onDone={() => setShowComposer(false)}
          hasRunningRoutine={hasRunningRoutine}
          raceState={raceState}
          quotaAfterFire={quotaAfterFire}
          onFiredImmediately={(runId, quota) => {
            setFiredRunId(runId);
            setQuotaAfterFire(quota);
          }}
        />
      )}
      {firedRunId && (
        <FireResultCard runId={firedRunId} onDismiss={() => setFiredRunId(null)} />
      )}
      {pending.length > 0 && (
        <div className="space-y-2 mb-3">
          {pending.map((it) => (
            <PendingIntentCard key={it.id} intent={it} />
          ))}
        </div>
      )}
      {pending.length === 0 && !showComposer && !firedRunId && (
        <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] text-xs text-zinc-500 text-center py-6">
          No pending intents. Add one to override the strategy for a single trade.
        </div>
      )}
      {recent.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <div className="text-[10px] tracking-wider text-zinc-600 uppercase mb-1">Recent outcomes</div>
          {recent.slice(0, 8).map((it) => (
            <RecentIntentRow key={it.id} intent={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function FireResultCard({ runId, onDismiss }: { runId: string; onDismiss: () => void }) {
  const qc = useQueryClient();
  const runQ = useQuery({
    queryKey: ["me", "routine-run", runId],
    queryFn: () => api.meRoutineRun(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && status !== "running" ? false : 1500;
    },
  });
  const run = runQ.data?.run;
  const status = run?.status ?? "running";
  const isTerminal = status !== "running";

  // When the routine finishes, refresh data the result might have changed.
  useEffect(() => {
    if (isTerminal) {
      qc.invalidateQueries({ queryKey: ["me", "open-orders"] });
      qc.invalidateQueries({ queryKey: ["me", "positions"] });
      qc.invalidateQueries({ queryKey: ["me", "routine-runs"] });
      qc.invalidateQueries({ queryKey: ["me", "intents"] });
    }
  }, [isTerminal, qc]);

  const statusClass =
    status === "succeeded"
      ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/5"
      : status === "partial"
        ? "text-amber-300 border-amber-500/40 bg-amber-500/5"
        : status === "validation_failed" || status === "error"
          ? "text-red-300 border-red-500/40 bg-red-500/5"
          : "text-blue-300 border-blue-500/40 bg-blue-500/5";

  return (
    <div className={cn("rounded-lg border p-3 mb-3", statusClass)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider font-bold">
            {status === "running" ? "Box, box…" : `Routine ${status}`}
          </span>
          {run?.scheduledSlot && (
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              {run.scheduledSlot}
            </span>
          )}
          {run && run.orders.length > 0 && (
            <span className="text-[10px] text-emerald-300">
              {run.orders.length} order{run.orders.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
        >
          Dismiss
        </button>
      </div>
      {status === "running" && (
        <div className="mt-2 text-xs text-zinc-400">
          Claude is reading your plan and the latest market state. This usually takes 5–15s.
        </div>
      )}
      {runQ.error instanceof ApiError && (
        <div className="mt-2 text-xs text-red-300">
          Couldn't fetch routine status: {runQ.error.message}. The routine may still complete in
          the background.
        </div>
      )}
      {run?.errorText && (
        <div className="mt-2 text-xs text-red-300">{run.errorText}</div>
      )}
      {run?.claudeReasoning && (
        <div className="mt-2 text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
          {run.claudeReasoning}
        </div>
      )}
      {run && run.validationFailures.length > 0 && (
        <div className="mt-2 space-y-1">
          {run.validationFailures.slice(0, 5).map((f, i) => (
            <div key={i} className="text-[11px] text-red-300/90">
              {f.symbol}: {f.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IntentComposer({
  onDone,
  hasRunningRoutine,
  raceState,
  quotaAfterFire,
  onFiredImmediately,
}: {
  onDone: () => void;
  hasRunningRoutine: boolean;
  raceState: "pre_race" | "in_race" | "post_race" | null;
  quotaAfterFire: { hourRemaining: number; dayRemaining: number } | null;
  onFiredImmediately: (
    runId: string,
    quota: { hourRemaining: number; dayRemaining: number },
  ) => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [binding, setBinding] = useState(true);
  const [ttlHours, setTtlHours] = useState("24");
  const [fireImmediately, setFireImmediately] = useState(false);

  const placeM = useMutation({
    mutationFn: () =>
      api.meCreateIntent({
        text: text.trim(),
        bindingNextSlot: fireImmediately ? true : binding,
        ttlHours: binding || fireImmediately ? 24 : Math.max(1, Math.min(72, Number(ttlHours) || 24)),
        fireImmediately,
      }),
    onSuccess: async (resp) => {
      setText("");
      await qc.invalidateQueries({ queryKey: ["me", "intents"] });
      if (resp.fireNow) {
        onFiredImmediately(resp.fireNow.runId, {
          hourRemaining: resp.fireNow.rateLimit.hourRemaining,
          dayRemaining: resp.fireNow.rateLimit.dayRemaining,
        });
        await qc.invalidateQueries({ queryKey: ["me", "routine-runs"] });
      }
      onDone();
    },
  });

  const err = placeM.error as ApiError | null;
  const fireBlockedReason: string | null = !fireImmediately
    ? null
    : raceState !== "in_race"
      ? raceState === "pre_race"
        ? "Available once the race starts"
        : "Race is over"
      : hasRunningRoutine
        ? "A routine is already running"
        : null;
  const canSubmit = text.trim().length >= 3 && !fireBlockedReason;

  return (
    <div className="rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 mb-3 space-y-3">
      <div className="text-[10px] tracking-wider text-blue-300 uppercase">
        Intent — Claude must address this. Bypasses the universe restriction; risk caps still apply.
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. buy 5 AAPL at market, or scale into NVDA on weakness"
        rows={2}
        className="w-full text-sm rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 placeholder:text-zinc-600"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={() => {
            setBinding(true);
            if (fireImmediately) {
              /* keep fire-immediately on; binding becomes implied */
            }
          }}
          disabled={fireImmediately}
          className={cn(
            "rounded px-2 py-1 uppercase tracking-wider text-[10px]",
            binding || fireImmediately
              ? "bg-blue-500/30 text-blue-100 border border-blue-400"
              : "border border-zinc-700 text-zinc-400",
            fireImmediately && "opacity-60 cursor-not-allowed",
          )}
        >
          Binding (next slot)
        </button>
        <button
          onClick={() => setBinding(false)}
          disabled={fireImmediately}
          className={cn(
            "rounded px-2 py-1 uppercase tracking-wider text-[10px]",
            !binding && !fireImmediately
              ? "bg-blue-500/30 text-blue-100 border border-blue-400"
              : "border border-zinc-700 text-zinc-400",
            fireImmediately && "opacity-40 cursor-not-allowed",
          )}
        >
          Standing
        </button>
        {!binding && !fireImmediately && (
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-500">TTL</span>
            <input
              value={ttlHours}
              onChange={(e) => setTtlHours(e.target.value)}
              inputMode="numeric"
              className="w-14 rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
            />
            <span className="text-zinc-500">hours (max 72)</span>
          </div>
        )}
      </div>
      <div className="flex items-start gap-2 rounded border border-blue-400/30 bg-blue-500/5 p-2">
        <input
          id="fire-immediately"
          type="checkbox"
          checked={fireImmediately}
          onChange={(e) => setFireImmediately(e.target.checked)}
          className="mt-0.5 accent-blue-400"
        />
        <label htmlFor="fire-immediately" className="text-xs text-zinc-300 cursor-pointer flex-1">
          <span className="font-semibold text-blue-100">Fire immediately</span>{" "}
          <span className="text-zinc-500">
            — also kick off a routine right now (5/hour, 15/day; race must be live).
          </span>
          {quotaAfterFire && (
            <span className="ml-1 text-[11px] text-zinc-400">
              · {quotaAfterFire.hourRemaining} left this hour ·{" "}
              {quotaAfterFire.dayRemaining} today
            </span>
          )}
          {fireBlockedReason && (
            <span className="ml-1 text-[11px] text-amber-300">· {fireBlockedReason}</span>
          )}
        </label>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-red-400 min-h-[1em]">{err ? err.message : ""}</div>
        <button
          onClick={() => placeM.mutate()}
          disabled={!canSubmit || placeM.isPending}
          className="text-xs rounded border border-blue-400 bg-blue-500/20 px-3 py-1.5 uppercase tracking-wider font-semibold text-blue-100 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {placeM.isPending
            ? fireImmediately
              ? "Firing…"
              : "Submitting…"
            : fireImmediately
              ? "Submit & fire"
              : "Submit intent"}
        </button>
      </div>
    </div>
  );
}

function PendingIntentCard({ intent }: { intent: IntentSummary }) {
  const qc = useQueryClient();
  const cancelM = useMutation({
    mutationFn: () => api.meCancelIntent(intent.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "intents"] }),
  });
  const ttl = Math.max(0, intent.expiresAt - Math.floor(Date.now() / 1000));
  const ttlLabel = ttl > 3600 ? `${Math.floor(ttl / 3600)}h` : `${Math.max(1, Math.floor(ttl / 60))}m`;
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 flex items-start gap-3">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider rounded bg-blue-500/30 px-1.5 py-0.5 text-blue-100">
            {intent.bindingNextSlot ? "Binding" : "Standing"}
          </span>
          <span className="text-[10px] text-zinc-500">expires in {ttlLabel}</span>
        </div>
        <div className="text-sm text-zinc-200">{intent.text}</div>
      </div>
      <button
        onClick={() => cancelM.mutate()}
        disabled={cancelM.isPending}
        className="text-[10px] rounded border border-zinc-700 px-2 py-1 uppercase tracking-wider text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
      >
        {cancelM.isPending ? "…" : "Withdraw"}
      </button>
    </div>
  );
}

function RecentIntentRow({ intent }: { intent: IntentSummary }) {
  const palette: Record<IntentSummary["status"], string> = {
    pending: "border-zinc-700 text-zinc-400",
    honored: "border-emerald-500/40 bg-emerald-500/5 text-emerald-200",
    rejected: "border-red-500/40 bg-red-500/5 text-red-200",
    expired: "border-zinc-700 bg-zinc-800/30 text-zinc-500",
  };
  return (
    <div className={cn("rounded border px-2.5 py-1.5 text-xs", palette[intent.status])}>
      <div className="flex items-center justify-between gap-2">
        <span className="uppercase tracking-wider text-[10px] font-semibold">{intent.status}</span>
        {intent.consumedAt && (
          <span className="text-[10px] opacity-70">{new Date(intent.consumedAt * 1000).toLocaleString()}</span>
        )}
      </div>
      <div className="mt-0.5 truncate">{intent.text}</div>
      {intent.rejectedReason && <div className="mt-0.5 text-[11px] opacity-80">{intent.rejectedReason}</div>}
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

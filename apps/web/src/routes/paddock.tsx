import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoutineSlot } from "shared/routine";
import { ROUTINE_SLOTS } from "shared/routine";
import { api, ApiError, type AdminTestRun } from "../lib/api";
import { cn } from "../lib/utils";

const SLOT_LABELS: Record<RoutineSlot, string> = {
  premarket: "09:15 · Premarket",
  open: "09:35 · Open",
  midmorning: "11:30 · Midmorning",
  afternoon: "14:00 · Afternoon",
  close: "15:45 · Close",
};

export function PaddockPage() {
  const qc = useQueryClient();
  const runsQ = useQuery({
    queryKey: ["admin", "test-runs"],
    queryFn: api.adminTestRuns,
    refetchInterval: (q) => {
      const data = q.state.data as { runs: AdminTestRun[] } | undefined;
      if (data?.runs.some((r) => r.status === "running")) return 2000;
      return false;
    },
  });

  const [instruction, setInstruction] = useState("");

  const fireM = useMutation({
    mutationFn: (slot: RoutineSlot) =>
      api.fireTestRoutine({ slot, oneShotInstruction: instruction.trim() || undefined }),
    onSuccess: () => {
      setInstruction("");
      qc.invalidateQueries({ queryKey: ["admin", "test-runs"] });
    },
  });

  const resetM = useMutation({
    mutationFn: api.resetAdminTestData,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "test-runs"] }),
  });

  const err = (fireM.error ?? resetM.error) as ApiError | null;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Paddock</div>
        <div className="text-2xl font-black tracking-tight mt-1">Solo-test panel</div>
        <div className="mt-1 text-sm text-zinc-500">
          Fire any routine slot against your own Alpaca paper account. Runs are tagged
          <span className="text-zinc-300 font-mono"> admin_test</span> and can be wiped before the real race locks.
        </div>
      </div>

      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4">
        <label className="block mb-3">
          <div className="mb-1.5 text-[10px] tracking-wider text-zinc-500 uppercase">
            One-shot instruction (optional) — appended to the prompt as USER URGENT INSTRUCTION
          </div>
          <textarea
            className="w-full min-h-[60px] rounded bg-black/60 border border-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. I just saw NVDA gap up premarket — lean into that if it holds the gap."
          />
        </label>
        <div className="grid grid-cols-5 gap-2">
          {ROUTINE_SLOTS.map((s) => (
            <button
              key={s}
              onClick={() => fireM.mutate(s)}
              disabled={fireM.isPending}
              className={cn(
                "rounded border border-zinc-700 bg-black/40 px-3 py-2 text-xs tracking-wider uppercase",
                "hover:border-zinc-500 disabled:opacity-40",
              )}
            >
              {fireM.isPending && fireM.variables === s ? "running…" : SLOT_LABELS[s].split(" · ")[1]}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between text-[10px] text-zinc-600">
          <span>Haiku 4.5 · validation layer on · orders land in your paper account</span>
          <button
            onClick={() => resetM.mutate()}
            disabled={resetM.isPending || !runsQ.data?.runs.length}
            className="underline hover:text-zinc-400 disabled:opacity-40"
          >
            Reset admin_test data
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {err.message}
        </div>
      )}

      <TestOrderPanel />

      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase">Recent test runs</div>
          <div className="text-[10px] text-zinc-600">auto-refreshes while any run is in flight</div>
        </div>
        {runsQ.isLoading && (
          <div className="text-sm text-zinc-500">Loading…</div>
        )}
        {runsQ.data?.runs.length === 0 && (
          <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No test runs yet. Fire a slot above.
          </div>
        )}
        {(runsQ.data?.runs ?? []).map((r) => (
          <RunCard key={r.id} run={r} />
        ))}
      </div>
    </div>
  );
}

function TestOrderPanel() {
  const [symbol, setSymbol] = useState("AAPL");
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState(1);
  const [lastOrder, setLastOrder] = useState<null | {
    id: string;
    symbol: string;
    side: string;
    qty: string;
    status: string;
    limit_price: string | null;
  }>(null);
  const m = useMutation({
    mutationFn: () =>
      api.adminTestOrder({
        symbol: symbol.trim().toUpperCase(),
        qty,
        side: "buy",
        type: "limit",
        limit_price: limitPrice,
        time_in_force: "day",
      }),
    onSuccess: (res) => setLastOrder(res.order),
  });
  const err = m.error as ApiError | null;
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4">
      <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase mb-1">Alpaca connectivity test</div>
      <div className="text-[10px] text-zinc-600 mb-3">
        Submits a real paper-trade limit-buy with a price far below market — it won't fill but proves the order path
        end-to-end. On weekends it queues for next open and expires at close.
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <label className="block">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Symbol</div>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="w-24 rounded bg-black/60 border border-zinc-800 px-2 py-1 text-sm tabular-digits"
          />
        </label>
        <label className="block">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Qty</div>
          <input
            type="number"
            min={1}
            max={100}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value) || 1)}
            className="w-20 rounded bg-black/60 border border-zinc-800 px-2 py-1 text-sm tabular-digits"
          />
        </label>
        <label className="block">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Limit $</div>
          <input
            type="number"
            step="0.01"
            value={limitPrice}
            onChange={(e) => setLimitPrice(Number(e.target.value) || 1)}
            className="w-24 rounded bg-black/60 border border-zinc-800 px-2 py-1 text-sm tabular-digits"
          />
        </label>
        <button
          onClick={() => m.mutate()}
          disabled={m.isPending}
          className="rounded bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 disabled:opacity-40"
        >
          {m.isPending ? "submitting…" : "Submit test order"}
        </button>
      </div>
      {err && (
        <div className="mt-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          {err.message}
        </div>
      )}
      {lastOrder && (
        <div className="mt-3 rounded border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200 font-mono">
          <div>
            <span className="font-bold">{lastOrder.side.toUpperCase()}</span> {lastOrder.qty} {lastOrder.symbol} limit ${lastOrder.limit_price}
          </div>
          <div className="text-[10px] text-emerald-400/70 mt-1">
            alpaca_order_id={lastOrder.id} · status={lastOrder.status}
          </div>
          <div className="text-[10px] text-zinc-500 mt-1">
            View at app.alpaca.markets/paper/dashboard/orders
          </div>
        </div>
      )}
    </div>
  );
}

function RunCard({ run }: { run: AdminTestRun }) {
  const [open, setOpen] = useState(false);
  const started = new Date(run.startedAt * 1000);
  const statusClass =
    run.status === "succeeded"
      ? "text-emerald-300 border-emerald-900/60 bg-emerald-950/30"
      : run.status === "partial"
        ? "text-amber-300 border-amber-900/60 bg-amber-950/30"
        : run.status === "running"
          ? "text-zinc-300 border-zinc-700 bg-zinc-800"
          : run.status === "validation_failed"
            ? "text-red-300 border-red-900/60 bg-red-950/30"
            : run.status === "error"
              ? "text-red-200 border-red-900/80 bg-red-950/50"
              : "text-zinc-400 border-zinc-800 bg-black/40";

  return (
    <div className="rounded border border-zinc-800 bg-[var(--color-race-panel)] p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-baseline justify-between gap-3"
      >
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-xs tracking-wider text-zinc-500 uppercase font-mono">
            {run.scheduledSlot ?? "—"}
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

      {open && (
        <div className="mt-4 space-y-4 text-sm">
          {run.errorText && (
            <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-200">
              <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1">Error</div>
              {run.errorText}
            </div>
          )}

          {run.oneShotInstruction && (
            <div>
              <div className="text-[10px] tracking-wider text-zinc-500 uppercase mb-1">
                One-shot instruction
              </div>
              <div className="rounded bg-black/60 px-3 py-2 text-zinc-300 whitespace-pre-wrap">
                {run.oneShotInstruction}
              </div>
            </div>
          )}

          {run.claudeReasoning && (
            <div>
              <div className="text-[10px] tracking-wider text-zinc-500 uppercase mb-1">
                Claude's reasoning · {run.claudeModel}
              </div>
              <div className="rounded bg-black/60 px-3 py-2 text-zinc-300 whitespace-pre-wrap leading-relaxed">
                {run.claudeReasoning}
              </div>
              <div className="mt-2 text-[10px] text-zinc-600 tabular-digits">
                tokens: input={run.tokens.input ?? 0}  output={run.tokens.output ?? 0}  cache_read={run.tokens.cacheRead ?? 0}  cache_write={run.tokens.cacheWrite ?? 0}
              </div>
            </div>
          )}

          {run.decisions && run.decisions.length > 0 && (
            <div>
              <div className="text-[10px] tracking-wider text-zinc-500 uppercase mb-1">
                Decisions ({run.decisions.length})
              </div>
              <div className="space-y-1.5">
                {run.decisions.map((d, i) => (
                  <div
                    key={i}
                    className="rounded border border-zinc-800 bg-black/40 px-3 py-2 text-xs"
                  >
                    <div className="flex items-baseline gap-2 font-mono">
                      <span
                        className={cn(
                          "font-bold uppercase",
                          d.action === "buy" && "text-emerald-400",
                          d.action === "sell" && "text-red-400",
                          d.action === "plan" && "text-amber-400",
                          d.action === "hold" && "text-zinc-500",
                        )}
                      >
                        {d.action}
                      </span>
                      <span className="font-bold">{d.symbol}</span>
                      {d.action !== "plan" && d.action !== "hold" && (
                        <>
                          <span className="text-zinc-500">qty</span>
                          <span>{d.qty}</span>
                          <span className="text-zinc-500">{d.order_type}</span>
                          {d.order_type === "limit" && d.limit_price != null && (
                            <span>@${d.limit_price.toFixed(2)}</span>
                          )}
                          <span className="text-zinc-500">{d.time_in_force}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 text-zinc-400">{d.rationale}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {run.validationFailures.length > 0 && (
            <div>
              <div className="text-[10px] tracking-wider text-red-400 uppercase mb-1">
                Validation failures
              </div>
              <div className="space-y-1 text-xs">
                {run.validationFailures.map((f, i) => (
                  <div key={i} className="rounded bg-red-950/30 border border-red-900/40 px-3 py-2">
                    <span className="font-mono font-bold text-red-300">{f.symbol}</span>
                    <span className="text-zinc-400"> — {f.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {run.orders.length > 0 && (
            <div>
              <div className="text-[10px] tracking-wider text-emerald-400 uppercase mb-1">
                Orders placed
              </div>
              <div className="space-y-1 text-xs">
                {run.orders.map((o, i) => (
                  <div
                    key={i}
                    className="rounded bg-emerald-950/20 border border-emerald-900/40 px-3 py-2 font-mono"
                  >
                    <span className="font-bold">{o.side.toUpperCase()}</span>{" "}
                    <span>{o.symbol}</span>{" "}
                    <span className="text-zinc-400">qty={o.qty}</span>{" "}
                    <span className="text-zinc-400">status={o.orderStatus}</span>
                    {o.filledAvgPrice && (
                      <span className="text-zinc-400"> @${o.filledAvgPrice}</span>
                    )}
                    <span className="text-zinc-600 ml-2">id={o.alpacaOrderId.slice(0, 8)}…</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

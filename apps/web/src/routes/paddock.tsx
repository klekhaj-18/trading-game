import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TEAM_COLOR_META, type TeamColor } from "shared/auth";
import { api, ApiError, type AdminRoutineRow, type RosterPlayer } from "../lib/api";
import { cn } from "../lib/utils";

const RACE_DURATION_DAYS = 30;

function fmtDateTime(epochSec: number | null): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString();
}

function isoLocalForInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RaceControlPanel() {
  const qc = useQueryClient();
  const raceQ = useQuery({
    queryKey: ["race"],
    queryFn: api.raceState,
    refetchInterval: 30_000,
  });
  const rosterQ = useQuery({
    queryKey: ["admin", "roster"],
    queryFn: api.adminRoster,
    refetchInterval: 30_000,
  });

  const invalidateAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["race"] }),
      qc.invalidateQueries({ queryKey: ["admin", "roster"] }),
    ]);

  const setDatesM = useMutation({
    mutationFn: (input: { startAt: string; endAt: string }) =>
      api.adminSetDates(input.startAt, input.endAt),
    onSuccess: invalidateAll,
  });
  const lockM = useMutation({
    mutationFn: api.adminLockDates,
    onSuccess: invalidateAll,
  });
  const extendM = useMutation({
    mutationFn: (newEndAt: string) => api.adminExtendEnd(newEndAt),
    onSuccess: invalidateAll,
  });
  const resetM = useMutation({
    mutationFn: api.adminUnlockForTesting,
    onSuccess: invalidateAll,
  });

  const [extendOpen, setExtendOpen] = useState(false);
  const [extendDate, setExtendDate] = useState("");
  const [resetConfirm, setResetConfirm] = useState(false);
  const [startConfirm, setStartConfirm] = useState(false);

  const race = raceQ.data;
  const roster = rosterQ.data;
  const error =
    (setDatesM.error ?? lockM.error ?? extendM.error ?? resetM.error) as ApiError | null;

  if (!race || !roster) {
    return (
      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4 text-sm text-zinc-500">
        Loading race control…
      </div>
    );
  }

  const readyCount = roster.players.filter(
    (p) => p.alpacaLinked && p.planState === "approved",
  ).length;
  const total = roster.players.length;

  const startRace = () => {
    const start = new Date();
    const end = new Date(start.getTime() + RACE_DURATION_DAYS * 24 * 60 * 60 * 1000);
    setDatesM.mutate(
      { startAt: start.toISOString(), endAt: end.toISOString() },
      { onSuccess: () => lockM.mutate() },
    );
    setStartConfirm(false);
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Paddock</div>
        <div className="text-2xl font-black tracking-tight mt-1">Race control</div>
      </div>

      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4 space-y-4">
        <RaceStatusBlock race={race} />

        <RosterTable players={roster.players} maxPlayers={roster.maxPlayers} />

        {error && (
          <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error.message}
          </div>
        )}

        {race.state === "pre_race" && (
          <div className="space-y-2">
            <button
              onClick={() => setStartConfirm(true)}
              disabled={setDatesM.isPending || lockM.isPending}
              className="w-full sm:w-auto px-4 py-2.5 rounded bg-red-600 hover:bg-red-500 text-white text-sm font-bold uppercase tracking-wider disabled:opacity-40"
            >
              {setDatesM.isPending || lockM.isPending ? "Starting…" : "🏁 Start race now"}
            </button>
            <p className="text-[11px] text-zinc-500">
              Sets start = now, end = now + {RACE_DURATION_DAYS} days, then locks the start. Only
              players whose plan is <span className="text-zinc-300">approved</span> and Alpaca is
              <span className="text-zinc-300"> linked</span> will trade. Others can join during the
              race; their account starts trading from their next routine slot after they finish
              onboarding.
            </p>
          </div>
        )}

        {race.state === "in_race" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  const cur = race.competitionEndAt
                    ? new Date(race.competitionEndAt * 1000)
                    : new Date();
                  const suggested = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
                  setExtendDate(isoLocalForInput(suggested));
                  setExtendOpen(true);
                }}
                className="px-3 py-2 rounded border border-zinc-700 text-zinc-200 text-xs uppercase tracking-wider hover:bg-zinc-800"
              >
                Extend end
              </button>
              <button
                onClick={() => setResetConfirm(true)}
                className="px-3 py-2 rounded border border-red-900/60 text-red-300 bg-red-950/30 text-xs uppercase tracking-wider hover:bg-red-950/50"
              >
                Reset (clear dates)
              </button>
            </div>
            {extendOpen && (
              <div className="rounded border border-zinc-800 bg-black/40 p-3 space-y-2">
                <label className="block">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                    New end date/time (your local TZ)
                  </div>
                  <input
                    type="datetime-local"
                    value={extendDate}
                    onChange={(e) => setExtendDate(e.target.value)}
                    className="mt-1 w-full rounded bg-black/60 border border-zinc-700 px-2 py-1.5 text-sm tabular-digits"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const iso = new Date(extendDate).toISOString();
                      extendM.mutate(iso, {
                        onSuccess: () => setExtendOpen(false),
                      });
                    }}
                    disabled={extendM.isPending || !extendDate}
                    className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs uppercase tracking-wider font-semibold disabled:opacity-40"
                  >
                    {extendM.isPending ? "…" : "Extend"}
                  </button>
                  <button
                    onClick={() => setExtendOpen(false)}
                    className="px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 text-xs uppercase tracking-wider"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {race.state === "post_race" && (
          <button
            onClick={() => setResetConfirm(true)}
            className="w-full sm:w-auto px-3 py-2 rounded border border-zinc-700 text-zinc-200 text-xs uppercase tracking-wider hover:bg-zinc-800"
          >
            Reset (clear dates and start over)
          </button>
        )}
      </div>

      {startConfirm && (
        <ConfirmModal
          title="Start the race now?"
          body={
            <>
              <p>
                The 30-day race will begin <strong>now</strong> and end on{" "}
                <strong>
                  {new Date(
                    Date.now() + RACE_DURATION_DAYS * 24 * 60 * 60 * 1000,
                  ).toLocaleString()}
                </strong>
                .
              </p>
              <p className="mt-2">
                <strong>{readyCount}</strong> of <strong>{total}</strong> players are fully
                onboarded and will start trading at the next routine slot. The remaining{" "}
                <strong>{total - readyCount}</strong> can finish onboarding during the race —
                their account starts trading the next slot after they approve.
              </p>
              <p className="mt-2 text-zinc-500 text-xs">
                Start date will be locked. End date can still be extended later.
              </p>
            </>
          }
          confirmLabel="Start the race"
          confirmTone="danger"
          onConfirm={startRace}
          onCancel={() => setStartConfirm(false)}
        />
      )}

      {resetConfirm && (
        <ConfirmModal
          title="Reset race?"
          body={
            <>
              <p>
                This clears <code>competition_start_at</code> and <code>competition_end_at</code>,
                unlocks dates, and stops all routine cron firings.
              </p>
              <p className="mt-2 text-zinc-500 text-xs">
                Trades, equity snapshots and routine runs already recorded are <em>not</em>{" "}
                deleted — only the race window is cleared. You can start a fresh race afterward.
              </p>
            </>
          }
          confirmLabel="Reset race"
          confirmTone="danger"
          onConfirm={() => {
            resetM.mutate();
            setResetConfirm(false);
          }}
          onCancel={() => setResetConfirm(false)}
        />
      )}
    </div>
  );
}

function RaceStatusBlock({ race }: { race: Awaited<ReturnType<typeof api.raceState>> }) {
  const labelClass = "text-[10px] tracking-wider text-zinc-500 uppercase";
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
      <div>
        <div className={labelClass}>State</div>
        <div
          className={cn(
            "mt-0.5 font-semibold uppercase tracking-wider",
            race.state === "in_race"
              ? "text-emerald-300"
              : race.state === "post_race"
                ? "text-[var(--color-flag-gold)]"
                : "text-zinc-400",
          )}
        >
          {race.state.replace("_", " ")}
        </div>
      </div>
      <div>
        <div className={labelClass}>Lap</div>
        <div className="mt-0.5 tabular-digits">
          {race.lap != null ? `${race.lap} / 30` : "—"}
        </div>
      </div>
      <div>
        <div className={labelClass}>Start</div>
        <div className="mt-0.5 tabular-digits text-zinc-300">
          {fmtDateTime(race.competitionStartAt)}
        </div>
      </div>
      <div>
        <div className={labelClass}>End</div>
        <div className="mt-0.5 tabular-digits text-zinc-300">
          {fmtDateTime(race.competitionEndAt)}
        </div>
      </div>
      {race.datesLocked && (
        <div className="col-span-2 sm:col-span-4 text-[11px] text-zinc-500">
          🔒 Start date locked. End can still be extended.
        </div>
      )}
    </div>
  );
}

function RosterTable({ players, maxPlayers }: { players: RosterPlayer[]; maxPlayers: number }) {
  const slots = [...players, ...Array(Math.max(0, maxPlayers - players.length)).fill(null)];
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[10px] tracking-wider text-zinc-500 uppercase">Roster</div>
        <div className="text-[10px] tabular-digits text-zinc-500">
          {players.filter((p) => p.alpacaLinked && p.planState === "approved").length} of{" "}
          {players.length} ready · {players.length} of {maxPlayers} signed up
        </div>
      </div>
      <div className="space-y-1.5">
        {slots.map((p, i) =>
          p ? <RosterRow key={p.id} player={p} /> : <RosterRow key={`empty-${i}`} player={null} />,
        )}
      </div>
    </div>
  );
}

function RosterRow({ player }: { player: RosterPlayer | null }) {
  if (!player) {
    return (
      <div className="flex items-center gap-3 rounded border border-dashed border-zinc-800 px-3 py-2 text-xs text-zinc-600">
        <span className="h-2 w-2 rounded-full bg-zinc-800" />
        Open seat
      </div>
    );
  }
  const hex = TEAM_COLOR_META[player.teamColor as TeamColor]?.hex ?? "#888";
  const ready = player.alpacaLinked && player.planState === "approved";
  const issues: string[] = [];
  if (!player.alpacaLinked) issues.push("link Alpaca");
  if (player.planState === "none") issues.push("write playbook");
  else if (player.planState === "pending") issues.push("plan pending approval");
  else if (player.planState === "rejected") issues.push("plan was rejected");
  else if (player.planState === "superseded") issues.push("re-approve playbook");
  const tone = ready ? "border-emerald-900/60 bg-emerald-950/20" : "border-amber-900/60 bg-amber-950/20";
  return (
    <div
      className={cn("rounded border px-3 py-2 text-xs", tone)}
      style={{ borderLeft: `3px solid ${hex}` }}
    >
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 rounded-full" style={{ background: hex }} />
        <span className="font-semibold text-sm">{player.displayName}</span>
        {player.isAdmin && (
          <span className="text-[9px] uppercase tracking-wider rounded bg-[var(--color-flag-gold)]/20 text-[var(--color-flag-gold)] px-1.5 py-0.5 font-bold">
            Admin
          </span>
        )}
        <div className="flex-1" />
        {ready ? (
          <span className="text-[10px] uppercase tracking-wider text-emerald-300">Ready</span>
        ) : (
          <span className="text-[10px] text-amber-300">{issues.join(", ")}</span>
        )}
        {player.alpacaLinked && <ResyncAlpacaButton player={player} />}
      </div>
    </div>
  );
}

function ResyncAlpacaButton({ player }: { player: RosterPlayer }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.adminResyncUserAlpaca(player.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "positions"] });
      qc.invalidateQueries({ queryKey: ["me", "open-orders"] });
    },
  });
  const data = m.data;
  const err = m.error as ApiError | null;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => m.mutate()}
        disabled={m.isPending}
        title="Bust this player's positions+open-orders KV cache and force-fetch from Alpaca. Use when their Pit Wall disagrees with Alpaca."
        className="text-[10px] uppercase tracking-wider rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40"
      >
        {m.isPending ? "syncing…" : "Resync Alpaca"}
      </button>
      {err && (
        <span className="text-[10px] text-red-300 font-mono">{err.message}</span>
      )}
      {data && !err && (
        <span className="text-[10px] font-mono">
          {data.positions.ok ? (
            <span className="text-emerald-300">
              {data.positions.count ?? 0} pos · {data.openOrders.count ?? 0} ord
              {data.account.ok && (
                <span className="text-zinc-500"> · acct {data.account.accountId?.slice(0, 8)}</span>
              )}
            </span>
          ) : (
            <span className="text-red-300">positions: {data.positions.error}</span>
          )}
        </span>
      )}
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  confirmTone,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmTone: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-950 p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-bold">{title}</div>
        <div className="text-sm text-zinc-300 space-y-1">{body}</div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-3 py-2 rounded border border-zinc-700 text-zinc-300 text-xs uppercase tracking-wider hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              "px-3 py-2 rounded text-xs uppercase tracking-wider font-semibold",
              confirmTone === "danger"
                ? "bg-red-600 hover:bg-red-500 text-white"
                : "bg-emerald-600 hover:bg-emerald-500 text-white",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

type CronTrigger = {
  label: string;
  cron: string;
  hint: string;
  /** "async" returns instantly (waitUntil); only safe for slots that finish in seconds. "sync" awaits the work and keeps the request open until completion (needed for routines that take 60-90s). */
  mode: "async" | "sync";
};

const CRON_TRIGGERS: CronTrigger[] = [
  { label: "Warm (12:45)", cron: "45 12 * * MON-FRI", hint: "Refresh union-universe factors only — fast, runs in background", mode: "async" },
  { label: "Premarket (13:15)", cron: "15 13 * * MON-FRI", hint: "Run premarket routine for all approved players — awaits completion (~60-90s)", mode: "sync" },
  { label: "Open (13:35)", cron: "35 13 * * MON-FRI", hint: "Run open routine for all approved players — awaits completion", mode: "sync" },
  { label: "Midmorning (15:30)", cron: "30 15 * * MON-FRI", hint: "Run midmorning routine for all approved players — awaits completion", mode: "sync" },
  { label: "Afternoon (18:00)", cron: "0 18 * * MON-FRI", hint: "Run afternoon routine for all approved players — awaits completion", mode: "sync" },
  { label: "Close (19:45)", cron: "45 19 * * MON-FRI", hint: "Run close routine for all approved players — awaits completion", mode: "sync" },
];

function ManualCronTriggerPanel() {
  const [lastFired, setLastFired] = useState<
    { label: string; cron: string; at: number; mode: "async" | "sync"; durationMs?: number } | null
  >(null);
  const m = useMutation({
    mutationFn: (t: CronTrigger) =>
      t.mode === "sync" ? api.adminTriggerCronSync(t.cron) : api.adminTriggerCron(t.cron),
    onSuccess: (res, vars) =>
      setLastFired({
        label: vars.label,
        cron: vars.cron,
        at: Date.now(),
        mode: vars.mode,
        durationMs:
          vars.mode === "sync"
            ? (res as unknown as { durationMs: number }).durationMs
            : undefined,
      }),
  });
  const err = m.error as ApiError | null;
  return (
    <div>
      <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">All-players</div>
      <div className="text-2xl font-black tracking-tight mt-1">Manual cron trigger</div>
      <div className="mt-1 text-sm text-zinc-500">
        Fire a slot for <strong>every approved + Alpaca-linked player</strong>, exactly as the scheduler
        would. Routine slots wait for the work to finish before responding (≈60–90s); warm returns
        instantly. Race must be <em>in_race</em>; otherwise the worker skips.
      </div>
      <div className="mt-3 rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {CRON_TRIGGERS.map((t) => (
            <button
              key={t.cron}
              title={t.hint}
              onClick={() => m.mutate(t)}
              disabled={m.isPending}
              className={cn(
                "rounded border border-zinc-700 bg-black/40 px-3 py-2 text-xs tracking-wider uppercase",
                "hover:border-zinc-500 disabled:opacity-40 text-left",
              )}
            >
              {m.isPending && m.variables?.cron === t.cron
                ? t.mode === "sync"
                  ? "running… (60–90s)"
                  : "firing…"
                : t.label}
            </button>
          ))}
        </div>
        {err && (
          <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {err.message}
          </div>
        )}
        {lastFired && !err && (
          <div className="rounded border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            {lastFired.mode === "sync" ? "Completed" : "Fired"}{" "}
            <span className="font-mono">{lastFired.label}</span>
            <span className="text-zinc-500"> · cron </span>
            <span className="font-mono">{lastFired.cron}</span>
            {lastFired.durationMs != null && (
              <>
                <span className="text-zinc-500"> · </span>
                <span className="tabular-digits">{(lastFired.durationMs / 1000).toFixed(1)}s</span>
              </>
            )}
            <span className="text-zinc-500"> · {new Date(lastFired.at).toLocaleTimeString()}</span>
            <div className="mt-1 text-[10px] text-zinc-500">
              Runs land in <span className="font-mono">routine_runs</span> with kind=
              <span className="font-mono">scheduled</span>; check Pit Wall radio per player.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PaddockPage() {
  return (
    <div className="space-y-6">
      <RaceControlPanel />
      <ManualCronTriggerPanel />
      <AllRoutinesPanel />
      <TestOrderPanel />
    </div>
  );
}

function AllRoutinesPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const runsQ = useQuery({
    queryKey: ["admin", "routines"],
    queryFn: () => api.adminListRoutines(50),
    refetchInterval: (q) => {
      const data = q.state.data as { runs: AdminRoutineRow[] } | undefined;
      if (data?.runs.some((r) => r.status === "running")) return 2000;
      return false;
    },
  });

  const killM = useMutation({
    mutationFn: (id: string) => api.adminKillRoutine(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "routines"] }),
  });

  const runs = runsQ.data?.runs ?? [];
  const runningCount = runs.filter((r) => r.status === "running").length;
  const err = (runsQ.error ?? killM.error) as ApiError | null;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-baseline justify-between gap-3 text-left"
      >
        <div>
          <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Admin</div>
          <div className="text-2xl font-black tracking-tight mt-1">
            All routines
            {runningCount > 0 && (
              <span className="ml-3 align-middle text-[11px] font-bold uppercase tracking-wider rounded px-2 py-0.5 border border-amber-500/60 bg-amber-500/15 text-amber-200">
                {runningCount} running
              </span>
            )}
            {runs.length > 0 && runningCount === 0 && (
              <span className="ml-3 align-middle text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                {runs.length} recent
              </span>
            )}
          </div>
        </div>
        <span className="text-zinc-500 text-lg">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {err && (
            <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {err.message}
            </div>
          )}
          {runsQ.isLoading && <div className="text-sm text-zinc-500">Loading…</div>}
          {!runsQ.isLoading && runs.length === 0 && (
            <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No routine runs yet.
            </div>
          )}
          {runs.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              onKill={
                r.status === "running"
                  ? () => {
                      if (
                        confirm(
                          `Kill routine for ${r.displayName}?\n\nslot: ${r.scheduledSlot ?? "—"}\nkind: ${r.kind}\nstarted: ${new Date(r.startedAt * 1000).toLocaleTimeString()}`,
                        )
                      ) {
                        killM.mutate(r.id);
                      }
                    }
                  : undefined
              }
              killPending={killM.isPending && killM.variables === r.id}
            />
          ))}
        </div>
      )}
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

function RunCard({
  run,
  onKill,
  killPending,
}: {
  run: AdminRoutineRow;
  onKill?: () => void;
  killPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
    <div className="rounded border border-zinc-800 bg-[var(--color-race-panel)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-baseline gap-3 min-w-0 flex-1 text-left"
        >
          <span className="text-xs font-bold text-zinc-200 truncate">{run.displayName}</span>
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
        </button>
        {onKill && (
          <button
            onClick={onKill}
            disabled={killPending}
            className="text-[10px] uppercase tracking-wider rounded border border-red-700 bg-red-950/40 px-2 py-1 text-red-200 hover:bg-red-900/50 disabled:opacity-40"
          >
            {killPending ? "killing…" : "kill"}
          </button>
        )}
        <button onClick={() => setOpen((v) => !v)} className="text-zinc-600 px-1">
          {open ? "▾" : "▸"}
        </button>
      </div>

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

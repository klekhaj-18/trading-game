import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { TEAM_COLOR_META, type TeamColor } from "shared/auth";
import type { LeaderboardRange, LeaderboardRow, PublicTickerEvent } from "shared/leaderboard";
import type { RoutineSlot } from "shared/routine";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { EquityChart, type EquityChartMode } from "../components/equity-chart";

const SLOT_LABEL: Record<RoutineSlot, string> = {
  premarket: "Pre-market",
  open: "Open",
  midmorning: "Mid-morning",
  afternoon: "Afternoon",
  close: "Close",
};

const SLOT_HOUR_ET: Record<RoutineSlot, [number, number]> = {
  premarket: [9, 15],
  open: [9, 35],
  midmorning: [11, 30],
  afternoon: [14, 0],
  close: [15, 45],
};

export function LeaderboardPage() {
  const [range, setRange] = useState<LeaderboardRange>("24h");
  const [chartMode, setChartMode] = useState<EquityChartMode>("percent");

  const boardQ = useQuery({
    queryKey: ["leaderboard"],
    queryFn: api.leaderboard,
    refetchInterval: 30_000,
  });
  const seriesQ = useQuery({
    queryKey: ["leaderboard", "series", range],
    queryFn: () => api.leaderboardEquitySeries(range),
    refetchInterval: 60_000,
  });
  const tickerQ = useQuery({
    queryKey: ["events", "ticker"],
    queryFn: () => api.eventsTicker(20),
    refetchInterval: 30_000,
  });
  const raceQ = useQuery({
    queryKey: ["race"],
    queryFn: api.raceState,
    refetchInterval: 30_000,
  });

  const rows = boardQ.data?.players ?? [];
  const ranked = useMemo(() => rankRows(rows), [rows]);

  return (
    <div className="space-y-6">
      <TopBanner raceState={raceQ.data} />

      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {ranked.map((r) => (
            <motion.div
              key={r.row.id}
              layout
              transition={{ type: "spring", stiffness: 300, damping: 28 }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <LeaderboardRowCard row={r.row} rank={r.rank} />
            </motion.div>
          ))}
        </AnimatePresence>
        {ranked.length === 0 && !boardQ.isLoading && (
          <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No players yet.
          </div>
        )}
      </div>

      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4">
        <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
          <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase">Telemetry</div>
          <div className="flex items-center gap-3">
            <div className="flex gap-1 text-[10px]">
              {(["percent", "equity"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setChartMode(m)}
                  className={cn(
                    "rounded px-2 py-0.5 uppercase tracking-wider",
                    chartMode === m
                      ? "bg-zinc-100 text-zinc-900 font-semibold"
                      : "text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  {m === "percent" ? "%" : "$"}
                </button>
              ))}
            </div>
            <div className="flex gap-1 text-[10px]">
              {(["24h", "7d", "30d"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={cn(
                    "rounded px-2 py-0.5 uppercase tracking-wider",
                    range === r
                      ? "bg-zinc-100 text-zinc-900 font-semibold"
                      : "text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>
        <EquityChart series={seriesQ.data?.series ?? []} height={280} mode={chartMode} />
      </div>

      <Ticker events={tickerQ.data?.events ?? []} />
    </div>
  );
}

interface Ranked {
  row: LeaderboardRow;
  rank: number;
}

function rankRows(rows: LeaderboardRow[]): Ranked[] {
  const sorted = [...rows].sort((a, b) => {
    const aHas = a.returnPct != null;
    const bHas = b.returnPct != null;
    if (aHas && bHas) {
      if (b.returnPct! !== a.returnPct!) return b.returnPct! - a.returnPct!;
    } else if (aHas !== bHas) {
      return aHas ? -1 : 1;
    }
    return a.displayName.localeCompare(b.displayName);
  });
  return sorted.map((row, i) => ({ row, rank: i + 1 }));
}

function LeaderboardRowCard({ row, rank }: { row: LeaderboardRow; rank: number }) {
  const hex = TEAM_COLOR_META[row.teamColor as TeamColor]?.hex ?? "#888";
  const changePct24h =
    row.equity != null && row.equity24hAgo != null && row.equity24hAgo > 0
      ? ((row.equity - row.equity24hAgo) / row.equity24hAgo) * 100
      : null;

  const returnTone =
    row.returnPct == null
      ? "text-zinc-500"
      : row.returnPct > 0
        ? "text-emerald-400"
        : row.returnPct < 0
          ? "text-red-400"
          : "text-zinc-300";

  const dayTone =
    changePct24h == null
      ? "text-zinc-500"
      : changePct24h > 0
        ? "text-emerald-400/80"
        : changePct24h < 0
          ? "text-red-400/80"
          : "text-zinc-400";

  return (
    <div
      className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] px-3 py-3 sm:px-4 flex items-center gap-3 sm:gap-4"
      style={{ borderLeft: `4px solid ${hex}` }}
    >
      <div className="flex items-center gap-2 sm:gap-3 sm:min-w-[120px]">
        <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase">P{rank}</div>
        <div className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: hex }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm sm:text-base font-bold break-words">{row.displayName}</div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          {row.teamColor}
        </div>
      </div>
      <div className="text-right shrink-0 sm:min-w-[140px]">
        <div className={cn("text-lg sm:text-2xl font-black tabular-digits", returnTone)}>
          {row.returnPct != null ? fmtSignedPct(row.returnPct) : "—"}
        </div>
        <div className="text-[10px] sm:text-xs tabular-digits text-zinc-500 mt-0.5">
          {row.equity != null ? fmtUsd(row.equity) : "—"}
        </div>
        <div className={cn("text-[10px] sm:text-xs tabular-digits mt-0.5", dayTone)}>
          {changePct24h != null ? `24h ${fmtSignedPct(changePct24h)}` : "no 24h data"}
        </div>
        {(row.strategyTradeCount > 0 || row.directTradeCount > 0) && (
          <div className="text-[9px] sm:text-[10px] tabular-digits text-zinc-500 mt-0.5">
            <span>AI {fmtSignedShort(row.strategyNetRealized)} ({row.strategyTradeCount})</span>
            {" · "}
            <span className={row.directTradeCount > 0 ? "text-amber-400/70" : ""}>
              Direct {fmtSignedShort(row.directNetRealized)} ({row.directTradeCount})
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtSignedPct(p: number): string {
  const sign = p > 0 ? "+" : p < 0 ? "−" : "";
  return `${sign}${Math.abs(p).toFixed(2)}%`;
}

function fmtSignedShort(n: number): string {
  if (n === 0) return "$0";
  const sign = n > 0 ? "+" : "−";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function TopBanner({ raceState }: { raceState: Awaited<ReturnType<typeof api.raceState>> | undefined }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  let primary = "TRADING GRAND PRIX";
  let secondary = "· · ·";
  let tone = "text-zinc-400";

  if (raceState) {
    if (raceState.state === "pre_race") {
      if (raceState.competitionStartAt) {
        secondary = `Starts ${formatRelative(raceState.competitionStartAt - now)}`;
      } else {
        secondary = "Pre-race · Dates not set";
      }
      tone = "text-zinc-400";
    } else if (raceState.state === "in_race") {
      secondary = `Lap ${raceState.lap ?? 0} / 30 · Next routine ${nextRoutineLabel(now)}`;
      tone = "text-emerald-300";
    } else {
      secondary = "Race finished · Chequered flag dropped";
      tone = "text-[var(--color-flag-gold)]";
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-gradient-to-r from-black/60 to-transparent px-5 py-4">
      <div className="text-xs tracking-[0.35em] text-zinc-500 uppercase">{primary}</div>
      <div className={cn("text-xl font-black tracking-tight tabular-digits mt-1", tone)}>
        {secondary}
      </div>
    </div>
  );
}

function Ticker({ events }: { events: PublicTickerEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded border border-dashed border-zinc-800 py-4 text-center text-xs text-zinc-600 uppercase tracking-wider">
        No routine fires yet
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)]">
      <div className="px-4 pt-3 text-[10px] tracking-[0.25em] text-zinc-500 uppercase">
        Radio ticker
      </div>
      <div className="px-4 pb-3 pt-1 max-h-48 overflow-y-auto space-y-1">
        {events.map((e) => {
          const hex = TEAM_COLOR_META[e.teamColor as TeamColor]?.hex ?? "#888";
          return (
            <div key={e.id} className="flex items-baseline gap-3 text-xs">
              <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: hex }} />
              <span className="font-semibold text-zinc-200">{e.displayName}</span>
              <span className="text-zinc-400">
                fired {e.kind === "on_demand" ? "on-demand" : (e.scheduledSlot && e.scheduledSlot !== "warm" ? SLOT_LABEL[e.scheduledSlot] : "scheduled")}
              </span>
              <span className="text-zinc-600 tabular-digits ml-auto">
                {formatRelative(e.startedAt - Math.floor(Date.now() / 1000))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function nextRoutineLabel(nowSec: number): string {
  // Read ET day-of-week + time-of-day via Intl so DST is handled correctly
  // (the previous hardcoded UTC-4 was wrong for EST). Trading-slot crons are
  // gated to MON-FRI in wrangler.toml, so we walk forward day-by-day and
  // skip weekends when picking the next fire. Warm slot fires daily but is
  // intentionally not surfaced — players care about trading routines.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  // 0 = Sun, 1 = Mon, ..., 6 = Sat.
  const DOW: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const today = DOW[weekday] ?? 1;
  const nowMins = hour * 60 + minute;
  const slotEntries = Object.entries(SLOT_HOUR_ET) as [RoutineSlot, [number, number]][];

  let best: { slot: RoutineSlot; deltaMins: number } | null = null;
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const dow = (today + dayOffset) % 7;
    if (dow === 0 || dow === 6) continue; // skip Sun/Sat — trading slots are MON-FRI
    for (const [slot, [h, m]] of slotEntries) {
      const fireFromNow = dayOffset * 24 * 60 + h * 60 + m - nowMins;
      if (fireFromNow <= 0) continue;
      if (best == null || fireFromNow < best.deltaMins) {
        best = { slot, deltaMins: fireFromNow };
      }
    }
    // Once we've found any candidate on day N, the earliest on N is by
    // construction earlier than any fire on day N+1 — stop walking.
    if (best) break;
  }

  void nowSec; // re-render trigger; actual time read is from `new Date()` above
  if (!best) return "Pre-market in 24h";
  return `${SLOT_LABEL[best.slot]} in ${formatCountdown(best.deltaMins)}`;
}

function formatCountdown(mins: number): string {
  if (mins >= 24 * 60) {
    const days = Math.floor(mins / (24 * 60));
    const remMins = mins % (24 * 60);
    const hh = Math.floor(remMins / 60);
    return hh > 0 ? `${days}d ${hh}h` : `${days}d`;
  }
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return hh > 0 ? `${hh}h ${mm.toString().padStart(2, "0")}m` : `${mm}m`;
}

function formatRelative(deltaSec: number): string {
  const abs = Math.abs(deltaSec);
  const past = deltaSec < 0;
  if (abs < 60) return past ? "just now" : "any moment";
  if (abs < 3600) {
    const m = Math.floor(abs / 60);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86400) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    return past ? `${h}h ${m}m ago` : `in ${h}h ${m}m`;
  }
  const d = Math.floor(abs / 86400);
  return past ? `${d}d ago` : `in ${d}d`;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

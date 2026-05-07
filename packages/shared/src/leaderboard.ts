import type { TeamColor } from "./auth";
import type { RoutineKind, ScheduledTouchpoint } from "./routine";

export interface LeaderboardRow {
  id: string;
  displayName: string;
  teamColor: TeamColor;
  equity: number | null;
  equity1hAgo: number | null;
  equity24hAgo: number | null;
  equity7dAgo: number | null;
  lastUpdatedAt: number | null;
  /** Earliest snapshot at-or-after race start. Null pre-race or before the first post-start cron. */
  baselineEquity: number | null;
  /** Total % return from baselineEquity. Drives ranking; null when baseline is null. */
  returnPct: number | null;
  /** Net realized cash flow from AI-mediated trades (sell notional - buy notional). */
  strategyNetRealized: number;
  /** Net realized cash flow from direct (discretionary) trades. */
  directNetRealized: number;
  strategyTradeCount: number;
  directTradeCount: number;
}

export interface LeaderboardResponse {
  players: LeaderboardRow[];
}

export interface LeaderboardEquityPoint {
  t: number;
  equity: number;
}

export interface LeaderboardEquitySeries {
  userId: string;
  displayName: string;
  teamColor: TeamColor;
  points: LeaderboardEquityPoint[];
  /** Earliest snapshot at-or-after race start. 0% baseline for the % return chart; null pre-race. */
  baselineEquity: number | null;
}

export const LEADERBOARD_RANGES = ["24h", "7d", "30d"] as const;
export type LeaderboardRange = (typeof LEADERBOARD_RANGES)[number];

export interface LeaderboardEquitySeriesResponse {
  range: LeaderboardRange;
  series: LeaderboardEquitySeries[];
}

export interface PublicTickerEvent {
  id: string;
  displayName: string;
  teamColor: TeamColor;
  kind: Extract<RoutineKind, "scheduled" | "on_demand">;
  scheduledSlot: ScheduledTouchpoint | null;
  startedAt: number;
}

export interface PublicTickerResponse {
  events: PublicTickerEvent[];
}

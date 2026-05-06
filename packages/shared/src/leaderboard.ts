import type { TeamColor } from "./auth";
import type { RoutineKind, RoutineSlot } from "./routine";

export interface LeaderboardRow {
  id: string;
  displayName: string;
  teamColor: TeamColor;
  equity: number | null;
  equity1hAgo: number | null;
  equity24hAgo: number | null;
  equity7dAgo: number | null;
  lastUpdatedAt: number | null;
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
  scheduledSlot: RoutineSlot | null;
  startedAt: number;
}

export interface PublicTickerResponse {
  events: PublicTickerEvent[];
}

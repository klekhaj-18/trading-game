import { Hono } from "hono";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type {
  LeaderboardEquitySeries,
  LeaderboardEquitySeriesResponse,
  LeaderboardRange,
  LeaderboardResponse,
  LeaderboardRow,
} from "shared/leaderboard";
import { LEADERBOARD_RANGES } from "shared/leaderboard";
import type { TeamColor } from "shared/auth";
import { getDb } from "../db/client";
import { equitySnapshots, users } from "../db/schema";
import { requireSession, type AppEnv } from "../middleware/session";

export const leaderboardRoutes = new Hono<AppEnv>();

leaderboardRoutes.use("*", requireSession);

leaderboardRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const playerRows = await db
    .select({ id: users.id, displayName: users.displayName, teamColor: users.teamColor })
    .from(users)
    .orderBy(asc(users.createdAt));

  const nowSec = Math.floor(Date.now() / 1000);
  const players: LeaderboardRow[] = [];
  for (const p of playerRows) {
    const projection = await getPublicLeaderboardRow(db, p, nowSec);
    players.push(projection);
  }

  const response: LeaderboardResponse = { players };
  return c.json(response);
});

leaderboardRoutes.get("/equity-series", async (c) => {
  const rangeRaw = c.req.query("range") ?? "24h";
  const range = (LEADERBOARD_RANGES as readonly string[]).includes(rangeRaw)
    ? (rangeRaw as LeaderboardRange)
    : "24h";
  const windowSec =
    range === "30d" ? 30 * 24 * 60 * 60 : range === "7d" ? 7 * 24 * 60 * 60 : 24 * 60 * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const since = nowSec - windowSec;

  const db = getDb(c.env.DB);
  const playerRows = await db
    .select({ id: users.id, displayName: users.displayName, teamColor: users.teamColor })
    .from(users)
    .orderBy(asc(users.createdAt));

  const series: LeaderboardEquitySeries[] = [];
  for (const p of playerRows) {
    const snaps = await db
      .select({ t: equitySnapshots.capturedAt, equity: equitySnapshots.equity })
      .from(equitySnapshots)
      .where(
        and(eq(equitySnapshots.userId, p.id), gte(equitySnapshots.capturedAt, since)),
      )
      .orderBy(asc(equitySnapshots.capturedAt));
    series.push({
      userId: p.id,
      displayName: p.displayName,
      teamColor: p.teamColor as TeamColor,
      points: snaps.map((s) => ({ t: s.t, equity: Number(s.equity) })),
    });
  }

  const response: LeaderboardEquitySeriesResponse = { range, series };
  return c.json(response);
});

type DbClient = ReturnType<typeof getDb>;

async function getPublicLeaderboardRow(
  db: DbClient,
  player: { id: string; displayName: string; teamColor: string },
  nowSec: number,
): Promise<LeaderboardRow> {
  const [latest] = await db
    .select({ equity: equitySnapshots.equity, t: equitySnapshots.capturedAt })
    .from(equitySnapshots)
    .where(eq(equitySnapshots.userId, player.id))
    .orderBy(desc(equitySnapshots.capturedAt))
    .limit(1);

  const equity = latest ? Number(latest.equity) : null;
  const lastUpdatedAt = latest?.t ?? null;

  const [hourAgo, dayAgo, weekAgo] = await Promise.all([
    equityAtOrBefore(db, player.id, nowSec - 60 * 60),
    equityAtOrBefore(db, player.id, nowSec - 24 * 60 * 60),
    equityAtOrBefore(db, player.id, nowSec - 7 * 24 * 60 * 60),
  ]);

  return {
    id: player.id,
    displayName: player.displayName,
    teamColor: player.teamColor as TeamColor,
    equity,
    equity1hAgo: hourAgo,
    equity24hAgo: dayAgo,
    equity7dAgo: weekAgo,
    lastUpdatedAt,
  };
}

async function equityAtOrBefore(
  db: DbClient,
  userId: string,
  atSec: number,
): Promise<number | null> {
  const [row] = await db
    .select({ equity: equitySnapshots.equity })
    .from(equitySnapshots)
    .where(
      and(eq(equitySnapshots.userId, userId), lte(equitySnapshots.capturedAt, atSec)),
    )
    .orderBy(desc(equitySnapshots.capturedAt))
    .limit(1);
  return row ? Number(row.equity) : null;
}

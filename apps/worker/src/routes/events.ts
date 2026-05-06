import { Hono } from "hono";
import { and, desc, eq, inArray, ne, or, isNull } from "drizzle-orm";
import type { PublicTickerEvent, PublicTickerResponse } from "shared/leaderboard";
import type { TeamColor } from "shared/auth";
import type { ScheduledTouchpoint } from "shared/routine";
import { getDb } from "../db/client";
import { routineRuns, users } from "../db/schema";
import { requireSession, type AppEnv } from "../middleware/session";

export const eventsRoutes = new Hono<AppEnv>();

eventsRoutes.use("*", requireSession);

eventsRoutes.get("/ticker", async (c) => {
  const limitRaw = Number(c.req.query("limit") ?? "20");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;

  const db = getDb(c.env.DB);
  const runs = await db
    .select({
      id: routineRuns.id,
      userId: routineRuns.userId,
      kind: routineRuns.kind,
      scheduledSlot: routineRuns.scheduledSlot,
      startedAt: routineRuns.startedAt,
    })
    .from(routineRuns)
    .where(
      and(
        inArray(routineRuns.kind, ["scheduled", "on_demand"]),
        // Public ticker is for race activity, not data-prep. Hide warm rows.
        or(isNull(routineRuns.scheduledSlot), ne(routineRuns.scheduledSlot, "warm")),
      ),
    )
    .orderBy(desc(routineRuns.startedAt))
    .limit(limit);

  if (runs.length === 0) {
    const response: PublicTickerResponse = { events: [] };
    return c.json(response);
  }

  const userIds = Array.from(new Set(runs.map((r) => r.userId)));
  const userRows = await db
    .select({ id: users.id, displayName: users.displayName, teamColor: users.teamColor })
    .from(users)
    .where(inArray(users.id, userIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const events: PublicTickerEvent[] = runs.flatMap((r) => {
    const u = userById.get(r.userId);
    if (!u) return [];
    return [
      {
        id: r.id,
        displayName: u.displayName,
        teamColor: u.teamColor as TeamColor,
        kind: r.kind as "scheduled" | "on_demand",
        scheduledSlot: r.scheduledSlot as ScheduledTouchpoint | null,
        startedAt: r.startedAt,
      },
    ];
  });

  const response: PublicTickerResponse = { events };
  return c.json(response);
});

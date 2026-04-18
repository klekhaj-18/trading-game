import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { deriveRaceState, lapOf, setDatesSchema, extendEndSchema } from "shared/race";
import { extendEnd, getRaceConfig, lockDates, unlockForTesting, writeDates } from "../trading/race";
import { requireSession, type AppEnv } from "../middleware/session";

export const raceRoutes = new Hono<AppEnv>();

raceRoutes.get("/", async (c) => {
  const cfg = await getRaceConfig(c.env);
  const nowSec = Math.floor(Date.now() / 1000);
  const state = deriveRaceState(cfg.competitionStartAt, cfg.competitionEndAt, nowSec);
  return c.json({
    state,
    competitionStartAt: cfg.competitionStartAt,
    competitionEndAt: cfg.competitionEndAt,
    datesLocked: cfg.datesLocked,
    nowSec,
    lap: lapOf(cfg.competitionStartAt, nowSec),
    totalLaps: 30 as const,
  });
});

raceRoutes.use("/admin/*", requireSession, async (c, next) => {
  const user = c.get("user");
  if (!user.isAdmin) return c.json({ error: "admin_only" }, 403);
  await next();
});

raceRoutes.post("/admin/set-dates", zValidator("json", setDatesSchema), async (c) => {
  const { startAt, endAt } = c.req.valid("json");
  try {
    await writeDates(c.env, Math.floor(new Date(startAt).getTime() / 1000), Math.floor(new Date(endAt).getTime() / 1000));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "set_dates_failed", message: err instanceof Error ? err.message : String(err) }, 400);
  }
});

raceRoutes.post("/admin/lock-dates", async (c) => {
  try {
    await lockDates(c.env);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "lock_failed", message: err instanceof Error ? err.message : String(err) }, 400);
  }
});

raceRoutes.post("/admin/extend-end", zValidator("json", extendEndSchema), async (c) => {
  const { newEndAt } = c.req.valid("json");
  try {
    await extendEnd(c.env, Math.floor(new Date(newEndAt).getTime() / 1000));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "extend_failed", message: err instanceof Error ? err.message : String(err) }, 400);
  }
});

raceRoutes.post("/admin/unlock-for-testing", async (c) => {
  await unlockForTesting(c.env);
  return c.json({ ok: true });
});

import { eq } from "drizzle-orm";
import { deriveRaceState, type RaceState } from "shared/race";
import { getDb } from "../db/client";
import { settings } from "../db/schema";

export interface RaceConfig {
  competitionStartAt: number | null;
  competitionEndAt: number | null;
  datesLocked: boolean;
}

export async function getRaceConfig(env: Env): Promise<RaceConfig> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  if (!row) {
    await db
      .insert(settings)
      .values({ id: 1, competitionStartAt: null, competitionEndAt: null, datesLocked: false })
      .onConflictDoNothing();
    return { competitionStartAt: null, competitionEndAt: null, datesLocked: false };
  }
  return {
    competitionStartAt: row.competitionStartAt,
    competitionEndAt: row.competitionEndAt,
    datesLocked: Boolean(row.datesLocked),
  };
}

export async function currentRaceState(env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<RaceState> {
  const cfg = await getRaceConfig(env);
  return deriveRaceState(cfg.competitionStartAt, cfg.competitionEndAt, nowSec);
}

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export async function writeDates(env: Env, startAtSec: number, endAtSec: number): Promise<void> {
  if (endAtSec <= startAtSec) throw new Error("endAt must be after startAt");
  if (Math.abs(endAtSec - startAtSec - THIRTY_DAYS) > 60) {
    throw new Error("Competition must be exactly 30 days");
  }
  const cfg = await getRaceConfig(env);
  if (cfg.datesLocked && cfg.competitionStartAt !== startAtSec) {
    throw new Error("Start date is locked");
  }
  const db = getDb(env.DB);
  await db
    .update(settings)
    .set({
      competitionStartAt: startAtSec,
      competitionEndAt: endAtSec,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(settings.id, 1));
}

export async function lockDates(env: Env): Promise<void> {
  const cfg = await getRaceConfig(env);
  if (!cfg.competitionStartAt || !cfg.competitionEndAt) {
    throw new Error("Dates must be set before locking");
  }
  const db = getDb(env.DB);
  await db
    .update(settings)
    .set({ datesLocked: true, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(settings.id, 1));
}

export async function unlockForTesting(env: Env): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(settings)
    .set({
      datesLocked: false,
      competitionStartAt: null,
      competitionEndAt: null,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(settings.id, 1));
}

export async function extendEnd(env: Env, newEndSec: number): Promise<void> {
  const cfg = await getRaceConfig(env);
  if (!cfg.competitionEndAt) throw new Error("No end date set");
  if (newEndSec <= cfg.competitionEndAt) throw new Error("newEnd must be after current end");
  const db = getDb(env.DB);
  await db
    .update(settings)
    .set({ competitionEndAt: newEndSec, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(settings.id, 1));
}

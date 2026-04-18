import { eq, like } from "drizzle-orm";
import type { TeamColor } from "shared/auth";
import { getDb } from "../db/client";
import { equitySnapshots, users } from "../db/schema";
import { hashPassword } from "../auth/password";
import { ulid } from "./ids";

export const DEMO_DISPLAY_PREFIX = "Demo ";

interface DemoSpec {
  displayName: string;
  teamColor: TeamColor;
  driftPerHour: number;
}

const DEMO_USERS: DemoSpec[] = [
  { displayName: "Demo Priya", teamColor: "mercedes", driftPerHour: 0.0012 },
  { displayName: "Demo Alex", teamColor: "mclaren", driftPerHour: 0 },
  { displayName: "Demo Jordan", teamColor: "redbull", driftPerHour: -0.0006 },
];

const STARTING_EQUITY = 100_000;
const HOURS = 30 * 24;
const HOURLY_VOLATILITY = 0.003;

type DbClient = ReturnType<typeof getDb>;

export interface SeedResult {
  created: Array<{ id: string; displayName: string; teamColor: TeamColor; snapshots: number }>;
  skipped: Array<{ displayName: string; reason: string }>;
}

export async function seedDemoUsers(db: DbClient): Promise<SeedResult> {
  const result: SeedResult = { created: [], skipped: [] };
  const nowSec = Math.floor(Date.now() / 1000);
  const unusablePassword = await hashPassword(crypto.randomUUID() + crypto.randomUUID());

  for (const spec of DEMO_USERS) {
    const [nameClash] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.displayName, spec.displayName))
      .limit(1);
    if (nameClash) {
      result.skipped.push({ displayName: spec.displayName, reason: "name_exists" });
      continue;
    }
    const [colorClash] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.teamColor, spec.teamColor))
      .limit(1);
    if (colorClash) {
      result.skipped.push({ displayName: spec.displayName, reason: "color_taken" });
      continue;
    }

    const id = ulid();
    await db.insert(users).values({
      id,
      displayName: spec.displayName,
      passwordHash: unusablePassword,
      teamColor: spec.teamColor,
      onboardedAt: nowSec,
    });

    const snapshots = buildEquityCurve(id, nowSec, spec.driftPerHour);
    const CHUNK = 12;
    for (let i = 0; i < snapshots.length; i += CHUNK) {
      const slice = snapshots.slice(i, i + CHUNK);
      if (slice.length > 0) await db.insert(equitySnapshots).values(slice);
    }

    result.created.push({
      id,
      displayName: spec.displayName,
      teamColor: spec.teamColor,
      snapshots: snapshots.length,
    });
  }
  return result;
}

export async function clearDemoUsers(db: DbClient): Promise<{ deleted: number }> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.displayName, `${DEMO_DISPLAY_PREFIX}%`));
  for (const r of rows) {
    await db.delete(users).where(eq(users.id, r.id));
  }
  return { deleted: rows.length };
}

function buildEquityCurve(userId: string, nowSec: number, driftPerHour: number) {
  let equity = STARTING_EQUITY;
  const rows: Array<typeof equitySnapshots.$inferInsert> = [];
  for (let hoursAgo = HOURS; hoursAgo >= 0; hoursAgo--) {
    const noise = gaussian() * HOURLY_VOLATILITY;
    equity = equity * (1 + driftPerHour + noise);
    if (equity < 80_000) equity = 80_000;
    if (equity > 130_000) equity = 130_000;
    const capturedAt = nowSec - hoursAgo * 3600;
    const cash = equity * 0.4;
    const longMarketValue = equity - cash;
    rows.push({
      id: ulid(),
      userId,
      equity: equity.toFixed(2),
      cash: cash.toFixed(2),
      buyingPower: (cash * 2).toFixed(2),
      longMarketValue: longMarketValue.toFixed(2),
      capturedAt,
    });
  }
  return rows;
}

function gaussian(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 || 1e-9)) * Math.cos(2 * Math.PI * u2);
}

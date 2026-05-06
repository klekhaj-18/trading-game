import { and, eq, isNotNull } from "drizzle-orm";
import type { RoutineSlot } from "shared/routine";
import { getDb } from "../db/client";
import { equitySnapshots, operationalPlans, users } from "../db/schema";
import { ulid } from "../lib/ids";
import { open } from "../lib/crypto";
import { fetchAccount, type AlpacaCreds } from "../lib/alpaca";
import { executeRoutine } from "./execute";
import { currentRaceState } from "../trading/race";

const SLOT_BY_CRON: Record<string, RoutineSlot> = {
  "15 13 * * 1-5": "premarket",
  "35 13 * * 1-5": "open",
  "30 15 * * 1-5": "midmorning",
  "0 18 * * 1-5": "afternoon",
  "45 19 * * 1-5": "close",
};

export async function handleScheduled(cron: string, env: Env, ctx: ExecutionContext): Promise<void> {
  const slot = SLOT_BY_CRON[cron];
  if (!slot) {
    console.warn("unknown cron", cron);
    return;
  }

  const state = await currentRaceState(env);
  if (state !== "in_race") {
    console.log(`cron ${cron} → slot ${slot}: skipped (race_state=${state})`);
    return;
  }

  ctx.waitUntil(runSlotForAllUsers(env, slot));
  ctx.waitUntil(captureEquitySnapshots(env));
}

async function runSlotForAllUsers(env: Env, slot: RoutineSlot): Promise<void> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(operationalPlans, eq(operationalPlans.userId, users.id))
    .where(and(eq(operationalPlans.approvalState, "approved"), isNotNull(users.alpacaKeyCiphertext)));
  const uniqueUsers = Array.from(new Set(rows.map((r) => r.userId)));
  console.log(`slot=${slot} firing for ${uniqueUsers.length} user(s)`);
  await Promise.allSettled(
    uniqueUsers.map((userId) => executeRoutine(env, { userId, slot, kind: "scheduled" })),
  );
}

export async function captureEquitySnapshotForUser(
  env: Env,
  user: typeof users.$inferSelect,
): Promise<boolean> {
  if (!user.alpacaKeyCiphertext || !user.alpacaKeyIv || !user.alpacaSecretCiphertext || !user.alpacaSecretIv) {
    return false;
  }
  try {
    const apiKey = await open(
      { ciphertext: user.alpacaKeyCiphertext, iv: user.alpacaKeyIv },
      env.ALPACA_KEY_ENCRYPTION_KEY,
    );
    const apiSecret = await open(
      { ciphertext: user.alpacaSecretCiphertext, iv: user.alpacaSecretIv },
      env.ALPACA_KEY_ENCRYPTION_KEY,
    );
    const creds: AlpacaCreds = { apiKey, apiSecret };
    const acct = await fetchAccount(creds.apiKey, creds.apiSecret);
    const db = getDb(env.DB);
    await db.insert(equitySnapshots).values({
      id: ulid(),
      userId: user.id,
      equity: acct.equity,
      cash: acct.cash,
      buyingPower: acct.buying_power,
      longMarketValue: acct.long_market_value,
      capturedAt: Math.floor(Date.now() / 1000),
    });
    return true;
  } catch (err) {
    console.error("equity snapshot failed for user", user.id, err);
    return false;
  }
}

export async function captureEquitySnapshots(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const linked = await db
    .select()
    .from(users)
    .where(isNotNull(users.alpacaKeyCiphertext));
  await Promise.allSettled(linked.map((u) => captureEquitySnapshotForUser(env, u)));
}

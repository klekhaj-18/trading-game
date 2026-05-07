import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import type { RoutineSlot } from "shared/routine";
import type { OperationalPlan } from "shared/playbook";
import { getDb } from "../db/client";
import { equitySnapshots, operationalPlans, routineRuns, users } from "../db/schema";
import { ulid } from "../lib/ids";
import { open } from "../lib/crypto";
import { fetchAccount, type AlpacaCreds } from "../lib/alpaca";
import { executeRoutine } from "./execute";
import { currentRaceState } from "../trading/race";
import { refreshFactors } from "../data/factors";

const FACTOR_WARM_CRON = "45 12 * * 1-5";
const EQUITY_TICK_CRON = "*/5 13-20 * * 1-5";

const SLOT_BY_CRON: Record<string, RoutineSlot> = {
  "15 13 * * 1-5": "premarket",
  "35 13 * * 1-5": "open",
  "30 15 * * 1-5": "midmorning",
  "0 18 * * 1-5": "afternoon",
  "45 19 * * 1-5": "close",
};

export async function handleScheduled(cron: string, env: Env, ctx: ExecutionContext): Promise<void> {
  const state = await currentRaceState(env);
  if (state !== "in_race") {
    console.log(`cron ${cron}: skipped (race_state=${state})`);
    return;
  }

  // 5-min equity tick during US market hours: snapshot only, no Claude / no factor refresh.
  // Drives a near-live leaderboard without touching the Anthropic budget.
  if (cron === EQUITY_TICK_CRON) {
    ctx.waitUntil(captureEquitySnapshots(env));
    return;
  }

  // Pre-premarket warm: refresh the union universe 30min before the 13:15
  // premarket routine fires, so routines consume already-warm KV.
  if (cron === FACTOR_WARM_CRON) {
    ctx.waitUntil(refreshFactorsForAllUniverses(env, { triggerLabel: "warm" }));
    ctx.waitUntil(captureEquitySnapshots(env));
    return;
  }

  const slot = SLOT_BY_CRON[cron];
  if (!slot) {
    console.warn("unknown cron", cron);
    return;
  }

  if (slot === "premarket") {
    // Safety net: if the 8:45 warm didn't land a successful row in the last
    // hour (cron failure, deploy gap, partial refresh), rebuild KV inline before
    // routines run. Sequenced inside one waitUntil so routines wait on it.
    ctx.waitUntil((async () => {
      const fresh = await wasWarmRecentlySuccessful(env, 60);
      if (!fresh) {
        console.log("premarket: no successful warm in last 60min — running fallback refresh inline");
        await refreshFactorsForAllUniverses(env, { triggerLabel: "premarket-fallback" });
      }
      await runSlotForAllUsers(env, slot);
    })());
  } else {
    ctx.waitUntil(runSlotForAllUsers(env, slot));
  }
  ctx.waitUntil(captureEquitySnapshots(env));
}

async function wasWarmRecentlySuccessful(env: Env, lookbackMinutes: number): Promise<boolean> {
  try {
    const db = getDb(env.DB);
    const cutoff = Math.floor(Date.now() / 1000) - lookbackMinutes * 60;
    const rows = await db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.scheduledSlot, "warm"),
          eq(routineRuns.status, "succeeded"),
          gt(routineRuns.startedAt, cutoff),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    // If the freshness check itself fails, assume not fresh and let the
    // fallback rebuild — safer than skipping the refresh.
    console.error("wasWarmRecentlySuccessful threw", err);
    return false;
  }
}

interface WarmRefreshOptions {
  /** Identifies who fired the refresh, so the Radio entry distinguishes the scheduled 8:45 warm from the 9:15 fallback. */
  triggerLabel: "warm" | "premarket-fallback";
}

async function refreshFactorsForAllUniverses(env: Env, opts: WarmRefreshOptions): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const db = getDb(env.DB);
  const prefix = opts.triggerLabel === "warm" ? "Pre-premarket warm" : "Warm fallback (09:15)";
  let approvedUserIds: string[] = [];
  try {
    const planRows = await db
      .select({
        userId: operationalPlans.userId,
        planJson: operationalPlans.planJson,
        alpacaKeyCiphertext: users.alpacaKeyCiphertext,
        alpacaKeyIv: users.alpacaKeyIv,
        alpacaSecretCiphertext: users.alpacaSecretCiphertext,
        alpacaSecretIv: users.alpacaSecretIv,
      })
      .from(operationalPlans)
      .innerJoin(users, eq(users.id, operationalPlans.userId))
      .where(
        and(
          inArray(operationalPlans.approvalState, ["approved"]),
          isNotNull(users.alpacaKeyCiphertext),
        ),
      );
    approvedUserIds = Array.from(new Set(planRows.map((r) => r.userId)));
    if (planRows.length === 0) {
      console.log(`${prefix}: no approved plans, skipping`);
      return;
    }
    // Union of universes across all approved players.
    const symbolSet = new Set<string>();
    for (const r of planRows) {
      try {
        const plan = JSON.parse(r.planJson) as OperationalPlan;
        for (const u of plan.universe ?? []) {
          if (u?.symbol) symbolSet.add(u.symbol.toUpperCase());
        }
      } catch {
        /* skip bad plan rows */
      }
    }
    if (symbolSet.size === 0) {
      console.log(`${prefix}: union universe is empty`);
      await recordWarmRuns(env, approvedUserIds, startedAt, "succeeded", `${prefix}: union universe empty, nothing to refresh.`, null);
      return;
    }
    const allSymbols = Array.from(symbolSet).sort();
    // Pick any one player's Alpaca creds to fetch news + bars (the data is universal).
    const candidate = planRows.find(
      (r) => r.alpacaKeyCiphertext && r.alpacaKeyIv && r.alpacaSecretCiphertext && r.alpacaSecretIv,
    );
    if (!candidate) {
      console.log(`${prefix}: no Alpaca-linked player to source market data`);
      await recordWarmRuns(env, approvedUserIds, startedAt, "error", `${prefix}: no Alpaca-linked player to source market data.`, "no_market_data_credentials");
      return;
    }
    const apiKey = await open(
      { ciphertext: candidate.alpacaKeyCiphertext!, iv: candidate.alpacaKeyIv! },
      env.ALPACA_KEY_ENCRYPTION_KEY,
    );
    const apiSecret = await open(
      { ciphertext: candidate.alpacaSecretCiphertext!, iv: candidate.alpacaSecretIv! },
      env.ALPACA_KEY_ENCRYPTION_KEY,
    );
    const creds: AlpacaCreds = { apiKey, apiSecret };
    // uncapped: cron has 15min wall time on Workers Paid; the entire union
    // universe (typically <200 symbols) refreshes comfortably in one call.
    const summary = await refreshFactors(env, creds, allSymbols, {
      uncapped: true,
      scoringConcurrency: 8,
    });
    const summaryLine = `${prefix}: ${summary.refreshedSymbols}/${allSymbols.length} symbols, ${summary.scoredHeadlines} headlines scored, ${summary.failures.length} failures, ${(summary.durationMs / 1000).toFixed(1)}s.`;
    console.log(summaryLine);
    if (summary.failures.length > 0) {
      for (const f of summary.failures.slice(0, 5)) {
        console.warn(`factor refresh failure: ${f.stage} ${f.symbol ?? ""} — ${f.reason}`);
      }
    }
    const status = summary.failures.length === 0 ? "succeeded" : "partial";
    await recordWarmRuns(env, approvedUserIds, startedAt, status, summaryLine, null);
  } catch (err) {
    console.error(`${prefix} threw`, err);
    await recordWarmRuns(
      env,
      approvedUserIds,
      startedAt,
      "error",
      `${prefix} threw an exception — KV may be stale for the 09:15 routine.`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Insert one synthetic routineRuns row per approved player so the warm cron
 * surfaces in each pit wall's Radio messages. The public ticker filters these
 * out (see routes/events.ts) — they're only meant for the per-player feed.
 */
async function recordWarmRuns(
  env: Env,
  userIds: string[],
  startedAt: number,
  status: "succeeded" | "partial" | "error",
  reasoning: string,
  errorText: string | null,
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const db = getDb(env.DB);
    const completedAt = Math.floor(Date.now() / 1000);
    await db.insert(routineRuns).values(
      userIds.map((userId) => ({
        id: ulid(),
        userId,
        operationalPlanId: null,
        kind: "scheduled" as const,
        scheduledSlot: "warm",
        oneShotInstruction: null,
        claudeReasoning: reasoning,
        status,
        errorText,
        startedAt,
        completedAt,
      })),
    );
  } catch (err) {
    console.error("recordWarmRuns failed", err);
  }
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

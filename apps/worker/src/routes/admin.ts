import { Hono } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import type { OperationalPlan } from "shared/playbook";
import { z } from "zod";
import { getDb } from "../db/client";
import { operationalPlans, routineRuns, trades, users } from "../db/schema";
import { captureEquitySnapshots, handleScheduled } from "../routines/cron";
import {
  AlpacaAuthError,
  fetchAccount,
  fetchOpenOrders,
  fetchOrder,
  fetchPositions,
  placeOrder,
  type AlpacaCreds,
} from "../lib/alpaca";
import { open } from "../lib/crypto";
import { ulid } from "../lib/ids";
import { clearDemoUsers, seedDemoUsers } from "../lib/demo-seed";
import { invalidateUserAlpacaCaches } from "../lib/user-cache";
import { requireSession, type AppEnv } from "../middleware/session";
import { refreshFactors, runConnectivityProbe, REFRESH_MAX_SYMBOLS_PER_CALL } from "../data/factors";

const testOrderSchema = z.object({
  symbol: z.string().trim().toUpperCase().min(1).max(8),
  qty: z.number().positive().max(100).default(1),
  side: z.enum(["buy", "sell"]).default("buy"),
  type: z.enum(["market", "limit"]).default("limit"),
  limit_price: z.number().positive().optional(),
  time_in_force: z.enum(["day", "gtc"]).default("day"),
});

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", requireSession, async (c, next) => {
  const user = c.get("user");
  if (!user.isAdmin) return c.json({ error: "admin_only" }, 403);
  await next();
});

adminRoutes.get("/roster", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      teamColor: users.teamColor,
      alpacaKeyCiphertext: users.alpacaKeyCiphertext,
      createdAt: users.createdAt,
      onboardedAt: users.onboardedAt,
    })
    .from(users)
    .orderBy(asc(users.createdAt));

  const players = await Promise.all(
    rows.map(async (u) => {
      const [latestPlan] = await db
        .select({ approvalState: operationalPlans.approvalState })
        .from(operationalPlans)
        .where(eq(operationalPlans.userId, u.id))
        .orderBy(desc(operationalPlans.createdAt))
        .limit(1);
      return {
        id: u.id,
        displayName: u.displayName,
        teamColor: u.teamColor,
        isAdmin: u.displayName === c.env.ADMIN_DISPLAY_NAME,
        alpacaLinked: u.alpacaKeyCiphertext != null,
        planState: (latestPlan?.approvalState ?? "none") as
          | "approved"
          | "pending"
          | "rejected"
          | "superseded"
          | "none",
        joinedAtSec: u.createdAt,
        onboardedAtSec: u.onboardedAt,
      };
    }),
  );

  return c.json({ players, maxPlayers: 4 as const });
});

// Cross-user routines list. Returns metadata only — no decisions, reasoning,
// orders, instructions, errorText, model, or token counts. The admin is also
// a player, so leaking per-row content would give them a competitive view of
// every other player's strategy. Owners see the rich view on Pit Wall.
adminRoutes.get("/routines", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: routineRuns.id,
      userId: routineRuns.userId,
      displayName: users.displayName,
      kind: routineRuns.kind,
      scheduledSlot: routineRuns.scheduledSlot,
      status: routineRuns.status,
      startedAt: routineRuns.startedAt,
      completedAt: routineRuns.completedAt,
    })
    .from(routineRuns)
    .leftJoin(users, eq(users.id, routineRuns.userId))
    .orderBy(desc(routineRuns.startedAt))
    .limit(limit);
  return c.json({
    runs: rows.map((r) => ({
      ...r,
      displayName: r.displayName ?? "(unknown)",
    })),
  });
});

adminRoutes.post("/routines/:id/kill", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const [existing] = await db
    .select({ status: routineRuns.status })
    .from(routineRuns)
    .where(eq(routineRuns.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.status !== "running") {
    return c.json({ ok: true, killed: 0, alreadyTerminal: true });
  }
  await db
    .update(routineRuns)
    .set({
      status: "error",
      errorText: `killed by admin ${user.displayName}`,
      completedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(routineRuns.id, id), eq(routineRuns.status, "running")));
  return c.json({ ok: true, killed: 1 });
});

adminRoutes.post("/capture-equity-now", async (c) => {
  await captureEquitySnapshots(c.env);
  return c.json({ ok: true });
});

adminRoutes.post(
  "/trigger-cron",
  zValidator("json", z.object({ cron: z.string() })),
  async (c) => {
    const { cron } = c.req.valid("json");
    c.executionCtx.waitUntil(handleScheduled(cron, c.env, c.executionCtx));
    return c.json({ ok: true, cron });
  },
);

// Sync variant: collects every waitUntil() call from handleScheduled and awaits
// them before responding. Premarket/open take 65-90s (Claude + Alpaca), which
// exceeds HTTP-context waitUntil's effective lifetime, so the async variant
// orphans those runs. Awaiting inline keeps the HTTP request open for the
// whole duration; Pro plan tolerates ~100s response time, which fits.
adminRoutes.post(
  "/trigger-cron-sync",
  zValidator("json", z.object({ cron: z.string() })),
  async (c) => {
    const { cron } = c.req.valid("json");
    const tasks: Promise<unknown>[] = [];
    const captureCtx = {
      waitUntil: (p: Promise<unknown>) => {
        tasks.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const startedAt = Date.now();
    await handleScheduled(cron, c.env, captureCtx);
    await Promise.allSettled(tasks);
    return c.json({ ok: true, cron, durationMs: Date.now() - startedAt });
  },
);

adminRoutes.post("/test-order", zValidator("json", testOrderSchema), async (c) => {
  const user = c.get("user");
  const input = c.req.valid("json");
  const db = getDb(c.env.DB);
  const [u] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!u?.alpacaKeyCiphertext || !u?.alpacaKeyIv || !u?.alpacaSecretCiphertext || !u?.alpacaSecretIv) {
    return c.json({ error: "alpaca_not_linked" }, 400);
  }
  const apiKey = await open(
    { ciphertext: u.alpacaKeyCiphertext, iv: u.alpacaKeyIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: u.alpacaSecretCiphertext, iv: u.alpacaSecretIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const creds: AlpacaCreds = { apiKey, apiSecret };
  try {
    const order = await placeOrder(creds, {
      symbol: input.symbol,
      qty: input.qty,
      side: input.side,
      type: input.type,
      time_in_force: input.time_in_force,
      limit_price: input.type === "limit" ? input.limit_price : undefined,
      client_order_id: `tgp-admin-test-${ulid()}`,
    });
    await db.insert(trades).values({
      id: ulid(),
      alpacaOrderId: order.id,
      userId: user.id,
      routineRunId: null,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      filledQty: order.filled_qty,
      filledAvgPrice: order.filled_avg_price,
      orderStatus: order.status,
      submittedAt: Math.floor(new Date(order.submitted_at).getTime() / 1000),
      filledAt: order.filled_at ? Math.floor(new Date(order.filled_at).getTime() / 1000) : null,
    });
    await invalidateUserAlpacaCaches(c.env, user.id);
    return c.json({ ok: true, order });
  } catch (err) {
    console.error("test-order error", err);
    return c.json(
      { error: "order_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

adminRoutes.post("/seed-demo-users", async (c) => {
  const db = getDb(c.env.DB);
  try {
    const result = await seedDemoUsers(db);
    return c.json(result);
  } catch (err) {
    console.error("seed-demo-users error", err);
    return c.json(
      { error: "seed_failed", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

adminRoutes.post("/clear-demo-users", async (c) => {
  const db = getDb(c.env.DB);
  const result = await clearDemoUsers(db);
  return c.json(result);
});

adminRoutes.get("/test-order/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const [u] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!u?.alpacaKeyCiphertext || !u?.alpacaKeyIv || !u?.alpacaSecretCiphertext || !u?.alpacaSecretIv) {
    return c.json({ error: "alpaca_not_linked" }, 400);
  }
  const apiKey = await open(
    { ciphertext: u.alpacaKeyCiphertext, iv: u.alpacaKeyIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: u.alpacaSecretCiphertext, iv: u.alpacaSecretIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  try {
    const order = await fetchOrder({ apiKey, apiSecret }, id);
    return c.json({ order });
  } catch (err) {
    return c.json({ error: "fetch_failed", message: err instanceof Error ? err.message : String(err) }, 502);
  }
});

async function loadAdminAlpacaCreds(env: Env, userId: string): Promise<AlpacaCreds | null> {
  const db = getDb(env.DB);
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u?.alpacaKeyCiphertext || !u?.alpacaKeyIv || !u?.alpacaSecretCiphertext || !u?.alpacaSecretIv) {
    return null;
  }
  const apiKey = await open(
    { ciphertext: u.alpacaKeyCiphertext, iv: u.alpacaKeyIv },
    env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: u.alpacaSecretCiphertext, iv: u.alpacaSecretIv },
    env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  return { apiKey, apiSecret };
}

adminRoutes.post("/users/:userId/alpaca-resync", async (c) => {
  const userId = c.req.param("userId");
  const db = getDb(c.env.DB);
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return c.json({ error: "user_not_found" }, 404);
  if (
    !u.alpacaKeyCiphertext ||
    !u.alpacaKeyIv ||
    !u.alpacaSecretCiphertext ||
    !u.alpacaSecretIv
  ) {
    return c.json({ error: "alpaca_not_linked" }, 400);
  }

  await invalidateUserAlpacaCaches(c.env, userId);

  const apiKey = await open(
    { ciphertext: u.alpacaKeyCiphertext, iv: u.alpacaKeyIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: u.alpacaSecretCiphertext, iv: u.alpacaSecretIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const creds: AlpacaCreds = { apiKey, apiSecret };

  const result: {
    userId: string;
    displayName: string;
    storedAccountId: string | null;
    cacheBusted: true;
    account: {
      ok: boolean;
      accountId?: string;
      equity?: string;
      cash?: string;
      longMarketValue?: string;
      status?: string;
      error?: string;
    };
    positions: { ok: boolean; count?: number; raw?: unknown; error?: string };
    openOrders: { ok: boolean; count?: number; error?: string };
  } = {
    userId,
    displayName: u.displayName,
    storedAccountId: u.alpacaAccountId,
    cacheBusted: true,
    account: { ok: false },
    positions: { ok: false },
    openOrders: { ok: false },
  };

  try {
    const acct = await fetchAccount(apiKey, apiSecret);
    result.account = {
      ok: true,
      accountId: acct.id,
      equity: acct.equity,
      cash: acct.cash,
      longMarketValue: acct.long_market_value,
      status: acct.status,
    };
  } catch (err) {
    result.account = {
      ok: false,
      error:
        err instanceof AlpacaAuthError
          ? `auth_failed (${err.status})`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  try {
    const positions = await fetchPositions(creds);
    result.positions = {
      ok: true,
      count: positions.length,
      raw: positions.map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        avgEntry: p.avg_entry_price,
        current: p.current_price,
        marketValue: p.market_value,
        unrealizedPl: p.unrealized_pl,
        side: p.side,
      })),
    };
  } catch (err) {
    result.positions = {
      ok: false,
      error:
        err instanceof AlpacaAuthError
          ? `auth_failed (${err.status})`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  try {
    const openOrders = await fetchOpenOrders(creds);
    result.openOrders = { ok: true, count: openOrders.length };
  } catch (err) {
    result.openOrders = {
      ok: false,
      error:
        err instanceof AlpacaAuthError
          ? `auth_failed (${err.status})`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  return c.json(result);
});

adminRoutes.post("/factors/probe", async (c) => {
  const user = c.get("user");
  const creds = await loadAdminAlpacaCreds(c.env, user.id);
  if (!creds) {
    return c.json(
      {
        error: "alpaca_not_linked",
        message:
          "Probe needs Alpaca creds for the news connectivity check. Link Alpaca on the admin account first, or call /factors/probe-keys for key-only checks.",
      },
      400,
    );
  }
  try {
    const result = await runConnectivityProbe(c.env, creds);
    const allOk =
      result.finnhub.ok && result.fred.ok && result.alpacaNews.ok && result.fmp.ok;
    return c.json({ ok: allOk, ...result });
  } catch (err) {
    console.error("factors probe error", err);
    return c.json(
      { error: "probe_failed", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

const refreshFactorsSchema = z.object({
  symbols: z.array(z.string().trim().min(1).max(8)).max(60).optional(),
});

adminRoutes.post("/factors/refresh", zValidator("json", refreshFactorsSchema), async (c) => {
  const user = c.get("user");
  const { symbols: bodySymbols } = c.req.valid("json");
  const creds = await loadAdminAlpacaCreds(c.env, user.id);
  if (!creds) {
    return c.json(
      { error: "alpaca_not_linked", message: "Refresh needs Alpaca creds for news. Link Alpaca on the admin account." },
      400,
    );
  }

  let symbols = bodySymbols?.map((s) => s.toUpperCase());
  let unionUniverse: string[] | null = null;
  if (!symbols || symbols.length === 0) {
    unionUniverse = await loadUnionUniverseSymbols(c.env);
    symbols = unionUniverse.slice(0, REFRESH_MAX_SYMBOLS_PER_CALL);
  }
  if (symbols.length === 0) {
    return c.json({ error: "no_symbols", message: "No approved plans yet — pass `symbols` in the body to refresh ad-hoc." }, 400);
  }

  try {
    const summary = await refreshFactors(c.env, creds, symbols);
    const remaining = unionUniverse ? unionUniverse.slice(REFRESH_MAX_SYMBOLS_PER_CALL) : [];
    return c.json({
      ok: summary.failures.length === 0,
      symbols,
      maxSymbolsPerCall: REFRESH_MAX_SYMBOLS_PER_CALL,
      remainingFromUnion: remaining,
      hint:
        remaining.length > 0
          ? `Worker subrequest budget caps each call at ${REFRESH_MAX_SYMBOLS_PER_CALL} symbols. Call again with the next chunk: { "symbols": ${JSON.stringify(remaining.slice(0, REFRESH_MAX_SYMBOLS_PER_CALL))} }`
          : undefined,
      ...summary,
    });
  } catch (err) {
    console.error("factors refresh error", err);
    return c.json(
      { error: "refresh_failed", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

async function loadUnionUniverseSymbols(env: Env): Promise<string[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ planJson: operationalPlans.planJson })
    .from(operationalPlans)
    .where(inArray(operationalPlans.approvalState, ["approved", "pending"]));
  const set = new Set<string>();
  for (const r of rows) {
    try {
      const plan = JSON.parse(r.planJson) as OperationalPlan;
      for (const u of plan.universe ?? []) {
        if (u?.symbol) set.add(u.symbol.toUpperCase());
      }
    } catch {
      /* ignore malformed plan rows */
    }
  }
  return Array.from(set);
}

function serializeRun(r: typeof routineRuns.$inferSelect) {
  let decisions: unknown = null;
  let validationFailures: unknown = [];
  let orders: unknown = [];
  if (r.decisionsJson) {
    try {
      const parsed = JSON.parse(r.decisionsJson) as {
        decisions?: unknown;
        validationFailures?: unknown;
        orders?: unknown;
      };
      decisions = parsed.decisions ?? null;
      validationFailures = parsed.validationFailures ?? [];
      orders = parsed.orders ?? [];
    } catch {
      /* ignore */
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    scheduledSlot: r.scheduledSlot,
    oneShotInstruction: r.oneShotInstruction,
    claudeModel: r.claudeModel,
    claudeReasoning: r.claudeReasoning,
    decisions,
    validationFailures,
    orders,
    status: r.status,
    errorText: r.errorText,
    tokens: {
      input: r.inputTokens,
      output: r.outputTokens,
      cacheRead: r.cacheReadTokens,
      cacheWrite: r.cacheWriteTokens,
    },
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

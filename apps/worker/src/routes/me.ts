import { Hono } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createIntentSchema,
  type CreateIntentResponse,
  type IntentSummary,
  type IntentsListResponse,
} from "shared/intent";
import type { PnlSplitResponse, SourceFlow } from "shared/pnl";
import {
  FIRE_NOW_DAILY_LIMIT,
  FIRE_NOW_HOURLY_LIMIT,
  deriveFireNowSlot,
  type FireNowResponse,
} from "shared/routine";
import { getDb } from "../db/client";
import { equitySnapshots, routineRuns, trades, userIntents, users } from "../db/schema";
import { open } from "../lib/crypto";
import {
  AlpacaAuthError,
  cancelAndReplaceOrder,
  cancelOrder,
  closePosition,
  fetchClosedOrders,
  fetchOpenOrders,
  fetchPositions,
  placeOrder,
  replaceOrder,
  type AlpacaCreds,
} from "../lib/alpaca";
import { ulid } from "../lib/ids";
import { invalidateUserAlpacaCaches } from "../lib/user-cache";
import { checkAndIncrementRateLimits } from "../lib/rate-limit";
import { captureEquitySnapshotForUser } from "../routines/cron";
import { executeRoutine } from "../routines/execute";
import { currentRaceState } from "../trading/race";
import { operationalPlans } from "../db/schema";
import { requireSession, type AppEnv } from "../middleware/session";

export const meRoutes = new Hono<AppEnv>();

meRoutes.use("*", requireSession);

meRoutes.get("/", (c) => {
  const user = c.get("user");
  return c.json({ user });
});

meRoutes.get("/positions", async (c) => {
  const user = c.get("user");
  const cacheKey = `positions:${user.id}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.json(JSON.parse(cached));

  const db = getDb(c.env.DB);
  const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!userRow?.alpacaKeyCiphertext || !userRow?.alpacaKeyIv || !userRow?.alpacaSecretCiphertext || !userRow?.alpacaSecretIv) {
    return c.json({ positions: [] });
  }
  const apiKey = await open(
    { ciphertext: userRow.alpacaKeyCiphertext, iv: userRow.alpacaKeyIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: userRow.alpacaSecretCiphertext, iv: userRow.alpacaSecretIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const creds: AlpacaCreds = { apiKey, apiSecret };
  try {
    const positions = await fetchPositions(creds);
    const payload = {
      positions: positions.map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        avgEntry: Number(p.avg_entry_price),
        current: Number(p.current_price),
        marketValue: Number(p.market_value),
        unrealizedPl: Number(p.unrealized_pl),
        unrealizedPlPct: Number(p.unrealized_plpc) * 100,
        side: p.side,
      })),
    };
    await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 });
    return c.json(payload);
  } catch (err) {
    console.error("positions error", err);
    if (err instanceof AlpacaAuthError) {
      return c.json({ error: "alpaca_auth_failed" }, 401);
    }
    return c.json(
      {
        error: "positions_fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

const replaceOrderSchema = z
  .object({
    qty: z.number().positive().max(100_000).optional(),
    limit_price: z.number().positive().max(1_000_000).optional(),
    time_in_force: z.enum(["day", "gtc"]).optional(),
  })
  .refine((v) => v.qty != null || v.limit_price != null || v.time_in_force != null, {
    message: "Provide at least one of qty, limit_price, time_in_force.",
  });

const directOrderSchema = z
  .object({
    symbol: z.string().min(1).max(8).regex(/^[A-Z][A-Z0-9.]*$/, "Symbol must be uppercase ticker"),
    side: z.enum(["buy", "sell"]),
    qty: z.number().int().positive().max(100_000),
    type: z.enum(["market", "limit"]),
    time_in_force: z.enum(["day", "gtc"]),
    limit_price: z.number().positive().max(1_000_000).optional(),
  })
  .refine((v) => v.type === "market" || v.limit_price != null, {
    message: "limit orders require limit_price",
    path: ["limit_price"],
  });

async function getCredsForUser(env: Env, userId: string): Promise<AlpacaCreds | null> {
  const db = getDb(env.DB);
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (
    !u?.alpacaKeyCiphertext ||
    !u?.alpacaKeyIv ||
    !u?.alpacaSecretCiphertext ||
    !u?.alpacaSecretIv
  ) {
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


meRoutes.post("/orders", zValidator("json", directOrderSchema), async (c) => {
  const user = c.get("user");
  const input = c.req.valid("json");
  const creds = await getCredsForUser(c.env, user.id);
  if (!creds) return c.json({ error: "alpaca_not_linked" }, 400);
  try {
    const order = await placeOrder(creds, {
      symbol: input.symbol,
      qty: input.qty,
      side: input.side,
      type: input.type,
      time_in_force: input.time_in_force,
      limit_price: input.type === "limit" ? input.limit_price : undefined,
      client_order_id: `tgp-direct-${ulid()}`,
    });
    const db = getDb(c.env.DB);
    await db.insert(trades).values({
      id: ulid(),
      alpacaOrderId: order.id,
      userId: user.id,
      routineRunId: null,
      source: "direct",
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
    return c.json({
      ok: true,
      order: {
        id: order.id,
        symbol: order.symbol,
        side: order.side,
        qty: Number(order.qty),
        orderType: order.order_type,
        status: order.status,
      },
    });
  } catch (err) {
    if (err instanceof AlpacaAuthError) {
      return c.json({ error: "alpaca_auth_failed" }, 401);
    }
    console.error("direct-order error", err);
    return c.json(
      { error: "place_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

meRoutes.patch("/orders/:id", zValidator("json", replaceOrderSchema), async (c) => {
  const user = c.get("user");
  const orderId = c.req.param("id");
  const input = c.req.valid("json");
  const creds = await getCredsForUser(c.env, user.id);
  if (!creds) return c.json({ error: "alpaca_not_linked" }, 400);
  try {
    let order;
    let fallback = false;
    try {
      order = await replaceOrder(creds, orderId, input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/42210000|cannot replace order/i.test(msg)) {
        order = await cancelAndReplaceOrder(creds, orderId, input);
        fallback = true;
      } else {
        throw err;
      }
    }
    await invalidateUserAlpacaCaches(c.env, user.id);
    return c.json({ ok: true, order, fallback });
  } catch (err) {
    if (err instanceof AlpacaAuthError) {
      return c.json({ error: "alpaca_auth_failed" }, 401);
    }
    console.error("replace-order error", err);
    return c.json(
      { error: "replace_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

meRoutes.delete("/orders/:id", async (c) => {
  const user = c.get("user");
  const orderId = c.req.param("id");
  const creds = await getCredsForUser(c.env, user.id);
  if (!creds) return c.json({ error: "alpaca_not_linked" }, 400);
  try {
    await cancelOrder(creds, orderId);
    await invalidateUserAlpacaCaches(c.env, user.id);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof AlpacaAuthError) {
      return c.json({ error: "alpaca_auth_failed" }, 401);
    }
    console.error("cancel-order error", err);
    return c.json(
      { error: "cancel_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

meRoutes.delete("/positions/:symbol", async (c) => {
  const user = c.get("user");
  const symbol = c.req.param("symbol").toUpperCase();
  const creds = await getCredsForUser(c.env, user.id);
  if (!creds) return c.json({ error: "alpaca_not_linked" }, 400);
  try {
    const result = await closePosition(creds, symbol);
    await invalidateUserAlpacaCaches(c.env, user.id);
    return c.json({ ok: true, result });
  } catch (err) {
    if (err instanceof AlpacaAuthError) {
      return c.json({ error: "alpaca_auth_failed" }, 401);
    }
    console.error("close-position error", err);
    return c.json(
      { error: "close_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

meRoutes.get("/open-orders", async (c) => {
  const user = c.get("user");
  const cacheKey = `open-orders:${user.id}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.json(JSON.parse(cached));

  const db = getDb(c.env.DB);
  const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!userRow?.alpacaKeyCiphertext || !userRow?.alpacaKeyIv || !userRow?.alpacaSecretCiphertext || !userRow?.alpacaSecretIv) {
    return c.json({ orders: [] });
  }
  const apiKey = await open(
    { ciphertext: userRow.alpacaKeyCiphertext, iv: userRow.alpacaKeyIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: userRow.alpacaSecretCiphertext, iv: userRow.alpacaSecretIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const creds: AlpacaCreds = { apiKey, apiSecret };
  try {
    const orders = await fetchOpenOrders(creds);
    const GHOST = new Set(["pending_cancel", "pending_replace", "replaced", "canceled", "expired"]);
    const payload = {
      orders: orders
        .filter((o) => !GHOST.has(o.status))
        .map((o) => ({
          id: o.id,
          symbol: o.symbol,
          side: o.side,
          qty: Number(o.qty),
          filledQty: o.filled_qty ? Number(o.filled_qty) : 0,
          orderType: o.order_type,
          limitPrice: o.limit_price != null ? Number(o.limit_price) : null,
          timeInForce: o.time_in_force,
          status: o.status,
          submittedAt: Math.floor(new Date(o.submitted_at).getTime() / 1000),
        })),
    };
    await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 });
    return c.json(payload);
  } catch (err) {
    console.error("open-orders error", err);
    if (err instanceof AlpacaAuthError) {
      return c.json({ error: "alpaca_auth_failed" }, 401);
    }
    return c.json(
      {
        error: "open_orders_fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

meRoutes.get("/recent-fills", async (c) => {
  const user = c.get("user");
  const cacheKey = `recent-fills:${user.id}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.json(JSON.parse(cached));

  const db = getDb(c.env.DB);
  const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (
    !userRow?.alpacaKeyCiphertext ||
    !userRow?.alpacaKeyIv ||
    !userRow?.alpacaSecretCiphertext ||
    !userRow?.alpacaSecretIv
  ) {
    return c.json({ fills: [] });
  }
  const apiKey = await open(
    { ciphertext: userRow.alpacaKeyCiphertext, iv: userRow.alpacaKeyIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: userRow.alpacaSecretCiphertext, iv: userRow.alpacaSecretIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const creds: AlpacaCreds = { apiKey, apiSecret };
  try {
    const orders = await fetchClosedOrders(creds, 20);
    const payload = {
      fills: orders.map((o) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        qty: Number(o.qty),
        filledQty: o.filled_qty ? Number(o.filled_qty) : 0,
        filledAvgPrice: o.filled_avg_price != null ? Number(o.filled_avg_price) : null,
        orderType: o.order_type,
        status: o.status,
        submittedAt: Math.floor(new Date(o.submitted_at).getTime() / 1000),
        filledAt: o.filled_at ? Math.floor(new Date(o.filled_at).getTime() / 1000) : null,
      })),
    };
    await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 });
    return c.json(payload);
  } catch (err) {
    console.error("recent-fills error", err);
    if (err instanceof AlpacaAuthError) {
      return c.json({ error: "alpaca_auth_failed" }, 401);
    }
    return c.json(
      {
        error: "recent_fills_fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

meRoutes.get("/routine-runs", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.userId, user.id))
    .orderBy(desc(routineRuns.startedAt))
    .limit(30);
  return c.json({ runs: rows.map(serializeRun) });
});

meRoutes.get("/routine-runs/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const [row] = await db
    .select()
    .from(routineRuns)
    .where(and(eq(routineRuns.id, id), eq(routineRuns.userId, user.id)))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ run: serializeRun(row) });
});

meRoutes.get("/equity-series", async (c) => {
  const user = c.get("user");
  const range = c.req.query("range") ?? "24h";
  const nowSec = Math.floor(Date.now() / 1000);
  const since =
    range === "7d" ? nowSec - 7 * 24 * 60 * 60 : range === "30d" ? nowSec - 30 * 24 * 60 * 60 : nowSec - 24 * 60 * 60;
  const db = getDb(c.env.DB);

  const readSeries = async () =>
    db
      .select()
      .from(equitySnapshots)
      .where(and(eq(equitySnapshots.userId, user.id), gte(equitySnapshots.capturedAt, since)))
      .orderBy(equitySnapshots.capturedAt);

  let rows = await readSeries();

  if (rows.length === 0) {
    const [totalRow] = await db
      .select({ n: equitySnapshots.id })
      .from(equitySnapshots)
      .where(eq(equitySnapshots.userId, user.id))
      .limit(1);
    if (!totalRow) {
      const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (userRow && userRow.alpacaKeyCiphertext) {
        const captured = await captureEquitySnapshotForUser(c.env, userRow);
        if (captured) rows = await readSeries();
      }
    }
  }

  return c.json({
    range,
    points: rows.map((r) => ({
      t: r.capturedAt,
      equity: Number(r.equity),
      cash: Number(r.cash),
      longMarketValue: Number(r.longMarketValue),
    })),
  });
});

meRoutes.get("/pnl-split", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      source: trades.source,
      side: trades.side,
      filledQty: trades.filledQty,
      filledAvgPrice: trades.filledAvgPrice,
    })
    .from(trades)
    .where(eq(trades.userId, user.id));
  const tally: Record<"ai" | "direct", SourceFlow> = {
    ai: { netRealized: 0, tradeCount: 0 },
    direct: { netRealized: 0, tradeCount: 0 },
  };
  for (const r of rows) {
    const src = r.source === "direct" ? "direct" : "ai";
    const fq = r.filledQty != null ? Number(r.filledQty) : 0;
    const fp = r.filledAvgPrice != null ? Number(r.filledAvgPrice) : 0;
    if (!Number.isFinite(fq) || !Number.isFinite(fp) || fq <= 0 || fp <= 0) continue;
    tally[src].tradeCount += 1;
    const notional = fq * fp;
    tally[src].netRealized += r.side === "sell" ? notional : -notional;
  }
  const payload: PnlSplitResponse = { strategy: tally.ai, direct: tally.direct };
  return c.json(payload);
});

meRoutes.get("/intents", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env.DB);
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select()
    .from(userIntents)
    .where(eq(userIntents.userId, user.id))
    .orderBy(desc(userIntents.createdAt))
    .limit(50);
  const pending: IntentSummary[] = [];
  const recent: IntentSummary[] = [];
  for (const r of rows) {
    const expired = r.status === "pending" && r.expiresAt < nowSec;
    const summary: IntentSummary = {
      id: r.id,
      text: r.text,
      bindingNextSlot: r.bindingNextSlot,
      status: expired ? "expired" : (r.status as IntentSummary["status"]),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      consumedAt: r.consumedAt,
      rejectedReason: r.rejectedReason,
      routineRunId: r.routineRunId,
    };
    if (summary.status === "pending") pending.push(summary);
    else recent.push(summary);
  }
  const payload: IntentsListResponse = { pending, recent: recent.slice(0, 20) };
  return c.json(payload);
});

meRoutes.post("/intents", zValidator("json", createIntentSchema), async (c) => {
  const user = c.get("user");
  const input = c.req.valid("json");
  const db = getDb(c.env.DB);
  const nowSec = Math.floor(Date.now() / 1000);

  // Pre-flight gates only if fireImmediately is set.
  let fireNow: FireNowResponse | undefined;

  if (input.fireImmediately) {
    const raceState = await currentRaceState(c.env, nowSec);
    if (raceState !== "in_race") {
      return c.json(
        {
          error: "race_not_active",
          message:
            raceState === "pre_race"
              ? "Fire immediately is available once the race starts."
              : "Race is over.",
        },
        403,
      );
    }

    const [running] = await db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(and(eq(routineRuns.userId, user.id), eq(routineRuns.status, "running")))
      .limit(1);
    if (running) {
      return c.json(
        {
          error: "routine_running",
          message: "A routine is already running. Try again once it finishes.",
        },
        409,
      );
    }

    const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!userRow?.alpacaKeyCiphertext) {
      return c.json(
        { error: "alpaca_not_linked", message: "Link your Alpaca paper account first." },
        400,
      );
    }
    const [approvedPlan] = await db
      .select({ id: operationalPlans.id })
      .from(operationalPlans)
      .where(
        and(eq(operationalPlans.userId, user.id), eq(operationalPlans.approvalState, "approved")),
      )
      .limit(1);
    if (!approvedPlan) {
      return c.json(
        { error: "no_approved_plan", message: "Your operational plan must be approved first." },
        400,
      );
    }

    const rl = await checkAndIncrementRateLimits(
      c.env,
      user.id,
      [
        { bucket: "fire_now_hour", windowSeconds: 3600, limit: FIRE_NOW_HOURLY_LIMIT },
        { bucket: "fire_now_day", windowSeconds: 86400, limit: FIRE_NOW_DAILY_LIMIT },
      ],
      nowSec,
    );
    if (!rl.ok) {
      const isHour = rl.failed.bucket === "fire_now_hour";
      return c.json(
        {
          error: "rate_limited",
          message: isHour
            ? `Hourly limit reached (${FIRE_NOW_HOURLY_LIMIT}/hr). Resets in ${humanizeRemaining(rl.failed.resetAt - nowSec)}.`
            : `Daily limit reached (${FIRE_NOW_DAILY_LIMIT}/day). Resets in ${humanizeRemaining(rl.failed.resetAt - nowSec)}.`,
          bucket: rl.failed.bucket,
          resetAt: rl.failed.resetAt,
        },
        429,
      );
    }

    const slot = deriveFireNowSlot(nowSec);
    const hour = rl.results.find((r) => r.bucket === "fire_now_hour")!;
    const day = rl.results.find((r) => r.bucket === "fire_now_day")!;
    fireNow = {
      runId: "",
      slot,
      rateLimit: {
        hourRemaining: hour.remaining,
        dayRemaining: day.remaining,
        hourResetAt: hour.resetAt,
        dayResetAt: day.resetAt,
      },
    };
  }

  // Force binding semantics when fire-immediate is set so reconcileIntents
  // requires Haiku to honor or explicitly reject during this run.
  const bindingNextSlot = input.fireImmediately ? true : input.bindingNextSlot;
  const ttlSec = input.ttlHours * 60 * 60;
  const expiresAt = nowSec + ttlSec;
  const intentId = ulid();
  await db.insert(userIntents).values({
    id: intentId,
    userId: user.id,
    text: input.text,
    bindingNextSlot,
    expiresAt,
    status: "pending",
    routineRunId: null,
    rejectedReason: null,
    consumedAt: null,
  });

  const summary: IntentSummary = {
    id: intentId,
    text: input.text,
    bindingNextSlot,
    status: "pending",
    createdAt: nowSec,
    expiresAt,
    consumedAt: null,
    rejectedReason: null,
    routineRunId: null,
  };

  if (fireNow) {
    const runId = ulid();
    await db.insert(routineRuns).values({
      id: runId,
      userId: user.id,
      operationalPlanId: null,
      kind: "on_demand",
      scheduledSlot: fireNow.slot,
      oneShotInstruction: input.text,
      status: "running",
    });
    fireNow.runId = runId;
    c.executionCtx.waitUntil(
      executeRoutine(c.env, {
        userId: user.id,
        slot: fireNow.slot,
        kind: "on_demand",
        oneShotInstruction: input.text,
        existingRunId: runId,
      }).catch((err) => {
        console.error("fire-now executeRoutine failed", err);
      }),
    );
    const response: CreateIntentResponse = { ok: true, intent: summary, fireNow };
    return c.json(response);
  }

  const response: CreateIntentResponse = { ok: true, intent: summary };
  return c.json(response);
});

function humanizeRemaining(seconds: number): string {
  if (seconds <= 60) return `${Math.max(1, seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

meRoutes.delete("/intents/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const [row] = await db
    .select()
    .from(userIntents)
    .where(and(eq(userIntents.id, id), eq(userIntents.userId, user.id)))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "pending") {
    return c.json({ error: "not_pending", status: row.status }, 409);
  }
  await db
    .update(userIntents)
    .set({ status: "rejected", rejectedReason: "withdrawn by user", consumedAt: Math.floor(Date.now() / 1000) })
    .where(eq(userIntents.id, id));
  return c.json({ ok: true });
});

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

import { Hono } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createIntentSchema, type IntentSummary, type IntentsListResponse } from "shared/intent";
import { getDb } from "../db/client";
import { equitySnapshots, routineRuns, trades, userIntents, users } from "../db/schema";
import { open } from "../lib/crypto";
import {
  AlpacaAuthError,
  cancelAndReplaceOrder,
  cancelOrder,
  closePosition,
  fetchOpenOrders,
  fetchPositions,
  placeOrder,
  replaceOrder,
  type AlpacaCreds,
} from "../lib/alpaca";
import { ulid } from "../lib/ids";
import { invalidateUserAlpacaCaches } from "../lib/user-cache";
import { captureEquitySnapshotForUser } from "../routines/cron";
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
    return c.json({ positions: [], error: "positions_fetch_failed" });
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
    return c.json({ orders: [], error: "open_orders_fetch_failed" });
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
  const ttlSec = input.ttlHours * 60 * 60;
  const expiresAt = nowSec + ttlSec;
  const id = ulid();
  await db.insert(userIntents).values({
    id,
    userId: user.id,
    text: input.text,
    bindingNextSlot: input.bindingNextSlot,
    expiresAt,
    status: "pending",
    routineRunId: null,
    rejectedReason: null,
    consumedAt: null,
  });
  const summary: IntentSummary = {
    id,
    text: input.text,
    bindingNextSlot: input.bindingNextSlot,
    status: "pending",
    createdAt: nowSec,
    expiresAt,
    consumedAt: null,
    rejectedReason: null,
    routineRunId: null,
  };
  return c.json({ ok: true, intent: summary });
});

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

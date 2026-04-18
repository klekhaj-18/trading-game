import { Hono } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db/client";
import { equitySnapshots, routineRuns, users } from "../db/schema";
import { open } from "../lib/crypto";
import {
  AlpacaAuthError,
  cancelAndReplaceOrder,
  cancelOrder,
  closePosition,
  fetchOpenOrders,
  fetchPositions,
  replaceOrder,
  type AlpacaCreds,
} from "../lib/alpaca";
import { invalidateUserAlpacaCaches } from "../lib/user-cache";
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
  const rows = await db
    .select()
    .from(equitySnapshots)
    .where(and(eq(equitySnapshots.userId, user.id), gte(equitySnapshots.capturedAt, since)))
    .orderBy(equitySnapshots.capturedAt);
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

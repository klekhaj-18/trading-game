import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { fireTestRoutineSchema } from "shared/routine";
import { z } from "zod";
import { getDb } from "../db/client";
import { routineRuns, trades, users } from "../db/schema";
import { executeRoutine } from "../routines/execute";
import { captureEquitySnapshots, handleScheduled } from "../routines/cron";
import { placeOrder, fetchOrder, type AlpacaCreds } from "../lib/alpaca";
import { open } from "../lib/crypto";
import { ulid } from "../lib/ids";
import { requireSession, type AppEnv } from "../middleware/session";

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

adminRoutes.post(
  "/fire-test-routine",
  zValidator("json", fireTestRoutineSchema),
  async (c) => {
    const user = c.get("user");
    const { slot, oneShotInstruction } = c.req.valid("json");
    const result = await executeRoutine(c.env, {
      userId: user.id,
      slot,
      kind: "admin_test",
      oneShotInstruction,
    });
    return c.json(result);
  },
);

adminRoutes.get("/test-runs", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(routineRuns)
    .where(and(eq(routineRuns.userId, user.id), eq(routineRuns.kind, "admin_test")))
    .orderBy(desc(routineRuns.startedAt))
    .limit(20);
  return c.json({ runs: rows.map(serializeRun) });
});

adminRoutes.post("/reset-admin-test-data", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env.DB);
  await db
    .delete(routineRuns)
    .where(and(eq(routineRuns.userId, user.id), eq(routineRuns.kind, "admin_test")));
  return c.json({ ok: true });
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
    return c.json({ ok: true, order });
  } catch (err) {
    console.error("test-order error", err);
    return c.json(
      { error: "order_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
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

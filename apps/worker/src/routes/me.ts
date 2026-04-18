import { Hono } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db/client";
import { equitySnapshots, routineRuns, users } from "../db/schema";
import { open } from "../lib/crypto";
import { fetchPositions, type AlpacaCreds } from "../lib/alpaca";
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

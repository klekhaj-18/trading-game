import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { coachChatRequestSchema } from "shared/coach";
import type { IntentSummary } from "shared/intent";
import type { OperationalPlan } from "shared/playbook";
import { coachTurn, type CoachContext } from "../claude/coach";
import { getDb } from "../db/client";
import { operationalPlans, playbooks, trades, userIntents, users } from "../db/schema";
import { open } from "../lib/crypto";
import { fetchPositions, type AlpacaCreds } from "../lib/alpaca";
import { requireSession, type AppEnv } from "../middleware/session";
import { loadCoachMarketContext } from "../data/factors";
import { loadGameState } from "../data/game-state";

export const coachRoutes = new Hono<AppEnv>();

coachRoutes.use("*", requireSession);

coachRoutes.post("/chat", zValidator("json", coachChatRequestSchema), async (c) => {
  const { messages } = c.req.valid("json");
  if (messages[messages.length - 1]?.role !== "user") {
    return c.json({ error: "last_message_must_be_user" }, 400);
  }

  const user = c.get("user");

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      const { ctx, creds } = await loadCoachContext(c.env, user.id);
      const result = await coachTurn(
        c.env,
        messages,
        ctx,
        {
          signal: controller.signal,
          onText: async (delta) => {
            await stream.writeSSE({ event: "text", data: JSON.stringify({ delta }) });
          },
          onLookup: async (event) => {
            await stream.writeSSE({ event: "lookup", data: JSON.stringify(event) });
          },
        },
        { creds },
      );

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          assistantText: result.assistantText,
          draft: result.draft,
          playbookRevision: result.playbookRevision,
          planRevision: result.planRevision,
          usage: result.usage,
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Client disconnected — nothing to send back.
        return;
      }
      console.error("coach chat error", err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          message: err instanceof Error ? err.message : "Coach had a hiccup. Try again.",
        }),
      });
    }
  });
});

async function loadCoachContext(env: Env, userId: string): Promise<{ ctx: CoachContext; creds: AlpacaCreds | null }> {
  const db = getDb(env.DB);
  const nowSec = Math.floor(Date.now() / 1000);

  const [pbRow] = await db
    .select()
    .from(playbooks)
    .where(eq(playbooks.userId, userId))
    .orderBy(desc(playbooks.version))
    .limit(1);

  let approvedPlan: OperationalPlan | null = null;
  if (pbRow) {
    const [planRow] = await db
      .select()
      .from(operationalPlans)
      .where(
        and(
          eq(operationalPlans.userId, userId),
          inArray(operationalPlans.approvalState, ["approved", "pending"]),
        ),
      )
      .orderBy(desc(operationalPlans.createdAt))
      .limit(1);
    if (planRow) {
      try {
        approvedPlan = JSON.parse(planRow.planJson) as OperationalPlan;
      } catch {
        approvedPlan = null;
      }
    }
  }

  const fills = await db
    .select()
    .from(trades)
    .where(eq(trades.userId, userId))
    .orderBy(desc(trades.submittedAt))
    .limit(10);

  const intentRows = await db
    .select()
    .from(userIntents)
    .where(
      and(
        eq(userIntents.userId, userId),
        eq(userIntents.status, "pending"),
        gt(userIntents.expiresAt, nowSec),
      ),
    )
    .orderBy(desc(userIntents.createdAt))
    .limit(10);
  const pendingIntents: IntentSummary[] = intentRows.map((r) => ({
    id: r.id,
    text: r.text,
    bindingNextSlot: r.bindingNextSlot,
    status: "pending",
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    rejectedReason: r.rejectedReason,
    routineRunId: r.routineRunId,
  }));

  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  let positions: CoachContext["positions"] = [];
  let creds: AlpacaCreds | null = null;
  if (userRow?.alpacaKeyCiphertext && userRow.alpacaKeyIv && userRow.alpacaSecretCiphertext && userRow.alpacaSecretIv) {
    try {
      const apiKey = await open(
        { ciphertext: userRow.alpacaKeyCiphertext, iv: userRow.alpacaKeyIv },
        env.ALPACA_KEY_ENCRYPTION_KEY,
      );
      const apiSecret = await open(
        { ciphertext: userRow.alpacaSecretCiphertext, iv: userRow.alpacaSecretIv },
        env.ALPACA_KEY_ENCRYPTION_KEY,
      );
      creds = { apiKey, apiSecret };
      const ap = await fetchPositions(creds);
      positions = ap.map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        avgEntry: Number(p.avg_entry_price),
        current: Number(p.current_price),
        unrealizedPl: Number(p.unrealized_pl),
      }));
    } catch (err) {
      console.warn("coach context: positions fetch failed", err);
    }
  }

  // Build market context + game state in parallel with what we already have.
  // marketContext requires Alpaca creds (for news + bars) and an approved/pending plan
  // (for the universe). gameState is DB-only — always derivable.
  const universeSymbols = approvedPlan?.universe?.map((u) => u.symbol).filter(Boolean) ?? [];
  const [marketContext, gameState] = await Promise.all([
    creds && universeSymbols.length > 0
      ? loadCoachMarketContext(env, creds, universeSymbols).catch((err) => {
          console.warn("coach context: market context load failed", err);
          return null;
        })
      : Promise.resolve(null),
    loadGameState(env, userId).catch((err) => {
      console.warn("coach context: game state load failed", err);
      return null;
    }),
  ]);

  const ctx: CoachContext = {
    playbook: pbRow
      ? { goalText: pbRow.goalText, playbookText: pbRow.playbookText, version: pbRow.version }
      : null,
    approvedPlan,
    positions,
    recentFills: fills.map((f) => ({
      symbol: f.symbol,
      side: f.side,
      qty: Number(f.qty),
      filledAvgPrice: f.filledAvgPrice != null ? Number(f.filledAvgPrice) : null,
      filledAtIso: f.filledAt != null ? new Date(f.filledAt * 1000).toISOString() : null,
      source: f.source === "direct" ? "direct" : "ai",
    })),
    pendingIntents,
    marketContext,
    gameState,
  };
  return { ctx, creds };
}

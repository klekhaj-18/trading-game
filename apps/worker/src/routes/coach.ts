import { Hono } from "hono";
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

export const coachRoutes = new Hono<AppEnv>();

coachRoutes.use("*", requireSession);

coachRoutes.post("/chat", zValidator("json", coachChatRequestSchema), async (c) => {
  const { messages } = c.req.valid("json");
  if (messages[messages.length - 1]?.role !== "user") {
    return c.json({ error: "last_message_must_be_user" }, 400);
  }
  try {
    const user = c.get("user");
    const ctx = await loadCoachContext(c.env, user.id);
    const result = await coachTurn(c.env, messages, ctx);
    return c.json({
      assistantText: result.assistantText,
      draft: result.draft,
      playbookRevision: result.playbookRevision,
      planRevision: result.planRevision,
      usage: result.usage,
    });
  } catch (err) {
    console.error("coach chat error", err);
    return c.json({ error: "coach_failed", message: "Coach had a hiccup. Try again." }, 502);
  }
});

async function loadCoachContext(env: Env, userId: string): Promise<CoachContext> {
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
      const creds: AlpacaCreds = { apiKey, apiSecret };
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

  return {
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
  };
}

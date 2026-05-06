import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { playbookInputSchema, proposePlanSchema, rejectPlanSchema } from "shared/playbook";
import { getDb } from "../db/client";
import { operationalPlans, playbooks, users } from "../db/schema";
import { ulid } from "../lib/ids";
import { open } from "../lib/crypto";
import { fetchAccount } from "../lib/alpaca";
import { translatePlaybook } from "../claude/client";
import { requireSession, type AppEnv } from "../middleware/session";

export const playbookRoutes = new Hono<AppEnv>();

playbookRoutes.use("*", requireSession);

playbookRoutes.get("/current", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env.DB);

  const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  const alpacaLinked = Boolean(userRow?.alpacaKeyCiphertext);

  const userPlaybooks = await db
    .select()
    .from(playbooks)
    .where(eq(playbooks.userId, user.id))
    .orderBy(desc(playbooks.version));

  const latest = userPlaybooks[0] ?? null;

  let plan = null as null | Awaited<ReturnType<typeof loadLatestPlan>>;
  if (latest) plan = await loadLatestPlan(c.env.DB, user.id, latest.id);

  return c.json({
    alpacaLinked,
    playbook: latest
      ? {
          id: latest.id,
          version: latest.version,
          goalText: latest.goalText,
          playbookText: latest.playbookText,
          createdAt: latest.createdAt,
        }
      : null,
    plan,
    history: userPlaybooks.map((p) => ({
      id: p.id,
      version: p.version,
      goalPreview: p.goalText.slice(0, 140),
      createdAt: p.createdAt,
    })),
  });
});

playbookRoutes.post("/", zValidator("json", playbookInputSchema), async (c) => {
  const user = c.get("user");
  const { goal, playbook } = c.req.valid("json");
  const db = getDb(c.env.DB);

  const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!userRow?.alpacaKeyCiphertext || !userRow?.alpacaKeyIv || !userRow?.alpacaSecretCiphertext || !userRow?.alpacaSecretIv) {
    return c.json({ error: "alpaca_not_linked", message: "Link your Alpaca paper account first." }, 400);
  }

  const apiKey = await open(
    { ciphertext: userRow.alpacaKeyCiphertext, iv: userRow.alpacaKeyIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const apiSecret = await open(
    { ciphertext: userRow.alpacaSecretCiphertext, iv: userRow.alpacaSecretIv },
    c.env.ALPACA_KEY_ENCRYPTION_KEY,
  );
  const account = await fetchAccount(apiKey, apiSecret);

  const existing = await db
    .select({ version: playbooks.version })
    .from(playbooks)
    .where(eq(playbooks.userId, user.id))
    .orderBy(desc(playbooks.version))
    .limit(1);
  const nextVersion = (existing[0]?.version ?? 0) + 1;

  await db
    .update(playbooks)
    .set({ supersededAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(playbooks.userId, user.id)));
  await db
    .update(operationalPlans)
    .set({ approvalState: "superseded" })
    .where(and(eq(operationalPlans.userId, user.id), eq(operationalPlans.approvalState, "pending")));
  await db
    .update(operationalPlans)
    .set({ approvalState: "superseded" })
    .where(and(eq(operationalPlans.userId, user.id), eq(operationalPlans.approvalState, "approved")));

  const playbookId = ulid();
  await db.insert(playbooks).values({
    id: playbookId,
    userId: user.id,
    version: nextVersion,
    goalText: goal,
    playbookText: playbook,
    supersededAt: null,
  });

  const priorRejected = await db
    .select({ reason: operationalPlans.rejectedReason })
    .from(operationalPlans)
    .where(and(eq(operationalPlans.userId, user.id), eq(operationalPlans.approvalState, "rejected")))
    .orderBy(desc(operationalPlans.createdAt))
    .limit(1);
  const priorFeedback = priorRejected[0]?.reason ?? undefined;

  const result = await translatePlaybook(c.env, {
    goal,
    playbook,
    priorFeedback: priorFeedback ?? undefined,
    account: {
      accountId: account.id,
      equity: account.equity,
      cash: account.cash,
      buyingPower: account.buying_power,
    },
  });

  const planId = ulid();
  await db.insert(operationalPlans).values({
    id: planId,
    userId: user.id,
    playbookId,
    planJson: JSON.stringify(result.plan),
    planMarkdown: result.plan.markdown_summary,
    claudeModel: result.model,
    approvalState: "pending",
  });

  return c.json({
    playbookId,
    plan: {
      id: planId,
      approvalState: "pending" as const,
      claudeModel: result.model,
      planMarkdown: result.plan.markdown_summary,
      planJson: result.plan,
      createdAt: Math.floor(Date.now() / 1000),
      approvedAt: null,
      rejectedReason: null,
    },
    usage: result.usage,
  });
});

playbookRoutes.post("/propose-plan", zValidator("json", proposePlanSchema), async (c) => {
  const user = c.get("user");
  const { plan, rationale } = c.req.valid("json");
  const db = getDb(c.env.DB);

  const [latestPlaybook] = await db
    .select({ id: playbooks.id, version: playbooks.version })
    .from(playbooks)
    .where(eq(playbooks.userId, user.id))
    .orderBy(desc(playbooks.version))
    .limit(1);
  if (!latestPlaybook) {
    return c.json({ error: "no_playbook", message: "Submit a playbook first." }, 400);
  }

  await db
    .update(operationalPlans)
    .set({ approvalState: "superseded" })
    .where(and(eq(operationalPlans.userId, user.id), eq(operationalPlans.approvalState, "pending")));

  const planId = ulid();
  const markdown = `${plan.markdown_summary}\n\n---\n\n_Coach revision rationale: ${rationale}_`;
  await db.insert(operationalPlans).values({
    id: planId,
    userId: user.id,
    playbookId: latestPlaybook.id,
    planJson: JSON.stringify(plan),
    planMarkdown: markdown,
    claudeModel: "coach-revision",
    approvalState: "pending",
  });

  const nowSec = Math.floor(Date.now() / 1000);
  return c.json({
    plan: {
      id: planId,
      approvalState: "pending" as const,
      claudeModel: "coach-revision",
      planMarkdown: markdown,
      planJson: plan,
      createdAt: nowSec,
      approvedAt: null,
      rejectedReason: null,
    },
  });
});

playbookRoutes.post("/plan/:id/approve", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const [plan] = await db
    .select()
    .from(operationalPlans)
    .where(and(eq(operationalPlans.id, id), eq(operationalPlans.userId, user.id)))
    .limit(1);
  if (!plan) return c.json({ error: "plan_not_found" }, 404);
  if (plan.approvalState !== "pending") {
    return c.json({ error: "plan_not_pending", state: plan.approvalState }, 409);
  }

  await db
    .update(operationalPlans)
    .set({ approvalState: "superseded" })
    .where(and(eq(operationalPlans.userId, user.id), eq(operationalPlans.approvalState, "approved")));

  const nowSec = Math.floor(Date.now() / 1000);
  await db
    .update(operationalPlans)
    .set({ approvalState: "approved", approvedAt: nowSec })
    .where(eq(operationalPlans.id, id));

  await db.update(users).set({ onboardedAt: user.onboardedAt ?? nowSec }).where(eq(users.id, user.id));

  return c.json({ ok: true, approvedAt: nowSec });
});

playbookRoutes.post("/plan/:id/reject", zValidator("json", rejectPlanSchema), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { reason } = c.req.valid("json");
  const db = getDb(c.env.DB);

  const [plan] = await db
    .select()
    .from(operationalPlans)
    .where(and(eq(operationalPlans.id, id), eq(operationalPlans.userId, user.id)))
    .limit(1);
  if (!plan) return c.json({ error: "plan_not_found" }, 404);
  if (plan.approvalState !== "pending") {
    return c.json({ error: "plan_not_pending", state: plan.approvalState }, 409);
  }

  await db
    .update(operationalPlans)
    .set({ approvalState: "rejected", rejectedReason: reason })
    .where(eq(operationalPlans.id, id));

  return c.json({ ok: true });
});

async function loadLatestPlan(d1: D1Database, userId: string, playbookId: string) {
  const db = getDb(d1);
  const [plan] = await db
    .select()
    .from(operationalPlans)
    .where(and(eq(operationalPlans.userId, userId), eq(operationalPlans.playbookId, playbookId)))
    .orderBy(desc(operationalPlans.createdAt))
    .limit(1);
  if (!plan) return null;
  return {
    id: plan.id,
    approvalState: plan.approvalState as "pending" | "approved" | "rejected" | "superseded",
    claudeModel: plan.claudeModel,
    planMarkdown: plan.planMarkdown,
    planJson: JSON.parse(plan.planJson) as unknown,
    createdAt: plan.createdAt,
    approvedAt: plan.approvedAt,
    rejectedReason: plan.rejectedReason,
  };
}

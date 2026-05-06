import { and, desc, eq, gt } from "drizzle-orm";
import type {
  HaikuDecision,
  PlacedOrderSummary,
  RoutineKind,
  RoutineSlot,
  RoutineStatus,
  ValidationFailure,
} from "shared/routine";
import type { IntentSummary } from "shared/intent";
import type { OperationalPlan } from "shared/playbook";
import { getDb } from "../db/client";
import { operationalPlans, routineRuns, trades, userIntents, users } from "../db/schema";
import { ulid } from "../lib/ids";
import { open } from "../lib/crypto";
import { AlpacaAuthError, fetchTradableSymbols, placeOrder, type AlpacaCreds } from "../lib/alpaca";
import { invalidateUserAlpacaCaches } from "../lib/user-cache";
import { runRoutineLlm } from "../claude/haiku";
import { buildAccountContext, buildMarketSnapshot } from "../trading/snapshot";
import { validateDecisions } from "../trading/validate";

export interface ExecuteRoutineInput {
  userId: string;
  slot: RoutineSlot;
  kind: RoutineKind;
  oneShotInstruction?: string;
  /**
   * Pre-allocated run id. When provided, the executor expects a routine_runs
   * row to already exist for this id (status="running") and will UPDATE that
   * row instead of inserting a new one. Used by fire-now so the route can
   * return the runId immediately and the work runs in ctx.waitUntil.
   */
  existingRunId?: string;
}

export interface ExecuteRoutineResult {
  runId: string;
  status: RoutineStatus;
  decisions: HaikuDecision[] | null;
  validationFailures: ValidationFailure[];
  orders: PlacedOrderSummary[];
  reasoning: string | null;
  errorText: string | null;
  usage: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
}

export async function executeRoutine(env: Env, input: ExecuteRoutineInput): Promise<ExecuteRoutineResult> {
  const db = getDb(env.DB);
  const runId = input.existingRunId ?? ulid();
  const preExisting = input.existingRunId != null;
  const startedAt = Math.floor(Date.now() / 1000);

  const earlyError = async (errorText: string, planId: string | null): Promise<ExecuteRoutineResult> => {
    if (preExisting) {
      await db
        .update(routineRuns)
        .set({
          operationalPlanId: planId,
          status: "error",
          errorText,
          completedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(routineRuns.id, runId));
    } else {
      await db.insert(routineRuns).values({
        id: runId,
        userId: input.userId,
        operationalPlanId: planId,
        kind: input.kind,
        scheduledSlot: input.slot,
        oneShotInstruction: input.oneShotInstruction ?? null,
        status: "error",
        errorText,
        completedAt: startedAt,
      });
    }
    return {
      runId,
      status: "error",
      decisions: null,
      validationFailures: [],
      orders: [],
      reasoning: null,
      errorText,
      usage: { input: null, output: null, cacheRead: null, cacheWrite: null },
    };
  };

  const [userRow] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!userRow) throw new Error("user_not_found");
  if (!userRow.alpacaKeyCiphertext || !userRow.alpacaKeyIv || !userRow.alpacaSecretCiphertext || !userRow.alpacaSecretIv) {
    return earlyError("Alpaca account not linked", null);
  }

  const [approvedPlan] = await db
    .select()
    .from(operationalPlans)
    .where(and(eq(operationalPlans.userId, input.userId), eq(operationalPlans.approvalState, "approved")))
    .orderBy(desc(operationalPlans.approvedAt))
    .limit(1);

  if (!approvedPlan) {
    return earlyError("No approved operational plan", null);
  }

  if (preExisting) {
    // Stub row already exists with status="running"; just attach the plan id.
    await db
      .update(routineRuns)
      .set({ operationalPlanId: approvedPlan.id })
      .where(eq(routineRuns.id, runId));
  } else {
    await db.insert(routineRuns).values({
      id: runId,
      userId: input.userId,
      operationalPlanId: approvedPlan.id,
      kind: input.kind,
      scheduledSlot: input.slot,
      oneShotInstruction: input.oneShotInstruction ?? null,
      status: "running",
    });
  }

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
    const plan = JSON.parse(approvedPlan.planJson) as OperationalPlan;

    const [account, snapshot, tradable] = await Promise.all([
      buildAccountContext(creds),
      buildMarketSnapshot(
        env,
        creds,
        plan.universe.map((u) => u.symbol),
      ),
      fetchTradableSymbols(creds, env.CACHE).catch(() => new Set<string>()),
    ]);

    const priorValidationFailures = await recentValidationFailures(env, input.userId);
    const pendingIntents = await loadPendingIntents(env, input.userId);

    const llm = await runRoutineLlm(env, {
      slot: input.slot,
      plan,
      planMarkdown: approvedPlan.planMarkdown,
      account,
      snapshot,
      priorValidationFailures,
      oneShotInstruction: input.oneShotInstruction,
      userIntents: pendingIntents,
    });

    const validation = validateDecisions(llm.decisions.decisions, {
      plan,
      account,
      snapshot,
      tradableSymbols: tradable.size > 0 ? tradable : new Set(plan.universe.map((u) => u.symbol.toUpperCase())),
      isPremarketSlot: input.slot === "premarket",
      marketIsOpen: snapshot.marketIsOpen,
    });

    const placed: PlacedOrderSummary[] = [];
    for (const { decision, index } of validation.accepted) {
      if (decision.action !== "buy" && decision.action !== "sell") continue;
      try {
        const order = await placeOrder(creds, {
          symbol: decision.symbol,
          qty: decision.qty,
          side: decision.action,
          type: decision.order_type,
          time_in_force: decision.time_in_force,
          limit_price: decision.order_type === "limit" ? decision.limit_price : undefined,
          client_order_id: `tgp-${runId}-${index}`,
        });
        placed.push({
          decisionIndex: index,
          alpacaOrderId: order.id,
          symbol: order.symbol,
          side: order.side,
          qty: order.qty,
          orderStatus: order.status,
          filledAvgPrice: order.filled_avg_price,
        });
        await db.insert(trades).values({
          id: ulid(),
          alpacaOrderId: order.id,
          userId: input.userId,
          routineRunId: runId,
          source: "ai",
          symbol: order.symbol,
          side: order.side,
          qty: order.qty,
          filledQty: order.filled_qty,
          filledAvgPrice: order.filled_avg_price,
          orderStatus: order.status,
          submittedAt: Math.floor(new Date(order.submitted_at).getTime() / 1000),
          filledAt: order.filled_at ? Math.floor(new Date(order.filled_at).getTime() / 1000) : null,
        });
      } catch (err) {
        validation.failures.push({
          decisionIndex: index,
          symbol: decision.symbol,
          reason: `alpaca order rejected: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (pendingIntents.length > 0) {
      await reconcileIntents(env, {
        runId,
        intents: pendingIntents,
        consumed: llm.decisions.consumed_intents ?? [],
        decisions: llm.decisions.decisions,
        placedDecisionIndices: new Set(placed.map((p) => p.decisionIndex)),
      });
    }

    const anyOrders = placed.length > 0;
    const anyFailures = validation.failures.length > 0;
    if (anyOrders) await invalidateUserAlpacaCaches(env, input.userId);
    const status: RoutineStatus =
      anyOrders && anyFailures ? "partial" : anyFailures ? "validation_failed" : "succeeded";

    await db
      .update(routineRuns)
      .set({
        claudeModel: llm.model,
        inputTokens: llm.usage.input_tokens,
        outputTokens: llm.usage.output_tokens,
        cacheReadTokens: llm.usage.cache_read_input_tokens,
        cacheWriteTokens: llm.usage.cache_creation_input_tokens,
        claudeReasoning: llm.decisions.reasoning,
        decisionsJson: JSON.stringify({
          decisions: llm.decisions.decisions,
          validationFailures: validation.failures,
          orders: placed,
        }),
        marketSnapshotJson: JSON.stringify(snapshot),
        status,
        completedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(routineRuns.id, runId));

    return {
      runId,
      status,
      decisions: llm.decisions.decisions,
      validationFailures: validation.failures,
      orders: placed,
      reasoning: llm.decisions.reasoning,
      errorText: null,
      usage: {
        input: llm.usage.input_tokens,
        output: llm.usage.output_tokens,
        cacheRead: llm.usage.cache_read_input_tokens,
        cacheWrite: llm.usage.cache_creation_input_tokens,
      },
    };
  } catch (err) {
    const msg = err instanceof AlpacaAuthError ? "alpaca auth failed" : err instanceof Error ? err.message : String(err);
    console.error("routine error", err);
    await db
      .update(routineRuns)
      .set({
        status: "error",
        errorText: msg.slice(0, 500),
        completedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(routineRuns.id, runId));
    return {
      runId,
      status: "error",
      decisions: null,
      validationFailures: [],
      orders: [],
      reasoning: null,
      errorText: msg,
      usage: { input: null, output: null, cacheRead: null, cacheWrite: null },
    };
  }
}

async function loadPendingIntents(env: Env, userId: string): Promise<IntentSummary[]> {
  const db = getDb(env.DB);
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
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
    .limit(20);
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    bindingNextSlot: r.bindingNextSlot,
    status: "pending" as const,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    rejectedReason: r.rejectedReason,
    routineRunId: r.routineRunId,
  }));
}

async function reconcileIntents(
  env: Env,
  args: {
    runId: string;
    intents: IntentSummary[];
    consumed: { id: string; status: "honored" | "rejected" | "deferred"; reason?: string }[];
    decisions: HaikuDecision[];
    placedDecisionIndices: Set<number>;
  },
): Promise<void> {
  const db = getDb(env.DB);
  const nowSec = Math.floor(Date.now() / 1000);
  // Intents whose intent_id was emitted on a successfully-placed order.
  const placedIntentIds = new Set<string>();
  args.decisions.forEach((d, idx) => {
    if (d.intent_id && args.placedDecisionIndices.has(idx)) {
      placedIntentIds.add(d.intent_id);
    }
  });
  const consumedById = new Map(args.consumed.map((c) => [c.id, c]));

  for (const intent of args.intents) {
    if (placedIntentIds.has(intent.id)) {
      // Order placed for this intent — honor it regardless of what Haiku declared.
      await db
        .update(userIntents)
        .set({
          status: "honored",
          routineRunId: args.runId,
          consumedAt: nowSec,
        })
        .where(eq(userIntents.id, intent.id));
      continue;
    }
    const declared = consumedById.get(intent.id);
    if (declared) {
      if (declared.status === "deferred") {
        // Standing intents stay pending; just record the routine run had visibility.
        if (!intent.bindingNextSlot) continue;
        // Binding intent declared deferred — that's effectively a rejection.
        await db
          .update(userIntents)
          .set({
            status: "rejected",
            routineRunId: args.runId,
            rejectedReason: declared.reason ?? "binding intent cannot be deferred — Haiku must honor or reject",
            consumedAt: nowSec,
          })
          .where(eq(userIntents.id, intent.id));
        continue;
      }
      const finalStatus = declared.status === "honored" ? "honored" : "rejected";
      // 'honored' without a placed order is suspicious but we trust Haiku for now.
      await db
        .update(userIntents)
        .set({
          status: finalStatus,
          routineRunId: args.runId,
          rejectedReason: finalStatus === "rejected" ? declared.reason ?? "rejected by Haiku" : null,
          consumedAt: nowSec,
        })
        .where(eq(userIntents.id, intent.id));
      continue;
    }
    // Not in consumed_intents and no order placed for it.
    if (intent.bindingNextSlot) {
      await db
        .update(userIntents)
        .set({
          status: "rejected",
          routineRunId: args.runId,
          rejectedReason: "Haiku failed to address binding instruction",
          consumedAt: nowSec,
        })
        .where(eq(userIntents.id, intent.id));
    }
    // Standing intents stay pending until expiry.
  }
}

async function recentValidationFailures(
  env: Env,
  userId: string,
): Promise<{ symbol: string; reason: string; atIso: string }[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ decisions: routineRuns.decisionsJson, startedAt: routineRuns.startedAt })
    .from(routineRuns)
    .where(eq(routineRuns.userId, userId))
    .orderBy(desc(routineRuns.startedAt))
    .limit(5);
  const out: { symbol: string; reason: string; atIso: string }[] = [];
  for (const r of rows) {
    if (!r.decisions) continue;
    try {
      const parsed = JSON.parse(r.decisions) as { validationFailures?: ValidationFailure[] };
      for (const f of parsed.validationFailures ?? []) {
        out.push({ symbol: f.symbol, reason: f.reason, atIso: new Date(r.startedAt * 1000).toISOString() });
      }
    } catch {
      /* ignore */
    }
  }
  return out.slice(0, 5);
}

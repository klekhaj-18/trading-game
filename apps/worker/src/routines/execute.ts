import { and, desc, eq } from "drizzle-orm";
import type {
  HaikuDecision,
  PlacedOrderSummary,
  RoutineKind,
  RoutineSlot,
  RoutineStatus,
  ValidationFailure,
} from "shared/routine";
import type { OperationalPlan } from "shared/playbook";
import { getDb } from "../db/client";
import { operationalPlans, routineRuns, trades, users } from "../db/schema";
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
  const runId = ulid();
  const startedAt = Math.floor(Date.now() / 1000);

  const [userRow] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!userRow) throw new Error("user_not_found");
  if (!userRow.alpacaKeyCiphertext || !userRow.alpacaKeyIv || !userRow.alpacaSecretCiphertext || !userRow.alpacaSecretIv) {
    await db.insert(routineRuns).values({
      id: runId,
      userId: input.userId,
      operationalPlanId: null,
      kind: input.kind,
      scheduledSlot: input.slot,
      oneShotInstruction: input.oneShotInstruction ?? null,
      status: "error",
      errorText: "Alpaca account not linked",
      completedAt: startedAt,
    });
    return {
      runId,
      status: "error",
      decisions: null,
      validationFailures: [],
      orders: [],
      reasoning: null,
      errorText: "Alpaca account not linked",
      usage: { input: null, output: null, cacheRead: null, cacheWrite: null },
    };
  }

  const [approvedPlan] = await db
    .select()
    .from(operationalPlans)
    .where(and(eq(operationalPlans.userId, input.userId), eq(operationalPlans.approvalState, "approved")))
    .orderBy(desc(operationalPlans.approvedAt))
    .limit(1);

  if (!approvedPlan) {
    await db.insert(routineRuns).values({
      id: runId,
      userId: input.userId,
      operationalPlanId: null,
      kind: input.kind,
      scheduledSlot: input.slot,
      oneShotInstruction: input.oneShotInstruction ?? null,
      status: "error",
      errorText: "No approved operational plan",
      completedAt: startedAt,
    });
    return {
      runId,
      status: "error",
      decisions: null,
      validationFailures: [],
      orders: [],
      reasoning: null,
      errorText: "No approved operational plan",
      usage: { input: null, output: null, cacheRead: null, cacheWrite: null },
    };
  }

  await db.insert(routineRuns).values({
    id: runId,
    userId: input.userId,
    operationalPlanId: approvedPlan.id,
    kind: input.kind,
    scheduledSlot: input.slot,
    oneShotInstruction: input.oneShotInstruction ?? null,
    status: "running",
  });

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

    const llm = await runRoutineLlm(env, {
      slot: input.slot,
      plan,
      planMarkdown: approvedPlan.planMarkdown,
      account,
      snapshot,
      priorValidationFailures,
      oneShotInstruction: input.oneShotInstruction,
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

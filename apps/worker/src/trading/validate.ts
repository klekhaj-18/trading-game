import type { OperationalPlan } from "shared/playbook";
import type { RoutineDecision, ValidationFailure } from "shared/routine";
import type { AccountContext, MarketSnapshot } from "./snapshot";

export interface ValidationContext {
  plan: OperationalPlan;
  account: AccountContext;
  snapshot: MarketSnapshot;
  tradableSymbols: Set<string>;
  isPremarketSlot: boolean;
  marketIsOpen: boolean;
}

export interface ValidationResult {
  accepted: { decision: RoutineDecision; index: number }[];
  failures: ValidationFailure[];
}

const MAX_ORDERS_PER_RUN = 5;
const HARD_CONCENTRATION_CAP = 0.25;
const BP_UTILIZATION_CAP = 0.95;
const LIMIT_PRICE_BAND = 0.1;

export function validateDecisions(decisions: RoutineDecision[], ctx: ValidationContext): ValidationResult {
  const accepted: { decision: RoutineDecision; index: number }[] = [];
  const failures: ValidationFailure[] = [];

  const universeSet = new Set(ctx.plan.universe.map((u) => u.symbol.toUpperCase()));
  const positionsBySymbol = new Map(ctx.account.positions.map((p) => [p.symbol.toUpperCase(), p]));
  const quotesBySymbol = new Map(
    ctx.snapshot.symbols.map((s) => [s.symbol.toUpperCase(), s.lastQuote?.mid ?? null] as const),
  );
  const openOrderSymbolSides = new Set(
    ctx.account.openOrders.map((o) => `${o.symbol.toUpperCase()}|${o.side}`),
  );

  let tentativeOpen = positionsBySymbol.size;
  let remainingBuyingPower = ctx.account.buyingPower * BP_UTILIZATION_CAP;
  let liveOrderCount = 0;

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i]!;
    const sym = d.symbol.toUpperCase();
    const fail = (reason: string): void => {
      failures.push({ decisionIndex: i, symbol: sym, reason });
    };

    if (d.action === "hold" || d.action === "plan") {
      accepted.push({ decision: d, index: i });
      continue;
    }

    if (ctx.isPremarketSlot || !ctx.marketIsOpen) {
      accepted.push({ decision: { ...d, action: "plan" }, index: i });
      continue;
    }

    if (liveOrderCount >= MAX_ORDERS_PER_RUN) {
      fail(`Exceeded ${MAX_ORDERS_PER_RUN} live orders per run`);
      continue;
    }

    if (!d.intent_id && !universeSet.has(sym)) {
      fail("Symbol not in plan universe");
      continue;
    }
    if (!ctx.tradableSymbols.has(sym)) {
      fail("Symbol not tradable on Alpaca");
      continue;
    }

    if (!Number.isFinite(d.qty) || d.qty <= 0) {
      fail("qty must be a positive finite number");
      continue;
    }

    const mid = quotesBySymbol.get(sym);
    if (d.order_type === "limit") {
      if (!Number.isFinite(d.limit_price ?? NaN)) {
        fail("limit order missing limit_price");
        continue;
      }
      if (mid != null && mid > 0) {
        const band = mid * LIMIT_PRICE_BAND;
        if (Math.abs((d.limit_price ?? 0) - mid) > band) {
          fail(`limit_price outside ${LIMIT_PRICE_BAND * 100}% of last quote`);
          continue;
        }
      }
    }

    if (!d.intent_id && openOrderSymbolSides.has(`${sym}|${d.action}`)) {
      fail(`duplicate: an open ${d.action} order already exists for ${sym}`);
      continue;
    }

    if (d.action === "sell") {
      const held = positionsBySymbol.get(sym);
      if (!held || held.qty < d.qty) {
        fail("sell qty exceeds held position");
        continue;
      }
      accepted.push({ decision: d, index: i });
      liveOrderCount += 1;
      continue;
    }

    const refPrice = (d.order_type === "limit" ? d.limit_price : mid) ?? mid ?? 0;
    if (!refPrice || refPrice <= 0) {
      fail("no reference price available for sizing check");
      continue;
    }
    const notional = d.qty * refPrice;

    const planCap = (ctx.plan.sizing.position_size_pct / 100) * ctx.account.equity;
    const concentrationCap = HARD_CONCENTRATION_CAP * ctx.account.equity;
    const sizeCap = Math.min(planCap, concentrationCap);
    if (notional > sizeCap) {
      fail(`notional $${notional.toFixed(0)} exceeds sizing cap $${sizeCap.toFixed(0)}`);
      continue;
    }

    if (notional > remainingBuyingPower) {
      fail(`notional $${notional.toFixed(0)} exceeds remaining buying power $${remainingBuyingPower.toFixed(0)}`);
      continue;
    }

    const isNewPosition = !positionsBySymbol.has(sym);
    if (isNewPosition && tentativeOpen + 1 > ctx.plan.sizing.max_positions) {
      fail(`would exceed max_positions ${ctx.plan.sizing.max_positions}`);
      continue;
    }

    accepted.push({ decision: d, index: i });
    liveOrderCount += 1;
    remainingBuyingPower -= notional;
    if (isNewPosition) tentativeOpen += 1;
  }

  return { accepted, failures };
}

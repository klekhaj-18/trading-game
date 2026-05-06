/**
 * "Net realized" here is the cash-flow approximation: sum of sell notional minus sum of buy notional
 * across filled trades. It is NOT FIFO/LIFO P&L (that would require lot tracking we don't have yet).
 * For an open position, the buy notional is "out" but the gain isn't reflected here. Good enough for
 * a quick AI-vs-discretionary read at the friend-group scale.
 */
export interface SourceFlow {
  netRealized: number;
  tradeCount: number;
}

export interface PnlSplitResponse {
  strategy: SourceFlow;
  direct: SourceFlow;
}

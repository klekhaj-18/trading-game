import type { AlpacaBar } from "./alpaca";

export interface TechnicalsCard {
  symbol: string;
  asOfDate: string | null;
  lastClose: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  pricePosVsSma50Pct: number | null;
  pricePosVsSma200Pct: number | null;
  rsi14: number | null;
  atr14: number | null;
  atr14PctOfPrice: number | null;
  realizedVol10dAnnPct: number | null;
  realizedVol30dAnnPct: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  pctFromFiftyTwoWeekHigh: number | null;
  pctFromFiftyTwoWeekLow: number | null;
  avgVolume30d: number | null;
  relativeVolume30d: number | null;
  barsAvailable: number;
}

const TRADING_DAYS_PER_YEAR = 252;

function sma(values: number[], window: number): number | null {
  if (values.length < window) return null;
  const slice = values.slice(values.length - window);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / window;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(bars: AlpacaBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c),
    );
    trueRanges.push(tr);
  }
  const slice = trueRanges.slice(trueRanges.length - period);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / period;
}

function realizedVolAnn(closes: number[], window: number): number | null {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(closes.length - (window + 1));
  const logReturns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1]! <= 0 || slice[i]! <= 0) continue;
    logReturns.push(Math.log(slice[i]! / slice[i - 1]!));
  }
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (logReturns.length - 1);
  const dailyStd = Math.sqrt(variance);
  return dailyStd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

export function computeTechnicals(symbol: string, bars: AlpacaBar[]): TechnicalsCard {
  const sym = symbol.toUpperCase();
  const sorted = [...bars].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const closes = sorted.map((b) => b.c);
  const last = sorted[sorted.length - 1] ?? null;
  const lastClose = last?.c ?? null;
  const asOfDate = last?.t ?? null;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const pricePosVsSma50Pct =
    lastClose != null && sma50 != null && sma50 > 0 ? ((lastClose - sma50) / sma50) * 100 : null;
  const pricePosVsSma200Pct =
    lastClose != null && sma200 != null && sma200 > 0 ? ((lastClose - sma200) / sma200) * 100 : null;

  const rsi14 = rsi(closes, 14);
  const atr14 = atr(sorted, 14);
  const atr14PctOfPrice = atr14 != null && lastClose != null && lastClose > 0
    ? (atr14 / lastClose) * 100
    : null;

  const realizedVol10dAnnPct = realizedVolAnn(closes, 10);
  const realizedVol30dAnnPct = realizedVolAnn(closes, 30);

  const window52w = sorted.slice(-Math.min(252, sorted.length));
  const fiftyTwoWeekHigh = window52w.length > 0 ? Math.max(...window52w.map((b) => b.h)) : null;
  const fiftyTwoWeekLow = window52w.length > 0 ? Math.min(...window52w.map((b) => b.l)) : null;
  const pctFromFiftyTwoWeekHigh =
    fiftyTwoWeekHigh != null && lastClose != null && fiftyTwoWeekHigh > 0
      ? ((lastClose - fiftyTwoWeekHigh) / fiftyTwoWeekHigh) * 100
      : null;
  const pctFromFiftyTwoWeekLow =
    fiftyTwoWeekLow != null && lastClose != null && fiftyTwoWeekLow > 0
      ? ((lastClose - fiftyTwoWeekLow) / fiftyTwoWeekLow) * 100
      : null;

  // Relative volume: today's volume vs 30-day average (excluding today).
  let relativeVolume30d: number | null = null;
  let avgVolume30d: number | null = null;
  if (sorted.length >= 31) {
    const tail = sorted.slice(-31);
    const todayVol = tail[tail.length - 1]!.v;
    const priorVols = tail.slice(0, 30).map((b) => b.v).filter((v) => v > 0);
    if (priorVols.length === 30) {
      const avg = priorVols.reduce((s, x) => s + x, 0) / priorVols.length;
      if (avg > 0) {
        avgVolume30d = avg;
        if (todayVol > 0) relativeVolume30d = todayVol / avg;
      }
    }
  }

  const round = (n: number | null, dp: number): number | null =>
    n == null ? null : Number(n.toFixed(dp));

  return {
    symbol: sym,
    asOfDate,
    lastClose: round(lastClose, 4),
    sma20: round(sma20, 4),
    sma50: round(sma50, 4),
    sma200: round(sma200, 4),
    pricePosVsSma50Pct: round(pricePosVsSma50Pct, 2),
    pricePosVsSma200Pct: round(pricePosVsSma200Pct, 2),
    rsi14: round(rsi14, 2),
    atr14: round(atr14, 4),
    atr14PctOfPrice: round(atr14PctOfPrice, 2),
    realizedVol10dAnnPct: round(realizedVol10dAnnPct, 2),
    realizedVol30dAnnPct: round(realizedVol30dAnnPct, 2),
    fiftyTwoWeekHigh: round(fiftyTwoWeekHigh, 4),
    fiftyTwoWeekLow: round(fiftyTwoWeekLow, 4),
    pctFromFiftyTwoWeekHigh: round(pctFromFiftyTwoWeekHigh, 2),
    pctFromFiftyTwoWeekLow: round(pctFromFiftyTwoWeekLow, 2),
    avgVolume30d: round(avgVolume30d, 0),
    relativeVolume30d: round(relativeVolume30d, 2),
    barsAvailable: sorted.length,
  };
}

export interface MomentumStat {
  symbol: string;
  return20dPct: number | null;
}

export function compute20dReturn(bars: AlpacaBar[]): number | null {
  const sorted = [...bars].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (sorted.length < 21) return null;
  const tail = sorted.slice(-21);
  const start = tail[0]!.c;
  const end = tail[tail.length - 1]!.c;
  if (start <= 0) return null;
  return ((end - start) / start) * 100;
}

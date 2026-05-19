/**
 * Aggregator: converts FeedTick state map → ArbitrageOpportunity[]
 *
 * Hard rules for a valid opportunity:
 *  1. Same canonical symbol on both exchanges (enforced by symbol normalization).
 *  2. Price ratio within 2× — rules out same-name tokens in different quote currencies
 *     (e.g. NATGAS priced in INR on Pi42 vs USDT on Aster).
 *  3. Next-funding timestamps within 30 minutes of each other — ensures both legs
 *     settle at the same time, making the funding-rate delta actually capturable.
 *  4. Both ticks must be fresh (received within the last 2 minutes).
 *  5. fundingRateDiff > 0.
 *
 * Calculation per spec:
 *  - Long  leg: exchange with LOWER funding rate (pays less, receives if negative)
 *  - Short leg: exchange with HIGHER funding rate (receives funding)
 *  - longPrice    = longExchange.bestAsk   (we buy at ask)
 *  - shortPrice   = shortExchange.bestBid  (we sell at bid)
 *  - fundingDiff  = shortFundingRate - longFundingRate  (always positive)
 *  - spreadPct    = |shortBid - longAsk| / longAsk      (always positive cost)
 *  - totalFees    = longTakerFee + shortTakerFee        (one-way entry, both legs)
 *  - netProfit    = fundingDiff - spreadPct - totalFees
 *  Sorted by netProfit descending.
 */

export type Exchange = "pi42" | "aster" | "delta" | "coinswitch";

export interface FeedTick {
  exchange: Exchange;
  symbol: string; // canonical
  bestBid: number;
  bestAsk: number;
  fundingRate: number; // raw per-settlement-period rate (decimal, as the exchange sends it)
  fundingIntervalMs: number; // per-symbol settlement interval: 28800000 (8h) or 14400000 (4h)
  nextFundingAt: number; // epoch ms — UTC-aligned settlement timestamp
  receivedAt: number; // epoch ms
}

export interface ArbitrageOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longAsk: number;
  shortBid: number;
  longFundingRate: number;
  shortFundingRate: number;
  fundingRateDiff: number; // shortFR - longFR, always positive, decimal
  spreadPct: number;       // |shortBid - longAsk| / longAsk, always positive decimal (entry cost)
  longMakerFee: number;    // maker fee at long exchange, decimal
  longTakerFee: number;    // taker fee at long exchange, decimal
  shortMakerFee: number;   // maker fee at short exchange, decimal
  shortTakerFee: number;   // taker fee at short exchange, decimal
  totalFees: number;       // longTakerFee + shortTakerFee (both exchanges, one-way entry)
  netProfit: number;       // fundingRateDiff - spreadPct - totalFees, decimal
  longFundingIntervalMs: number;  // funding interval at long exchange (ms)
  shortFundingIntervalMs: number; // funding interval at short exchange (ms)
  nextFundingAt: number;   // sooner settlement epoch ms
  updatedAt: number;
  longMaxLeverage: number | null;  // max leverage at long exchange for this symbol
  shortMaxLeverage: number | null; // max leverage at short exchange for this symbol
  // Spread history stats (populated by scanner, 0 until first sample arrives)
  spreadSampleCount: number;   // 1-second samples recorded in the rolling 5-hour window
  lowestSpreadPct: number;     // minimum spreadPct seen in the 5-hour window (decimal)
  spreadTimesHit: number;      // samples where spreadPct ≤ targeted spread threshold
}

/**
 * Per-exchange flat fee rates (decimal, one-side entry).
 * totalFees = longTakerFee + shortTakerFee (both legs, one-way entry).
 */
const EXCHANGE_FEES: Record<Exchange, { makerFee: number; takerFee: number }> = {
  pi42:       { makerFee: 0.0007,  takerFee: 0.0007  },  // 0.07%
  aster:      { makerFee: 0.0004,  takerFee: 0.0004  },  // 0.04%
  delta:      { makerFee: 0.0007,  takerFee: 0.0007  },  // 0.07%
  coinswitch: { makerFee: 0.00088, takerFee: 0.00088 },  // 0.088%
};

// 30-minute window — both legs must settle within this tolerance of each other.
const FUNDING_TIME_TOLERANCE_MS = 30 * 60 * 1000;

const EIGHT_HOURS_MS = 28_800_000;

/**
 * Normalize a raw per-settlement-period funding rate to a per-8h equivalent.
 * This is ONLY used for cross-exchange comparison and diff calculation.
 * Display always uses the raw rate with its native interval label.
 */
function toPerEightHours(rate: number, intervalMs: number): number {
  return rate * (EIGHT_HOURS_MS / intervalMs);
}

// Maximum allowed price ratio between two ticks for the same symbol.
const MAX_PRICE_RATIO = 2;

/**
 * Build all ArbitrageOpportunity pairs from the current feed state.
 * leverageMaps: optional per-exchange max-leverage lookup (symbol → integer leverage).
 */
export function buildOpportunities(
  feedState: Map<Exchange, Map<string, FeedTick>>,
  activeExchanges?: Set<Exchange>,
  leverageMaps?: ReadonlyMap<Exchange, ReadonlyMap<string, number>>,
): ArbitrageOpportunity[] {
  // Collect ticks per canonical symbol across all (active) exchanges
  const symbolMap = new Map<string, FeedTick[]>();

  for (const [exchange, ticks] of feedState) {
    if (activeExchanges && !activeExchanges.has(exchange)) continue;
    for (const [symbol, tick] of ticks) {
      const list = symbolMap.get(symbol) ?? [];
      list.push(tick);
      symbolMap.set(symbol, list);
    }
  }

  const opportunities: ArbitrageOpportunity[] = [];
  const now = Date.now();
  const STALE_MS = 120_000; // 2 minutes

  for (const [symbol, ticks] of symbolMap) {
    if (ticks.length < 2) continue;

    // Drop stale ticks
    const fresh = ticks.filter((t) => now - t.receivedAt < STALE_MS);
    if (fresh.length < 2) continue;

    // Check every exchange pair for this symbol
    for (let i = 0; i < fresh.length; i++) {
      for (let j = i + 1; j < fresh.length; j++) {
        const a = fresh[i];
        const b = fresh[j];

        // ── Rule 2: Same coin / same quote currency (price ratio ≤ 2×) ──────
        const priceRatio = a.bestAsk / b.bestBid;
        if (priceRatio > MAX_PRICE_RATIO || priceRatio < 1 / MAX_PRICE_RATIO) {
          continue;
        }

        // ── Rule 2b: Minimum price threshold — ignore sub-penny micro-caps ───
        // Instruments priced below $0.0001 are typically meme/dust tokens with
        // unreliable funding rates. Pi42 quotes in INR (~84× larger) so they
        // will never be filtered out by this check.
        const MIN_PRICE = 0.0001;
        if (a.bestAsk < MIN_PRICE || b.bestAsk < MIN_PRICE) continue;

        // ── Rule 3a: Same funding interval (4h must pair with 4h, 8h with 8h) ─
        if (a.fundingIntervalMs !== b.fundingIntervalMs) {
          continue;
        }

        // ── Rule 3b: Aligned funding settlement time ──────────────────────
        const timeDiff = Math.abs(a.nextFundingAt - b.nextFundingAt);
        if (timeDiff > FUNDING_TIME_TOLERANCE_MS) {
          continue;
        }

        // ── Step 3: Normalize to per-8h for cross-interval-agnostic display ──
        // Both legs now have the same interval, but we express the diff in
        // per-8h terms as a standardized unit for the UI.
        const aNorm = toPerEightHours(a.fundingRate, a.fundingIntervalMs);
        const bNorm = toPerEightHours(b.fundingRate, b.fundingIntervalMs);

        // Long = lower normalized funding, Short = higher normalized funding
        const longIsA  = aNorm <= bNorm;
        const longTick  = longIsA ? a : b;
        const shortTick = longIsA ? b : a;
        const longNorm  = longIsA ? aNorm : bNorm;
        const shortNorm = longIsA ? bNorm : aNorm;

        // ── Rule 5: Positive rate differential ───────────────────────────
        const fundingRateDiff = shortNorm - longNorm; // per-8h normalized
        if (fundingRateDiff <= 0) continue;

        // ── Step 4: Prices ────────────────────────────────────────────────
        const longAsk  = longTick.bestAsk;   // we buy at ask on the long leg
        const shortBid = shortTick.bestBid;  // we sell at bid on the short leg

        // ── Step 6: Spread ────────────────────────────────────────────────
        // Always positive — entry cost regardless of direction
        const spreadPct = Math.abs((shortBid - longAsk) / longAsk);

        // ── Step 7: Fees ──────────────────────────────────────────────────
        const longFees  = EXCHANGE_FEES[longTick.exchange];
        const shortFees = EXCHANGE_FEES[shortTick.exchange];

        const longMakerFee  = longFees.makerFee;
        const longTakerFee  = longFees.takerFee;
        const shortMakerFee = shortFees.makerFee;
        const shortTakerFee = shortFees.takerFee;

        // Both exchanges, one-way entry
        const totalFees = longTakerFee + shortTakerFee;

        // ── Step 8: Net Profit ────────────────────────────────────────────
        const netProfit = fundingRateDiff - spreadPct - totalFees;

        // Use the sooner settlement as canonical nextFundingAt
        const nextFundingAt = Math.min(longTick.nextFundingAt, shortTick.nextFundingAt);

        // Leverage lookup (null when exchange doesn't publish this data)
        const longMaxLeverage  = leverageMaps?.get(longTick.exchange)?.get(symbol) ?? null;
        const shortMaxLeverage = leverageMaps?.get(shortTick.exchange)?.get(symbol) ?? null;

        opportunities.push({
          symbol,
          longExchange:    longTick.exchange,
          shortExchange:   shortTick.exchange,
          longAsk,
          shortBid,
          longFundingRate:  longTick.fundingRate,
          shortFundingRate: shortTick.fundingRate,
          fundingRateDiff,
          spreadPct,
          longMakerFee,
          longTakerFee,
          shortMakerFee,
          shortTakerFee,
          totalFees,
          netProfit,
          longFundingIntervalMs:  longTick.fundingIntervalMs,
          shortFundingIntervalMs: shortTick.fundingIntervalMs,
          nextFundingAt,
          updatedAt: now,
          longMaxLeverage,
          shortMaxLeverage,
          spreadSampleCount: 0,
          lowestSpreadPct: 0,
          spreadTimesHit: 0,
        });
      }
    }
  }

  // ── Step 9: Sort by highest netProfit ─────────────────────────────────────
  opportunities.sort((a, b) => b.netProfit - a.netProfit);

  return opportunities;
}

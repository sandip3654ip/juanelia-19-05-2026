import { getTradingFees }            from "./fees/index.js";
import { findCheapestTransferRoute } from "./fees/network-matcher.js";
import type { SpotOpportunity, SpotQuote } from "./types.js";

export interface FeeGetter {
  (exchange: string, symbol: string): { maker: number; taker: number };
}

// ── Staleness ─────────────────────────────────────────────────────────────────
const MAX_AGE_MS = 60_000;

// ── Ticker-collision guard ────────────────────────────────────────────────────
// Beyond this threshold the same ticker almost certainly refers to a different
// coin on two different exchanges (e.g. ELON on KuCoin ≠ Bybit).
const MAX_DIFF_PCT = 5;

// ── Minimum exchanges per symbol ──────────────────────────────────────────────
const MIN_EXCHANGES = 2;

// ── Tax constants ─────────────────────────────────────────────────────────────
// Indian GST on broker fees: 18 % — applied on both legs.
const FEE_TAX_RATE = 0.18;
// TDS (Tax Deducted at Source): 1 % on sell-leg gross proceeds.
const TDS_RATE = 0.01;

const REFERENCE_TRADE_USD = 1_000;

export function buildOpportunities(
  exchangeData: Map<string, Map<string, SpotQuote>>,
  feeGetter: FeeGetter,
): SpotOpportunity[] {
  const now    = Date.now();
  const cutoff = now - MAX_AGE_MS;

  const allSymbols = new Set<string>();
  for (const quotes of exchangeData.values()) {
    for (const sym of quotes.keys()) allSymbols.add(sym);
  }

  const opportunities: SpotOpportunity[] = [];

  for (const symbol of allSymbols) {
    const prices: Array<{ exchange: string; bid: number; ask: number }> = [];

    for (const [exchange, quotes] of exchangeData.entries()) {
      const q = quotes.get(symbol);
      if (!q || q.receivedAt < cutoff) continue;
      if (q.bid <= 0 || q.ask <= 0) continue;
      if (q.ask < 0.0001) continue; // ignore sub-penny micro-cap tokens
      prices.push({ exchange, bid: q.bid, ask: q.ask });
    }

    if (prices.length < MIN_EXCHANGES) continue;

    let buyEntry  = prices[0];
    let sellEntry = prices[0];

    for (const p of prices) {
      if (p.ask < buyEntry.ask)  buyEntry  = p;
      if (p.bid > sellEntry.bid) sellEntry = p;
    }

    if (buyEntry.exchange === sellEntry.exchange) continue;

    const priceDiffPct = ((sellEntry.bid - buyEntry.ask) / buyEntry.ask) * 100;

    // Ticker-collision guard — implausibly large diff almost certainly means
    // the same ticker refers to different coins on the two exchanges.
    if (priceDiffPct > MAX_DIFF_PCT) continue;

    // ── Fee calculation ──────────────────────────────────────────────────────
    const buyFees  = feeGetter(buyEntry.exchange,  symbol);
    const sellFees = feeGetter(sellEntry.exchange, symbol);

    // Drop pairs with no common transfer network between the two exchanges.
    const route = findCheapestTransferRoute(
      buyEntry.exchange,
      symbol,
      sellEntry.exchange,
    );
    if (route === null) continue;

    const wdFeeInCoin            = route.withdrawFee ?? null;
    const depFeeInCoin           = route.depositFee  ?? null;
    const totalTransferFeeInCoin = route.totalFee    ?? null;
    const wdFeeUSD            = wdFeeInCoin            !== null ? wdFeeInCoin            * buyEntry.ask : null;
    const depFeeUSD           = depFeeInCoin           !== null ? depFeeInCoin           * buyEntry.ask : null;
    const totalTransferFeeUSD = totalTransferFeeInCoin !== null ? totalTransferFeeInCoin * buyEntry.ask : null;

    // ── Net profit formula ────────────────────────────────────────────────────
    //   Tokens      = A / B
    //   SellValue   = Tokens × S
    //   GrossProfit = SellValue − A
    //   BuyFee      = A × BF%
    //   SellFee     = SellValue × SF%
    //   TDSAmount   = SellValue × TDS%
    //   WF          = withdrawal fee (USDT)
    //   NetProfit   = GrossProfit − BuyFee − SellFee − TDSAmount − WF
    const buyFeeEff  = buyFees.taker  * (1 + FEE_TAX_RATE);
    const sellFeeEff = sellFees.taker * (1 + FEE_TAX_RATE);

    const tokens      = REFERENCE_TRADE_USD / buyEntry.ask;
    const sellValue   = tokens * sellEntry.bid;
    const grossProfit = sellValue - REFERENCE_TRADE_USD;
    const buyFee      = REFERENCE_TRADE_USD * buyFeeEff;
    const sellFee     = sellValue * sellFeeEff;
    const tdsAmt      = sellValue * TDS_RATE;
    const wdFee       = totalTransferFeeUSD ?? 0;
    const netProfit   = grossProfit - buyFee - sellFee - tdsAmt - wdFee;
    const netProfitPct = (netProfit / REFERENCE_TRADE_USD) * 100;

    opportunities.push({
      symbol,
      buyExchange:  buyEntry.exchange,
      sellExchange: sellEntry.exchange,
      buyAsk:       buyEntry.ask,
      sellBid:      sellEntry.bid,
      priceDiffPct,
      netProfitPct,
      fees: {
        buyFeeRate:             buyFees.taker,
        sellFeeRate:            sellFees.taker,
        withdrawFeeInCoin:      wdFeeInCoin,
        withdrawFeeUSD:         wdFeeUSD,
        withdrawNetwork:        route.canonicalNetwork ?? null,
        withdrawFeeKnown:       true,
        depositFeeInCoin:       depFeeInCoin,
        totalTransferFeeInCoin,
        feeSource:              route.feeSource         ?? null,
        addressVerified:        route.addressVerified        ?? null,
        routesConsidered:       route.routesConsidered       ?? null,
        speedTier:              (route.speedTier             ?? null) as "fast" | "medium" | null,
        addressConfirmedCount:  route.confirmedCount         ?? null,
        feeTaxRate:             FEE_TAX_RATE,
        tdsRate:                TDS_RATE,
      },
      allPrices: prices
        .slice()
        .sort((a, b) => b.bid - a.bid)
        .map((p) => ({ exchange: p.exchange, bid: p.bid, ask: p.ask })),
      safetyWarnings:      [],
      updatedAt:           now,
      profitTimesHit:      0,
      highestNetProfitPct: null,
      lowestNetProfitPct:  null,
    });
  }

  // Sort by net profit descending (best real opportunity first)
  opportunities.sort((a, b) => b.netProfitPct - a.netProfitPct);
  return opportunities;
}

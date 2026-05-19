export interface SpotQuote {
  bid: number;
  ask: number;
  receivedAt: number;
}

export interface SpotExchangePrice {
  exchange: string;
  bid: number;
  ask: number;
}

export interface SpotFeeBreakdown {
  /** Taker fee on the BUY exchange (we hit the ask for instant fill) */
  buyFeeRate:            number;        // e.g. 0.001 = 0.10%
  /** Taker fee on the SELL exchange (we hit the bid for instant fill) */
  sellFeeRate:           number;
  /** Cheapest withdrawal fee leaving the buy exchange (in base coin units) */
  withdrawFeeInCoin:     number | null;
  /** withdrawFeeInCoin × buyAsk in USD */
  withdrawFeeUSD:        number | null;
  /** Canonical network used for the transfer (e.g. "ARBITRUM", "BEP20") */
  withdrawNetwork:       string | null;
  /** true → fee data was found and included in netProfitPct */
  withdrawFeeKnown:      boolean;
  /** Deposit fee charged by the sell exchange on this network (in coin units; usually 0) */
  depositFeeInCoin:      number | null;
  /** Total transfer cost = withdrawFee + depositFee (in coin units) */
  totalTransferFeeInCoin: number | null;
  /** Where the withdrawal data came from */
  feeSource:             "api" | "static" | null;
  /**
   * true  → both exchanges exposed the contract address on the matched network and they MATCHED.
   * false → match relied on network identity only (one side did not expose an address —
   *         e.g. Bybit, or a native asset). Lower confidence; manually verify before trading.
   * null  → no route found.
   */
  addressVerified:       boolean | null;
  /**
   * Total number of compatible networks considered before picking the cheapest one shown.
   * 1 = only one option existed; >1 = the displayed network is the cheapest of N alternatives.
   * null = no route found.
   */
  routesConsidered:      number | null;
  /**
   * Speed tier of the chosen network: "fast" (<5 min) | "medium" (5–30 min).
   * Slow networks (BTC, LTC, DOGE, BCH, …) are filtered out and never appear here.
   * null = no route found.
   */
  speedTier:             "fast" | "medium" | null;
  /**
   * How many consecutive daily refreshes have returned the exact same deposit address
   * for this coin on the sell exchange. Bot eligibility requires ≥10.
   * null = no route found.
   */
  addressConfirmedCount: number | null;
  /**
   * Tax surcharge applied to both legs' taker fees in the netProfitPct calculation
   * (decimal, e.g. 0.18 = 18 % GST). UI shows the effective rate as
   * `buyFeeRate × (1 + feeTaxRate)`.
   */
  feeTaxRate:            number;
  /**
   * TDS (Tax Deducted at Source) rate applied on sell-leg gross proceeds in
   * the netProfitPct calculation (decimal, e.g. 0.01 = 1 %). Indian crypto
   * rules: 1 % TDS is withheld on every sell trade.
   */
  tdsRate:               number;
}

export interface SpotOpportunity {
  symbol:          string;
  buyExchange:     string;
  sellExchange:    string;
  buyAsk:          number;
  sellBid:         number;
  priceDiffPct:    number; // gross spread %
  netProfitPct:    number; // after maker + taker + withdrawal fees
  fees:            SpotFeeBreakdown;
  allPrices:       SpotExchangePrice[];
  updatedAt:       number;
  profitTimesHit:      number;       // 1-second samples in 4h window where netProfitPct >= targetedNetProfit (0 when no target)
  highestNetProfitPct: number | null; // highest netProfitPct recorded in the 4h window (null = no history yet)
  lowestNetProfitPct:  number | null; // lowest  netProfitPct recorded in the 4h window (null = no history yet)
  /**
   * Soft safety warnings on opportunities that passed all hard gates.
   * Cards are still shown but UI displays caution badges for each flag.
   *
   * Possible values:
   *   "unverified_route"  — network matched but contract address unverified
   *   "estimated_fees"    — withdrawal fee from static table (not live API)
   *   "medium_speed"      — transfer network typically takes 5–30 min
   *   "low_profit"        — net profit < 0 % (above the floor but not yet positive)
   */
  safetyWarnings: string[];
}

export interface SpotExchangeStatus {
  exchange:    string;
  status:      "online" | "offline";
  dataSource:  "ws" | "rest";
  symbolCount: number;
  lastFetchAt: number | null;
}

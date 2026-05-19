export type HedgeExchange = "binance" | "bybit" | "kucoin" | "bitget";

export type HedgePhase =
  | "idle"        // not started
  | "watching"    // Phase 1: waiting for neutral spread to init inventory
  | "harvesting"  // Phase 2: actively capturing spreads
  | "exiting"     // Phase 3: waiting for neutral spread to sell inventory
  | "stopped";    // cycle complete / manually stopped

export interface HedgeConfig {
  token:               string;         // e.g. "GOD", "BTC" (no USDT suffix)
  exchangeA:           HedgeExchange;
  exchangeB:           HedgeExchange;
  tradeAmountUsdt:     number;         // USDT per round e.g. 100
  minSpreadPct:        number;         // target net profit % to trigger a harvest flip
  neutralThresholdPct: number;         // spread % considered "neutral" for init/exit
  maxRounds:           number;         // max harvest flips before auto-exit (0 = unlimited)
  flipIntervalSec:     number;         // cooldown seconds between harvest rounds (0 = no cooldown)
  tdsPct:              number;         // TDS on sell leg e.g. 1.0
  takerFeePct:         number;         // taker fee per leg e.g. 0.1 (base, before GST)
  gstPct:              number;         // GST on exchange fees e.g. 18 → effective fee = takerFee × 1.18
  dryRun:              boolean;        // simulate orders without real execution
  maxLossUsdt?:        number;         // circuit breaker: auto-exit if session net loss exceeds this (0 = disabled)
}

export interface ExchangeInventory {
  usdt:  number;
  token: number;
}

export interface HedgeInventory {
  a: ExchangeInventory;  // exchangeA
  b: ExchangeInventory;  // exchangeB
}

export interface HedgeTrade {
  id:            string;
  roundNum:      number;
  timestamp:     number;
  tradeType:     "init" | "harvest" | "exit";
  buyExchange:   HedgeExchange | null;
  sellExchange:  HedgeExchange | null;
  buyPrice:      number | null;
  sellPrice:     number | null;
  qty:           number;
  grossProfit:   number;
  tdsUsdt:       number;
  feesUsdt:      number;
  netProfit:     number;
  inventoryAfter: HedgeInventory;
  buyOrderId?:   string;
  sellOrderId?:  string;
  buyStatus?:    string;
  sellStatus?:   string;
  note?:         string;
}

export interface LiveSpread {
  token:        string;
  exchangeA:    string;
  exchangeB:    string;
  askA:         number | null;
  bidA:         number | null;
  askB:         number | null;
  bidB:         number | null;
  /** Best harvest spread % — positive means profitable direction exists */
  spreadPct:    number | null;
  /** Which direction is the profitable one */
  direction:    "sell_A_buy_B" | "sell_B_buy_A" | "neutral" | "unknown";
  /** Net profit % after TDS + taker fees on both legs */
  netProfitPct: number | null;
  updatedAt:    number;
}

export interface HedgeError {
  ts:  number;
  msg: string;
}

export interface HedgeBotState {
  phase:          HedgePhase;
  config:         HedgeConfig | null;
  inventory:      HedgeInventory | null;
  trades:         HedgeTrade[];
  roundCount:     number;
  totalNetProfit: number;
  startedAt:      number | null;
  lastTradeAt:    number | null;
  lastSyncAt:     number | null;   // last time real balances were fetched from exchanges
  statusMessage:  string;
  errors:         HedgeError[];    // recent non-fatal errors / compensation events
}

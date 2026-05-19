/**
 * Spot Arbitrage Bot Engine — Full State Machine
 * ────────────────────────────────────────────────
 * Flow: buying → transferring → waiting_withdrawal → waiting_deposit → monitoring → selling → completed | failed
 *
 * One active trade at a time (maxOpenPositions = 1).
 * All exchange calls are real — no simulation mode.
 *
 * Safety timeouts:
 *   waiting_withdrawal → 2 h
 *   waiting_deposit    → 6 h  (measured from withdrawal confirmation)
 *   monitoring         → 24 h force-sell
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join }                                    from "node:path";
import { logger }              from "../logger.js";
import { spotScanner }         from "../spot-scanner/index.js";
import { spotPriceHistory }    from "../spot-scanner/price-history.js";
import {
  placeOrder,
  getBalance,
  kucoinTransferMainToTrade,
  kucoinGetMainBalance,
  type Exchange,
} from "../trading/index.js";
import { getCachedBalances }                               from "../wallet/index.js";
import { withdraw, getWithdrawStatus, getDepositByTxId }   from "../trading/withdraw.js";
import {
  getDepositAddress,
  getDepositAddressStatus,
  getNextAutoRefreshAt,
} from "../spot-scanner/fees/deposit-address-service.js";
import {
  findCheapestTransferRoute,
  getNativeWithdrawChainId,
} from "../spot-scanner/fees/network-matcher.js";
import type { SpotOpportunity } from "../spot-scanner/types.js";

// ── Config ────────────────────────────────────────────────────────────────────

export type PriceMovementWindow = "4H" | "8H" | "12H" | "24H";

export interface BotConfig {
  enabled:                boolean;

  // Opportunity filters
  minNetProfitPct:        number;   // live net profit ≥ this % to qualify
  minTimesHit:            number;   // must have been profitable ≥ N seconds in 4h window
  maxMovementPct:         number;   // sell-side price movement cap (0 = no cap)
  priceMovementWindow:    PriceMovementWindow;
  requireAddressVerified: boolean;  // only trade pairs with verified deposit addresses
  maxWithdrawFeeUSD:      number;   // max withdrawal fee in USD (0 = no cap)

  // Trade execution
  tradeAmountUSDT:        number;   // capital per trade in USDT
  takeProfitPct:          number;   // sell when live net profit ≥ this %
  maxOpenPositions:       number;   // concurrent positions cap (currently only 1 supported)

  // Advanced
  allowedExchanges:       string[];
  maxFeesPct:             number;
  maxTradesPerHour:       number;
}

const DEFAULT_CONFIG: BotConfig = {
  enabled:                false,
  minNetProfitPct:        1.0,
  minTimesHit:            3,
  maxMovementPct:         0,
  priceMovementWindow:    "4H",
  requireAddressVerified: false,
  maxWithdrawFeeUSD:      0,
  tradeAmountUSDT:        100,
  takeProfitPct:          1.0,
  maxOpenPositions:       1,
  allowedExchanges:       ["binance", "bybit", "kucoin", "bitget"],
  maxFeesPct:             100,
  maxTradesPerHour:       1000,
};

// ── Config persistence ────────────────────────────────────────────────────────

const DATA_DIR    = join(process.cwd(), "data");
const CONFIG_FILE = join(DATA_DIR, "bot-config.json");

function loadConfigFromDisk(): void {
  try {
    const raw    = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotConfig>;
    config = { ...config, ...parsed };
    logger.info({ enabled: config.enabled }, "bot config loaded from disk");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err: (err as Error).message }, "bot config load failed — using defaults");
    }
  }
}

function saveConfigToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "bot config save failed");
  }
}

// ── Trade types ───────────────────────────────────────────────────────────────

export type TradePhase =
  | "buying"
  | "transferring"
  | "waiting_withdrawal"
  | "waiting_deposit"
  | "monitoring"
  | "selling"
  | "completed"
  | "failed";

export interface BotTrade {
  id:                   string;
  timestamp:            number;
  updatedAt:            number;
  phase:                TradePhase;

  // Opportunity snapshot
  symbol:               string;
  buyExchange:          string;
  sellExchange:         string;
  tradeAmountUSDT:      number;
  expectedNetProfitPct: number;
  totalFeesPct:         number;
  grossSpreadPct:       number;
  timesHit:             number;
  buyAsk:               number;
  sellBid:              number;

  // Phase: buying
  buyOrderId?:          string;
  executedBuyQty?:      number;
  executedBuyPrice?:    number;

  // Phase: transferring
  transferNetwork?:       string;       // canonical network (e.g. "SOL")
  transferNetworkNative?: string;       // exchange-native chain ID (e.g. "SOL" / "sol")
  depositAddress?:        string;
  depositTag?:            string | null;
  withdrawalId?:          string;
  withdrawalInitiatedAt?: number;
  withdrawalStatus?:      string;
  withdrawalTxId?:        string;
  withdrawalConfirmedAt?: number;
  usdtExchange?:          string;       // exchange that held USDT at trade start

  // Fees snapshot at trade entry — used for accurate live P&L in monitoring
  feesSnapshot?: {
    sellFeeRate: number;
    tdsRate:     number;
    feeTaxRate:  number;
  };

  // Full opportunity snapshot
  opportunitySnapshot?: {
    netProfitPct:          number;
    grossSpreadPct:        number;
    buyAsk:                number;
    sellBid:               number;
    timesHit:              number;
    highestNetProfitPct:   number | null;
    capturedAt:            number;
    fees: {
      buyFeeRate:             number;
      sellFeeRate:            number;
      feeTaxRate:             number;
      tdsRate:                number;
      withdrawFeeInCoin:      number | null;
      withdrawFeeUSD:         number | null;
      withdrawNetwork:        string | null;
      totalTransferFeeInCoin: number | null;
      speedTier:              "fast" | "medium" | null;
      feeSource:              "api" | "static" | null;
      addressVerified:        boolean | null;
      routesConsidered:       number | null;
    };
    allPrices: { exchange: string; bid: number; ask: number }[];
  };

  // Phase: waiting_deposit
  preDepositBalance?:   number;
  depositedQty?:        number;
  depositConfirmedAt?:  number;

  // Phase: monitoring
  monitoringStartAt?:   number;
  monitoringStartBid?:  number;
  currentBid?:          number;
  currentNetProfitPct?: number;
  peakNetProfitPct?:    number;

  // Phase: selling
  sellOrderId?:         string;
  executedSellQty?:     number;
  executedSellPrice?:   number;
  actualNetProfitPct?:  number;
  completedAt?:         number;

  error?:               string;
}

// ── State ─────────────────────────────────────────────────────────────────────

let config: BotConfig = { ...DEFAULT_CONFIG };
loadConfigFromDisk();

const trades: BotTrade[] = [];
let activeTrade:   BotTrade | null = null;
let loopTimer:     ReturnType<typeof setInterval> | null = null;
let fastPoller:    ReturnType<typeof setInterval> | null = null;
let monitorPoller: ReturnType<typeof setInterval> | null = null;
let isAdvancing  = false;
let tradesThisHour   = 0;
let hourWindowStart  = Date.now();

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetHourWindow(): void {
  if (Date.now() - hourWindowStart >= 3_600_000) {
    tradesThisHour  = 0;
    hourWindowStart = Date.now();
  }
}

/**
 * Floor a number to `decimals` decimal places (never rounds UP).
 * Used for withdrawal and sell quantities to avoid "insufficient balance" errors.
 */
function floorTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.floor(n * factor) / factor;
}

/**
 * Net profit % on a given USDT trade amount, accounting for all fees.
 * Includes: buy fee + GST, sell fee + GST, TDS, withdrawal fee (in USDT).
 */
function calcNetProfitPct(opp: SpotOpportunity, amount: number): number {
  const { fees, buyAsk, sellBid } = opp;
  const buyFeeEff  = (fees.buyFeeRate  ?? 0.001) * (1 + (fees.feeTaxRate ?? 0.18));
  const sellFeeEff = (fees.sellFeeRate ?? 0.001) * (1 + (fees.feeTaxRate ?? 0.18));
  const tdsRate    = fees.tdsRate ?? 0.01;
  const tokens     = buyAsk > 0 ? amount / buyAsk : 0;
  const sellValue  = tokens * sellBid;
  const gross      = sellValue - amount;
  const buyFee     = amount    * buyFeeEff;
  const sellFee    = sellValue * sellFeeEff;
  const tds        = sellValue * tdsRate;
  const wdFeeUSDT  = (fees.totalTransferFeeInCoin ?? 0) * buyAsk;
  const net        = gross - buyFee - sellFee - tds - wdFeeUSDT;
  return amount > 0 ? (net / amount) * 100 : 0;
}

/**
 * Total fees as % of trade amount (buy fee + sell fee + TDS + withdrawal fee).
 * Used for the maxFeesPct filter in opportunity selection.
 * Exported so the /bot/find-opportunity diagnostic route can apply the same cap.
 */
export function calcTotalFeesPct(opp: SpotOpportunity, amount: number): number {
  const { fees, buyAsk, sellBid } = opp;
  const buyFeeEff  = (fees.buyFeeRate  ?? 0.001) * (1 + (fees.feeTaxRate ?? 0.18));
  const sellFeeEff = (fees.sellFeeRate ?? 0.001) * (1 + (fees.feeTaxRate ?? 0.18));
  const tdsRate    = fees.tdsRate ?? 0.01;
  const tokens     = buyAsk > 0 ? amount / buyAsk : 0;
  const sellValue  = tokens * sellBid;
  const buyFee     = amount    * buyFeeEff;
  const sellFee    = sellValue * sellFeeEff;
  const tds        = sellValue * tdsRate;
  const wdFeeUSDT  = (fees.totalTransferFeeInCoin ?? 0) * buyAsk;
  const totalFees  = buyFee + sellFee + tds + wdFeeUSDT;
  return amount > 0 ? (totalFees / amount) * 100 : 0;
}

/**
 * Live net profit % during monitoring.
 * Uses actual depositedQty + current market bid + fees snapshot from trade entry.
 */
function calcLiveNetProfit(trade: BotTrade, liveBid: number): number {
  const qty  = trade.depositedQty ?? (trade.executedBuyQty ?? 0);
  const cost = trade.tradeAmountUSDT;
  if (cost <= 0 || qty <= 0 || liveBid <= 0) return 0;
  const gross       = qty * liveBid;
  const fs          = trade.feesSnapshot;
  const sellFeeRate = (fs?.sellFeeRate ?? 0.001) * (1 + (fs?.feeTaxRate ?? 0.18));
  const tdsRate     = fs?.tdsRate ?? 0.01;
  const sellFee     = gross * sellFeeRate;
  const tds         = gross * tdsRate;
  const net         = gross - sellFee - tds - cost;
  return (net / cost) * 100;
}

/**
 * KuCoin sell-side balance: deposits always land in MAIN account.
 * All other exchanges: regular spot/unified account via getBalance().
 */
async function getSellSideBalance(sellEx: Exchange, coin: string): Promise<number> {
  const bals = sellEx === "kucoin"
    ? await kucoinGetMainBalance(coin)
    : await getBalance(sellEx, coin);
  return bals[coin]?.free ?? 0;
}

function finalizeTrade(trade: BotTrade): void {
  tradesThisHour++;
  trades.unshift(trade);
  if (trades.length > 200) trades.splice(200);
  activeTrade = null;
}

function failTrade(trade: BotTrade, reason: string): void {
  trade.phase     = "failed";
  trade.error     = reason;
  trade.updatedAt = Date.now();
  logger.error({ id: trade.id, symbol: trade.symbol, reason }, "bot: trade failed");
  stopFastPoller();
  stopMonitorPoller();
  finalizeTrade(trade);
}

// ── Pollers ───────────────────────────────────────────────────────────────────
// fast poller  (1s)   — owns waiting_withdrawal + waiting_deposit phases
// monitor poller (100ms) — owns monitoring phase for instant profit-trigger

function startFastPoller(): void {
  if (fastPoller) return;
  fastPoller = setInterval(() => {
    if (!activeTrade) { stopFastPoller(); return; }
    const p = activeTrade.phase;
    if (p !== "waiting_withdrawal" && p !== "waiting_deposit") { stopFastPoller(); return; }
    if (isAdvancing) return;
    isAdvancing = true;
    advanceTrade(activeTrade)
      .catch((err: unknown) => logger.error({ err }, "bot: fast poller error"))
      .finally(() => { isAdvancing = false; });
  }, 1_000);
  logger.info("bot: fast poller started (1s)");
}

function stopFastPoller(): void {
  if (fastPoller) { clearInterval(fastPoller); fastPoller = null; logger.info("bot: fast poller stopped"); }
}

function startMonitorPoller(): void {
  if (monitorPoller) return;
  monitorPoller = setInterval(() => {
    if (!activeTrade) { stopMonitorPoller(); return; }
    if (activeTrade.phase !== "monitoring") { stopMonitorPoller(); return; }
    if (isAdvancing) return;
    isAdvancing = true;
    advanceTrade(activeTrade)
      .catch((err: unknown) => logger.error({ err }, "bot: monitor poller error"))
      .finally(() => { isAdvancing = false; });
  }, 100);
  logger.info("bot: monitor poller started (100ms)");
}

function stopMonitorPoller(): void {
  if (monitorPoller) { clearInterval(monitorPoller); monitorPoller = null; logger.info("bot: monitor poller stopped"); }
}

// ── Phase handlers ────────────────────────────────────────────────────────────

// Phase 1: BUYING
// Binance: market buy with quoteOrderQty — fills inline, no extra wait.
// Bybit  : market buy with marketUnit=quoteCoin — 600ms wait then fetchOrder.
// KuCoin : market buy with funds (quoteQty) — 800ms wait then fetchOrder.
// Bitget : market buy with notional — 800ms wait then fetchOrder.
//
// All 4 exchanges land bought tokens in the spot/trade account.
// KuCoin: tokens land in TRADE account (withdrawal requires TRADE→MAIN transfer later).

async function doBuying(trade: BotTrade): Promise<void> {
  const buyEx = trade.buyExchange as Exchange;
  const amount = trade.tradeAmountUSDT;

  const result = await placeOrder(buyEx, {
    symbol:        trade.symbol,
    side:          "buy",
    type:          "market",
    quoteQty:      amount,
    clientOrderId: trade.id,
  });

  trade.buyOrderId       = result.orderId;
  trade.executedBuyQty   = result.executedQty;
  trade.executedBuyPrice = result.avgPrice;
  trade.phase            = "transferring";
  trade.updatedAt        = Date.now();
  logger.info(
    { id: trade.id, buyEx, orderId: result.orderId, qty: result.executedQty, avgPrice: result.avgPrice },
    "bot: buy placed",
  );
}

// Phase 2: TRANSFERRING
// Resolves the cheapest transfer route, fetches the deposit address on sell exchange,
// then calls withdraw() on the buy exchange.
//
// KuCoin buy-side:   coins land in TRADE. kucoinWithdraw() does TRADE→MAIN internally before withdrawing.
// Bybit  buy-side:   coins in UNIFIED account — withdraw from UNIFIED.
// Binance buy-side:  coins in spot account — standard withdrawal.
// Bitget  buy-side:  coins in spot account — standard withdrawal.
//
// Withdrawal amount = floor(executedBuyQty × 0.9999, 8dp)
//   → always rounds DOWN to avoid "insufficient balance" from exchange minimums.

async function doTransferring(trade: BotTrade): Promise<void> {
  const coin   = trade.symbol;
  const buyEx  = trade.buyExchange;
  const sellEx = trade.sellExchange;

  // Guard A: executedBuyQty must be > 0.
  // KuCoin fetchOrder can fail and return 0 in the fallback path —
  // never attempt a zero-amount withdrawal.
  if ((trade.executedBuyQty ?? 0) <= 0) {
    return failTrade(
      trade,
      `Cannot transfer: executedBuyQty is 0 for ${coin} on ${buyEx} — buy order may not have filled`,
    );
  }

  // Guard B: hold if deposit address sync is actively running.
  // Addresses may be mid-refresh — withdrawing now could route to a stale address.
  // (We do NOT block for "sync imminent" — if buy is already done, withdraw immediately.)
  if (getDepositAddressStatus().isRefreshing) {
    logger.info(
      { id: trade.id, coin, buyEx, sellEx },
      "bot: withdrawal HELD — deposit address sync in progress, retrying next tick",
    );
    return; // stays in "transferring", retries on next 1s tick
  }

  // Guard C: cheapest route must exist.
  const route = findCheapestTransferRoute(buyEx, coin, sellEx);
  if (!route) {
    return failTrade(trade, `No transfer route found for ${coin}: ${buyEx} → ${sellEx}`);
  }

  const canonicalNet = route.canonicalNetwork;
  const nativeChain  = getNativeWithdrawChainId(buyEx, coin, canonicalNet);
  if (!nativeChain) {
    return failTrade(trade, `Native chain ID not found for ${coin} on ${buyEx} (${canonicalNet})`);
  }

  const depEntry = getDepositAddress(sellEx, coin, canonicalNet);
  if (!depEntry?.address) {
    return failTrade(
      trade,
      `Deposit address not found for ${coin} on ${sellEx} via ${canonicalNet} — run address refresh`,
    );
  }

  trade.transferNetwork       = canonicalNet;
  trade.transferNetworkNative = nativeChain;
  trade.depositAddress        = depEntry.address;
  trade.depositTag            = depEntry.tag ?? null;

  // Floor (never round up) to 8dp — avoids "insufficient balance" errors.
  // toPrecision(6) could round UP e.g. 13835.182 → 13835.2, requesting more than available.
  const withdrawAmt = floorTo((trade.executedBuyQty ?? 0) * 0.9999, 8);

  const result = await withdraw(buyEx as Exchange, {
    coin,
    chainId:  nativeChain,
    address:  depEntry.address,
    tag:      depEntry.tag ?? null,
    amount:   withdrawAmt,
    clientId: `${trade.id}-wd`,
  });

  trade.withdrawalId          = result.withdrawalId;
  trade.withdrawalInitiatedAt = Date.now();
  trade.withdrawalStatus      = "pending";
  trade.phase                 = "waiting_withdrawal";
  trade.updatedAt             = Date.now();
  logger.info(
    { id: trade.id, coin, canonicalNet, nativeChain, withdrawAmt, withdrawalId: result.withdrawalId },
    "bot: withdrawal submitted",
  );
}

// Phase 3: WAITING_WITHDRAWAL
// Polls the buy exchange every 1s until withdrawal status = "success" or a terminal error.
//
// Binance : status 0=pending, 6=processing, 1=success
// Bybit   : BlockchainConfirmed → "success"
// KuCoin  : SUCCESS → "success"
// Bitget  : success → "success"
//
// On success: snapshots pre-deposit balance on sell exchange, then moves to waiting_deposit.
// KuCoin sell-side: pre-deposit balance queried from MAIN account (deposits land there).

async function doWaitingWithdrawal(trade: BotTrade): Promise<void> {
  const coin = trade.symbol;
  const now  = Date.now();
  const age  = now - (trade.withdrawalInitiatedAt ?? now);

  if (age > 2 * 3_600_000) {
    return failTrade(trade, `Withdrawal timeout: waited ${Math.round(age / 60_000)}m for ${coin}`);
  }

  // Network errors and timeouts must NOT fail the trade — coins may still be withdrawing.
  // Return and retry on the next 1s tick instead.
  let ws: Awaited<ReturnType<typeof getWithdrawStatus>> = null;
  try {
    ws = await getWithdrawStatus(trade.buyExchange as Exchange, coin, trade.withdrawalId ?? "");
  } catch (err) {
    logger.warn(
      { id: trade.id, coin, withdrawalId: trade.withdrawalId, err: String(err) },
      "bot: getWithdrawStatus threw (network/timeout) — coins may still be withdrawing; retrying next tick",
    );
    trade.updatedAt = now;
    return;
  }
  if (!ws) { trade.updatedAt = now; return; }

  trade.withdrawalStatus = ws.status;
  if (ws.txId) trade.withdrawalTxId = ws.txId;
  trade.updatedAt = now;

  if (ws.status === "failed" || ws.status === "canceled") {
    return failTrade(trade, `Withdrawal ${ws.status} for ${coin}: ${trade.withdrawalId}`);
  }

  if (ws.status === "success") {
    trade.withdrawalConfirmedAt = now;
    // Snapshot sell-side balance BEFORE the deposit arrives.
    // Used as baseline for balance-delta deposit detection.
    // KuCoin: deposits land in MAIN account — must use kucoinGetMainBalance, not getBalance (TRADE).
    try {
      trade.preDepositBalance = await getSellSideBalance(trade.sellExchange as Exchange, coin);
    } catch {
      trade.preDepositBalance = 0;
    }
    trade.phase = "waiting_deposit";
    logger.info(
      { id: trade.id, coin, txId: ws.txId, prebal: trade.preDepositBalance },
      "bot: withdrawal confirmed → deposit tracking started",
    );
  } else {
    logger.debug(
      { id: trade.id, coin, status: ws.status, ageMin: Math.round(age / 60_000) },
      "bot: withdrawal in progress",
    );
  }
}

// Phase 4: WAITING_DEPOSIT
// Polls sell exchange every 1s until the transferred coins arrive.
//
// Primary method: txId-based tracking via getDepositByTxId() — exact, reliable.
//   Binance : GET /sapi/v1/capital/deposit/hisrec?txId=...    status 0=pending, 6=processing, 1=success
//   Bybit   : GET /v5/asset/deposit/query-record?txID=...     status 1=pending, 2=processing, 3=success
//   KuCoin  : GET /api/v1/deposits?currency=... items.hash    status PROCESSING/SUCCESS
//   Bitget  : GET /api/v2/spot/wallet/deposit-records?txId=... status pending/success
//
// Fallback method: balance-delta (when txId not yet available from withdrawal API).
//   balance delta ≥ 90% of executedBuyQty → deposit arrived.
//   KuCoin sell-side: ALWAYS use MAIN account balance (deposits land there, not in TRADE).
//
// BUG D fix: txId fallback path also uses getSellSideBalance (routes to kucoinGetMainBalance for KuCoin).
// BUG E fix: depositedQty must be > 0 before advancing to monitoring — guard added.

async function doWaitingDeposit(trade: BotTrade): Promise<void> {
  const coin     = trade.symbol;
  const sellEx   = trade.sellExchange as Exchange;
  const now      = Date.now();
  const age      = now - (trade.withdrawalConfirmedAt ?? trade.withdrawalInitiatedAt ?? now);
  // Single source of truth for expected qty — avoids repeated declarations below.
  const expected = trade.executedBuyQty ?? 0;

  if (age > 6 * 3_600_000) {
    return failTrade(trade, `Deposit timeout: waited ${Math.round(age / 60_000)}m for ${coin} on ${sellEx}`);
  }

  // Paranoia guard: Phase 2 Guard A should have already blocked zero-qty trades,
  // but fail explicitly here to prevent false deposit detection via balance delta.
  if (expected <= 0) {
    return failTrade(trade, `Cannot detect deposit: executedBuyQty is 0 for ${coin} — corrupted trade state`);
  }

  // ── Primary: track via blockchain txId ───────────────────────────────────────
  if (trade.withdrawalTxId) {
    // Network errors and timeouts must NOT fail the trade — coins are in transit.
    // Return and retry on the next 1s tick instead.
    let depStatus: Awaited<ReturnType<typeof getDepositByTxId>> = null;
    try {
      depStatus = await getDepositByTxId(sellEx, coin, trade.withdrawalTxId);
    } catch (err) {
      logger.warn(
        { id: trade.id, coin, sellEx, txId: trade.withdrawalTxId, err: String(err) },
        "bot: getDepositByTxId threw (network/timeout) — coins in transit; retrying next tick",
      );
      trade.updatedAt = now;
      return;
    }

    if (depStatus?.status === "success") {
      // Use reported amount if exchange provides it.
      // Fallback: measure balance delta on sell exchange.
      // KuCoin: getSellSideBalance routes to MAIN account.
      let depositedQty = depStatus.amount ?? 0;

      if (depositedQty <= 0) {
        // Balance delta fallback when exchange doesn't report amount.
        let bal = 0;
        try {
          bal = await getSellSideBalance(sellEx, coin);
        } catch (err) {
          logger.warn(
            { id: trade.id, coin, sellEx, err: String(err) },
            "bot: getSellSideBalance threw in txId amount-fallback — retrying next tick",
          );
          trade.updatedAt = now;
          return;
        }
        const prebal = trade.preDepositBalance ?? 0;
        const delta  = bal - prebal;

        // Safety cap: preDepositBalance snapshot failure (prebal=0) + pre-existing coins
        // → delta = full balance >> expected → catastrophic wrong depositedQty.
        if (delta > expected * 1.05 && prebal === 0) {
          logger.warn(
            { id: trade.id, coin, sellEx, delta, expected, prebal },
            "bot: balance delta >> expected with prebal=0 — snapshot likely failed; retrying next tick",
          );
          trade.updatedAt = now;
          return;
        }
        depositedQty = Math.max(0, delta);
      }

      // Qty still 0 — balance not yet updated (race condition). Retry next tick.
      if (depositedQty <= 0) {
        trade.updatedAt = now;
        logger.debug(
          { id: trade.id, coin, sellEx, txId: trade.withdrawalTxId },
          "bot: deposit success reported but qty=0 — balance not yet updated; retrying next tick",
        );
        return;
      }

      // Final safety cap: depositedQty cannot exceed 105% of sent qty (allows for tiny dust).
      // Prevents accidental oversell if pre-existing coins inflate the delta.
      if (depositedQty > expected * 1.05) {
        logger.warn(
          { id: trade.id, coin, sellEx, depositedQty, expected },
          "bot: depositedQty > 105% of executedBuyQty — capping to expected qty",
        );
        depositedQty = expected;
      }

      trade.depositedQty       = floorTo(depositedQty, 8);
      trade.depositConfirmedAt = now;
      trade.phase              = "monitoring";
      trade.monitoringStartAt  = now;
      trade.monitoringStartBid = spotScanner.getLiveQuote(trade.sellExchange, coin)?.bid;
      trade.updatedAt          = now;
      logger.info(
        { id: trade.id, coin, sellEx, depositedQty: trade.depositedQty, txId: trade.withdrawalTxId, method: "txId" },
        "bot: deposit confirmed via txId → monitoring",
      );
    } else {
      trade.updatedAt = now;
      logger.debug(
        { id: trade.id, coin, txId: trade.withdrawalTxId, status: depStatus?.status ?? "not_found_yet" },
        "bot: waiting_deposit — tracking via txId",
      );
    }
    return;
  }

  // ── Fallback: balance delta (txId not yet available from withdrawal API) ──────
  // KuCoin sell-side: MUST read MAIN account (deposits land there, not TRADE).
  let bal = 0;
  try {
    bal = await getSellSideBalance(sellEx, coin);
  } catch (err) {
    logger.warn(
      { id: trade.id, coin, sellEx, err: String(err) },
      "bot: getSellSideBalance threw in balance-delta path — coins in transit; retrying next tick",
    );
    trade.updatedAt = now;
    return;
  }

  const prebal   = trade.preDepositBalance ?? 0;
  const received = bal - prebal;

  // Safety cap: preDepositBalance snapshot failure (prebal=0) + pre-existing coins
  // → received = full balance >> expected → catastrophic wrong depositedQty.
  if (received > expected * 1.05 && prebal === 0) {
    logger.warn(
      { id: trade.id, coin, sellEx, bal, received, expected, prebal },
      "bot: balance delta >> expected with prebal=0 — snapshot likely failed; retrying next tick",
    );
    trade.updatedAt = now;
    return;
  }

  if (received >= expected * 0.90) {
    // Qty guard: received must be positive before advancing.
    if (received <= 0) {
      trade.updatedAt = now;
      logger.debug({ id: trade.id, coin, sellEx, bal, prebal }, "bot: balance delta ≥ 90% but received=0 — retrying");
      return;
    }

    trade.depositedQty       = floorTo(received, 8);
    trade.depositConfirmedAt = now;
    trade.phase              = "monitoring";
    trade.monitoringStartAt  = now;
    trade.monitoringStartBid = spotScanner.getLiveQuote(trade.sellExchange, coin)?.bid;
    trade.updatedAt          = now;
    logger.info(
      { id: trade.id, coin, sellEx, depositedQty: trade.depositedQty, prebal, bal, method: "balance_delta" },
      "bot: deposit confirmed via balance delta → monitoring",
    );
  } else {
    trade.updatedAt = now;
    logger.debug(
      { id: trade.id, coin, sellEx, bal, prebal, expected, received: received.toFixed(8) },
      "bot: waiting_deposit — balance delta not sufficient yet",
    );
  }
}

// Phase 5: MONITORING
// Called every 100ms by monitorPoller. Reads latest WebSocket bid — no HTTP calls.
// Triggers sell as soon as live net profit ≥ takeProfitPct.
// Force-sells after 24h timeout.

async function doMonitoring(trade: BotTrade): Promise<void> {
  const coin   = trade.symbol;
  const now    = Date.now();
  const monAge = now - (trade.monitoringStartAt ?? now);

  // Read latest WS bid — zero network calls, cached from live WebSocket
  const lq = spotScanner.getLiveQuote(trade.sellExchange, coin);
  const freshQuote = lq !== null && lq !== undefined && (now - lq.receivedAt) < 120_000;
  if (freshQuote && lq) {
    trade.currentBid          = lq.bid;
    const liveProfit          = calcLiveNetProfit(trade, lq.bid);
    trade.currentNetProfitPct = liveProfit;
    if ((trade.peakNetProfitPct ?? -Infinity) < liveProfit) {
      trade.peakNetProfitPct = liveProfit;
    }
  }
  trade.updatedAt = now;

  // Only trigger profit-based sell when quote is FRESH (< 2 min old).
  // Stale quote: price may have dropped since last update — acting on stale profit
  // could place a sell order expecting $X but getting far less from the actual market.
  // Force-sell (24h timeout) intentionally fires regardless of quote freshness.
  const shouldSell = freshQuote && (trade.currentNetProfitPct ?? 0) >= config.takeProfitPct;
  const timedOut   = monAge >= 24 * 3_600_000;

  if (shouldSell) {
    trade.phase = "selling";
    logger.info(
      { id: trade.id, profit: trade.currentNetProfitPct?.toFixed(3), target: config.takeProfitPct, bid: trade.currentBid },
      "bot: profit target met → selling",
    );
  } else if (timedOut) {
    trade.phase = "selling";
    logger.warn({ id: trade.id, monAgeH: Math.round(monAge / 3_600_000) }, "bot: monitoring timeout → force sell");
  }
}

// Phase 6: SELLING
// Places a market SELL order for the actual received qty (depositedQty).
//
// KuCoin sell-side: deposit arrived in MAIN account → must transfer MAIN→TRADE before sell.
//   (sell orders draw from TRADE account; kucoinTransferMainToTrade throws on failure)
// Bybit  sell-side: UNIFIED account — sell directly.
// Binance sell-side: spot account — sell directly.
// Bitget  sell-side: spot account — sell directly.
//
// Sell qty uses floorTo(8dp) — never round up, avoid "insufficient balance" errors.

async function doSelling(trade: BotTrade): Promise<void> {
  const sellEx = trade.sellExchange as Exchange;

  // Floor to 8dp — never round up, avoid "insufficient balance" errors.
  // Use let — KuCoin path may reduce qty to match actual MAIN balance.
  let qty = floorTo(trade.depositedQty ?? trade.executedBuyQty ?? 0, 8);

  // Guard: qty must be > 0 before placing any sell order.
  // Prevents an exchange-level LOT_SIZE error from masking an underlying data bug.
  if (qty <= 0) {
    return failTrade(
      trade,
      `Cannot sell: qty is 0 for ${trade.symbol} (depositedQty=${trade.depositedQty}, executedBuyQty=${trade.executedBuyQty})`,
    );
  }

  // KuCoin: deposit arrives in MAIN; spot sell order requires coins in TRADE account.
  // depositedQty may be slightly above actual MAIN balance because on-chain network fees
  // are deducted after the amount is recorded. Using depositedQty directly for the
  // MAIN→TRADE transfer would cause TRANSFER_BALANCE_NOT_ENOUGH.
  // Fix: read actual MAIN balance and use min(depositedQty, mainFree).
  if (sellEx === "kucoin") {
    const mainBals = await kucoinGetMainBalance(trade.symbol);
    const mainFree  = mainBals[trade.symbol]?.free ?? 0;
    const safeQty   = floorTo(Math.min(qty, mainFree), 8);
    if (safeQty <= 0) {
      return failTrade(
        trade,
        `KuCoin MAIN account has 0 ${trade.symbol} available — deposit may not have arrived in MAIN account`,
      );
    }
    if (safeQty < qty) {
      logger.warn(
        { id: trade.id, coin: trade.symbol, depositedQty: qty, mainFree, safeQty },
        "bot: KuCoin MAIN balance < depositedQty — using actual MAIN balance (on-chain fees deducted)",
      );
    }
    await kucoinTransferMainToTrade(trade.symbol, safeQty);
    qty = safeQty;
    // Update depositedQty to reflect actual sell qty (on-chain fees may have reduced it).
    // calcLiveNetProfit uses trade.depositedQty — must match what was actually sold.
    trade.depositedQty = safeQty;
  }

  // Market SELL — all exchanges: sell by base qty (depositedQty tokens), receive USDT.
  const result = await placeOrder(sellEx, {
    symbol:        trade.symbol,
    side:          "sell",
    type:          "market",
    baseQty:       qty,
    clientOrderId: `${trade.id}-sell`,
  });

  trade.sellOrderId        = result.orderId;
  trade.executedSellQty    = result.executedQty;
  trade.executedSellPrice  = result.avgPrice;
  trade.actualNetProfitPct = result.avgPrice
    ? calcLiveNetProfit(trade, result.avgPrice)
    : undefined;
  trade.completedAt        = Date.now();
  trade.phase              = "completed";
  trade.updatedAt          = Date.now();

  logger.info(
    { id: trade.id, sellEx, orderId: result.orderId, qty: result.executedQty, profit: trade.actualNetProfitPct?.toFixed(3) },
    "bot: trade completed",
  );
  finalizeTrade(trade);
}

// ── State machine dispatcher ──────────────────────────────────────────────────

async function advanceTrade(trade: BotTrade): Promise<void> {
  try {
    switch (trade.phase) {
      case "buying":              await doBuying(trade);            break;
      case "transferring":        await doTransferring(trade);      break;
      case "waiting_withdrawal":  await doWaitingWithdrawal(trade); break;
      case "waiting_deposit":     await doWaitingDeposit(trade);    break;
      case "monitoring":          await doMonitoring(trade);        break;
      case "selling":             await doSelling(trade);           break;
    }
    // Assign poller ownership after each phase advance
    const p = trade.phase;
    if (p === "waiting_withdrawal" || p === "waiting_deposit") {
      stopMonitorPoller();
      startFastPoller();
    } else if (p === "monitoring") {
      stopFastPoller();
      startMonitorPoller();
    } else {
      stopFastPoller();
      stopMonitorPoller();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id: trade.id, phase: trade.phase, err: msg }, "bot: unhandled error in phase");
    failTrade(trade, `Unhandled error in ${trade.phase}: ${msg}`);
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  // ── Active trade: always advance to completion, even if bot is disabled ───────
  if (activeTrade) {
    const p = activeTrade.phase;
    // fast/monitor pollers own these phases — tick just keeps them alive (idempotent)
    if (p === "waiting_withdrawal" || p === "waiting_deposit") { startFastPoller(); return; }
    if (p === "monitoring")                                     { startMonitorPoller(); return; }
    if (isAdvancing) return;
    isAdvancing = true;
    try {
      logger.debug({ id: activeTrade.id, phase: activeTrade.phase }, "bot: advancing active trade");
      await advanceTrade(activeTrade);
    } finally {
      isAdvancing = false;
    }
    return;
  }

  // ── No active trade: scan for a new opportunity ───────────────────────────────
  if (!config.enabled) return;
  if (config.maxOpenPositions <= 0) return;

  // Block new trades 2 minutes before a deposit address sync starts (or during sync).
  // Reason: mid-sync addresses may be stale — could route withdrawal to wrong wallet.
  const SYNC_PREBLOCK_MS = 2 * 60_000;
  const { isRefreshing } = getDepositAddressStatus();
  const nextSync         = getNextAutoRefreshAt();
  const msUntilSync      = nextSync ? nextSync.getTime() - Date.now() : Infinity;
  const syncImminent     = msUntilSync <= SYNC_PREBLOCK_MS;

  if (isRefreshing || syncImminent) {
    const reason    = isRefreshing ? "sync_in_progress" : "sync_imminent";
    const minsUntil = isFinite(msUntilSync) ? Math.ceil(msUntilSync / 60_000) : null;
    logger.info(
      { reason, isRefreshing, syncImminent, minsUntil, nextSync: nextSync?.toISOString() },
      "bot: new trade BLOCKED — deposit address sync",
    );
    return;
  }

  resetHourWindow();
  if (tradesThisHour >= config.maxTradesPerHour) {
    logger.debug({ tradesThisHour, cap: config.maxTradesPerHour }, "bot: hourly cap reached");
    return;
  }

  // ── Phase -1: USDT Detection ─────────────────────────────────────────────────
  // Read availableUSDT from wallet cache (wallet/index.ts refreshes every 3s).
  // Zero extra API calls — same data shown in the Wallet tab.
  const wallets   = getCachedBalances();
  const walletMap = Object.fromEntries(wallets.map(w => [w.exchange, w]));

  const usdtExchanges = (config.allowedExchanges as Exchange[])
    .filter(ex => (walletMap[ex]?.availableUSDT ?? 0) >= config.tradeAmountUSDT)
    .sort((a, b) => (walletMap[b]?.availableUSDT ?? 0) - (walletMap[a]?.availableUSDT ?? 0));

  if (usdtExchanges.length === 0) {
    const balSummary = (config.allowedExchanges as Exchange[])
      .map(ex => `${ex}:${(walletMap[ex]?.availableUSDT ?? 0).toFixed(2)}`)
      .join(", ");
    logger.debug({ balSummary, required: config.tradeAmountUSDT }, "bot: no exchange has enough USDT");
    return;
  }

  const richest = usdtExchanges[0]!;
  logger.debug(
    { usdtExchange: richest, availableUSDT: walletMap[richest]?.availableUSDT, required: config.tradeAmountUSDT },
    "bot: USDT detected — scanning for opportunities",
  );

  // ── Phase 0: Opportunity Selection ───────────────────────────────────────────
  // Opportunities are pre-sorted by netProfitPct descending by the scanner.
  // Apply all config filters, then pick the best candidate.
  const opps = spotScanner.getOpportunitiesWithTarget(config.minNetProfitPct) as (SpotOpportunity & { profitTimesHit: number })[];

  // Pre-fetch movement data once only if cap is active (avoids O(n) map lookup per opp)
  const exMovements = config.maxMovementPct > 0
    ? spotPriceHistory.getExchangeMovements()
    : null;

  const candidates = opps.filter((opp) => {
    // Buy exchange must hold enough USDT
    if (!usdtExchanges.includes(opp.buyExchange as Exchange))  return false;
    // Both exchanges must be in allowed list
    if (!config.allowedExchanges.includes(opp.sellExchange))   return false;
    // Net profit filter
    if ((opp.netProfitPct ?? -999) < config.minNetProfitPct)   return false;
    // Total fees cap
    if (calcTotalFeesPct(opp, config.tradeAmountUSDT) > config.maxFeesPct) return false;
    // Times-hit filter: must have been profitable ≥ N seconds in 4h window
    if ((opp.profitTimesHit ?? 0) < config.minTimesHit)        return false;
    // Sell-side price movement cap (0 = no cap)
    // Positive-only rule: negative movement (price dropping) also fails the filter.
    if (exMovements && config.maxMovementPct > 0) {
      const mov = exMovements[opp.sellExchange]?.[opp.symbol]?.[config.priceMovementWindow] ?? null;
      if (mov !== null && (mov < 0 || mov > config.maxMovementPct)) return false;
    }
    // Address verification filter
    if (config.requireAddressVerified && opp.fees.addressVerified !== true) return false;
    // Withdrawal fee cap (0 = no cap)
    if (config.maxWithdrawFeeUSD > 0) {
      const wdUSD = opp.fees.withdrawFeeUSD;
      if (wdUSD !== null && wdUSD > config.maxWithdrawFeeUSD)  return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    logger.debug({ eligible: opps.length }, "bot: no candidates meet filter criteria");
    return;
  }

  // Pick highest net profit opportunity
  const best = [...candidates].sort(
    (a, b) => (b.netProfitPct ?? -999) - (a.netProfitPct ?? -999),
  )[0]!;

  const netPct = best.netProfitPct ?? 0;
  const feePct = calcTotalFeesPct(best, config.tradeAmountUSDT);

  logger.info(
    {
      symbol:   best.symbol,
      buyEx:    best.buyExchange,
      sellEx:   best.sellExchange,
      netPct:   netPct.toFixed(4),
      feePct:   feePct.toFixed(3),
      spread:   best.priceDiffPct.toFixed(3),
      timesHit: best.profitTimesHit,
    },
    "bot: starting trade on top opportunity",
  );

  activeTrade = {
    id:                   `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp:            Date.now(),
    updatedAt:            Date.now(),
    phase:                "buying",
    symbol:               best.symbol,
    buyExchange:          best.buyExchange,
    sellExchange:         best.sellExchange,
    tradeAmountUSDT:      config.tradeAmountUSDT,
    usdtExchange:         best.buyExchange as Exchange,
    expectedNetProfitPct: netPct,
    totalFeesPct:         feePct,
    grossSpreadPct:       best.priceDiffPct,
    timesHit:             best.profitTimesHit ?? 0,
    buyAsk:               best.buyAsk,
    sellBid:              best.sellBid,
    feesSnapshot: {
      sellFeeRate: best.fees?.sellFeeRate ?? 0.001,
      tdsRate:     best.fees?.tdsRate     ?? 0.01,
      feeTaxRate:  best.fees?.feeTaxRate  ?? 0.18,
    },
    opportunitySnapshot: {
      netProfitPct:        best.netProfitPct,
      grossSpreadPct:      best.priceDiffPct,
      buyAsk:              best.buyAsk,
      sellBid:             best.sellBid,
      timesHit:            best.profitTimesHit ?? 0,
      highestNetProfitPct: best.highestNetProfitPct ?? null,
      capturedAt:          Date.now(),
      fees: {
        buyFeeRate:             best.fees?.buyFeeRate             ?? 0.001,
        sellFeeRate:            best.fees?.sellFeeRate            ?? 0.001,
        feeTaxRate:             best.fees?.feeTaxRate             ?? 0.18,
        tdsRate:                best.fees?.tdsRate                ?? 0.01,
        withdrawFeeInCoin:      best.fees?.withdrawFeeInCoin      ?? null,
        withdrawFeeUSD:         best.fees?.withdrawFeeUSD         ?? null,
        withdrawNetwork:        best.fees?.withdrawNetwork        ?? null,
        totalTransferFeeInCoin: best.fees?.totalTransferFeeInCoin ?? null,
        speedTier:              best.fees?.speedTier              ?? null,
        feeSource:              best.fees?.feeSource              ?? null,
        addressVerified:        best.fees?.addressVerified        ?? null,
        routesConsidered:       best.fees?.routesConsidered       ?? null,
      },
      allPrices: best.allPrices ?? [],
    },
  };

  // RACE CONDITION FIX: set isAdvancing BEFORE the first advanceTrade call.
  // Without this, if doBuying takes > 1s (KuCoin/Bitget wait 800ms + network),
  // the next setInterval tick fires, sees activeTrade.phase="buying" and
  // isAdvancing=false, and calls advanceTrade again → TWO concurrent buy orders.
  isAdvancing = true;
  try {
    await advanceTrade(activeTrade);
  } finally {
    isAdvancing = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getConfig(): BotConfig { return { ...config }; }

export function updateConfig(patch: Partial<BotConfig>): BotConfig {
  config = { ...config, ...patch };
  logger.info({ config }, "bot config updated");
  saveConfigToDisk();
  return { ...config };
}

export function getTrades(): BotTrade[] { return trades; }

export function getActiveTrade(): BotTrade | null { return activeTrade; }

export function getBotStatus() {
  resetHourWindow();
  return {
    running:        loopTimer !== null,
    config:         { ...config },
    tradesThisHour,
    hourWindowStart,
    totalTrades:    trades.length,
    recentTrades:   trades.slice(0, 10),
    hasActiveTrade: activeTrade !== null,
  };
}

/** Fire one tick immediately (useful for manual testing / UI "Run Now" button). */
export async function tickOnce(): Promise<void> {
  await tick();
}

/** Clear completed/failed trade history. */
export function clearTrades(): void {
  trades.splice(0);
  logger.info("bot: trade history cleared");
}

export function startBotLoop(intervalMs = 1_000): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    tick().catch((err: unknown) => logger.error({ err }, "bot: tick error"));
  }, intervalMs);
  logger.info({ intervalMs }, "bot loop started");
}

export function stopBotLoop(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  stopFastPoller();
  stopMonitorPoller();
  logger.info("bot loop stopped");
}

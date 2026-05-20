/**
 * Spot Hedge Arbitrage Bot — Production Engine
 *
 * Phase 1 (watching):   wait for neutral spread → buy token on cheaper exchange
 * Phase 2 (harvesting): detect profitable spread → simultaneous sell-high + buy-low (inventory flip)
 * Phase 3 (exiting):    wait for neutral spread → sell all tokens back to USDT
 *
 * Safety features:
 *   ① Lot-size precision   — quantities floored to exchange step size before every order
 *   ② Quote freshness guard — skip trades when live quote is > 3 seconds stale
 *   ③ One-leg compensation  — if only one side of a harvest fills, a rollback order is placed immediately
 *   ④ Parallel exit         — exit sells on both exchanges fire concurrently
 *   ⑤ Periodic balance sync — every 60 ticks (≈30 s) real balances are reconciled with virtual inventory
 *   ⑥ KuCoin auto-transfer  — before first sell on KuCoin, any MAIN-account token is moved to TRADE
 */

import { logger } from "../logger.js";
import { spotScanner } from "../spot-scanner/index.js";
import { placeOrder, kucoinTransferMainToTrade, kucoinGetMainBalance } from "../trading/index.js";
import { getCachedBalances } from "../wallet/index.js";
import { getSymbolInfo, floorToStep } from "./symbol-info.js";
import type {
  HedgeConfig, HedgePhase, HedgeInventory, HedgeTrade,
  HedgeBotState, HedgeError, LiveSpread, HedgeExchange,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const TICK_MS              = 500;           // bot loop interval
const QUOTE_MAX_AGE        = 3_000;         // ms — stale quote threshold
const SYNC_EVERY           = 60;            // ticks between balance syncs (≈30 s)
const MAX_ERRORS           = 20;            // cap errors[] array length
const MAX_CONSEC_ERRORS    = 3;             // consecutive errors before auto graceful-exit

// ── State ─────────────────────────────────────────────────────────────────────
let _state: HedgeBotState = {
  phase: "idle", config: null, inventory: null,
  trades: [], roundCount: 0, totalNetProfit: 0,
  startedAt: null, lastTradeAt: null, lastSyncAt: null,
  statusMessage: "Bot not started", errors: [],
};

let _loopTimer:        ReturnType<typeof setInterval> | null = null;
let _exitRequested     = false;
let _tradeInProgress   = false;
let _tickCount         = 0;
let _lastHarvestAt     = 0;   // ms timestamp of last completed harvest round (for flip interval cooldown)
let _consecErrors      = 0;   // consecutive errors since last successful trade
const _kucoinMainDone  = new Set<string>(); // tokens whose MAIN→TRADE check is done for this session

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function addError(msg: string): void {
  _state.errors.push({ ts: Date.now(), msg });
  if (_state.errors.length > MAX_ERRORS) _state.errors.shift();
  logger.warn({ msg }, "spot-hedge: error logged");

  // ── Consecutive-error circuit breaker ────────────────────────────────────
  // If MAX_CONSEC_ERRORS errors occur without a successful trade in between,
  // trigger a graceful exit to protect inventory.
  _consecErrors++;
  if (_consecErrors >= MAX_CONSEC_ERRORS && !_exitRequested
      && _state.phase !== "exiting" && _state.phase !== "stopped") {
    _exitRequested = true;
    const cbMsg = `⚠ Circuit breaker: ${_consecErrors} consecutive errors — initiating graceful exit`;
    _state.statusMessage = cbMsg;
    logger.warn({ consecErrors: _consecErrors }, "spot-hedge: consecutive-error circuit breaker triggered");
  }
}

function getQuotes(cfg: HedgeConfig) {
  return {
    a: spotScanner.getLiveQuote(cfg.exchangeA, cfg.token),
    b: spotScanner.getLiveQuote(cfg.exchangeB, cfg.token),
  };
}

/** Return quote age in milliseconds. */
function quoteAgeMs(receivedAt: number): number {
  return Date.now() - receivedAt;
}

/**
 * GO/NO-GO spread check — pure price-based, no inventory qty needed.
 *
 * Step 1: rawSpread% = (sellBid − buyAsk) / buyAsk × 100
 * Step 2: subtract both-side effective fees (takerFee × (1 + GST%) × 2 legs)
 * Step 3: subtract TDS on sell side (tdsPct × sellBid/buyAsk, i.e. % of buyCost)
 * Result: net profit % relative to the buy cost
 *
 * This is the gate — if netPct < minSpreadPct, we don't even look at inventory.
 */
function calcSpreadNetPct(
  sellBid: number,
  buyAsk:  number,
  cfg:     Pick<HedgeConfig, "tdsPct" | "takerFeePct" | "gstPct">,
): { rawSpreadPct: number; bothFeesPct: number; tdsPct: number; netPct: number } {
  // Step 1 — raw spread between sell-side bid and buy-side ask
  const rawSpreadPct  = (sellBid - buyAsk) / buyAsk * 100;

  // Step 2 — effective fee per leg = takerFee × (1 + GST), apply to both legs
  const effFeePct     = (cfg.takerFeePct / 100) * (1 + cfg.gstPct / 100);
  const bothFeesPct   = effFeePct * 2 * 100;   // convert back to % for display

  // Step 3 — TDS: 1% of sell revenue; sell revenue = (sellBid/buyAsk) × buyCost
  //   expressed as % of buyCost → tdsPct × (sellBid / buyAsk)
  const tdsPct        = cfg.tdsPct * (sellBid / buyAsk);

  const netPct        = rawSpreadPct - bothFeesPct - tdsPct;
  return { rawSpreadPct, bothFeesPct, tdsPct, netPct };
}

/**
 * POST-TRADE P&L accounting — uses actual executed qty and prices.
 * Called after both legs fill to record exact profit in USDT.
 */
function calcProfit(
  sellBid:  number,
  buyAsk:   number,
  cfg:      Pick<HedgeConfig, "tdsPct" | "takerFeePct" | "gstPct" | "tradeAmountUsdt">,
  sellQty?: number,   // actual inventory qty; omit for price-only estimation
): { grossPct: number; netPct: number; tdsUsdt: number; feesUsdt: number; netUsdt: number; sellRevenue: number } {
  const qty            = sellQty ?? (cfg.tradeAmountUsdt / buyAsk);
  const sellRevenue    = qty * sellBid;              // USDT received from selling tokens
  const buyCost        = cfg.tradeAmountUsdt;        // USDT spent on buying — always fixed
  const gross          = sellRevenue - buyCost;
  const tdsUsdt        = (cfg.tdsPct / 100) * sellRevenue;   // TDS only on sell side
  const effFeePct      = (cfg.takerFeePct / 100) * (1 + cfg.gstPct / 100);
  const feesUsdt       = effFeePct * (sellRevenue + buyCost);  // fee on both legs
  const netUsdt        = gross - tdsUsdt - feesUsdt;
  return {
    grossPct:    (gross   / buyCost) * 100,
    netPct:      (netUsdt / buyCost) * 100,
    tdsUsdt, feesUsdt, netUsdt, sellRevenue,
  };
}

/**
 * Before first sell on KuCoin, silently move any token sitting in the MAIN
 * (funding) account to the TRADE account. Deposits always land in MAIN;
 * sell orders require the coin to be in TRADE.
 */
async function tryKucoinMainTransfer(token: string): Promise<void> {
  if (_kucoinMainDone.has(token)) return;
  _kucoinMainDone.add(token);   // mark immediately so parallel ticks don't double-call
  try {
    const mainBal = await kucoinGetMainBalance(token.toUpperCase());
    const free    = mainBal[token.toUpperCase()]?.free ?? 0;
    if (free > 0) {
      await kucoinTransferMainToTrade(token.toUpperCase(), free);
      logger.info({ token, amount: free }, "spot-hedge: KuCoin MAIN→TRADE transfer completed");
    }
  } catch (err) {
    // Non-fatal — TRADE account might already have enough balance
    logger.warn({ token, err: String(err) }, "spot-hedge: KuCoin MAIN→TRADE transfer skipped");
  }
}

// ── Phase 1 — Initialization ──────────────────────────────────────────────────

async function doInit(cfg: HedgeConfig, inv: HedgeInventory): Promise<void> {
  const { a, b } = getQuotes(cfg);
  if (!a || !b) { _state.statusMessage = "Waiting for live quotes…"; return; }

  // Quote freshness guard
  const ageA = quoteAgeMs(a.receivedAt), ageB = quoteAgeMs(b.receivedAt);
  if (ageA > QUOTE_MAX_AGE || ageB > QUOTE_MAX_AGE) {
    _state.statusMessage = `Quotes stale (${Math.max(ageA, ageB).toFixed(0)} ms) — waiting for fresh data`;
    return;
  }

  const spreadPct = (Math.abs(a.ask - b.ask) / ((a.ask + b.ask) / 2)) * 100;
  if (spreadPct > cfg.neutralThresholdPct) {
    _state.statusMessage = `Waiting for neutral spread (${spreadPct.toFixed(3)}% > ${cfg.neutralThresholdPct}% max)`;
    return;
  }

  // Choose the cheaper exchange for the init buy
  const buyOnA = a.ask <= b.ask;
  const buyEx  = buyOnA ? cfg.exchangeA : cfg.exchangeB;
  const buyPrc = buyOnA ? a.ask : b.ask;
  const symbol = `${cfg.token.toUpperCase()}USDT`;

  // USDT balance check — must have enough on the buy-side exchange before placing order
  const buyUSDT = buyOnA ? inv.a.usdt : inv.b.usdt;
  if (buyUSDT < cfg.tradeAmountUsdt * 0.99) {
    const msg = `Init blocked: insufficient USDT on ${buyEx} (have ${buyUSDT.toFixed(2)}, need ${cfg.tradeAmountUsdt.toFixed(2)})`;
    addError(msg);
    _state.statusMessage = msg;
    return;
  }

  // Get step size for the buy exchange, floor qty
  const info   = await getSymbolInfo(buyEx, cfg.token);
  const rawQty = cfg.tradeAmountUsdt / buyPrc;
  const qty    = floorToStep(rawQty, info.stepSize);

  if (qty < info.minQty) {
    addError(`Init: qty ${qty} < minQty ${info.minQty} on ${buyEx} — increase trade amount`);
    _state.statusMessage = `Init blocked: qty below minQty on ${buyEx}`;
    return;
  }

  logger.info({ buyEx, buyPrc, qty, spreadPct, dryRun: cfg.dryRun }, "spot-hedge: Phase1 init buy");

  try {
    let execQty = qty, execPrc = buyPrc;
    let buyOrderId: string | undefined;
    let buyStatus:  string | undefined;

    if (!cfg.dryRun) {
      const res = await placeOrder(buyEx, { symbol, side: "buy", type: "market", quoteQty: cfg.tradeAmountUsdt });
      if (!res.executedQty) throw new Error(`Init buy returned executedQty=0 on ${buyEx}`);
      execQty    = res.executedQty;
      execPrc    = res.avgPrice;
      buyOrderId = res.orderId;
      buyStatus  = res.status;
    }

    // USDT spent = exactly tradeAmountUsdt (market quoteQty order); fee taken from received tokens
    if (buyOnA) { inv.a.token += execQty; inv.a.usdt -= cfg.tradeAmountUsdt; }
    else        { inv.b.token += execQty; inv.b.usdt -= cfg.tradeAmountUsdt; }

    const initEffFeePct = (cfg.takerFeePct / 100) * (1 + cfg.gstPct / 100);
    const initFeeUsdt   = initEffFeePct * cfg.tradeAmountUsdt;  // fee basis is USDT spent, not token value

    _state.trades.push({
      id: uid(), roundNum: 0, timestamp: Date.now(), tradeType: "init",
      buyExchange: buyEx, sellExchange: null,
      buyPrice: execPrc, sellPrice: null, qty: execQty,
      grossProfit: 0, tdsUsdt: 0,
      feesUsdt:   initFeeUsdt,
      netProfit: -initFeeUsdt,
      inventoryAfter: JSON.parse(JSON.stringify(inv)),
      buyOrderId, buyStatus,
      note: `Init buy ${execQty.toFixed(6)} ${cfg.token} on ${buyEx} @ ${execPrc}`,
    });
    _state.totalNetProfit += _state.trades.at(-1)!.netProfit;
    _state.lastTradeAt     = Date.now();
    _state.phase           = "harvesting";
    _state.statusMessage   = `Inventory initialized on ${buyEx} — scanning for spread opportunities`;
    logger.info({ buyEx, execQty, execPrc }, "spot-hedge: inventory initialized");
  } catch (err) {
    const msg = `Init buy failed: ${err instanceof Error ? err.message : String(err)}`;
    addError(msg);
    _state.statusMessage = msg;
  }
}

// ── Phase 2 — Harvest ─────────────────────────────────────────────────────────

async function doHarvest(cfg: HedgeConfig, inv: HedgeInventory): Promise<void> {
  const { a, b } = getQuotes(cfg);
  if (!a || !b) { _state.statusMessage = "Waiting for live quotes…"; return; }

  // Quote freshness guard
  const ageA = quoteAgeMs(a.receivedAt), ageB = quoteAgeMs(b.receivedAt);
  if (ageA > QUOTE_MAX_AGE || ageB > QUOTE_MAX_AGE) {
    _state.statusMessage = `Quotes stale (${Math.max(ageA, ageB).toFixed(0)} ms) — pausing`;
    return;
  }

  // ── Flip interval cooldown ────────────────────────────────────────────────
  if (cfg.flipIntervalSec > 0 && _lastHarvestAt > 0) {
    const elapsedSec   = (Date.now() - _lastHarvestAt) / 1_000;
    const remainingSec = cfg.flipIntervalSec - elapsedSec;
    if (remainingSec > 0) {
      _state.statusMessage = `Cooling down — next round unlocks in ${remainingSec.toFixed(0)}s`;
      return;
    }
  }

  const symbol = `${cfg.token.toUpperCase()}USDT`;

  // Fetch step sizes for both exchanges (cached after first call)
  const [infoA, infoB] = await Promise.all([
    getSymbolInfo(cfg.exchangeA, cfg.token),
    getSymbolInfo(cfg.exchangeB, cfg.token),
  ]);

  // ── Step 1: Spread gate (price-only, no inventory needed) ────────────────
  // Formula: rawSpread% = (sellBid − buyAsk) / buyAsk × 100
  //          net%       = rawSpread% − both-side fees% − TDS%
  // If neither direction clears minSpreadPct, skip immediately — no point
  // fetching step sizes or checking inventory.
  const spreadAB = calcSpreadNetPct(a.bid, b.ask, cfg);   // sell A bid, buy B ask
  const spreadBA = calcSpreadNetPct(b.bid, a.ask, cfg);   // sell B bid, buy A ask

  const spreadPassAB = spreadAB.netPct >= cfg.minSpreadPct;
  const spreadPassBA = spreadBA.netPct >= cfg.minSpreadPct;

  if (!spreadPassAB && !spreadPassBA) {
    const bestNet   = Math.max(spreadAB.netPct, spreadBA.netPct);
    const bestDir   = spreadAB.netPct >= spreadBA.netPct ? "A→B" : "B→A";
    const best      = spreadAB.netPct >= spreadBA.netPct ? spreadAB : spreadBA;
    _state.statusMessage =
      `Scanning… ${bestDir} spread=${best.rawSpreadPct.toFixed(3)}%` +
      ` fees=${best.bothFeesPct.toFixed(3)}% TDS=${best.tdsPct.toFixed(3)}%` +
      ` net=${bestNet.toFixed(3)}% (need ${cfg.minSpreadPct}%)`;
    return;
  }

  // ── Step 2: Inventory check (only for directions that passed spread gate) ─
  const sellQtyAB = floorToStep(inv.a.token, infoA.stepSize);   // sell ALL tokens on A
  const sellQtyBA = floorToStep(inv.b.token, infoB.stepSize);   // sell ALL tokens on B

  const canSellA = sellQtyAB >= infoA.minQty;
  const canSellB = sellQtyBA >= infoB.minQty;
  const canBuyA  = inv.a.usdt >= cfg.tradeAmountUsdt * 0.99;
  const canBuyB  = inv.b.usdt >= cfg.tradeAmountUsdt * 0.99;

  const useAB = spreadPassAB && canSellA && canBuyB;
  const useBA = spreadPassBA && canSellB && canBuyA;

  if (!useAB && !useBA) {
    // Spread was profitable but inventory is on the wrong side
    const passDir = spreadPassAB ? "A→B" : "B→A";
    _state.statusMessage = `Spread OK (${passDir}) but inventory not ready — waiting for next flip`;
    return;
  }

  // ── Step 3: Final qty-based profit for trade recording (uses actual inventory) ─
  const profitAB = calcProfit(a.bid, b.ask, cfg, sellQtyAB);
  const profitBA = calcProfit(b.bid, a.ask, cfg, sellQtyBA);

  const sellEx   = useAB ? cfg.exchangeA : cfg.exchangeB;
  const buyEx    = useAB ? cfg.exchangeB : cfg.exchangeA;
  const sellPrc  = useAB ? a.bid         : b.bid;
  const buyPrc   = useAB ? b.ask         : a.ask;
  const profit   = useAB ? profitAB      : profitBA;
  const sellQty  = useAB ? sellQtyAB     : sellQtyBA;
  const sellInfo = useAB ? infoA         : infoB;

  // Min qty / min notional validation on sell side
  if (sellQty < sellInfo.minQty) {
    addError(`Harvest: sell qty ${sellQty} < minQty ${sellInfo.minQty} on ${sellEx}`);
    _state.statusMessage = `Harvest blocked: sell qty below minQty on ${sellEx}`;
    return;
  }
  if (sellQty * sellPrc < sellInfo.minNotional) {
    addError(`Harvest: order value < minNotional ${sellInfo.minNotional} on ${sellEx}`);
    _state.statusMessage = `Harvest blocked: order value below minNotional on ${sellEx}`;
    return;
  }

  logger.info({ sellEx, buyEx, sellPrc, buyPrc, sellQty, netPct: profit.netPct, dryRun: cfg.dryRun }, "spot-hedge: harvest trade");

  try {
    // Track sell and buy legs separately — they produce different token quantities
    let execSellPrc = sellPrc,  execBuyPrc = buyPrc;
    let execSellQty = sellQty;                           // tokens sold from sell-exchange
    let execBuyQty  = cfg.tradeAmountUsdt / buyPrc;     // tokens bought on buy-exchange (estimated for dry-run)
    let sellOrderId: string | undefined;
    let sellStatus:  string | undefined;
    let buyOrderId:  string | undefined;
    let buyStatus:   string | undefined;

    if (!cfg.dryRun) {
      // KuCoin MAIN→TRADE: ensure token is in TRADE account before selling
      if (sellEx === "kucoin") await tryKucoinMainTransfer(cfg.token);

      // Fire both legs simultaneously and capture individual results
      const [sellSettled, buySettled] = await Promise.allSettled([
        placeOrder(sellEx, { symbol, side: "sell", type: "market", baseQty: sellQty }),
        placeOrder(buyEx,  { symbol, side: "buy",  type: "market", quoteQty: cfg.tradeAmountUsdt }),
      ]);

      const sellOk = sellSettled.status === "fulfilled" && (sellSettled.value.executedQty > 0);
      const buyOk  = buySettled.status  === "fulfilled" && (buySettled.value.executedQty  > 0);

      // ── Partial fill compensation ──────────────────────────────────────────
      if (!sellOk && !buyOk) {
        // Both failed — no positions taken, safe to retry next tick
        const reason = sellSettled.status === "rejected"
          ? String(sellSettled.reason)
          : buySettled.status === "rejected" ? String(buySettled.reason) : "executedQty=0";
        throw new Error(`Both legs failed: ${reason}`);
      }

      if (sellOk && !buyOk) {
        // Sell filled, buy failed → buy back on sell-exchange to restore inventory
        const sold    = sellSettled.value;
        const compMsg = `Sell on ${sellEx} filled (qty ${sold.executedQty.toFixed(6)}) but buy on ${buyEx} failed — placing compensation buy on ${sellEx}`;
        addError(compMsg);
        logger.warn({ sellEx, buyEx, qty: sold.executedQty }, "spot-hedge: sell filled, buy failed — compensating");
        try {
          await placeOrder(sellEx, { symbol, side: "buy", type: "market", quoteQty: sold.executedQuoteQty });
          addError(`Compensation buy on ${sellEx} placed — inventory restored`);
        } catch {
          const critMsg = `CRITICAL: compensation buy on ${sellEx} FAILED — token inventory unbalanced! Manual check required.`;
          addError(critMsg);
          _state.phase         = "exiting";
          _state.statusMessage = critMsg;
        }
        throw new Error(`Harvest aborted: ${compMsg}`);
      }

      if (!sellOk && buyOk) {
        // Buy filled, sell failed → sell back on buy-exchange to restore inventory
        const bought  = buySettled.value;
        const compQty = floorToStep(bought.executedQty, (useAB ? infoB : infoA).stepSize);
        const compMsg = `Buy on ${buyEx} filled (qty ${bought.executedQty.toFixed(6)}) but sell on ${sellEx} failed — placing compensation sell on ${buyEx}`;
        addError(compMsg);
        logger.warn({ sellEx, buyEx, qty: bought.executedQty }, "spot-hedge: buy filled, sell failed — compensating");
        try {
          await placeOrder(buyEx, { symbol, side: "sell", type: "market", baseQty: compQty });
          addError(`Compensation sell on ${buyEx} placed — inventory restored`);
        } catch {
          const critMsg = `CRITICAL: compensation sell on ${buyEx} FAILED — token inventory unbalanced! Manual check required.`;
          addError(critMsg);
          _state.phase         = "exiting";
          _state.statusMessage = critMsg;
        }
        throw new Error(`Harvest aborted: ${compMsg}`);
      }

      // Both legs filled — record actual executed prices and quantities per leg
      const sellFill = (sellSettled as PromiseFulfilledResult<import("../trading/index.js").TradeResult>).value;
      const buyFill  = (buySettled  as PromiseFulfilledResult<import("../trading/index.js").TradeResult>).value;
      execSellPrc = sellFill.avgPrice;
      execBuyPrc  = buyFill.avgPrice;
      execSellQty = sellFill.executedQty;   // actual tokens sold (may differ from sellQty due to partial fills)
      execBuyQty  = buyFill.executedQty;    // actual tokens bought (different from sell qty!)
      sellOrderId = sellFill.orderId;
      sellStatus  = sellFill.status;
      buyOrderId  = buyFill.orderId;
      buyStatus   = buyFill.status;
    }

    // Recalculate profit using actual executed prices and actual sell qty
    const realized = calcProfit(execSellPrc, execBuyPrc, cfg, execSellQty);

    // ── Inventory update (per-leg, not averaged) ───────────────────────────
    //   Sell side: tokens out, USDT in (minus TDS on sell, minus sell fee incl. GST)
    //   Buy  side: USDT out (exactly tradeAmountUsdt), tokens in (fee taken from tokens)
    const tdsOnSell  = (cfg.tdsPct / 100) * realized.sellRevenue;
    const feeOnSell  = (cfg.takerFeePct / 100) * (1 + cfg.gstPct / 100) * realized.sellRevenue;

    if (useAB) {
      inv.a.token -= execSellQty;
      inv.a.usdt  += realized.sellRevenue - tdsOnSell - feeOnSell;
      inv.b.token += execBuyQty;
      inv.b.usdt  -= cfg.tradeAmountUsdt;   // buy fee is taken from received tokens
    } else {
      inv.b.token -= execSellQty;
      inv.b.usdt  += realized.sellRevenue - tdsOnSell - feeOnSell;
      inv.a.token += execBuyQty;
      inv.a.usdt  -= cfg.tradeAmountUsdt;
    }

    _state.roundCount++;
    _state.trades.push({
      id: uid(), roundNum: _state.roundCount, timestamp: Date.now(), tradeType: "harvest",
      buyExchange: buyEx, sellExchange: sellEx,
      buyPrice: execBuyPrc, sellPrice: execSellPrc, qty: execSellQty,
      grossProfit: realized.grossPct / 100 * cfg.tradeAmountUsdt,
      tdsUsdt:     realized.tdsUsdt,
      feesUsdt:    realized.feesUsdt,
      netProfit:   realized.netUsdt,
      inventoryAfter: JSON.parse(JSON.stringify(inv)),
      sellOrderId, sellStatus, buyOrderId, buyStatus,
      note: `Round ${_state.roundCount}: sell ${execSellQty.toFixed(6)} ${cfg.token} on ${sellEx} @ ${execSellPrc.toFixed(4)}, buy on ${buyEx} @ ${execBuyPrc.toFixed(4)}`,
    });
    _state.totalNetProfit += realized.netUsdt;
    _state.lastTradeAt     = Date.now();
    _lastHarvestAt         = Date.now();   // record for flip-interval cooldown
    _consecErrors          = 0;            // successful trade — reset error streak

    // Auto-exit when maxRounds limit reached (0 = unlimited)
    if (cfg.maxRounds > 0 && _state.roundCount >= cfg.maxRounds) {
      _state.phase         = "exiting";
      _state.statusMessage = `Round ${_state.roundCount}/${cfg.maxRounds} done (+${realized.netUsdt.toFixed(4)} USDT) — max rounds reached, exiting`;
    } else {
      const rounds = cfg.maxRounds > 0 ? `${_state.roundCount}/${cfg.maxRounds}` : String(_state.roundCount);
      _state.statusMessage = `Round ${rounds} done — net +${realized.netUsdt.toFixed(4)} USDT`;
    }
    logger.info({ sellEx, buyEx, netUsdt: realized.netUsdt, round: _state.roundCount }, "spot-hedge: harvest complete");
  } catch (err) {
    if (_state.phase !== "exiting") {
      const msg = `Harvest failed: ${err instanceof Error ? err.message : String(err)}`;
      _state.statusMessage = msg;
      logger.error({ err }, "spot-hedge: harvest error");
    }
  }
}

// ── Phase 3 — Exit ────────────────────────────────────────────────────────────

async function doExit(cfg: HedgeConfig, inv: HedgeInventory): Promise<void> {
  const { a, b } = getQuotes(cfg);
  if (!a || !b) { _state.statusMessage = "Exit: waiting for live quotes…"; return; }

  // Quote freshness guard — same threshold as doHarvest
  const ageA = quoteAgeMs(a.receivedAt), ageB = quoteAgeMs(b.receivedAt);
  if (ageA > QUOTE_MAX_AGE || ageB > QUOTE_MAX_AGE) {
    _state.statusMessage = `Exit: quotes stale (${Math.max(ageA, ageB).toFixed(0)} ms) — waiting for fresh data`;
    return;
  }

  const spreadPct = (Math.abs(a.bid - b.bid) / ((a.bid + b.bid) / 2)) * 100;
  if (spreadPct > cfg.neutralThresholdPct) {
    _state.statusMessage = `Exit: waiting for neutral spread (${spreadPct.toFixed(3)}% > ${cfg.neutralThresholdPct}%)`;
    return;
  }

  const symbol = `${cfg.token.toUpperCase()}USDT`;

  // Fetch step sizes for both exchanges
  const [infoA, infoB] = await Promise.all([
    getSymbolInfo(cfg.exchangeA, cfg.token),
    getSymbolInfo(cfg.exchangeB, cfg.token),
  ]);

  const qtyA = floorToStep(inv.a.token, infoA.stepSize);
  const qtyB = floorToStep(inv.b.token, infoB.stepSize);

  const needSellA = qtyA >= infoA.minQty;
  const needSellB = qtyB >= infoB.minQty;

  if (!needSellA && !needSellB) {
    // No token to sell — we're done
    _state.phase = "stopped";
    _state.statusMessage = `Cycle complete — total net: ${_state.totalNetProfit >= 0 ? "+" : ""}${_state.totalNetProfit.toFixed(4)} USDT`;
    stopLoop();
    return;
  }

  // KuCoin MAIN→TRADE before selling
  if (needSellA && cfg.exchangeA === "kucoin") await tryKucoinMainTransfer(cfg.token);
  if (needSellB && cfg.exchangeB === "kucoin") await tryKucoinMainTransfer(cfg.token);

  logger.info({ qtyA, qtyB, dryRun: cfg.dryRun }, "spot-hedge: exit sells");

  // Fire both exit sells concurrently
  type SellTask = { exchange: HedgeExchange; qty: number; bidPx: number; side: "a" | "b" };
  const tasks: SellTask[] = [];
  if (needSellA) tasks.push({ exchange: cfg.exchangeA, qty: qtyA, bidPx: a.bid, side: "a" });
  if (needSellB) tasks.push({ exchange: cfg.exchangeB, qty: qtyB, bidPx: b.bid, side: "b" });

  const settled = await Promise.allSettled(
    tasks.map(t =>
      cfg.dryRun
        ? Promise.resolve({ execPrc: t.bidPx, execQty: t.qty, orderId: undefined as string | undefined, status: undefined as string | undefined })
        : placeOrder(t.exchange, { symbol, side: "sell", type: "market", baseQty: t.qty })
            .then(r => ({ execPrc: r.avgPrice, execQty: r.executedQty, orderId: r.orderId, status: r.status })),
    ),
  );

  let anyFailed = false;
  settled.forEach((result, i) => {
    const task = tasks[i];
    if (result.status === "rejected") {
      const msg = `Exit sell on ${task.exchange} failed: ${String(result.reason)}`;
      addError(msg);
      _state.statusMessage = msg;
      anyFailed = true;
      return;
    }

    const { execPrc, execQty, orderId: sellOrderId, status: sellStatus } = result.value;
    const revenue = execQty * execPrc;
    const tds     = (cfg.tdsPct / 100) * revenue;
    // Exit sell fee includes GST: e.g. 0.1% base × 1.18 = 0.118% effective
    const fees    = (cfg.takerFeePct / 100) * (1 + cfg.gstPct / 100) * revenue;

    if (task.side === "a") { inv.a.token = 0; inv.a.usdt += revenue - tds - fees; }
    else                   { inv.b.token = 0; inv.b.usdt += revenue - tds - fees; }

    // Gross = revenue vs cost basis of these tokens (last harvest's buy = tradeAmountUsdt)
    const exitGross = revenue - cfg.tradeAmountUsdt;
    const exitNet   = exitGross - tds - fees;
    _state.trades.push({
      id: uid(), roundNum: _state.roundCount, timestamp: Date.now(), tradeType: "exit",
      buyExchange: null, sellExchange: task.exchange,
      buyPrice: null, sellPrice: execPrc, qty: execQty,
      grossProfit: exitGross, tdsUsdt: tds, feesUsdt: fees,
      netProfit: exitNet,
      sellOrderId, sellStatus,
      inventoryAfter: JSON.parse(JSON.stringify(inv)),
      note: `Exit sell ${cfg.token} on ${task.exchange}`,
    });
    _state.totalNetProfit += exitNet;
    _state.lastTradeAt     = Date.now();
  });

  if (!anyFailed) {
    _state.phase         = "stopped";
    _state.statusMessage = `Cycle complete — total net: ${_state.totalNetProfit >= 0 ? "+" : ""}${_state.totalNetProfit.toFixed(4)} USDT`;
    logger.info({ totalNetProfit: _state.totalNetProfit }, "spot-hedge: cycle complete");
    stopLoop();
  }
}

// ── Balance Sync ──────────────────────────────────────────────────────────────
// Uses the already-cached wallet data (refreshed every 3s by the wallet module)
// No extra API calls — pure in-memory read.

function doSync(cfg: HedgeConfig, inv: HedgeInventory): void {
  if (cfg.dryRun) return;   // dry run uses virtual inventory; nothing to sync

  const sym    = cfg.token.toUpperCase();
  const cached = getCachedBalances();

  const checks: Array<{ side: "a" | "b"; exchange: string; virtual: { token: number } }> = [
    { side: "a", exchange: cfg.exchangeA, virtual: inv.a },
    { side: "b", exchange: cfg.exchangeB, virtual: inv.b },
  ];

  for (const { side, exchange, virtual } of checks) {
    const wallet = cached.find(w => w.exchange === exchange);
    if (!wallet || wallet.status !== "ok") continue;

    const tokenAsset = wallet.assets.find(a => a.coin === sym);
    const realToken  = tokenAsset?.free ?? null;
    if (realToken === null) continue;

    // Only check token drift — USDT balance is total account USDT, not bot-specific
    const drift = virtual.token > 0
      ? Math.abs(realToken - virtual.token) / virtual.token
      : (realToken > 0.0001 ? 1 : 0);

    if (drift > 0.05) {
      const msg = `${sym} drift on ${exchange}: bot thinks ${virtual.token.toFixed(6)}, wallet shows ${realToken.toFixed(6)} — correcting`;
      addError(msg);
      logger.warn({ exchange, virtual: virtual.token, real: realToken }, "spot-hedge: token inventory drift — syncing");
      if (side === "a") inv.a.token = realToken;
      else              inv.b.token = realToken;
    }
  }

  _state.lastSyncAt = Date.now();
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

function stopLoop(): void {
  if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
}

async function tick(): Promise<void> {
  if (_tradeInProgress) return;
  const cfg = _state.config;
  const inv = _state.inventory;
  if (!cfg || !inv) return;

  _tradeInProgress = true;
  _tickCount++;

  try {
    // ── Max-loss circuit breaker ────────────────────────────────────────────
    // If the session net P&L drops below the configured loss limit, initiate
    // a graceful exit immediately — before doing any more trades.
    const maxLoss = cfg.maxLossUsdt ?? 0;
    if (maxLoss > 0
        && _state.totalNetProfit < -maxLoss
        && !_exitRequested
        && _state.phase === "harvesting") {
      _exitRequested       = true;
      _state.statusMessage = `⚠ Max-loss circuit breaker: loss ${Math.abs(_state.totalNetProfit).toFixed(4)} USDT ≥ limit ${maxLoss} USDT — graceful exit initiated`;
      logger.warn({ loss: _state.totalNetProfit, limit: maxLoss }, "spot-hedge: max-loss circuit breaker triggered");
    }

    // Graceful-exit transition
    if (_exitRequested && _state.phase === "harvesting") {
      _state.phase         = "exiting";
      _state.statusMessage = _state.statusMessage.startsWith("⚠")
        ? _state.statusMessage + " — waiting for neutral spread"
        : "Exit requested — waiting for neutral spread to sell inventory";
    }

    if      (_state.phase === "watching")   await doInit(cfg, inv);
    else if (_state.phase === "harvesting") await doHarvest(cfg, inv);
    else if (_state.phase === "exiting")    await doExit(cfg, inv);

    // Periodic token-balance sync using already-cached wallet data (no extra API call)
    if (_state.phase !== "idle" && _state.phase !== "stopped") {
      if (_tickCount % SYNC_EVERY === 0) doSync(cfg, inv);
    }
  } finally {
    _tradeInProgress = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startHedgeBot(config: HedgeConfig): Promise<{ ok: boolean; error?: string }> {
  if (_state.phase !== "idle" && _state.phase !== "stopped") {
    return { ok: false, error: `Bot already running (phase: ${_state.phase})` };
  }

  // Seed virtual inventory from real balances (live mode) or from config (dry run)
  let initA = { usdt: config.tradeAmountUsdt, token: 0 };
  let initB = { usdt: config.tradeAmountUsdt, token: 0 };

  if (!config.dryRun) {
    // Use already-cached wallet data — no extra API call needed
    const sym    = config.token.toUpperCase();
    const cached = getCachedBalances();
    const wA     = cached.find(w => w.exchange === config.exchangeA);
    const wB     = cached.find(w => w.exchange === config.exchangeB);

    if (wA?.status === "ok") {
      initA = {
        usdt:  wA.availableUSDT,
        token: wA.assets.find(a => a.coin === sym)?.free ?? 0,
      };
    }
    if (wB?.status === "ok") {
      initB = {
        usdt:  wB.availableUSDT,
        token: wB.assets.find(a => a.coin === sym)?.free ?? 0,
      };
    }

    // Pre-warm symbol info cache for both exchanges
    await Promise.allSettled([
      getSymbolInfo(config.exchangeA, config.token),
      getSymbolInfo(config.exchangeB, config.token),
    ]);
  }

  _exitRequested    = false;
  _tickCount        = 0;
  _lastHarvestAt    = 0;
  _consecErrors     = 0;
  _kucoinMainDone.clear();

  // If either exchange already holds tokens, skip the init-buy phase entirely.
  // This prevents a double-buy when restarting after a previous session.
  const hasExistingInventory = initA.token > 0 || initB.token > 0;

  _state = {
    phase:          hasExistingInventory ? "harvesting" : "watching",
    config,
    inventory:      { a: initA, b: initB },
    trades:         [],
    roundCount:     0,
    totalNetProfit: 0,
    startedAt:      Date.now(),
    lastTradeAt:    null,
    lastSyncAt:     null,
    statusMessage:  hasExistingInventory
      ? `Existing inventory detected (A:${initA.token.toFixed(4)} / B:${initB.token.toFixed(4)} ${config.token}) — scanning for spread`
      : `Watching for neutral spread (max ${config.neutralThresholdPct}%)…`,
    errors:         [],
  };

  stopLoop();
  _loopTimer = setInterval(tick, TICK_MS);
  logger.info({ config }, "spot-hedge: bot started");
  return { ok: true };
}

export function stopHedgeBot(force = false): { ok: boolean } {
  if (_state.phase === "idle" || _state.phase === "stopped") return { ok: true };
  if (force) {
    stopLoop();
    _state.phase         = "stopped";
    _state.statusMessage = "Force stopped";
    logger.info("spot-hedge: bot force stopped");
  } else {
    _exitRequested       = true;
    logger.info("spot-hedge: graceful exit requested");
  }
  return { ok: true };
}

export function getHedgeBotState(): HedgeBotState {
  return { ..._state, trades: [..._state.trades], errors: [..._state.errors] };
}

export function getLiveSpread(
  token:     string,
  exchangeA: HedgeExchange,
  exchangeB: HedgeExchange,
  cfg?:      Pick<HedgeConfig, "tdsPct" | "takerFeePct" | "gstPct" | "tradeAmountUsdt">,
): LiveSpread {
  const a = spotScanner.getLiveQuote(exchangeA, token);
  const b = spotScanner.getLiveQuote(exchangeB, token);
  const updatedAt = Date.now();

  if (!a || !b) {
    return {
      token, exchangeA, exchangeB,
      askA: a?.ask ?? null, bidA: a?.bid ?? null,
      askB: b?.ask ?? null, bidB: b?.bid ?? null,
      spreadPct: null, direction: "unknown", netProfitPct: null, updatedAt,
    };
  }

  const partial: HedgeConfig = {
    token, exchangeA, exchangeB,
    tdsPct:              cfg?.tdsPct          ?? 1,
    takerFeePct:         cfg?.takerFeePct     ?? 0.1,
    gstPct:              cfg?.gstPct          ?? 18,
    tradeAmountUsdt:     cfg?.tradeAmountUsdt ?? 100,
    minSpreadPct: 0, neutralThresholdPct: 0, maxRounds: 0, flipIntervalSec: 0, dryRun: true,
  };

  // Use same spread-based formula as the harvesting gate:
  //   rawSpread% = (sellBid − buyAsk) / buyAsk × 100
  //   net%       = rawSpread% − both-side fees% − TDS%
  const spreadAB = calcSpreadNetPct(a.bid, b.ask, partial);   // sell A bid, buy B ask
  const spreadBA = calcSpreadNetPct(b.bid, a.ask, partial);   // sell B bid, buy A ask

  const useAB = spreadAB.netPct >= spreadBA.netPct;
  const best  = useAB ? spreadAB : spreadBA;
  const dir   = useAB ? "sell_A_buy_B" : "sell_B_buy_A";

  return {
    token, exchangeA, exchangeB,
    askA: a.ask, bidA: a.bid,
    askB: b.ask, bidB: b.bid,
    spreadPct:    best.rawSpreadPct,
    direction:    dir,
    netProfitPct: best.netPct,
    updatedAt,
  };
}

import { Router, type IRouter } from "express";
import {
  getConfig, updateConfig, getTrades, getBotStatus, getActiveTrade, tickOnce, clearTrades,
  calcTotalFeesPct,
} from "../lib/bot/bot-engine.js";
import { getAllBalances, getBalance, placeOrder, cancelOrder, fetchOrder, type Exchange } from "../lib/trading/index.js";
import { spotScanner }      from "../lib/spot-scanner/index.js";
import { spotPriceHistory } from "../lib/spot-scanner/price-history.js";
import type { SpotOpportunity } from "../lib/spot-scanner/types.js";

const router: IRouter = Router();

const VALID_WINDOWS = new Set(["4H", "8H", "12H", "24H"]);
const VALID_EXCHANGES: Exchange[] = ["binance", "bybit", "kucoin", "bitget"];

// ── Existing bot control routes ────────────────────────────────────────────────

router.get("/bot/status", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(getBotStatus());
});

router.get("/bot/config", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(getConfig());
});

router.put("/bot/config", (req, res): void => {
  const body = req.body as Record<string, unknown>;
  const patch: Parameters<typeof updateConfig>[0] = {};

  if (typeof body.enabled                 === "boolean") patch.enabled                 = body.enabled;
  // Opportunity filters
  if (typeof body.minNetProfitPct         === "number" ) patch.minNetProfitPct         = body.minNetProfitPct;
  if (typeof body.minTimesHit             === "number" ) patch.minTimesHit             = Math.max(0, Math.floor(body.minTimesHit));
  if (typeof body.maxMovementPct          === "number" ) patch.maxMovementPct          = Math.max(0, body.maxMovementPct);
  if (typeof body.requireAddressVerified  === "boolean") patch.requireAddressVerified  = body.requireAddressVerified;
  if (typeof body.maxWithdrawFeeUSD       === "number" ) patch.maxWithdrawFeeUSD       = Math.max(0, body.maxWithdrawFeeUSD);
  if (typeof body.priceMovementWindow     === "string"  && VALID_WINDOWS.has(body.priceMovementWindow)) {
    patch.priceMovementWindow = body.priceMovementWindow as "4H" | "8H" | "12H" | "24H";
  }
  // Trade settings
  if (typeof body.tradeAmountUSDT         === "number" ) patch.tradeAmountUSDT         = Math.max(1, body.tradeAmountUSDT);
  if (typeof body.takeProfitPct           === "number" ) patch.takeProfitPct           = body.takeProfitPct;
  if (typeof body.maxOpenPositions        === "number" ) patch.maxOpenPositions        = Math.max(1, Math.floor(body.maxOpenPositions));
  // Advanced / internal
  if (typeof body.maxFeesPct              === "number" ) patch.maxFeesPct              = Math.max(0, body.maxFeesPct);
  if (typeof body.maxTradesPerHour        === "number" ) patch.maxTradesPerHour        = Math.max(1, Math.floor(body.maxTradesPerHour));
  if (Array.isArray(body.allowedExchanges)) {
    patch.allowedExchanges = (body.allowedExchanges as unknown[]).filter((x): x is string => typeof x === "string");
  }

  const updated = updateConfig(patch);
  req.log.info({ patch }, "bot config updated via API");
  res.json(updated);
});

router.get("/bot/trades", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(getTrades());
});

router.get("/bot/active-trade", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(getActiveTrade());
});

router.post("/bot/tick", (req, res): void => {
  // Allow tick if bot is enabled OR there is an active trade to advance.
  // Active trades must always be advanced to completion regardless of enabled state
  // (matches bot-engine tick() behaviour which checks activeTrade first).
  if (!getConfig().enabled && !getActiveTrade()) {
    res.status(400).json({ error: "Bot is not enabled and no active trade — enable the bot first" });
    return;
  }
  tickOnce()
    .then(() => {
      req.log.info("bot: manual tick fired via API");
      res.json({ ok: true, activeTrade: getActiveTrade(), status: getBotStatus() });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, "bot: manual tick error");
      res.status(500).json({ error: msg });
    });
});

router.delete("/bot/trades", (req, res): void => {
  clearTrades();
  req.log.info("bot: trade history cleared via API");
  res.json({ ok: true });
});

// ── Step 1: USDT Balance Detection ────────────────────────────────────────────
/**
 * GET /api/bot/detect-usdt
 * Fetches USDT balance across all 4 exchanges. Identifies the best "buy exchange"
 * (most free USDT). This is Step 1 of the arbitrage flow.
 */
router.get("/bot/detect-usdt", (_req, res): void => {
  res.set("Cache-Control", "no-store");

  getAllBalances("USDT")
    .then((balances) => {
      const rows = VALID_EXCHANGES.map((ex) => {
        const b = balances[ex];
        return {
          exchange: ex,
          free:     b?.free   ?? 0,
          locked:   b?.locked ?? 0,
          ok:       b !== null,
        };
      });

      const best = rows.reduce(
        (a, b) => (b.free > a.free ? b : a),
        { exchange: "none", free: 0, locked: 0, ok: false },
      );

      const totalUSDT = rows.reduce((s, r) => s + r.free, 0);

      res.json({ balances: rows, best, totalUSDT, timestamp: Date.now() });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    });
});

// ── API Auth Verification ─────────────────────────────────────────────────────
/**
 * GET /api/bot/verify-apis
 * Verifies that all 4 exchange API keys are working by fetching USDT balance
 * on each exchange. If balance fetch succeeds, auth + signing is confirmed correct.
 * This is the safest way to verify order API readiness without placing real orders.
 */
router.get("/bot/verify-apis", (_req, res): void => {
  res.set("Cache-Control", "no-store");

  const start = Date.now();
  const checks = VALID_EXCHANGES.map(async (ex) => {
    const t0 = Date.now();
    try {
      const bals = await getBalance(ex, "USDT");
      const usdt  = bals["USDT"] ?? { free: 0, locked: 0 };
      return {
        exchange: ex,
        ok:           true,
        usdtFree:     usdt.free,
        usdtLocked:   usdt.locked,
        durationMs:   Date.now() - t0,
      };
    } catch (err) {
      return {
        exchange:   ex,
        ok:         false,
        error:      err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
    }
  });

  Promise.all(checks)
    .then((results) => {
      const allOk = results.every(r => r.ok);
      res.json({
        allOk,
        exchanges:    results,
        durationMs:   Date.now() - start,
        message:      allOk
          ? "All exchange APIs verified — auth + signing working correctly"
          : "Some exchanges failed — check API keys and IP whitelisting",
      });
    })
    .catch((err: unknown) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });
});

// ── Testnet-style Order API Test (place limit + cancel immediately) ───────────
/**
 * POST /api/bot/test-order
 * Body: { exchange: "binance"|"bybit"|"kucoin"|"bitget", symbol?: "BTC"|"ETH"|..., qty?: number }
 *
 * Safe order API test without spending real funds:
 *   1. Gets current market price from spot scanner
 *   2. Places a LIMIT BUY at 50% below market (will never fill)
 *   3. Records full order placement response
 *   4. Immediately cancels the order
 *   5. Fetches final order state
 *   6. Returns complete request/response cycle for verification
 *
 * Minimum qty defaults: BTC=0.0001, ETH=0.01, others=1.0 (adjust if exchange rejects)
 */
router.post("/bot/test-order", (req, res): void => {
  res.set("Cache-Control", "no-store");

  const body     = req.body as Record<string, unknown>;
  const exchange = (body.exchange as string | undefined) ?? "";
  const symbol   = ((body.symbol as string | undefined) ?? "BTC").toUpperCase();
  const qtyParam = typeof body.qty === "number" ? body.qty : undefined;

  if (!VALID_EXCHANGES.includes(exchange as Exchange)) {
    res.status(400).json({ error: `exchange must be one of: ${VALID_EXCHANGES.join(", ")}` });
    return;
  }

  const ex = exchange as Exchange;

  // Default minimum quantities per symbol (safe for all exchanges)
  const DEFAULT_QTY: Record<string, number> = { BTC: 0.0001, ETH: 0.01, BNB: 0.1, SOL: 0.1, XRP: 1.0 };
  const baseQty = qtyParam ?? DEFAULT_QTY[symbol] ?? 1.0;

  const steps: Array<Record<string, unknown>> = [];
  const overallStart = Date.now();

  const run = async () => {
    // ── Step A: Get current price from spot scanner ──────────────────────────
    // Try getLiveQuote first (direct quote map, uses SYMBOLUSDT key)
    const quote = spotScanner.getLiveQuote(ex, symbol);
    let currentAsk = quote?.ask ?? 0;
    let priceSource = "spot_scanner_quote";

    // Fallback 1: try any other exchange's live quote
    if (currentAsk <= 0) {
      for (const fallbackEx of VALID_EXCHANGES) {
        const q = spotScanner.getLiveQuote(fallbackEx, symbol);
        if (q && q.ask > 0) { currentAsk = q.ask; priceSource = `fallback_quote_${fallbackEx}`; break; }
      }
    }

    // Fallback 2: use spot opportunities list (has live prices for many symbols)
    if (currentAsk <= 0) {
      const opps = spotScanner.getOpportunities() as SpotOpportunity[];
      const match = opps.find(o => o.symbol === symbol && o.buyAsk > 0);
      if (match) { currentAsk = match.buyAsk; priceSource = "spot_opportunities"; }
    }

    // Fallback 3: hardcoded per-symbol estimates (last resort)
    if (currentAsk <= 0) {
      const PRICE_ESTIMATES: Record<string, number> = {
        BTC: 95_000, ETH: 2_400, BNB: 600, SOL: 150,
        XRP: 2.2, ADA: 0.7, AVAX: 25, DOGE: 0.2,
      };
      currentAsk = PRICE_ESTIMATES[symbol] ?? 100;
      priceSource = "hardcoded_estimate";
    }

    steps.push({
      step:       "get_price",
      ok:         true,
      exchange:   ex,
      symbol,
      currentAsk,
      source:     priceSource,
    });

    // Test limit price = 50% of current ask (safely below market, will never fill)
    const testPrice = parseFloat((currentAsk * 0.50).toFixed(2));

    // ── Step B: Place limit order ────────────────────────────────────────────
    let orderId = "";
    const placeStart = Date.now();
    try {
      const placeRes = await placeOrder(ex, {
        symbol,
        side:    "buy",
        type:    "limit",
        baseQty,
        price:   testPrice,
        clientOrderId: `test-${Date.now()}`,
      });
      orderId = placeRes.orderId;
      steps.push({
        step:       "place_order",
        ok:         true,
        exchange:   ex,
        symbol,
        testPrice,
        baseQty,
        orderId,
        status:     placeRes.status,
        raw:        placeRes.raw,
        durationMs: Date.now() - placeStart,
      });
    } catch (err) {
      steps.push({
        step:       "place_order",
        ok:         false,
        exchange:   ex,
        symbol,
        testPrice,
        baseQty,
        error:      err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - placeStart,
      });
      return; // Cannot cancel if placement failed
    }

    // Brief wait before cancel (ensure order is registered on exchange)
    await new Promise(r => setTimeout(r, 400));

    // ── Step C: Cancel the order ─────────────────────────────────────────────
    const cancelStart = Date.now();
    try {
      const cancelRes = await cancelOrder(ex, symbol, orderId);
      steps.push({
        step:       "cancel_order",
        ok:         true,
        exchange:   ex,
        orderId,
        status:     cancelRes.status,
        raw:        cancelRes.raw,
        durationMs: Date.now() - cancelStart,
      });
    } catch (err) {
      steps.push({
        step:       "cancel_order",
        ok:         false,
        exchange:   ex,
        orderId,
        error:      err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - cancelStart,
      });
    }

    // ── Step D: Fetch final order state ─────────────────────────────────────
    await new Promise(r => setTimeout(r, 300));
    const fetchStart = Date.now();
    try {
      const orderState = await fetchOrder(ex, symbol, orderId);
      steps.push({
        step:       "fetch_order",
        ok:         true,
        exchange:   ex,
        orderId,
        status:     orderState.status,
        executedQty:      orderState.executedQty,
        executedQuoteQty: orderState.executedQuoteQty,
        avgPrice:         orderState.avgPrice,
        raw:        orderState.raw,
        durationMs: Date.now() - fetchStart,
      });
    } catch (err) {
      steps.push({
        step:       "fetch_order",
        ok:         false,
        exchange:   ex,
        orderId,
        error:      err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - fetchStart,
      });
    }
  };

  run()
    .then(() => {
      const allOk  = steps.every(s => s["ok"] === true);
      const placed  = steps.find(s => s["step"] === "place_order");
      const cancelled = steps.find(s => s["step"] === "cancel_order");
      req.log.info({ exchange: ex, symbol, allOk, steps: steps.length }, "bot: test-order cycle complete");
      res.json({
        exchange,
        symbol,
        success:    allOk,
        orderId:    placed?.["ok"] ? placed["orderId"] : null,
        placed:     placed?.["ok"]    ?? false,
        cancelled:  cancelled?.["ok"] ?? false,
        steps,
        totalMs:    Date.now() - overallStart,
        message:    allOk
          ? `✓ ${ex.toUpperCase()} order API verified — place + cancel cycle successful`
          : `✗ ${ex.toUpperCase()} test failed — see steps for details`,
      });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ exchange: ex, symbol, err: msg }, "bot: test-order unhandled error");
      res.status(500).json({ error: msg, steps });
    });
});

// ── Step 2: Find best opportunity matching bot config filters ─────────────────
/**
 * GET /api/bot/find-opportunity
 * Applies all bot config filters to current spot opportunities and returns
 * the best candidate (same logic as bot engine tick — useful for manual inspection).
 */
router.get("/bot/find-opportunity", (_req, res): void => {
  res.set("Cache-Control", "no-store");

  const cfg  = getConfig();
  // Cast includes profitTimesHit which the scanner attaches alongside SpotOpportunity fields
  const opps = spotScanner.getOpportunitiesWithTarget(cfg.minNetProfitPct) as
    (SpotOpportunity & { profitTimesHit?: number })[];

  // Pre-fetch movement data once (same as bot engine tick — avoids O(n) map lookup per opp)
  const exMovements = cfg.maxMovementPct > 0 ? spotPriceHistory.getExchangeMovements() : null;

  const candidates = opps.filter((opp) => {
    // Both exchanges must be in the allowed list
    if (!cfg.allowedExchanges.includes(opp.buyExchange))  return false;
    if (!cfg.allowedExchanges.includes(opp.sellExchange)) return false;
    // Net profit threshold
    if ((opp.netProfitPct ?? -999) < cfg.minNetProfitPct) return false;
    // Total fees cap (same formula as bot engine)
    if (calcTotalFeesPct(opp, cfg.tradeAmountUSDT) > cfg.maxFeesPct) return false;
    // Must have been profitable >= N seconds in recent window
    if ((opp.profitTimesHit ?? 0) < cfg.minTimesHit) return false;
    // Sell-side price movement cap (0 = no cap) — must match bot engine tick() logic exactly
    if (exMovements && cfg.maxMovementPct > 0) {
      const mov = exMovements[opp.sellExchange]?.[opp.symbol]?.[cfg.priceMovementWindow] ?? null;
      if (mov !== null && mov > cfg.maxMovementPct) return false;
    }
    // Deposit address must be verified (≥10 consecutive stable refreshes)
    if (cfg.requireAddressVerified && opp.fees.addressVerified !== true) return false;
    // Withdrawal fee cap (0 = no cap)
    if (cfg.maxWithdrawFeeUSD > 0) {
      const wdUSD = opp.fees.withdrawFeeUSD;
      if (wdUSD !== null && wdUSD > cfg.maxWithdrawFeeUSD) return false;
    }
    return true;
  });

  candidates.sort((a, b) => (b.netProfitPct ?? -999) - (a.netProfitPct ?? -999));

  const rejectedCount = opps.length - candidates.length;
  res.json({
    found:         candidates.length,
    rejected:      rejectedCount,
    config:        cfg,
    best:          candidates[0] ?? null,
    all:           candidates.slice(0, 10),
    totalScanned:  opps.length,
    timestamp:     Date.now(),
  });
});

export default router;

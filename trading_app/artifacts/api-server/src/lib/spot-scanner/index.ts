/**
 * Spot scanner orchestrator
 *
 * Manages four exchange adapters:
 *   • Binance  — combined individual WS streams (btcusdt@bookTicker/…) — 721 pairs,
 *                falls back to REST poll if both WS ports are geo-blocked
 *   • KuCoin   — WS /market/ticker:all (real-time, token-authed)
 *   • Bybit    — WS tickers.{SYMBOL} (real-time, REST seed)
 *   • Bitget   — WS SPOT/ticker (real-time, REST seed)
 *
 * Opportunities are rebuilt every REBUILD_INTERVAL_MS from all adapter quote maps.
 * Exchange status is derived from whether fresh quotes (≤ MAX_STALE_MS) exist.
 * Fee service is started at the same time and supplies maker/taker/withdrawal fees.
 */

import { logger } from "../logger.js";
import { buildOpportunities } from "./aggregator.js";
import { getTradingFees, startWithdrawalFeeService, startBinanceDataService, startKucoinDataService, startBitgetDataService, startBybitDataService, startDepositAddressService } from "./fees/index.js";
import { CcxtSpotAdapter } from "./adapters/ccxt-spot-adapter.js";
import { spotPriceHistory, type SpotQuote, type SpotPriceSample } from "./price-history.js";
import { spotProfitHistory, makeProfitKey, type ProfitSample } from "./profit-history.js";
import type { SpotOpportunity, SpotExchangeStatus } from "./types.js";

const REBUILD_INTERVAL_MS = 500;
const MAX_STALE_MS = 60_000;

const binance = new CcxtSpotAdapter('binance');
const kucoin  = new CcxtSpotAdapter('kucoin');
const bybit   = new CcxtSpotAdapter('bybit');
const bitget  = new CcxtSpotAdapter('bitget');

const ADAPTERS: Array<{ name: string; adapter: { quotes: Map<string, { receivedAt: number }>; dataSource?: "ws" | "rest" } }> = [
  { name: "binance", adapter: binance },
  { name: "kucoin",  adapter: kucoin  },
  { name: "bybit",   adapter: bybit   },
  { name: "bitget",  adapter: bitget  },
];

let _opportunities: SpotOpportunity[] = [];
let _lastUpdatedAt: number | null = null;
let _running = false;
let _rebuildTimer: ReturnType<typeof setInterval> | null = null;

// ── Pre-warmed mini sparkline cache ─────────────────────────────────────────
// Built from ONLY the active opportunity symbols (100-200 symbols) instead of
// the full 2 000+ universe, making it 10-40× faster to build. The cache is
// refreshed asynchronously after every 30s price-history snapshot so HTTP
// requests always get a near-instant cache hit.

interface MiniSpkCache {
  ask: Record<string, Record<string, SpotPriceSample[]>>;
  bid: Record<string, Record<string, SpotPriceSample[]>>;
  builtAt: number;
}

let _miniSpkCache: MiniSpkCache | null = null;

// ── getOpportunitiesWithTarget stats cache ──────────────────────────────────
// `getTimesAbove` / `getHighest` / `getLowest` each scan up to 9 000 samples
// per key. With 100+ opportunities this is O(opps × 9000) per request —
// expensive at 500ms polling. We cache the stats per (profitVersion, threshold)
// and rebuild only when the profit-history snapshot advances (every 2s).

interface OppStats {
  profitTimesHit:      number;
  highestNetProfitPct: number | null;
  lowestNetProfitPct:  number | null;
}
let _statsCache: {
  profitVersion: number;
  threshold:     number;
  stats:         Map<string, OppStats>;
} | null = null;

/** Rebuild the mini sparkline cache for the current set of active symbols. */
function buildAndCacheMiniSpk(): void {
  const active = new Set(_opportunities.map((o) => o.symbol));
  _miniSpkCache = {
    ask:     spotPriceHistory.buildMiniSparklinesForSymbols(active, 60),
    bid:     spotPriceHistory.buildBidMiniSparklinesForSymbols(active, 60),
    builtAt: Date.now(),
  };
  logger.debug(
    { symbols: active.size, builtAt: _miniSpkCache.builtAt },
    "mini sparkline cache rebuilt",
  );
}

/**
 * Fee lookup — prefers live per-symbol fees from adapters that expose them
 * (Bitget: /spot/public/symbols per-symbol).
 * Falls back to static standard rates for exchanges without public fee APIs.
 */
function feeGetter(exchange: string, symbol: string): { maker: number; taker: number } {
  if (exchange === "bitget") {
    const f = bitget.feeMap.get(symbol);
    if (f) return f;
  }
  return getTradingFees(exchange);
}

function rebuild(): void {
  const exchangeData = new Map(
    ADAPTERS.map(({ name, adapter }) => [
      name,
      adapter.quotes as Map<string, { bid: number; ask: number; receivedAt: number }>,
    ]),
  );
  _opportunities = buildOpportunities(exchangeData, feeGetter);
  _lastUpdatedAt = Date.now();
}

function getStatus(name: string): SpotExchangeStatus {
  const adapter = ADAPTERS.find((a) => a.name === name)!.adapter;
  const now = Date.now();
  let freshCount = 0;
  let lastFetchAt: number | null = null;

  for (const q of adapter.quotes.values()) {
    if (q.receivedAt > now - MAX_STALE_MS) {
      freshCount++;
      if (lastFetchAt === null || q.receivedAt > lastFetchAt) {
        lastFetchAt = q.receivedAt;
      }
    }
  }

  return {
    exchange: name,
    status: freshCount > 0 ? "online" : "offline",
    dataSource: (adapter as { dataSource?: "ws" | "rest" }).dataSource ?? "ws",
    symbolCount: freshCount,
    lastFetchAt,
  };
}

export const spotScanner = {
  get running()      { return _running; },
  get opportunities(){ return _opportunities; },
  get lastUpdatedAt(){ return _lastUpdatedAt; },

  getStatuses(): SpotExchangeStatus[] {
    return ADAPTERS.map(({ name }) => getStatus(name));
  },

  getOpportunities(minDiffPct = 0): SpotOpportunity[] {
    return minDiffPct <= 0
      ? _opportunities
      : _opportunities.filter((o) => o.priceDiffPct >= minDiffPct);
  },

  /**
   * Same as getOpportunities() but adds profitTimesHit for each opportunity —
   * count of 4h samples where netProfitPct >= targetedNetProfitPct.
   */
  getOpportunitiesWithTarget(targetedNetProfitPct: number, minDiffPct = 0): SpotOpportunity[] {
    const base          = this.getOpportunities(minDiffPct);
    const profitVersion = spotProfitHistory.getVersion();

    // Rebuild stats only when profit-history has a new snapshot (every 2s).
    // This turns an O(opps × 9000) scan per 500ms request into O(1) lookups.
    if (
      !_statsCache ||
      _statsCache.profitVersion !== profitVersion ||
      _statsCache.threshold     !== targetedNetProfitPct
    ) {
      const stats = new Map<string, OppStats>();
      // Compute stats for every currently-active opportunity
      for (const o of _opportunities) {
        const key = makeProfitKey(o.symbol, o.buyExchange, o.sellExchange);
        if (stats.has(key)) continue;
        stats.set(key, {
          profitTimesHit:      isFinite(targetedNetProfitPct)
            ? spotProfitHistory.getTimesAbove(key, targetedNetProfitPct)
            : 0,
          highestNetProfitPct: spotProfitHistory.getHighest(key),
          lowestNetProfitPct:  spotProfitHistory.getLowest(key),
        });
      }
      _statsCache = { profitVersion, threshold: targetedNetProfitPct, stats };
    }

    return base.map((o) => {
      const key    = makeProfitKey(o.symbol, o.buyExchange, o.sellExchange);
      const cached = _statsCache!.stats.get(key);
      return {
        ...o,
        profitTimesHit:      cached?.profitTimesHit      ?? 0,
        highestNetProfitPct: cached?.highestNetProfitPct ?? null,
        lowestNetProfitPct:  cached?.lowestNetProfitPct  ?? null,
      };
    });
  },

  getPriceHistory(): Record<string, SpotPriceSample[]> {
    return spotPriceHistory.getAll();
  },

  getPriceMovements(): Record<string, Record<string, number | null>> {
    return spotPriceHistory.getMovements();
  },

  getExchangePriceMovements(): Record<string, Record<string, Record<string, number | null>>> {
    return spotPriceHistory.getExchangeMovements();
  },

  /**
   * Downsampled mini sparklines for active symbols (fast — ~60 pts per series).
   * Use this for the small charts inside cards.
   * Served from the pre-warmed cache; falls back to cold build on first call.
   */
  getMiniSparklines(_maxPoints = 60): Record<string, Record<string, SpotPriceSample[]>> {
    if (!_miniSpkCache) buildAndCacheMiniSpk();
    return _miniSpkCache!.ask;
  },

  /**
   * Full-resolution ask sparklines for a specific symbol (used by chart modal).
   * Uses per-symbol builder — O(rows × 4) instead of O(rows × 2000+ symbols).
   */
  getFullSparklines(symbol: string): Record<string, SpotPriceSample[]> {
    return spotPriceHistory.getAskSparklineForSymbol(symbol);
  },

  /**
   * Downsampled bid-price mini sparklines for active symbols.
   * Use for the SELL exchange in SpotHedge cards (spread = A_ask − B_bid).
   * Served from the pre-warmed cache; falls back to cold build on first call.
   */
  getBidMiniSparklines(_maxPoints = 60): Record<string, Record<string, SpotPriceSample[]>> {
    if (!_miniSpkCache) buildAndCacheMiniSpk();
    return _miniSpkCache!.bid;
  },

  /**
   * Full-resolution bid sparklines for one symbol (chart modal sell side).
   * Uses per-symbol builder — O(rows × 4) instead of O(rows × 2000+ symbols).
   */
  getBidFullSparklines(symbol: string): Record<string, SpotPriceSample[]> {
    return spotPriceHistory.getBidSparklineForSymbol(symbol);
  },

  /**
   * Per-exchange sparklines for symbols currently in opportunities (full resolution).
   * @deprecated Use getMiniSparklines() for cards; getFullSparklines(symbol) for chart modal.
   */
  getSparklines(limit = 3000): Record<string, Record<string, SpotPriceSample[]>> {
    const all = spotPriceHistory.getExchangeSparklines(limit);
    const active = new Set(_opportunities.map((o) => o.symbol));
    const result: Record<string, Record<string, SpotPriceSample[]>> = {};
    for (const [ex, symMap] of Object.entries(all)) {
      for (const [sym, samples] of Object.entries(symMap)) {
        if (!active.has(sym)) continue;
        if (!result[ex]) result[ex] = {};
        result[ex][sym] = samples;
      }
    }
    return result;
  },

  getProfitHistory(): Record<string, ProfitSample[]> {
    return spotProfitHistory.getAll();
  },

  getCrossovers(threshold = 0, maxEvents = 10) {
    return spotProfitHistory.getCrossoversAll(threshold, maxEvents);
  },

  /**
   * Cross-exchange price table.
   * Returns one row per canonical symbol (e.g. "BTC" from "BTCUSDT"),
   * with per-exchange { bid, ask } or null if exchange doesn't list it / data is stale.
   */
  getMarkets(): Array<{
    symbol:  string;
    binance: { bid: number; ask: number } | null;
    bybit:   { bid: number; ask: number } | null;
    kucoin:  { bid: number; ask: number } | null;
    bitget:  { bid: number; ask: number } | null;
  }> {
    const now   = Date.now();
    const STALE = 60_000;

    // Adapters store quotes keyed by canonical coin name (e.g. "BTC", "ETH")
    // after stripStable() normalization — no suffix filtering needed.
    const allSymbols = new Set<string>();
    for (const { adapter } of ADAPTERS) {
      const q = adapter.quotes as Map<string, { bid: number; ask: number; receivedAt: number }>;
      for (const sym of q.keys()) {
        if (sym.length > 0) allSymbols.add(sym);
      }
    }

    type Row = {
      symbol:  string;
      binance: { bid: number; ask: number } | null;
      bybit:   { bid: number; ask: number } | null;
      kucoin:  { bid: number; ask: number } | null;
      bitget:  { bid: number; ask: number } | null;
    };

    const result: Row[] = [];
    for (const sym of allSymbols) {
      const row: Row = { symbol: sym, binance: null, bybit: null, kucoin: null, bitget: null };
      for (const { name, adapter } of ADAPTERS) {
        const q = (adapter.quotes as Map<string, { bid: number; ask: number; receivedAt: number }>).get(sym);
        if (q && now - q.receivedAt < STALE) {
          (row as Record<string, unknown>)[name] = { bid: q.bid, ask: q.ask };
        }
      }
      result.push(row);
    }

    return result.sort((a, b) => a.symbol.localeCompare(b.symbol));
  },

  start(): void {
    if (_running) return;
    _running = true;

    startWithdrawalFeeService();
    startBybitDataService();
    startBinanceDataService();
    startKucoinDataService();
    startBitgetDataService();
    startDepositAddressService();

    binance.start();
    kucoin.start();
    bybit.start();
    bitget.start();

    _rebuildTimer = setInterval(rebuild, REBUILD_INTERVAL_MS);

    // Spot price history: one row-per-30s snapshot of ALL exchanges' ask prices,
    // single file, persists to disk every 60s, retains 25h rolling window (3000 rows).
    // onSnapshot: pre-warms the mini sparkline cache asynchronously after each snapshot
    // so HTTP requests always get a fast cache hit instead of a 2-5s cold build.
    spotPriceHistory.start(
      () => new Map<string, Map<string, SpotQuote>>([
        ["binance", binance.quotes as Map<string, SpotQuote>],
        ["kucoin",  kucoin.quotes  as Map<string, SpotQuote>],
        ["bybit",   bybit.quotes   as Map<string, SpotQuote>],
        ["bitget",  bitget.quotes  as Map<string, SpotQuote>],
      ]),
      buildAndCacheMiniSpk,
    );

    // Spot profit history: snapshots netProfitPct of every opportunity every 1s,
    // 5h rolling retention, in-memory only (per-sample age-based prune).
    spotProfitHistory.start(() => _opportunities);

    logger.info("spot scanner started (binance/kucoin/bybit/bitget WS + price/profit history)");
  },

  stop(): void {
    if (_rebuildTimer) clearInterval(_rebuildTimer);
    binance.stop();
    kucoin.stop();
    bybit.stop();
    bitget.stop();
    spotPriceHistory.stop();
    spotProfitHistory.stop();
    _running = false;
    logger.info("spot scanner stopped");
  },

  /**
   * Return the live bid/ask for a specific coin on a specific exchange.
   * Symbol lookup: "{COIN}USDT" (e.g. "MOVRUSDT").
   * Returns null if exchange unknown or no live quote available.
   */
  getLiveQuote(exchangeName: string, coin: string): SpotQuote | null {
    const entry = ADAPTERS.find(a => a.name === exchangeName);
    if (!entry) return null;
    // Adapters store quotes keyed by stripped coin name ("BTC", not "BTCUSDT")
    const sym = coin.toUpperCase().replace(/USDT$|USDC$|BUSD$/, "");
    const q = (entry.adapter.quotes as Map<string, SpotQuote>).get(sym);
    return q ?? null;
  },
};

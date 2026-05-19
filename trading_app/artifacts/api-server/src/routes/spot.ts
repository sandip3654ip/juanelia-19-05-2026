import { Router, type IRouter } from "express";
import { spotScanner } from "../lib/spot-scanner/index.js";
import {
  fetchAndSaveBinance,
  getAllBinanceData,
  getBinanceCoin,
  getBinanceFetchStatus,
  getBinanceWithdrawNetworks,
  getBinanceDepositNetworks,
} from "../lib/spot-scanner/fees/binance-data.js";
import {
  fetchAndSaveKucoin,
  getAllKucoinData,
  getKucoinCoin,
  getKucoinFetchStatus,
  getKucoinWithdrawNetworks,
  getKucoinDepositNetworks,
} from "../lib/spot-scanner/fees/kucoin-data.js";
import {
  fetchAndSaveBitget,
  getAllBitgetData,
  getBitgetCoin,
  getBitgetFetchStatus,
  getBitgetWithdrawNetworks,
  getBitgetDepositNetworks,
} from "../lib/spot-scanner/fees/bitget-data.js";
import {
  fetchAndSaveBybit,
  getAllBybitData,
  getBybitCoin,
  getBybitFetchStatus,
  getBybitDepositNetworks,
  getBybitWithdrawalEntry,
} from "../lib/spot-scanner/fees/bybit-data.js";
import {
  getAllDepositAddresses,
  getDepositAddress,
  getDepositAddressStatus,
  refreshExchangeAddresses,
  getRefreshProgress,
  getNextAutoRefreshAt,
} from "../lib/spot-scanner/fees/deposit-address-service.js";
import {
  GetSpotOpportunitiesResponse,
  GetSpotStatusResponse,
} from "@workspace/api-zod";
import { normalizeNetwork } from "../lib/spot-scanner/fees/withdrawal-fees.js";

const router: IRouter = Router();

router.get("/spot/price-history", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getPriceHistory());
});

router.get("/spot/price-movements", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getPriceMovements());
});

router.get("/spot/price-movements-by-exchange", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getExchangePriceMovements());
});

// Mini sparklines for cards — ~60 downsampled pts per series, fast (<2MB)
router.get("/spot/sparklines", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getMiniSparklines(60));
});

// Full-resolution sparklines for one symbol — used by chart modal on-demand
router.get("/spot/sparklines-full", (req, res): void => {
  const symbol = typeof req.query["symbol"] === "string" ? req.query["symbol"] : "";
  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getFullSparklines(symbol));
});

// Bid-price mini sparklines — for SpotHedge SELL side (spread = A_ask − B_bid)
router.get("/spot/sparklines-bid", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getBidMiniSparklines(60));
});

// Full-resolution bid sparklines for chart modal SELL side
router.get("/spot/sparklines-full-bid", (req, res): void => {
  const symbol = typeof req.query["symbol"] === "string" ? req.query["symbol"] : "";
  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getBidFullSparklines(symbol));
});

router.get("/spot/markets", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getMarkets());
});

router.get("/spot/profit-history", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getProfitHistory());
});

router.get("/spot/crossovers", (req, res): void => {
  const threshold  = parseFloat(req.query["threshold"] as string);
  const maxEvents  = parseInt(req.query["maxEvents"]   as string, 10);
  const thr = isFinite(threshold) ? threshold : 0;
  const max = isFinite(maxEvents) && maxEvents > 0 ? Math.min(maxEvents, 20) : 10;
  res.set("Cache-Control", "no-store");
  res.json(spotScanner.getCrossovers(thr, max));
});

router.get("/spot/status", (req, res): void => {
  const payload = {
    running: spotScanner.running,
    exchanges: spotScanner.getStatuses(),
    opportunityCount: spotScanner.opportunities.length,
    lastUpdatedAt: spotScanner.lastUpdatedAt,
  };

  const parsed = GetSpotStatusResponse.safeParse(payload);
  if (!parsed.success) {
    req.log.error({ errors: parsed.error.message }, "spot status parse error");
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.set("Cache-Control", "no-store");
  res.json(parsed.data);
});

router.get("/spot/opportunities", (req, res): void => {
  const minDiffPct        = parseFloat(req.query["minDiffPct"]        as string);
  const targetedNetProfit = parseFloat(req.query["targetedNetProfit"] as string);
  const min = isFinite(minDiffPct) ? minDiffPct : 0;

  // If a targetedNetProfit threshold is supplied, annotate each opp with profitTimesHit
  const opps = isFinite(targetedNetProfit)
    ? spotScanner.getOpportunitiesWithTarget(targetedNetProfit, min)
    : spotScanner.getOpportunities(min);

  const parsed = GetSpotOpportunitiesResponse.safeParse(opps);
  if (!parsed.success) {
    req.log.error({ errors: parsed.error.message }, "spot opportunities parse error");
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.set("Cache-Control", "no-store");
  res.json(parsed.data);
});

// ── Bybit fee data inspection endpoint ────────────────────────────────────

/**
 * GET /api/spot/fees/bybit
 * Returns the full saved Bybit fee dataset.
 * Deposit data: live from public API (903 coins).
 * Withdrawal data: static table (~115 coins — Bybit has no public withdrawal API).
 * Supports ?coin=ETH to get data for a single coin.
 */
router.get("/spot/fees/bybit", (req, res): void => {
  const coinParam = (req.query["coin"] as string | undefined)?.toUpperCase();

  if (coinParam) {
    const data = getBybitCoin(coinParam);
    if (!data) {
      res.status(404).json({ error: `Coin ${coinParam} not found in Bybit data` });
      return;
    }
    const dep = getBybitDepositNetworks(coinParam);
    const wd  = getBybitWithdrawalEntry(coinParam);
    res.set("Cache-Control", "no-store");
    res.json({
      coin:              coinParam,
      depositNetworks:   dep,
      withdrawalEntry:   wd,
      withdrawalNote:    wd === null
        ? "Not in static table — Bybit has no public withdrawal API"
        : "Source: static table (manually maintained). Bybit has no public withdrawal API.",
    });
    return;
  }

  const status = getBybitFetchStatus();
  const all    = getAllBybitData();
  res.set("Cache-Control", "no-store");
  res.json({
    meta: {
      totalCoins:            status.coins,
      depositApiCoins:       status.depositApiCoins,
      withdrawalCoins:       status.withdrawalCoins,
      bothAvailable:         status.bothAvailable,
      fetchedAt:             status.fetchedAt,
      savedFile:             status.file,
      withdrawalNote:        "Bybit withdrawal API requires HMAC auth. Withdrawal data is from a static manually-maintained table.",
    },
    data: all,
  });
});

// ── Bitget fee data inspection endpoint ───────────────────────────────────

/**
 * GET /api/spot/fees/bitget
 * Returns the full saved Bitget fee dataset (all coins, all networks).
 * Supports ?coin=ETH to get data for a single coin.
 */
router.get("/spot/fees/bitget", (req, res): void => {
  const coinParam = (req.query["coin"] as string | undefined)?.toUpperCase();

  if (coinParam) {
    const data = getBitgetCoin(coinParam);
    if (!data) {
      res.status(404).json({ error: `Coin ${coinParam} not found in Bitget data` });
      return;
    }
    const wd  = getBitgetWithdrawNetworks(coinParam);
    const dep = getBitgetDepositNetworks(coinParam);
    res.set("Cache-Control", "no-store");
    res.json({
      coin:                    coinParam,
      networks:                data,
      withdrawEnabledNetworks: wd,
      depositEnabledNetworks:  dep,
    });
    return;
  }

  const status = getBitgetFetchStatus();
  const all    = getAllBitgetData();
  res.set("Cache-Control", "no-store");
  res.json({
    meta: {
      coins:     status.coins,
      fetchedAt: status.fetchedAt,
      savedFile: status.file,
    },
    data: all,
  });
});

// ── KuCoin fee data inspection endpoint ───────────────────────────────────

/**
 * GET /api/spot/fees/kucoin
 * Returns the full saved KuCoin fee dataset (all coins, all networks).
 * Supports ?coin=ETH to get data for a single coin.
 */
router.get("/spot/fees/kucoin", (req, res): void => {
  const coinParam = (req.query["coin"] as string | undefined)?.toUpperCase();

  if (coinParam) {
    const data = getKucoinCoin(coinParam);
    if (!data) {
      res.status(404).json({ error: `Coin ${coinParam} not found in KuCoin data` });
      return;
    }
    const wd  = getKucoinWithdrawNetworks(coinParam);
    const dep = getKucoinDepositNetworks(coinParam);
    res.set("Cache-Control", "no-store");
    res.json({
      coin:                    coinParam,
      networks:                data,
      withdrawEnabledNetworks: wd,
      depositEnabledNetworks:  dep,
    });
    return;
  }

  const status = getKucoinFetchStatus();
  const all    = getAllKucoinData();
  res.set("Cache-Control", "no-store");
  res.json({
    meta: {
      coins:     status.coins,
      fetchedAt: status.fetchedAt,
      savedFile: status.file,
    },
    data: all,
  });
});

// ── Binance fee data inspection endpoints ─────────────────────────────────

/**
 * GET /api/spot/fees/binance
 * Returns the full saved Binance fee dataset (all coins, all networks).
 * Supports ?coin=BTC to get data for a single coin.
 */
router.get("/spot/fees/binance", (req, res): void => {
  const coinParam = (req.query["coin"] as string | undefined)?.toUpperCase();

  if (coinParam) {
    const data = getBinanceCoin(coinParam);
    if (!data) {
      res.status(404).json({ error: `Coin ${coinParam} not found in Binance data` });
      return;
    }
    const wd  = getBinanceWithdrawNetworks(coinParam);
    const dep = getBinanceDepositNetworks(coinParam);
    res.set("Cache-Control", "no-store");
    res.json({
      coin:                    coinParam,
      networks:                data,
      withdrawEnabledNetworks: wd,
      depositEnabledNetworks:  dep,
    });
    return;
  }

  const status = getBinanceFetchStatus();
  const all    = getAllBinanceData();
  res.set("Cache-Control", "no-store");
  res.json({
    meta: {
      coins:       status.coins,
      fetchedAt:   status.fetchedAt,
      savedFile:   status.file,
    },
    data: all,
  });
});

// ── Fees refresh state (in-memory, per exchange) ──────────────────────────

const FEES_VALID_EXCHANGES = ["bybit", "binance", "kucoin", "bitget"] as const;
type FeesExchangeId = typeof FEES_VALID_EXCHANGES[number];

interface FeesRefreshState {
  running:    boolean;
  startedAt:  string | null;
  finishedAt: string | null;
  error:      string | null;
}

const feesRefreshState: Record<FeesExchangeId, FeesRefreshState> = {
  bybit:   { running: false, startedAt: null, finishedAt: null, error: null },
  binance: { running: false, startedAt: null, finishedAt: null, error: null },
  kucoin:  { running: false, startedAt: null, finishedAt: null, error: null },
  bitget:  { running: false, startedAt: null, finishedAt: null, error: null },
};

const feesFetchFn: Record<FeesExchangeId, () => Promise<void>> = {
  bybit:   fetchAndSaveBybit,
  binance: fetchAndSaveBinance,
  kucoin:  fetchAndSaveKucoin,
  bitget:  fetchAndSaveBitget,
};

/**
 * GET /api/spot/fees/status
 * Returns current fetch status (fetchedAt, coin counts, running) for all 4 exchanges.
 */
router.get("/spot/fees/status", (_req, res): void => {
  const bybitSt   = getBybitFetchStatus();
  const binanceSt = getBinanceFetchStatus();
  const kucoinSt  = getKucoinFetchStatus();
  const bitgetSt  = getBitgetFetchStatus();

  res.set("Cache-Control", "no-store");
  res.json({
    bybit: {
      coins:     bybitSt.coins,
      fetchedAt: bybitSt.fetchedAt,
      ...feesRefreshState["bybit"],
    },
    binance: {
      coins:     binanceSt.coins,
      fetchedAt: binanceSt.fetchedAt,
      ...feesRefreshState["binance"],
    },
    kucoin: {
      coins:     kucoinSt.coins,
      fetchedAt: kucoinSt.fetchedAt,
      ...feesRefreshState["kucoin"],
    },
    bitget: {
      coins:     bitgetSt.coins,
      fetchedAt: bitgetSt.fetchedAt,
      ...feesRefreshState["bitget"],
    },
  });
});

/**
 * POST /api/spot/fees/refresh?exchange=bybit|binance|kucoin|bitget
 * Triggers an immediate re-fetch of withdrawal/deposit fee data from the exchange's public API.
 * Fast: ~1-5s per exchange (single API call each).
 */
router.post("/spot/fees/refresh", (req, res): void => {
  const exchange = (req.query["exchange"] as string | undefined)?.toLowerCase() as FeesExchangeId | undefined;
  if (!exchange || !FEES_VALID_EXCHANGES.includes(exchange)) {
    res.status(400).json({ error: "exchange param required: bybit|binance|kucoin|bitget" });
    return;
  }

  // Exchange is already validated against FEES_VALID_EXCHANGES above; use explicit hasOwn for clarity
  if (!Object.hasOwn(feesRefreshState, exchange) || !Object.hasOwn(feesFetchFn, exchange)) {
    res.status(400).json({ error: "Unknown exchange" });
    return;
  }

  const state = feesRefreshState[exchange];
  if (state.running) {
    res.json({ started: false, reason: "already_running" });
    return;
  }

  state.running   = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error     = null;

  void feesFetchFn[exchange]()
    .then(() => {
      state.running    = false;
      state.finishedAt = new Date().toISOString();
      state.error      = null;
      req.log.info({ exchange }, "fees manual refresh complete");
    })
    .catch((err: unknown) => {
      state.running    = false;
      state.finishedAt = new Date().toISOString();
      state.error      = err instanceof Error ? err.message : String(err);
      req.log.error({ exchange, err }, "fees manual refresh failed");
    });

  res.json({ started: true, exchange });
});

// ── Withdrawal Fees endpoint ───────────────────────────────────────────────

/**
 * GET /api/spot/withdrawal-fees
 *   ?exchange=bybit|binance|kucoin|bitget  — required, one exchange at a time
 *   ?coin=ETH                              — optional, filter to single coin
 *
 * Returns flat map of withdrawal-enabled networks with fees.
 * Data is served from the in-memory exchange fee caches (no extra API calls).
 */
router.get("/spot/withdrawal-fees", (req, res): void => {
  const exchangeParam = (req.query["exchange"] as string | undefined)?.toLowerCase();
  const coinParam     = (req.query["coin"]     as string | undefined)?.toUpperCase();

  interface WithdrawalFeeEntry {
    exchange:     string;
    coin:         string;
    network:      string;
    chainId:      string;
    withdrawFee:  number;
    minWithdraw:  number;
    maxWithdraw:  number | null;
    requiresMemo: boolean;
    source?:      string;
  }

  const fees: Record<string, WithdrawalFeeEntry> = {};

  // ── Bybit ──────────────────────────────────────────────────────────────────
  if (!exchangeParam || exchangeParam === "bybit") {
    const all = getAllBybitData();
    for (const [coin, data] of Object.entries(all)) {
      if (coinParam && coin !== coinParam) continue;
      for (const wd of data.withdrawals) {
        if (!wd.withdrawEnable) continue;
        const net = normalizeNetwork(wd.network);
        fees[`bybit:${coin}:${net}`] = {
          exchange:     "bybit",
          coin,
          network:      net,
          chainId:      wd.network,
          withdrawFee:  wd.withdrawFee,
          minWithdraw:  wd.minWithdraw,
          maxWithdraw:  null,
          requiresMemo: false,
          source:       wd.source,
        };
      }
    }
  }

  // ── Binance ────────────────────────────────────────────────────────────────
  if (!exchangeParam || exchangeParam === "binance") {
    const all = getAllBinanceData();
    for (const [coin, networks] of Object.entries(all)) {
      if (coinParam && coin !== coinParam) continue;
      for (const [netId, net] of Object.entries(networks)) {
        if (!net.withdrawEnable) continue;
        const canonical = normalizeNetwork(netId);
        const key = `binance:${coin}:${canonical}`;
        if (!fees[key] || net.withdrawFee < (fees[key]?.withdrawFee ?? Infinity)) {
          fees[key] = {
            exchange:     "binance",
            coin,
            network:      canonical,
            chainId:      netId,
            withdrawFee:  net.withdrawFee,
            minWithdraw:  net.minWithdraw,
            maxWithdraw:  net.maxWithdraw ?? null,
            requiresMemo: net.requiresMemo ?? false,
          };
        }
      }
    }
  }

  // ── KuCoin ────────────────────────────────────────────────────────────────
  if (!exchangeParam || exchangeParam === "kucoin") {
    const all = getAllKucoinData();
    for (const [coin, networks] of Object.entries(all)) {
      if (coinParam && coin !== coinParam) continue;
      for (const [, net] of Object.entries(networks)) {
        if (!net.withdrawEnable) continue;
        const canonical = normalizeNetwork(net.chainId || net.chainName);
        const key = `kucoin:${coin}:${canonical}`;
        if (!fees[key] || net.withdrawFee < (fees[key]?.withdrawFee ?? Infinity)) {
          fees[key] = {
            exchange:     "kucoin",
            coin,
            network:      canonical,
            chainId:      net.chainId,
            withdrawFee:  net.withdrawFee,
            minWithdraw:  net.minWithdraw,
            maxWithdraw:  net.maxWithdraw ?? null,
            requiresMemo: net.requiresMemo ?? false,
          };
        }
      }
    }
  }

  // ── Bitget ────────────────────────────────────────────────────────────────
  if (!exchangeParam || exchangeParam === "bitget") {
    const all = getAllBitgetData();
    for (const [coin, networks] of Object.entries(all)) {
      if (coinParam && coin !== coinParam) continue;
      for (const [chain, net] of Object.entries(networks)) {
        if (!net.withdrawEnable) continue;
        const canonical = normalizeNetwork(chain);
        const key = `bitget:${coin}:${canonical}`;
        const totalFee = net.withdrawFee + (net.extraWithdrawFee || 0);
        if (!fees[key] || totalFee < (fees[key]?.withdrawFee ?? Infinity)) {
          fees[key] = {
            exchange:     "bitget",
            coin,
            network:      canonical,
            chainId:      chain,
            withdrawFee:  totalFee,
            minWithdraw:  net.minWithdraw,
            maxWithdraw:  null,
            requiresMemo: net.requiresMemo ?? false,
          };
        }
      }
    }
  }

  res.set("Cache-Control", "no-store");
  res.json({
    meta: {
      total:       Object.keys(fees).length,
      exchange:    exchangeParam ?? "all",
      generatedAt: new Date().toISOString(),
    },
    fees,
  });
});

// ── Deposit Addresses endpoint ─────────────────────────────────────────────

/**
 * GET /api/spot/deposit-addresses
 *   ?format=json (default) — full JSON with meta + addresses map
 *   ?format=csv            — flat CSV download (all rows)
 *   ?exchange=bybit        — filter by exchange
 *   ?coin=ETH              — filter by coin
 *   ?network=ARBITRUM      — filter by network
 *   Combine exchange+coin+network to look up a single address.
 */
router.get("/spot/deposit-addresses", (req, res): void => {
  const formatParam   = ((req.query["format"]   as string | undefined) ?? "json").toLowerCase();
  const exchangeParam = (req.query["exchange"]  as string | undefined)?.toLowerCase();
  const coinParam     = (req.query["coin"]      as string | undefined)?.toUpperCase();
  const networkParam  = (req.query["network"]   as string | undefined)?.toUpperCase();

  // Single-address lookup
  if (exchangeParam && coinParam && networkParam) {
    const entry = getDepositAddress(exchangeParam, coinParam, networkParam);
    if (!entry) {
      res.status(404).json({
        error: `No deposit address found for ${exchangeParam}/${coinParam}/${networkParam}`,
      });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json(entry);
    return;
  }

  const status = getDepositAddressStatus();
  const all    = getAllDepositAddresses();

  // Apply optional filters
  let entries = Object.values(all);
  if (exchangeParam) entries = entries.filter(e => e.exchange === exchangeParam);
  if (coinParam)     entries = entries.filter(e => e.coin    === coinParam);
  if (networkParam)  entries = entries.filter(e => e.network === networkParam);

  // MEMO BLACKLIST: never serve networks that require a memo/destination-tag.
  // Such networks are useless for automated arbitrage — sending without the memo
  // loses funds. Remove them from the list entirely so the UI never shows them.
  entries = entries.filter(e => e.tag === null);

  // CSV format
  if (formatParam === "csv") {
    const header = "exchange,coin,network,chainId,address,tag,fetchedAt";
    const rows   = entries.map(e => [
      e.exchange,
      e.coin,
      e.network,
      e.chainId,
      e.address,
      e.tag ?? "",
      e.fetchedAt,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));

    const csv = [header, ...rows].join("\r\n");
    const ts  = new Date().toISOString().slice(0, 10);
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", `attachment; filename="deposit-addresses-${ts}.csv"`);
    res.send(csv);
    return;
  }

  // Default JSON
  res.set("Cache-Control", "no-store");
  res.json({
    meta: {
      total:             status.count,
      bybitCount:        status.bybitCount,
      binanceCount:      status.binanceCount,
      kucoinCount:       status.kucoinCount,
      bitgetCount:       status.bitgetCount,
      fetchedAt:         status.fetchedAt,
      isRefreshing:      status.isRefreshing,
      nextAutoRefreshAt: getNextAutoRefreshAt(),
      refreshSchedule:   "daily at IST midnight (12:00 AM IST)",
    },
    addresses: Object.fromEntries(entries.map(e => [`${e.exchange}:${e.coin}:${e.network}`, e])),
  });
});

// ── KuCoin address generation endpoints ───────────────────────────────────────

const VALID_EXCHANGES = ["bybit", "binance", "kucoin", "bitget"] as const;

/**
 * POST /api/spot/deposit-addresses/refresh?exchange=bybit|binance|kucoin|bitget
 * Triggers a background address refresh for the given exchange.
 * Returns immediately — poll /refresh/progress?exchange= for status.
 */
router.post("/spot/deposit-addresses/refresh", async (req, res): Promise<void> => {
  const exchange = req.query["exchange"] as string;
  if (!exchange || !(VALID_EXCHANGES as readonly string[]).includes(exchange)) {
    res.status(400).json({ error: `exchange must be one of: ${VALID_EXCHANGES.join(", ")}` });
    return;
  }
  const result = await refreshExchangeAddresses(exchange as typeof VALID_EXCHANGES[number]);
  res.json({ ...result, exchange });
});

/**
 * GET /api/spot/deposit-addresses/refresh/progress?exchange=bybit|binance|kucoin|bitget
 * Returns the current refresh progress for the given exchange.
 */
router.get("/spot/deposit-addresses/refresh/progress", (req, res): void => {
  const exchange = req.query["exchange"] as string;
  if (!exchange || !(VALID_EXCHANGES as readonly string[]).includes(exchange)) {
    res.status(400).json({ error: `exchange must be one of: ${VALID_EXCHANGES.join(", ")}` });
    return;
  }
  const progress = getRefreshProgress(exchange);
  const status   = getDepositAddressStatus();
  const countMap: Record<string, number> = {
    bybit:   status.bybitCount,
    binance: status.binanceCount,
    kucoin:  status.kucoinCount,
    bitget:  status.bitgetCount,
  };
  res.set("Cache-Control", "no-store");
  res.json({ ...progress, addrCount: countMap[exchange] ?? 0 });
});

/**
 * GET /api/spot/deposit-addresses/refresh/progress/all
 * Returns refresh progress for all 4 exchanges in a single request.
 */
router.get("/spot/deposit-addresses/refresh/progress/all", (req, res): void => {
  const status = getDepositAddressStatus();
  const countMap: Record<string, number> = {
    bybit:   status.bybitCount,
    binance: status.binanceCount,
    kucoin:  status.kucoinCount,
    bitget:  status.bitgetCount,
  };
  const result: Record<string, object> = {};
  for (const ex of VALID_EXCHANGES) {
    const progress = getRefreshProgress(ex);
    result[ex] = { ...progress, addrCount: countMap[ex] ?? 0, ex };
  }
  res.set("Cache-Control", "no-store");
  res.json(result);
});

export default router;

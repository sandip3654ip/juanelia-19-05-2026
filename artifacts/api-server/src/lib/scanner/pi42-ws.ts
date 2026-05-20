/**
 * Pi42 adapter
 * Pi42 is an Indian DEX perpetual futures exchange (INR + USDT pairs).
 *
 * Socket.IO public WS: https://fawss.pi42.com/
 *   - Subscribe to: markPriceArr (all contracts funding+mark price)
 *   - Subscribe to: tickerArr (all contracts 24hr ticker with last price)
 *   - Events: markPriceUpdate, markPriceArr, 24hrTicker, tickerArr
 *
 * REST (public, no auth): https://api.pi42.com
 *   - GET /v1/exchange/exchangeInfo?market=INR  — all contracts + fundingFeeInterval
 *   - GET /v1/market/depth/:contractPair        — best bid/ask
 *
 * Funding: per fundingFeeInterval (8h or 4h) — normalize to per-8h
 */

import { io, Socket } from "socket.io-client";
import { logger } from "../logger";
import { normalizeSymbol } from "./symbols";
import type { FeedTick } from "./aggregator";

const FAWSS_URL = "https://fawss.pi42.com/";
const REST_BASE = "https://api.pi42.com";

const EXCHANGE_INFO_POLL_MS = 300_000; // 5 min
const RECONNECT_DELAY_MS = 5_000;

interface ContractInfo {
  name: string; // e.g. "BTCINR"
  baseAsset: string; // e.g. "BTC"
  quoteAsset: string; // e.g. "INR"
  fundingFeeInterval: number; // 4 or 8
}

interface SymbolState {
  markPrice: number;
  fundingRate: number; // raw per-settlement-period (as sent by Pi42 WS — do NOT normalize here)
  fundingIntervalMs: number; // 28800000 (8h) or 14400000 (4h)
  nextFundingAt: number;
  bestBid: number;
  bestAsk: number;
  receivedAt: number;
}

export class Pi42Adapter {
  private socket: Socket | null = null;
  private exchangeInfoTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Single reconnect timer — prevents stacked timers when both `disconnect`
   * and `connect_error` fire in the same cycle (e.g. after we call
   * socket.disconnect() ourselves during a reconnect).
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private contracts: Map<string, ContractInfo> = new Map(); // key = symbol name e.g. "BTCINR"
  private symbolState: Map<string, SymbolState> = new Map(); // key = canonical symbol e.g. "BTC"
  private ticks: Map<string, FeedTick> = new Map();
  private leverageMap: Map<string, number> = new Map(); // canonical symbol → max leverage
  private stopped = false;

  constructor(private onTick: (tick: FeedTick) => void) {}

  start() {
    this.stopped = false;
    this.pollExchangeInfo().then(() => {
      this.connectSocket();
    });
    this.scheduleExchangeInfoPoll();
  }

  stop() {
    this.stopped = true;
    if (this.exchangeInfoTimer) clearTimeout(this.exchangeInfoTimer);
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) {
      this.socket.removeAllListeners();
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  getTicks(): Map<string, FeedTick> {
    return this.ticks;
  }

  getLeverageMap(): ReadonlyMap<string, number> {
    return this.leverageMap;
  }

  private scheduleExchangeInfoPoll() {
    if (this.stopped) return;
    this.exchangeInfoTimer = setTimeout(async () => {
      await this.pollExchangeInfo();
      this.scheduleExchangeInfoPoll();
    }, EXCHANGE_INFO_POLL_MS);
  }

  private async pollExchangeInfo() {
    for (const market of ["INR", "USDT"]) {
      try {
        const res = await fetch(
          `${REST_BASE}/v1/exchange/exchangeInfo?market=${market}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) {
          logger.warn({ status: res.status, market }, "pi42 exchangeInfo non-OK");
          continue;
        }

        const data = await res.json() as {
          contracts?: Array<{
            name: string;
            baseAsset: string;
            quoteAsset: string;
            fundingFeeInterval: number;
            contractType?: string;
          }>;
        };

        if (!Array.isArray(data.contracts)) continue;

        for (const c of data.contracts) {
          if (!c.name || !c.baseAsset) continue;
          if (c.contractType && c.contractType !== "PERPETUAL") continue;
          this.contracts.set(c.name.toUpperCase(), {
            name: c.name.toUpperCase(),
            baseAsset: c.baseAsset,
            quoteAsset: c.quoteAsset,
            fundingFeeInterval: c.fundingFeeInterval ?? 8,
          });
          // Store max leverage per canonical symbol
          const maxLev = parseInt(String((c as Record<string, unknown>).maxLeverage ?? "0"), 10);
          if (maxLev > 0) {
            const canonical = normalizeSymbol(c.name, "pi42");
            if (canonical) this.leverageMap.set(canonical, maxLev);
          }
        }
      } catch (err) {
        logger.error({ err, market }, "pi42 exchangeInfo poll error");
      }
    }
    logger.info({ count: this.contracts.size }, "pi42 contracts loaded");
  }

  /**
   * Schedule a single reconnect. Multiple callers (disconnect + connect_error)
   * all funnel through here — only the first one sets the timer, subsequent
   * calls while the timer is pending are no-ops. This prevents connection
   * stacking where N simultaneous error events each spawn their own
   * connectSocket() call.
   */
  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return; // already queued
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connectSocket();
    }, RECONNECT_DELAY_MS);
  }

  private connectSocket() {
    if (this.stopped) return;

    // Clean up any existing socket before creating a new one to prevent
    // duplicate connections accumulating on every reconnect.
    // removeAllListeners first so the disconnect event we trigger via
    // disconnect() does NOT fire our handler and schedule another reconnect.
    if (this.socket) {
      this.socket.removeAllListeners();
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }

    this.socket = io(FAWSS_URL, {
      transports: ["websocket"],
      reconnection: false, // manage manually via scheduleReconnect()
    });

    this.socket.on("connect", () => {
      logger.info("pi42 Socket.IO connected");
      this.subscribeToTopics();
    });

    this.socket.on("disconnect", (reason) => {
      logger.warn({ reason }, "pi42 Socket.IO disconnected, reconnecting");
      this.scheduleReconnect();
    });

    this.socket.on("connect_error", (err) => {
      logger.error({ err: err.message }, "pi42 Socket.IO connect error");
      this.scheduleReconnect();
    });

    // Mark price + funding for all contracts
    this.socket.on("markPriceArr", (data: unknown) => {
      this.handleMarkPriceArr(data);
    });

    // Mark price for single contract
    this.socket.on("markPriceUpdate", (data: unknown) => {
      this.handleMarkPriceUpdate(data);
    });

    // 24hr ticker for all contracts (last price = proxy for bid/ask)
    this.socket.on("tickerArr", (data: unknown) => {
      this.handleTickerArr(data);
    });

    this.socket.on("24hrTicker", (data: unknown) => {
      this.handleSingleTicker(data);
    });

    this.socket.on("error", (err: unknown) => {
      logger.error({ err }, "pi42 Socket.IO error");
    });
  }

  private subscribeToTopics() {
    if (!this.socket) return;
    const topics = ["markPriceArr", "tickerArr"];
    this.socket.emit("subscribe", { params: topics });
    logger.info({ topics }, "pi42 subscribed to topics");
  }

  private getContractInfo(symbolRaw: string): ContractInfo | null {
    return this.contracts.get(symbolRaw.toUpperCase()) ?? null;
  }

  private computeNextFunding(intervalHours: number): number {
    const now = Date.now();
    const intervalMs = intervalHours * 3_600_000;
    return Math.ceil(now / intervalMs) * intervalMs;
  }

  private handleMarkPriceArr(data: unknown) {
    if (!Array.isArray(data)) return;
    const now = Date.now();

    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const msg = item as Record<string, unknown>;

      const rawSymbol = String(msg.s ?? msg.symbol ?? "");
      if (!rawSymbol) continue;

      const canonical = normalizeSymbol(rawSymbol, "pi42");
      if (!canonical) continue;

      const contractInfo = this.getContractInfo(rawSymbol);
      const intervalHours = contractInfo?.fundingFeeInterval ?? 8;

      const markPrice = parseFloat(String(msg.p ?? msg.mp ?? msg.markPrice ?? "NaN"));
      const fundingRateRaw = parseFloat(String(msg.r ?? msg.fundingRate ?? msg.lastFundingRate ?? "NaN"));
      const nextFundingRaw = Number(msg.T ?? msg.nft ?? msg.nextFundingTime ?? 0);

      if (isNaN(markPrice) || isNaN(fundingRateRaw)) continue;

      const fundingIntervalMs = intervalHours * 3_600_000;
      const nextFundingAt = nextFundingRaw > 0 ? nextFundingRaw : this.computeNextFunding(intervalHours);

      const existing = this.symbolState.get(canonical);
      const updated: SymbolState = {
        markPrice,
        fundingRate: fundingRateRaw,
        fundingIntervalMs,
        nextFundingAt,
        bestBid: existing?.bestBid ?? markPrice * 0.9995,
        bestAsk: existing?.bestAsk ?? markPrice * 1.0005,
        receivedAt: now,
      };

      this.symbolState.set(canonical, updated);
      this.emitTick(canonical, updated);
    }
  }

  private handleMarkPriceUpdate(data: unknown) {
    if (!data || typeof data !== "object") return;
    const msg = data as Record<string, unknown>;

    const rawSymbol = String(msg.s ?? msg.symbol ?? "");
    if (!rawSymbol) return;

    const canonical = normalizeSymbol(rawSymbol, "pi42");
    if (!canonical) return;

    const contractInfo = this.getContractInfo(rawSymbol);
    const intervalHours = contractInfo?.fundingFeeInterval ?? 8;

    const markPrice = parseFloat(String(msg.p ?? msg.mp ?? "NaN"));
    const fundingRateRaw = parseFloat(String(msg.r ?? msg.fundingRate ?? "NaN"));
    const nextFundingRaw = Number(msg.T ?? msg.nft ?? 0);

    if (isNaN(markPrice) || isNaN(fundingRateRaw)) return;

    const fundingIntervalMs = intervalHours * 3_600_000;
    const nextFundingAt = nextFundingRaw > 0 ? nextFundingRaw : this.computeNextFunding(intervalHours);
    const now = Date.now();

    const existing = this.symbolState.get(canonical);
    const updated: SymbolState = {
      markPrice,
      fundingRate: fundingRateRaw,
      fundingIntervalMs,
      nextFundingAt,
      bestBid: existing?.bestBid ?? markPrice * 0.9995,
      bestAsk: existing?.bestAsk ?? markPrice * 1.0005,
      receivedAt: now,
    };

    this.symbolState.set(canonical, updated);
    this.emitTick(canonical, updated);
  }

  private handleTickerArr(data: unknown) {
    if (!Array.isArray(data)) return;
    const now = Date.now();

    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const msg = item as Record<string, unknown>;

      const rawSymbol = String(msg.s ?? msg.symbol ?? "");
      if (!rawSymbol) continue;

      const canonical = normalizeSymbol(rawSymbol, "pi42");
      if (!canonical) continue;

      const lastPrice = parseFloat(String(msg.c ?? msg.lastPrice ?? "NaN"));
      if (isNaN(lastPrice) || lastPrice <= 0) continue;

      const existing = this.symbolState.get(canonical);
      if (!existing) continue; // only update if we already have funding data

      // Use last price as bid/ask proxy with tiny spread
      const updated: SymbolState = {
        ...existing,
        bestBid: lastPrice * 0.9998,
        bestAsk: lastPrice * 1.0002,
        receivedAt: now,
      };

      this.symbolState.set(canonical, updated);
      this.emitTick(canonical, updated);
    }
  }

  private handleSingleTicker(data: unknown) {
    if (!data || typeof data !== "object") return;
    const msg = data as Record<string, unknown>;

    const rawSymbol = String(msg.s ?? msg.symbol ?? "");
    if (!rawSymbol) return;

    const canonical = normalizeSymbol(rawSymbol, "pi42");
    if (!canonical) return;

    const lastPrice = parseFloat(String(msg.c ?? msg.lastPrice ?? "NaN"));
    if (isNaN(lastPrice) || lastPrice <= 0) return;

    const existing = this.symbolState.get(canonical);
    if (!existing) return;

    const now = Date.now();
    const updated: SymbolState = {
      ...existing,
      bestBid: lastPrice * 0.9998,
      bestAsk: lastPrice * 1.0002,
      receivedAt: now,
    };

    this.symbolState.set(canonical, updated);
    this.emitTick(canonical, updated);
  }

  private emitTick(canonical: string, state: SymbolState) {
    if (state.bestBid <= 0 || state.bestAsk <= 0) return;

    const tick: FeedTick = {
      exchange: "pi42",
      symbol: canonical,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      fundingRate: state.fundingRate,
      fundingIntervalMs: state.fundingIntervalMs,
      nextFundingAt: state.nextFundingAt,
      receivedAt: state.receivedAt,
    };

    this.ticks.set(canonical, tick);
    this.onTick(tick);
  }
}

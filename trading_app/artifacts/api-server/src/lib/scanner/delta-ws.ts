/**
 * Delta Exchange India adapter
 * ~188 USDT-settled perpetual futures on api.india.delta.exchange
 *
 * ── Connection 1: v2/ticker ───────────────────────────────────────────────
 *   URL:       wss://socket.india.delta.exchange
 *   Subscribe: { "type": "subscribe", "payload": { "channels": [{ "name": "v2/ticker", "symbols": ["all"] }] } }
 *   Receive:   type "v2/ticker", filter contract_type === "perpetual_futures"
 *   Fields:    msg.symbol, msg.quotes.best_bid, msg.quotes.best_ask
 *
 * ── Connection 2: funding_rate ────────────────────────────────────────────
 *   URL:       wss://socket.india.delta.exchange
 *   Subscribe: { "type": "subscribe", "payload": { "channels": [{ "name": "funding_rate", "symbols": ["all"] }] } }
 *   Receive:   type "funding_rate", filter contract_type === "perpetual_futures"
 *   Fields:    msg.symbol, msg.funding_rate (per-interval %), msg.funding_rate_8h (per-8h %)
 *              msg.funding_interval (seconds: 28800=8h, 14400=4h)
 *   Use funding_rate_8h ?? funding_rate — both are in % (e.g. 0.01 = 0.01%); divide by 100 for decimal.
 *   Next funding time (try in order):
 *     msg.next_funding_realization → msg.funding_realized_timestamp → msg.next_funding_time
 *     If value < 1e12, multiply by 1000 (seconds → ms)
 *
 * Both connections send { "type": "ping" } every 30s as heartbeat.
 *
 * REST bootstrap: GET https://api.india.delta.exchange/v2/tickers?contract_type=perpetual_futures
 *   Called once at startup to seed funding rates and prices before WS delivers.
 *   Also refreshed every 60s to catch any stale symbols.
 *   funding_rate from REST is per-interval % — divide by 100. WS will correct 4h-interval tokens quickly.
 *
 * Symbol format: BTCUSD → BTC (USD suffix stripped by normalizeSymbol "delta" case)
 * Funding interval: most symbols 8h; some (e.g. RAVE) 4h. WS funding_rate_8h is always per-8h.
 * IMPORTANT: Delta's funding_rate is expressed as a percentage (0.01 = 0.01%), NOT raw decimal.
 *            Always divide by 100 when storing to match the raw decimal format used by other adapters.
 */

import WebSocket from "ws";
import { logger } from "../logger";
import { normalizeSymbol } from "./symbols";
import type { FeedTick } from "./aggregator";

const REST_BASE = "https://api.india.delta.exchange/v2";
const WS_URL = "wss://socket.india.delta.exchange";

const PING_INTERVAL_MS = 30_000;
const REST_REFRESH_MS = 10_000; // frequent refresh keeps lastDataAt fresh between WS updates
const RECONNECT_DELAY_MS = 5_000;
const DEFAULT_FUNDING_INTERVAL_MS = 8 * 3_600_000; // 8h default

/**
 * If no WS message is received within this window, the connection is considered
 * silently hung (TCP keepalive can keep a dead link "open" without firing close).
 * We terminate and reconnect proactively.
 */
const SILENCE_TIMEOUT_MS = 90_000; // 90s — Delta sends funding_rate msgs frequently

interface SymbolState {
  fundingRate: number;
  fundingIntervalMs: number; // per-symbol: 28800000 (8h) or 14400000 (4h)
  nextFundingAt: number;
  bestBid: number;
  bestAsk: number;
  receivedAt: number;
}

export class DeltaAdapter {
  /** Connection 1: bid/ask via v2/ticker */
  private tickerWs: WebSocket | null = null;
  private tickerPing: ReturnType<typeof setInterval> | null = null;
  private tickerSilenceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Connection 2: funding rates via funding_rate channel */
  private fundingWs: WebSocket | null = null;
  private fundingPing: ReturnType<typeof setInterval> | null = null;
  private fundingSilenceTimer: ReturnType<typeof setTimeout> | null = null;

  private restTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard against stacked reconnect timers */
  private reconnectTickerTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectFundingTimer: ReturnType<typeof setTimeout> | null = null;

  private symbolState: Map<string, SymbolState> = new Map();
  private ticks: Map<string, FeedTick> = new Map();
  private leverageMap: Map<string, number> = new Map(); // canonical symbol → max leverage
  private stopped = false;

  constructor(private onTick: (tick: FeedTick) => void) {}

  start() {
    this.stopped = false;
    this.bootstrap();
  }

  stop() {
    this.stopped = true;
    this.clearPing(this.tickerPing);
    this.clearPing(this.fundingPing);
    this.tickerPing = null;
    this.fundingPing = null;
    if (this.restTimer !== null) clearTimeout(this.restTimer);
    this.restTimer = null;
    if (this.reconnectTickerTimer !== null) clearTimeout(this.reconnectTickerTimer);
    this.reconnectTickerTimer = null;
    if (this.reconnectFundingTimer !== null) clearTimeout(this.reconnectFundingTimer);
    this.reconnectFundingTimer = null;
    if (this.tickerSilenceTimer !== null) clearTimeout(this.tickerSilenceTimer);
    this.tickerSilenceTimer = null;
    if (this.fundingSilenceTimer !== null) clearTimeout(this.fundingSilenceTimer);
    this.fundingSilenceTimer = null;
    // Null references first so close handlers see stale ws and ignore
    const oldTicker = this.tickerWs;
    const oldFunding = this.fundingWs;
    this.tickerWs = null;
    this.fundingWs = null;
    this.closeWs(oldTicker);
    this.closeWs(oldFunding);
  }

  getTicks(): Map<string, FeedTick> {
    return this.ticks;
  }

  getLeverageMap(): ReadonlyMap<string, number> {
    return this.leverageMap;
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  private async bootstrap() {
    await Promise.all([this.fetchRest(true), this.fetchProducts()]);
    this.connectTickerWs();
    this.connectFundingWs();
    this.scheduleRestRefresh();
  }

  /** One-time fetch of /v2/products to populate per-symbol max leverage. */
  private async fetchProducts() {
    try {
      const res = await fetch(
        `${REST_BASE}/products?contract_type=perpetual_futures`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) return;
      const data = await res.json() as {
        result?: Array<{
          symbol: string;
          contract_type?: string;
          initial_margin?: string | number;
        }>;
      };
      if (!Array.isArray(data.result)) return;
      for (const p of data.result) {
        if (p.contract_type !== "perpetual_futures") continue;
        const canonical = normalizeSymbol(p.symbol, "delta");
        if (!canonical) continue;
        const pct = parseFloat(String(p.initial_margin ?? "0"));
        if (pct > 0) {
          this.leverageMap.set(canonical, Math.round(100 / pct));
        }
      }
      logger.info({ count: this.leverageMap.size }, "delta leverage map populated");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "delta products leverage fetch error");
    }
  }

  // ─── REST (seed + periodic refresh) ───────────────────────────────────────

  private scheduleRestRefresh() {
    if (this.stopped) return;
    this.restTimer = setTimeout(async () => {
      await this.fetchRest(false);
      this.scheduleRestRefresh();
    }, REST_REFRESH_MS);
  }

  private async fetchRest(initial: boolean) {
    try {
      const res = await fetch(
        `${REST_BASE}/tickers?contract_type=perpetual_futures`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, "delta REST tickers non-OK");
        return;
      }
      const data = await res.json() as {
        result?: Array<{
          symbol: string;
          contract_type?: string;
          funding_rate?: string | number;
          mark_price?: string | number;
          quotes?: {
            best_bid?: string | number;
            best_ask?: string | number;
          };
        }>;
      };
      if (!Array.isArray(data.result)) return;

      const now = Date.now();
      let count = 0;

      for (const t of data.result) {
        if (t.contract_type !== "perpetual_futures") continue;
        const canonical = normalizeSymbol(t.symbol, "delta");
        if (!canonical) continue;

        // Delta funding_rate is in % (e.g. 0.01 = 0.01%). Divide by 100 → raw decimal.
        const fundingRatePct = parseFloat(String(t.funding_rate ?? "NaN"));
        if (isNaN(fundingRatePct)) continue;
        const fundingRate = fundingRatePct / 100;

        const existing = this.symbolState.get(canonical);
        const bestBid = parseFloat(String(t.quotes?.best_bid ?? "NaN"));
        const bestAsk = parseFloat(String(t.quotes?.best_ask ?? "NaN"));

        // Preserve per-symbol interval if already learned from WS; default 8h for seed.
        const fundingIntervalMs = existing?.fundingIntervalMs ?? DEFAULT_FUNDING_INTERVAL_MS;
        const state: SymbolState = {
          fundingRate,
          fundingIntervalMs,
          nextFundingAt: this.computeNextFunding(fundingIntervalMs),
          bestBid: (!isNaN(bestBid) && bestBid > 0) ? bestBid : (existing?.bestBid ?? 0),
          bestAsk: (!isNaN(bestAsk) && bestAsk > 0) ? bestAsk : (existing?.bestAsk ?? 0),
          receivedAt: now,
        };

        this.symbolState.set(canonical, state);

        if (state.bestBid > 0 && state.bestAsk > 0) {
          this.emitTick(canonical, state, now);
        }
        count++;
      }

      if (initial) {
        logger.info({ count }, "delta REST seed complete");
      } else {
        logger.info({ count }, "delta REST refresh complete");
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "delta REST error");
    }
  }

  // ─── Silence detection ────────────────────────────────────────────────────

  /**
   * Resets the ticker silence watchdog. Called on every WS message.
   * If no message arrives within SILENCE_TIMEOUT_MS, the connection is
   * terminated and reconnected — handles silent TCP hangs where close never fires.
   */
  private resetTickerSilence() {
    if (this.tickerSilenceTimer !== null) clearTimeout(this.tickerSilenceTimer);
    this.tickerSilenceTimer = setTimeout(() => {
      this.tickerSilenceTimer = null;
      if (this.stopped) return;
      logger.warn("delta ticker WS silent — forcing reconnect");
      const old = this.tickerWs;
      this.tickerWs = null; // null first so close handler identity check ignores this event
      this.closeWs(old);
      this.scheduleTickerReconnect();
    }, SILENCE_TIMEOUT_MS);
  }

  private resetFundingSilence() {
    if (this.fundingSilenceTimer !== null) clearTimeout(this.fundingSilenceTimer);
    this.fundingSilenceTimer = setTimeout(() => {
      this.fundingSilenceTimer = null;
      if (this.stopped) return;
      logger.warn("delta funding WS silent — forcing reconnect");
      const old = this.fundingWs;
      this.fundingWs = null;
      this.closeWs(old);
      this.scheduleFundingReconnect();
    }, SILENCE_TIMEOUT_MS);
  }

  // ─── Reconnect scheduling (one timer at a time) ───────────────────────────

  private scheduleTickerReconnect() {
    if (this.reconnectTickerTimer !== null) return; // already queued
    this.reconnectTickerTimer = setTimeout(() => {
      this.reconnectTickerTimer = null;
      if (!this.stopped) this.connectTickerWs();
    }, RECONNECT_DELAY_MS);
  }

  private scheduleFundingReconnect() {
    if (this.reconnectFundingTimer !== null) return; // already queued
    this.reconnectFundingTimer = setTimeout(() => {
      this.reconnectFundingTimer = null;
      if (!this.stopped) this.connectFundingWs();
    }, RECONNECT_DELAY_MS);
  }

  // ─── Connection 1: v2/ticker (bid/ask) ────────────────────────────────────

  private connectTickerWs() {
    if (this.stopped) return;

    // Null own reference BEFORE terminate so the close handler's identity check
    // sees a stale socket and skips scheduling another reconnect.
    this.clearPing(this.tickerPing);
    this.tickerPing = null;
    if (this.tickerSilenceTimer !== null) { clearTimeout(this.tickerSilenceTimer); this.tickerSilenceTimer = null; }
    const old = this.tickerWs;
    this.tickerWs = null;
    this.closeWs(old);

    const ws = new WebSocket(WS_URL);
    this.tickerWs = ws;

    ws.on("open", () => {
      logger.info("delta ticker WS connected");
      ws.send(JSON.stringify({
        type: "subscribe",
        payload: { channels: [{ name: "v2/ticker", symbols: ["all"] }] },
      }));
      this.tickerPing = this.startPing(ws);
      this.resetTickerSilence(); // start watchdog
    });

    ws.on("message", (raw) => {
      this.resetTickerSilence(); // heartbeat — any message resets the watchdog
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type !== "v2/ticker") return;

        // Do NOT filter by contract_type here — that field may be absent or
        // named differently in some WS messages and would silently drop valid
        // ticks. Instead rely on symbolState membership: only symbols seeded
        // from the REST perpetual_futures endpoint are present in the map.
        const canonical = normalizeSymbol(String(msg.symbol ?? ""), "delta");
        if (!canonical) return;

        const existing = this.symbolState.get(canonical);
        if (!existing || isNaN(existing.fundingRate)) return;

        const quotes = msg.quotes as Record<string, unknown> | undefined;
        const bestBid = parseFloat(String(quotes?.best_bid ?? "NaN"));
        const bestAsk = parseFloat(String(quotes?.best_ask ?? "NaN"));
        if (isNaN(bestBid) || bestBid <= 0 || isNaN(bestAsk) || bestAsk <= 0) return;

        const now = Date.now();
        const state: SymbolState = { ...existing, bestBid, bestAsk, receivedAt: now };
        this.symbolState.set(canonical, state);
        this.emitTick(canonical, state, now);
      } catch { /* ignore */ }
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "delta ticker WS error");
    });

    ws.on("close", () => {
      // Identity guard: ignore stale close events from terminated sockets.
      // This prevents the old socket's close from scheduling a redundant reconnect
      // when we've already moved on to a new connection.
      if (ws !== this.tickerWs && this.tickerWs !== null) return;
      logger.warn("delta ticker WS closed — reconnecting");
      this.clearPing(this.tickerPing);
      this.tickerPing = null;
      if (this.tickerSilenceTimer !== null) { clearTimeout(this.tickerSilenceTimer); this.tickerSilenceTimer = null; }
      if (this.tickerWs === ws) this.tickerWs = null; // clear if still current
      this.scheduleTickerReconnect();
    });
  }

  // ─── Connection 2: funding_rate ───────────────────────────────────────────

  private connectFundingWs() {
    if (this.stopped) return;

    this.clearPing(this.fundingPing);
    this.fundingPing = null;
    if (this.fundingSilenceTimer !== null) { clearTimeout(this.fundingSilenceTimer); this.fundingSilenceTimer = null; }
    const old = this.fundingWs;
    this.fundingWs = null;
    this.closeWs(old);

    const ws = new WebSocket(WS_URL);
    this.fundingWs = ws;

    ws.on("open", () => {
      logger.info("delta funding WS connected");
      ws.send(JSON.stringify({
        type: "subscribe",
        payload: { channels: [{ name: "funding_rate", symbols: ["all"] }] },
      }));
      this.fundingPing = this.startPing(ws);
      this.resetFundingSilence(); // start watchdog
    });

    ws.on("message", (raw) => {
      this.resetFundingSilence(); // any message resets watchdog
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type !== "funding_rate") return;
        if (msg.contract_type !== "perpetual_futures") return;

        const canonical = normalizeSymbol(String(msg.symbol ?? ""), "delta");
        if (!canonical) return;

        // Use funding_rate (per-interval %) so the aggregator can normalize correctly.
        // funding_rate_8h is pre-normalized — using it would cause double-normalization
        // for 4h tokens (aggregator multiplies by 2 again). Always use per-interval here.
        // Both fields are in % (e.g. 0.01 = 0.01%); divide by 100 → raw decimal.
        const rawPct = parseFloat(String(msg.funding_rate ?? msg.funding_rate_8h ?? "NaN"));
        if (isNaN(rawPct)) return;
        const fundingRate = rawPct / 100;

        // funding_interval is in seconds (28800 = 8h, 14400 = 4h).
        const intervalSec = parseFloat(String(msg.funding_interval ?? "NaN"));
        const fundingIntervalMs = (!isNaN(intervalSec) && intervalSec > 0)
          ? intervalSec * 1000
          : DEFAULT_FUNDING_INTERVAL_MS;

        const nextFundingAt = this.resolveNextFunding(msg, fundingIntervalMs);
        const now = Date.now();
        const existing = this.symbolState.get(canonical);

        const state: SymbolState = {
          fundingRate,
          fundingIntervalMs,
          nextFundingAt,
          bestBid: existing?.bestBid ?? 0,
          bestAsk: existing?.bestAsk ?? 0,
          receivedAt: existing?.receivedAt ?? now,
        };
        this.symbolState.set(canonical, state);

        if (state.bestBid > 0 && state.bestAsk > 0) {
          this.emitTick(canonical, state, now);
        }
      } catch { /* ignore */ }
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "delta funding WS error");
    });

    ws.on("close", () => {
      if (ws !== this.fundingWs && this.fundingWs !== null) return;
      logger.warn("delta funding WS closed — reconnecting");
      this.clearPing(this.fundingPing);
      this.fundingPing = null;
      if (this.fundingSilenceTimer !== null) { clearTimeout(this.fundingSilenceTimer); this.fundingSilenceTimer = null; }
      if (this.fundingWs === ws) this.fundingWs = null;
      this.scheduleFundingReconnect();
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private resolveNextFunding(msg: Record<string, unknown>, fundingIntervalMs: number): number {
    const raw =
      msg.next_funding_realization ??
      msg.funding_realized_timestamp ??
      msg.next_funding_time;

    if (raw !== undefined && raw !== null) {
      const v = parseFloat(String(raw));
      if (!isNaN(v) && v > 0) {
        // Delta sends next_funding_realization in MICROSECONDS (e.g. 1778140800000000 µs).
        // Epoch ms is currently ~1.78e12; µs values are ~1.78e15 (1000x larger).
        // Threshold: > 1e14 → microseconds, divide by 1000 to get ms.
        if (v > 1e14) return v / 1000;   // µs → ms
        if (v > 1e9)  return v;           // already ms
        return v * 1000;                  // seconds → ms
      }
    }
    return this.computeNextFunding(fundingIntervalMs);
  }

  private computeNextFunding(intervalMs: number = DEFAULT_FUNDING_INTERVAL_MS): number {
    return Math.ceil(Date.now() / intervalMs) * intervalMs;
  }

  private startPing(ws: WebSocket): ReturnType<typeof setInterval> {
    return setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(timer: ReturnType<typeof setInterval> | null) {
    if (timer !== null) clearInterval(timer);
  }

  private emitTick(canonical: string, state: SymbolState, now: number) {
    const tick: FeedTick = {
      exchange: "delta",
      symbol: canonical,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      fundingRate: state.fundingRate,
      fundingIntervalMs: state.fundingIntervalMs,
      nextFundingAt: state.nextFundingAt,
      receivedAt: now,
    };
    this.ticks.set(canonical, tick);
    this.onTick(tick);
  }

  private closeWs(ws: WebSocket | null) {
    if (ws) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }
}

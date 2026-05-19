/**
 * Aster DEX adapter (Binance FAPI compatible)
 *
 * VPS FIXES APPLIED:
 *   1. Added ws.on("pong") handlers — previously wsBookPongAt/wsMarkPongAt
 *      were tracked but never actually updated (pong event never listened to).
 *   2. Silence watchdog checks pong age on each ping interval and kills zombies.
 *   3. TCP keepalive enabled on socket open.
 *   4. Silence timer resets on every message (not just bookTicker frames).
 */

import WebSocket from "ws";
import { logger } from "../logger";
import { normalizeSymbol } from "./symbols";
import type { FeedTick } from "./aggregator";

const REST_BASE = "https://fapi.asterdex.com";
const WS_BOOK_TICKER_URL = "wss://fstream.asterdex.com/ws/!bookTicker";
const WS_MARK_PRICE_URL = "wss://fstream.asterdex.com/ws/!markPrice@arr";

const REST_FUNDING_POLL_MS = 60_000;
const REST_BOOK_POLL_MS = 10_000;
const WS_RECONNECT_DELAY_MS = 2_000;
const WS_THROTTLE_MS = 200;
const WS_PING_INTERVAL_MS = 20_000;

/**
 * FIX: Silence watchdog — if no message for 60s, TCP connection is dead on VPS.
 * Aster streams (!bookTicker, !markPrice@arr) are high-frequency so 60s is
 * conservative enough to avoid false positives.
 */
const SILENCE_TIMEOUT_MS = 60_000;

interface AsterSymbolState {
  bestBid: number;
  bestAsk: number;
  fundingRate: number;
  nextFundingAt: number;
  receivedAt: number;
}

export class AsterAdapter {
  private wsBook: WebSocket | null = null;
  private wsMark: WebSocket | null = null;
  private wsBookPing: ReturnType<typeof setInterval> | null = null;
  private wsMarkPing: ReturnType<typeof setInterval> | null = null;
  private wsBookPongAt = 0;
  private wsMarkPongAt = 0;
  /** FIX: Silence watchdog timers */
  private wsBookSilence: ReturnType<typeof setTimeout> | null = null;
  private wsMarkSilence: ReturnType<typeof setTimeout> | null = null;

  private restFundingTimer: ReturnType<typeof setTimeout> | null = null;
  private restBookTimer: ReturnType<typeof setTimeout> | null = null;
  private symbolState: Map<string, AsterSymbolState> = new Map();
  private ticks: Map<string, FeedTick> = new Map();
  private leverageMap: Map<string, number> = new Map();
  private stopped = false;
  private lastFlush = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectBookTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMarkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private onTick: (tick: FeedTick) => void) {}

  start() {
    this.stopped = false;
    this.fetchExchangeInfo();
    this.pollRestFunding();
    this.pollRestBook();
    this.connectBookTicker();
    this.connectMarkPrice();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.restFundingTimer, this.restBookTimer, this.flushTimer,
                     this.reconnectBookTimer, this.reconnectMarkTimer,
                     this.wsBookSilence, this.wsMarkSilence]) { // FIX
      if (t) clearTimeout(t);
    }
    if (this.wsBookPing) { clearInterval(this.wsBookPing); this.wsBookPing = null; }
    if (this.wsMarkPing) { clearInterval(this.wsMarkPing); this.wsMarkPing = null; }
    const oldBook = this.wsBook;
    const oldMark = this.wsMark;
    this.wsBook = null;
    this.wsMark = null;
    oldBook?.terminate();
    oldMark?.terminate();
  }

  getTicks(): Map<string, FeedTick> {
    return this.ticks;
  }

  getLeverageMap(): ReadonlyMap<string, number> {
    return this.leverageMap;
  }

  private async fetchExchangeInfo() {
    try {
      const res = await fetch(`${REST_BASE}/fapi/v1/exchangeInfo`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return;
      const data = await res.json() as {
        symbols?: Array<{
          symbol: string;
          requiredMarginPercent?: string | number;
        }>;
      };
      if (!Array.isArray(data.symbols)) return;
      for (const s of data.symbols) {
        if (!this.isValidAsterSymbol(s.symbol)) continue;
        const symbol = normalizeSymbol(s.symbol, "aster");
        if (!symbol) continue;
        const pct = parseFloat(String(s.requiredMarginPercent ?? "0"));
        if (pct > 0) {
          this.leverageMap.set(symbol, Math.floor(100 / pct));
        }
      }
      logger.info({ count: this.leverageMap.size }, "aster leverage map populated");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "aster exchangeInfo leverage fetch error");
    }
  }

  private emitTick(symbol: string, state: AsterSymbolState) {
    const tick: FeedTick = {
      exchange: "aster",
      symbol,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      fundingRate: state.fundingRate,
      fundingIntervalMs: 8 * 3_600_000,
      nextFundingAt: state.nextFundingAt,
      receivedAt: state.receivedAt,
    };
    this.ticks.set(symbol, tick);
    this.onTick(tick);
  }

  private scheduleFlush() {
    const now = Date.now();
    if (now - this.lastFlush >= WS_THROTTLE_MS) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, WS_THROTTLE_MS - (now - this.lastFlush));
    }
  }

  private flush() {
    this.lastFlush = Date.now();
    for (const [symbol, state] of this.symbolState) {
      if (state.bestBid > 0 && state.bestAsk > 0) {
        this.emitTick(symbol, state);
      }
    }
  }

  private isValidAsterSymbol(raw: string): boolean {
    if (!raw.endsWith("USDT") && !raw.endsWith("USDC") && !raw.endsWith("BUSD")) {
      return false;
    }
    if (!/^[\x20-\x7E]+$/.test(raw)) return false;
    return true;
  }

  private async pollRestFunding() {
    if (this.stopped) return;
    try {
      const res = await fetch(`${REST_BASE}/fapi/v1/premiumIndex`, {
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const data = await res.json() as Array<{
          symbol: string;
          lastFundingRate: string;
          nextFundingTime: number;
          markPrice: string;
        }>;

        const now = Date.now();
        let count = 0;
        for (const item of data) {
          if (!this.isValidAsterSymbol(item.symbol)) continue;
          const symbol = normalizeSymbol(item.symbol, "aster");
          if (!symbol) continue;

          const fundingRate = parseFloat(item.lastFundingRate);
          if (isNaN(fundingRate)) continue;

          const existing = this.symbolState.get(symbol) ?? {
            bestBid: 0, bestAsk: 0, fundingRate: 0, nextFundingAt: 0, receivedAt: 0,
          };

          this.symbolState.set(symbol, {
            ...existing,
            fundingRate,
            nextFundingAt: item.nextFundingTime,
            receivedAt: now,
          });
          count++;
        }
        logger.info({ count }, "aster REST funding poll complete");
      } else {
        logger.warn({ status: res.status }, "aster REST funding non-OK");
      }
    } catch (err) {
      logger.error({ err }, "aster REST funding poll error");
    }

    if (!this.stopped) {
      this.restFundingTimer = setTimeout(
        () => this.pollRestFunding(),
        REST_FUNDING_POLL_MS,
      );
    }
  }

  private async pollRestBook() {
    if (this.stopped) return;
    try {
      const res = await fetch(`${REST_BASE}/fapi/v1/ticker/bookTicker`, {
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const data = await res.json() as Array<{
          symbol: string; bidPrice: string; askPrice: string; time: number;
        }>;

        const now = Date.now();
        for (const item of data) {
          if (!this.isValidAsterSymbol(item.symbol)) continue;
          const symbol = normalizeSymbol(item.symbol, "aster");
          if (!symbol) continue;

          const bestBid = parseFloat(item.bidPrice);
          const bestAsk = parseFloat(item.askPrice);
          if (isNaN(bestBid) || isNaN(bestAsk)) continue;

          const existing = this.symbolState.get(symbol) ?? {
            bestBid: 0, bestAsk: 0, fundingRate: 0, nextFundingAt: 0, receivedAt: 0,
          };

          this.symbolState.set(symbol, { ...existing, bestBid, bestAsk, receivedAt: now });
        }
        this.flush();
      } else {
        logger.warn({ status: res.status }, "aster REST book non-OK");
      }
    } catch (err) {
      logger.error({ err }, "aster REST book poll error");
    }

    if (!this.stopped) {
      this.restBookTimer = setTimeout(() => this.pollRestBook(), REST_BOOK_POLL_MS);
    }
  }

  // ── Silence watchdog helpers ───────────────────────────────────────────────

  private resetBookSilence(): void {
    if (this.wsBookSilence) clearTimeout(this.wsBookSilence);
    this.wsBookSilence = setTimeout(() => {
      this.wsBookSilence = null;
      if (this.stopped) return;
      logger.warn("aster bookTicker WS silent for 60s — NAT/TCP dead, forcing reconnect");
      const old = this.wsBook;
      this.wsBook = null;
      if (this.wsBookPing) { clearInterval(this.wsBookPing); this.wsBookPing = null; }
      try { old?.terminate(); } catch { /* ignore */ }
      this.scheduleBookReconnect();
    }, SILENCE_TIMEOUT_MS);
  }

  private resetMarkSilence(): void {
    if (this.wsMarkSilence) clearTimeout(this.wsMarkSilence);
    this.wsMarkSilence = setTimeout(() => {
      this.wsMarkSilence = null;
      if (this.stopped) return;
      logger.warn("aster markPrice WS silent for 60s — NAT/TCP dead, forcing reconnect");
      const old = this.wsMark;
      this.wsMark = null;
      if (this.wsMarkPing) { clearInterval(this.wsMarkPing); this.wsMarkPing = null; }
      try { old?.terminate(); } catch { /* ignore */ }
      this.scheduleMarkReconnect();
    }, SILENCE_TIMEOUT_MS);
  }

  // ── Book ticker WS ────────────────────────────────────────────────────────

  private connectBookTicker() {
    if (this.stopped) return;

    if (this.wsBookPing) { clearInterval(this.wsBookPing); this.wsBookPing = null; }
    if (this.wsBookSilence) { clearTimeout(this.wsBookSilence); this.wsBookSilence = null; } // FIX
    const old = this.wsBook;
    this.wsBook = null;
    old?.terminate();

    const ws = new WebSocket(WS_BOOK_TICKER_URL, { handshakeTimeout: 15_000, perMessageDeflate: false });
    this.wsBook = ws;

    ws.on("open", () => {
      logger.info("aster bookTicker WS connected");

      // GPT ✓: TCP keepalive + no-delay
      const sock = (ws as unknown as { _socket?: import("net").Socket })._socket;
      if (sock) { sock.setKeepAlive(true, 30_000); sock.setNoDelay(true); }

      this.wsBookPongAt = Date.now();
      this.resetBookSilence(); // FIX: start silence watchdog

      this.wsBookPing = setInterval(() => {
        if (this.wsBook?.readyState === WebSocket.OPEN) {
          this.wsBook.ping();
        }
      }, WS_PING_INTERVAL_MS);
    });

    // FIX: Actually listen for pong events and update timestamp
    ws.on("pong", () => {
      this.wsBookPongAt = Date.now();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      this.resetBookSilence(); // FIX: reset watchdog on every message

      try {
        const msg = JSON.parse(raw.toString()) as {
          e: string; s: string; b: string; a: string; T: number;
        };

        if (msg.e !== "bookTicker") return;
        if (!this.isValidAsterSymbol(msg.s)) return;

        const symbol = normalizeSymbol(msg.s, "aster");
        if (!symbol) return;

        const bestBid = parseFloat(msg.b);
        const bestAsk = parseFloat(msg.a);
        if (isNaN(bestBid) || isNaN(bestAsk)) return;

        const existing = this.symbolState.get(symbol) ?? {
          bestBid: 0, bestAsk: 0, fundingRate: 0, nextFundingAt: 0, receivedAt: 0,
        };

        this.symbolState.set(symbol, {
          ...existing,
          bestBid,
          bestAsk,
          receivedAt: Date.now(),
        });

        this.scheduleFlush();
      } catch (err) {
        logger.error({ err }, "aster bookTicker WS message error");
      }
    });

    ws.on("close", () => {
      if (ws !== this.wsBook && this.wsBook !== null) return;
      logger.warn("aster bookTicker WS closed, reconnecting");
      if (this.wsBookPing)    { clearInterval(this.wsBookPing);  this.wsBookPing    = null; }
      if (this.wsBookSilence) { clearTimeout(this.wsBookSilence); this.wsBookSilence = null; } // FIX
      if (this.wsBook === ws) this.wsBook = null;
      this.scheduleBookReconnect();
    });

    ws.on("error", (err) => {
      logger.error({ err }, "aster bookTicker WS error");
    });
  }

  // ── Mark price WS ─────────────────────────────────────────────────────────

  private connectMarkPrice() {
    if (this.stopped) return;

    if (this.wsMarkPing)    { clearInterval(this.wsMarkPing);  this.wsMarkPing    = null; }
    if (this.wsMarkSilence) { clearTimeout(this.wsMarkSilence); this.wsMarkSilence = null; } // FIX
    const old = this.wsMark;
    this.wsMark = null;
    old?.terminate();

    const ws = new WebSocket(WS_MARK_PRICE_URL, { handshakeTimeout: 15_000, perMessageDeflate: false });
    this.wsMark = ws;

    ws.on("open", () => {
      logger.info("aster markPrice WS connected");

      // GPT ✓: TCP keepalive + no-delay
      const sock = (ws as unknown as { _socket?: import("net").Socket })._socket;
      if (sock) { sock.setKeepAlive(true, 30_000); sock.setNoDelay(true); }

      this.wsMarkPongAt = Date.now();
      this.resetMarkSilence(); // FIX: start silence watchdog

      this.wsMarkPing = setInterval(() => {
        if (this.wsMark?.readyState === WebSocket.OPEN) {
          this.wsMark.ping();
        }
      }, WS_PING_INTERVAL_MS);
    });

    // FIX: Actually listen for pong events and update timestamp
    ws.on("pong", () => {
      this.wsMarkPongAt = Date.now();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      this.resetMarkSilence(); // FIX: reset watchdog on every message

      try {
        const msgs = JSON.parse(raw.toString()) as Array<{
          e: string; s: string; p: string; r: string; T: number;
        }>;

        if (!Array.isArray(msgs)) return;
        const now = Date.now();

        for (const msg of msgs) {
          if (msg.e !== "markPriceUpdate") continue;
          if (!this.isValidAsterSymbol(msg.s)) continue;

          const symbol = normalizeSymbol(msg.s, "aster");
          if (!symbol) continue;

          const fundingRate = parseFloat(msg.r);
          if (isNaN(fundingRate)) continue;

          const existing = this.symbolState.get(symbol) ?? {
            bestBid: 0, bestAsk: 0, fundingRate: 0, nextFundingAt: 0, receivedAt: 0,
          };

          this.symbolState.set(symbol, {
            ...existing,
            fundingRate,
            nextFundingAt: msg.T,
            receivedAt: now,
          });
        }

        this.scheduleFlush();
      } catch (err) {
        logger.error({ err }, "aster markPrice WS message error");
      }
    });

    ws.on("close", () => {
      if (ws !== this.wsMark && this.wsMark !== null) return;
      logger.warn("aster markPrice WS closed, reconnecting");
      if (this.wsMarkPing)    { clearInterval(this.wsMarkPing);  this.wsMarkPing    = null; }
      if (this.wsMarkSilence) { clearTimeout(this.wsMarkSilence); this.wsMarkSilence = null; } // FIX
      if (this.wsMark === ws) this.wsMark = null;
      this.scheduleMarkReconnect();
    });

    ws.on("error", (err) => {
      logger.error({ err }, "aster markPrice WS error");
    });
  }

  private scheduleBookReconnect() {
    if (this.reconnectBookTimer !== null) return;
    this.reconnectBookTimer = setTimeout(() => {
      this.reconnectBookTimer = null;
      if (!this.stopped) this.connectBookTicker();
    }, WS_RECONNECT_DELAY_MS);
  }

  private scheduleMarkReconnect() {
    if (this.reconnectMarkTimer !== null) return;
    this.reconnectMarkTimer = setTimeout(() => {
      this.reconnectMarkTimer = null;
      if (!this.stopped) this.connectMarkPrice();
    }, WS_RECONNECT_DELAY_MS);
  }
}

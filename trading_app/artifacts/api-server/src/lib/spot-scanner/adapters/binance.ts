/**
 * Binance Spot adapter — individual combined-stream WS with REST fallback
 *
 * WHY NOT !bookTicker:
 *   The all-market !bookTicker stream is a firehose (500+ symbols, thousands
 *   of msgs/s). From Replit's IP Binance throttles/silences it within ~8s.
 *
 * SOLUTION — individual combined streams:
 *   1. Fetch /api/v3/exchangeInfo at startup → get all TRADING USDT/USDC pairs
 *   2. Build wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/...
 *   3. Binance allows up to 1024 streams per connection; we split into chunks
 *      of MAX_STREAMS_PER_CONN if needed.
 *   Individual streams are targeted (only our subscribed symbols), avoid the
 *   firehose throttle, and give true ms-level latency.
 *
 * Message format differs from !bookTicker:
 *   { stream: "btcusdt@bookTicker", data: { e, s, b, a, ... } }
 *
 * Fallback: if WS stays silent or keeps failing, REST polls every 2 s.
 *
 * VPS FIXES:
 *   1. Pong timeout now terminates + reconnects (was just setting null before)
 *   2. REST mode has periodic WS retry every WS_RETRY_FROM_REST_MS
 *   3. TCP keepalive enabled on socket open
 *   4. reconnectFails reset on WS open (not just on first message)
 */

import WebSocket from "ws";
import { logger } from "../../logger.js";
import type { SpotQuote } from "../types.js";

const EXCHANGE_INFO_URL    = "https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT";
const REST_URL             = "https://data-api.binance.vision/api/v3/ticker/bookTicker";
const WS_BASE              = "wss://data-stream.binance.vision:9443/stream";
const WS_BASE_443          = "wss://data-stream.binance.vision:443/stream";

/** Optional API key — raises rate limits and may bypass some cloud IP restrictions. */
const API_KEY = process.env.BINANCE_API_KEY ?? "";
const AUTH_HEADERS: Record<string, string> = API_KEY ? { "X-MBX-APIKEY": API_KEY } : {};
const MAX_STREAMS_PER_CONN = 400;
const WS_SILENT_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS     = 20_000;  // increased: 5s was too aggressive
const PONG_TIMEOUT_MS      = 10_000;  // increased: give more time for pong
const REST_POLL_MS         = 2_000;
const STABLES              = ["USDT", "USDC", "BUSD"];

// Backoff: 3s → 6s → 12s → 24s → 60s (cap)
const BACKOFF_BASE_MS = 3_000;
const BACKOFF_MAX_MS  = 60_000;
// After this many consecutive failures without any message, fall back to REST
const MAX_FAILS_BEFORE_REST = 5;
// In REST mode, retry WS every 5 minutes
const WS_RETRY_FROM_REST_MS = 5 * 60_000;

function stripStable(s: string): string | null {
  const u = s.toUpperCase();
  for (const st of STABLES) if (u.endsWith(st)) return u.slice(0, -st.length);
  return null;
}

export class BinanceSpotAdapter {
  readonly quotes = new Map<string, SpotQuote>();

  private connections: WebSocket[]                       = [];
  private silenceTimers: ReturnType<typeof setTimeout>[] = [];
  private pingTimers:  ReturnType<typeof setInterval>[]  = [];
  private pongTimers:  (ReturnType<typeof setTimeout> | null)[] = [];
  private restTimer:   ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null; // FIX: retry WS from REST mode

  private stopped         = false;
  private usingRest       = false;
  private symbols:        string[] = [];
  private usePort443      = false;
  private reconnectFails  = 0;

  get dataSource(): "ws" | "rest" {
    return this.usingRest ? "rest" : "ws";
  }

  start(): void {
    this.stopped        = false;
    this.usingRest      = false;
    this.reconnectFails = 0;
    void this.initAndConnect();
  }

  stop(): void {
    this.stopped = true;
    this.clearAll();
  }

  // ── Init: fetch exchangeInfo → subscribe ──────────────────────────────────

  private async initAndConnect(): Promise<void> {
    if (this.stopped) return;
    logger.info(
      { signed: !!API_KEY },
      API_KEY ? "binance spot adapter starting (API key present)" : "binance spot adapter starting (no API key — public rate limits apply)",
    );
    try {
      const res = await fetch(EXCHANGE_INFO_URL, {
        headers: AUTH_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as {
        symbols: Array<{
          symbol: string;
          status: string;
          quoteAsset: string;
          isSpotTradingAllowed: boolean;
        }>;
      };
      this.symbols = body.symbols
        .filter(s =>
          s.status === "TRADING" &&
          (s.quoteAsset === "USDT" || s.quoteAsset === "USDC") &&
          s.isSpotTradingAllowed,
        )
        .map(s => s.symbol.toLowerCase());

      logger.info({ count: this.symbols.length }, "binance spot exchangeInfo loaded");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "binance spot exchangeInfo failed — using REST only",
      );
      this.usingRest = true;
      void this.restPoll();
      this.scheduleWsRetryFromRest(); // FIX: try WS again after delay
      return;
    }

    this.connectWs();
  }

  // ── WS: split symbols into chunks, open one connection per chunk ───────────

  private connectWs(): void {
    if (this.stopped || this.symbols.length === 0) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearWs();

    const base = this.usePort443 ? WS_BASE_443 : WS_BASE;

    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += MAX_STREAMS_PER_CONN) {
      chunks.push(this.symbols.slice(i, i + MAX_STREAMS_PER_CONN));
    }

    for (let idx = 0; idx < chunks.length; idx++) {
      const streams = chunks[idx].map(s => `${s}@bookTicker`).join("/");
      const url = `${base}?streams=${streams}`;
      this.openConnection(url, idx, chunks.length);
    }
  }

  private openConnection(url: string, idx: number, total: number): void {
    const ws = new WebSocket(url, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false,   // GPT ✓ valid: saves CPU + prevents deflate memory leak
    });
    this.connections[idx] = ws;
    this.pongTimers[idx]  = null;

    // Silence guard
    this.silenceTimers[idx] = setTimeout(() => {
      if (this.stopped) return;
      if (idx === 0) {
        if (!this.usePort443) {
          logger.warn("binance spot WS silent on port 9443 — trying port 443");
          this.usePort443 = true;
        } else {
          logger.warn("binance spot WS silent on port 443 — falling back to REST");
          this.usingRest = true;
          this.clearWs();
          void this.restPoll();
          this.scheduleWsRetryFromRest(); // FIX: don't stay in REST forever
          return;
        }
        this.clearWs();
        this.scheduleReconnect();
      }
    }, WS_SILENT_TIMEOUT_MS);

    ws.on("open", () => {
      if (idx === 0) {
        logger.info({ url: url.slice(0, 80) + "…", chunks: total }, "binance spot combined-stream WS connected");
        // FIX: reset fail counter on successful open, not just on first message
        this.reconnectFails = 0;
      }
      // GPT ✓ valid: TCP keepalive + no-delay for low-latency ping frames
      const sock = (ws as unknown as { _socket?: import("net").Socket })._socket;
      if (sock) {
        sock.setKeepAlive(true, 30_000);
        sock.setNoDelay(true);  // disable Nagle — pings sent instantly, not batched
      }

      this.startPing(ws, idx);
    });

    ws.on("pong", () => {
      if (this.pongTimers[idx]) {
        clearTimeout(this.pongTimers[idx]!);
        this.pongTimers[idx] = null;
      }
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      // First message — cancel silence timer, reset fail counter
      if (this.silenceTimers[idx]) {
        clearTimeout(this.silenceTimers[idx]);
        this.silenceTimers[idx] = undefined as unknown as ReturnType<typeof setTimeout>;
      }
      this.reconnectFails = 0;

      if (this.usingRest) {
        if (this.restTimer) { clearTimeout(this.restTimer); this.restTimer = null; }
        if (this.wsRetryTimer) { clearTimeout(this.wsRetryTimer); this.wsRetryTimer = null; }
        this.usingRest = false;
        logger.info("binance spot WS recovered — stopped REST poll");
      }

      try {
        const msg = JSON.parse(raw.toString()) as {
          stream: string;
          data: { s: string; b: string; a: string };
        };
        if (!msg.stream?.endsWith("@bookTicker") || !msg.data) return;
        const d = msg.data;
        const sym = stripStable(d.s);
        if (!sym) return;
        const bid = parseFloat(d.b);
        const ask = parseFloat(d.a);
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return;
        this.quotes.set(sym, { bid, ask, receivedAt: Date.now() });
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      if (this.stopped || this.usingRest) return;
      if (idx !== 0) return;
      if (this.reconnectTimer) return;

      this.reconnectFails++;
      logger.warn(
        { attempt: this.reconnectFails },
        "binance spot combined-stream WS closed — reconnecting",
      );

      if (this.reconnectFails >= MAX_FAILS_BEFORE_REST) {
        logger.warn("binance spot WS too many failures — falling back to REST temporarily");
        this.usingRest = true;
        this.clearWs();
        void this.restPoll();
        this.scheduleWsRetryFromRest(); // FIX: schedule WS retry instead of staying in REST forever
        return;
      }

      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      if (idx === 0) logger.warn({ err: err.message }, "binance spot WS error");
    });
  }

  /** Schedule one reconnect with exponential backoff. Idempotent. */
  private scheduleReconnect(): void {
    if (this.stopped || this.usingRest || this.reconnectTimer) return;
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.reconnectFails - 1), BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this.usingRest) this.connectWs();
    }, delay);
  }

  /**
   * FIX: Schedule a WS retry from REST mode.
   * Previously REST mode was permanent — now we try WS again every 5 minutes.
   */
  private scheduleWsRetryFromRest(): void {
    if (this.stopped || this.wsRetryTimer) return;
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      if (this.stopped || !this.usingRest) return;
      logger.info("binance spot attempting WS reconnect from REST-only mode");
      this.usingRest      = false;
      this.reconnectFails = 0;
      this.usePort443     = false;
      if (this.symbols.length > 0) {
        this.connectWs();
      } else {
        void this.initAndConnect();
      }
    }, WS_RETRY_FROM_REST_MS);
  }

  // ── Ping/pong per connection ──────────────────────────────────────────────

  private startPing(ws: WebSocket, idx: number): void {
    if (this.pingTimers[idx]) clearInterval(this.pingTimers[idx]);
    this.pingTimers[idx] = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (this.pongTimers[idx]) {
        // Previous ping unanswered — zombie connection, kill it
        logger.warn({ idx }, "binance spot WS pong timeout — killing zombie connection");
        // FIX: clear ping timer before terminate to prevent re-entrancy
        clearInterval(this.pingTimers[idx]);
        this.pingTimers[idx] = undefined as unknown as ReturnType<typeof setInterval>;
        clearTimeout(this.pongTimers[idx]!);
        this.pongTimers[idx] = null;
        ws.terminate();
        if (!this.stopped && !this.usingRest && idx === 0) {
          this.reconnectFails++;
          this.scheduleReconnect();
        }
        return;
      }

      ws.ping();
      this.pongTimers[idx] = setTimeout(() => {
        // FIX: Pong timeout — terminate immediately instead of just clearing the timer.
        // Previously this just set pongTimers[idx] = null, which meant the zombie
        // detection at the next ping interval could never fire (timer was already null).
        logger.warn({ idx }, "binance spot WS pong not received — terminating zombie");
        this.pongTimers[idx] = null;
        if (ws.readyState === WebSocket.OPEN) {
          clearInterval(this.pingTimers[idx]);
          this.pingTimers[idx] = undefined as unknown as ReturnType<typeof setInterval>;
          ws.terminate();
          if (!this.stopped && !this.usingRest && idx === 0) {
            this.reconnectFails++;
            this.scheduleReconnect();
          }
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  // ── REST fallback ─────────────────────────────────────────────────────────

  private async restPoll(): Promise<void> {
    if (this.stopped || !this.usingRest) return;

    try {
      const res = await fetch(REST_URL, { headers: AUTH_HEADERS, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Array<{
        symbol: string; bidPrice: string; askPrice: string;
      }>;

      const now = Date.now();
      for (const item of body) {
        const sym = stripStable(item.symbol);
        if (!sym) continue;
        const bid = parseFloat(item.bidPrice);
        const ask = parseFloat(item.askPrice);
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) continue;
        this.quotes.set(sym, { bid, ask, receivedAt: now });
      }
      logger.info({ count: this.quotes.size }, "binance spot REST fallback poll complete");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "binance spot REST fallback poll failed",
      );
    }

    if (!this.stopped && this.usingRest) {
      this.restTimer = setTimeout(() => void this.restPoll(), REST_POLL_MS);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  private clearWs(): void {
    for (const t of this.silenceTimers) if (t) clearTimeout(t);
    for (const t of this.pingTimers)    if (t) clearInterval(t);
    for (const t of this.pongTimers)    if (t) clearTimeout(t);
    this.silenceTimers = [];
    this.pingTimers    = [];
    this.pongTimers    = [];
    for (const ws of this.connections) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    this.connections = [];
  }

  private clearAll(): void {
    this.clearWs();
    if (this.restTimer)      { clearTimeout(this.restTimer);      this.restTimer      = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.wsRetryTimer)   { clearTimeout(this.wsRetryTimer);   this.wsRetryTimer   = null; }
  }
}

/**
 * Bybit Spot adapter — WS with API-key auth + REST-only fallback.
 *
 * VPS FIXES APPLIED:
 *   1. Silence watchdog: if no WS message for SILENCE_TIMEOUT_MS, force reconnect.
 *      On VPS, NAT tables expire (60-300s) making TCP appear open while dead.
 *      The 'close' event never fires — only silence detection catches this.
 *   2. TCP keepalive enabled on socket open.
 *   3. Silence timer reset on every message (not just specific ones).
 */

import { createHmac } from "node:crypto";
import WebSocket      from "ws";
import { logger }     from "../../logger.js";
import type { SpotQuote } from "../types.js";

const REST_BASE     = "https://api.bybit.com";
const REST_PATH     = "/v5/market/tickers";
const REST_QUERY    = "category=spot";
const REST_URL      = `${REST_BASE}${REST_PATH}?${REST_QUERY}`;
const WS_URL        = "wss://stream.bybit.com/v5/public/spot";

const RECONNECT_MS     = 5_000;
const RESEED_MS        = 10 * 60_000;
const REST_FAST_MS     = 15_000;
const PING_MS          = 20_000;
const SUB_CHUNK        = 10;
const RECV_WINDOW      = "5000";
const STABLES          = ["USDT", "USDC", "BUSD"];

const WS_403_THRESHOLD = 3;
const WS_RETRY_MS      = 30 * 60_000;

/**
 * FIX: Silence watchdog timeout.
 * Bybit sends heartbeat pong replies and ticker updates frequently.
 * If nothing arrives for 60s, the TCP connection is dead (NAT expired on VPS).
 */
const SILENCE_TIMEOUT_MS = 60_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function stripStable(s: string): string | null {
  const u = s.toUpperCase();
  for (const st of STABLES) if (u.endsWith(st)) return u.slice(0, -st.length);
  return null;
}

function getKeys(): { apiKey: string; apiSecret: string } | null {
  const apiKey    = process.env["BYBIT_API_KEY"];
  const apiSecret = process.env["BYBIT_API_SECRET"];
  if (apiKey && apiSecret) return { apiKey, apiSecret };
  return null;
}

function signedHeaders(apiKey: string, apiSecret: string, queryString: string): Record<string, string> {
  const ts  = String(Date.now());
  const str = `${ts}${apiKey}${RECV_WINDOW}${queryString}`;
  const sig = createHmac("sha256", apiSecret).update(str).digest("hex");
  return {
    "X-BAPI-API-KEY":      apiKey,
    "X-BAPI-TIMESTAMP":    ts,
    "X-BAPI-RECV-WINDOW":  RECV_WINDOW,
    "X-BAPI-SIGN":         sig,
  };
}

function wsAuthArgs(apiKey: string, apiSecret: string): [string, number, string] {
  const expires = Date.now() + 5_000;
  const sig     = createHmac("sha256", apiSecret)
    .update(`GET/realtime${expires}`)
    .digest("hex");
  return [apiKey, expires, sig];
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class BybitSpotAdapter {
  readonly quotes = new Map<string, SpotQuote>();

  private rawSymbols:     string[]                               = [];
  private ws:             WebSocket | null                       = null;
  private pingTimer:      ReturnType<typeof setInterval>  | null = null;
  private reseedTimer:    ReturnType<typeof setTimeout>   | null = null;
  private wsRetryTimer:   ReturnType<typeof setTimeout>   | null = null;
  private silenceTimer:   ReturnType<typeof setTimeout>   | null = null; // FIX
  private stopped         = false;

  private consecutive403 = 0;
  private wsBlocked      = false;

  start(): void {
    this.stopped = false;
    void this.seedAndConnect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer)    clearInterval(this.pingTimer);
    if (this.reseedTimer)  clearTimeout(this.reseedTimer);
    if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer); // FIX
    this.ws?.terminate();
    this.ws = null;
  }

  // ── REST seed ─────────────────────────────────────────────────────────────

  private async restSeed(): Promise<boolean> {
    try {
      const keys    = getKeys();
      const headers = keys
        ? signedHeaders(keys.apiKey, keys.apiSecret, REST_QUERY)
        : undefined;

      const res = await fetch(REST_URL, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = (await res.json()) as {
        result: { list: Array<{ symbol: string; bid1Price: string; ask1Price: string }> };
      };
      const now     = Date.now();
      const rawSyms: string[] = [];

      for (const item of body.result.list) {
        const sym = stripStable(item.symbol);
        if (!sym) continue;
        rawSyms.push(item.symbol);
        const bid = parseFloat(item.bid1Price);
        const ask = parseFloat(item.ask1Price);
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) continue;
        this.quotes.set(sym, { bid, ask, receivedAt: now });
      }

      this.rawSymbols = rawSyms;
      logger.info(
        { count: this.quotes.size, signed: !!keys },
        "bybit spot REST seed complete",
      );
      return true;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "bybit spot REST seed failed",
      );
      return false;
    }
  }

  // ── Startup ───────────────────────────────────────────────────────────────

  private async seedAndConnect(): Promise<void> {
    if (this.stopped) return;
    await this.restSeed();
    if (this.stopped) return;

    if (this.wsBlocked) {
      this.scheduleRestFastPoll();
    } else {
      this.connect();
      this.scheduleReseed();
    }
  }

  // ── REST-only / fast-poll mode ────────────────────────────────────────────

  private scheduleRestFastPoll(): void {
    if (this.reseedTimer) clearTimeout(this.reseedTimer);
    this.reseedTimer = setTimeout(async () => {
      if (this.stopped) return;
      await this.restSeed();
      if (!this.stopped && this.wsBlocked) this.scheduleRestFastPoll();
    }, REST_FAST_MS);
  }

  private enterRestOnlyMode(): void {
    if (this.wsBlocked) return;
    this.wsBlocked = true;
    const keys = getKeys();
    logger.warn(
      { retryMs: WS_RETRY_MS, hasApiKey: !!keys },
      keys
        ? "bybit spot WS blocked (403) — signed REST-only mode, retrying WS in 30min"
        : "bybit spot WS blocked (403) — no API key, REST-only mode; add BYBIT_API_KEY to fix",
    );
    if (this.reseedTimer) { clearTimeout(this.reseedTimer); this.reseedTimer = null; }
    this.scheduleRestFastPoll();

    if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
    this.wsRetryTimer = setTimeout(() => {
      if (this.stopped) return;
      logger.info("bybit spot WS retry after REST-only period");
      this.wsBlocked      = false;
      this.consecutive403 = 0;
      if (this.reseedTimer) { clearTimeout(this.reseedTimer); this.reseedTimer = null; }
      void this.seedAndConnect();
    }, WS_RETRY_MS);
  }

  // ── WS-mode periodic reseed ───────────────────────────────────────────────

  private scheduleReseed(): void {
    if (this.reseedTimer) clearTimeout(this.reseedTimer);
    this.reseedTimer = setTimeout(async () => {
      if (this.stopped) return;
      await this.restSeed();
      if (this.ws?.readyState === WebSocket.OPEN) this.subscribeAll();
      if (!this.stopped && !this.wsBlocked) this.scheduleReseed();
    }, RESEED_MS);
  }

  // ── Silence watchdog ──────────────────────────────────────────────────────

  /**
   * FIX: Reset the silence watchdog on every received WS message.
   * If SILENCE_TIMEOUT_MS passes without any message, the TCP connection
   * is considered dead (NAT expired on VPS). We terminate and reconnect.
   */
  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.stopped || this.wsBlocked) return;
      logger.warn("bybit spot WS silent for 60s — NAT/TCP likely dead, forcing reconnect");
      const old = this.ws;
      this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      try { old?.terminate(); } catch { /* ignore */ }
      setTimeout(() => this.connect(), RECONNECT_MS);
    }, SILENCE_TIMEOUT_MS);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped || this.wsBlocked) return;

    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }

    this.ws = new WebSocket(WS_URL, { handshakeTimeout: 15_000, perMessageDeflate: false });

    this.ws.on("open", () => {
      this.consecutive403 = 0;

      // GPT ✓: TCP keepalive + no-delay
      const sock = (this.ws as unknown as { _socket?: import("net").Socket })._socket;
      if (sock) { sock.setKeepAlive(true, 30_000); sock.setNoDelay(true); }

      const keys = getKeys();
      if (keys) {
        this.ws!.send(JSON.stringify({
          op:   "auth",
          args: wsAuthArgs(keys.apiKey, keys.apiSecret),
        }));
        logger.info("bybit spot WS connected (signed auth sent)");
      } else {
        logger.info("bybit spot WS connected (no API key)");
      }

      this.subscribeAll();
      this.resetSilenceTimer(); // FIX: start silence watchdog

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: "ping" }));
        }
      }, PING_MS);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.resetSilenceTimer(); // FIX: reset watchdog on every message

      try {
        const msg = JSON.parse(raw.toString()) as {
          op?:     string;
          success?: boolean;
          topic?:  string;
          type?:   "snapshot" | "delta";
          data?:   {
            symbol:      string;
            bid1Price?:  string;
            ask1Price?:  string;
            lastPrice?:  string;
          };
        };

        if (msg.op === "auth") {
          if (msg.success) logger.info("bybit spot WS auth success");
          else             logger.warn("bybit spot WS auth failed — check BYBIT_API_KEY/SECRET");
          return;
        }

        if (!msg.topic?.startsWith("tickers.") || !msg.data) return;
        if (msg.type !== "snapshot" && msg.type !== "delta") return;

        const sym = stripStable(msg.data.symbol);
        if (!sym) return;

        const parsePos = (s: string | undefined): number => {
          if (!s) return NaN;
          const v = parseFloat(s);
          return isFinite(v) && v > 0 ? v : NaN;
        };

        const newBid  = parsePos(msg.data.bid1Price);
        const newAsk  = parsePos(msg.data.ask1Price);
        const newLast = parsePos(msg.data.lastPrice);

        const existing = this.quotes.get(sym);

        const bid = isFinite(newBid)  ? newBid  : isFinite(newLast) ? newLast : existing?.bid ?? 0;
        const ask = isFinite(newAsk)  ? newAsk  : isFinite(newLast) ? newLast : existing?.ask ?? 0;

        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return;
        this.quotes.set(sym, { bid, ask, receivedAt: Date.now() });
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("close", () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
      this.ws = null;
      if (!this.stopped && !this.wsBlocked) {
        logger.warn("bybit spot WS closed, reconnecting");
        setTimeout(() => this.connect(), RECONNECT_MS);
      }
    });

    this.ws.on("error", (err) => {
      const msg   = err.message ?? "";
      const is403 = msg.includes("403");

      if (is403) {
        this.consecutive403++;
        if (this.consecutive403 >= WS_403_THRESHOLD) {
          this.ws?.terminate();
          this.ws = null;
          if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
          if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
          this.enterRestOnlyMode();
          return;
        }
      } else {
        this.consecutive403 = 0;
      }

      logger.error({ err: msg }, "bybit spot WS error");
    });
  }

  private subscribeAll(): void {
    if (!this.ws || this.rawSymbols.length === 0) return;
    for (let i = 0; i < this.rawSymbols.length; i += SUB_CHUNK) {
      const args = this.rawSymbols
        .slice(i, i + SUB_CHUNK)
        .map((s) => `tickers.${s}`);
      this.ws.send(JSON.stringify({ op: "subscribe", args }));
    }
  }
}

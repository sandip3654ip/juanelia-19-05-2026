/**
 * Kraken Spot WS adapter (v2)
 *
 * VPS FIXES APPLIED:
 *   1. Silence watchdog: if no WS message for SILENCE_TIMEOUT_MS, force reconnect.
 *      Kraken WS is delta-only (sends only on price changes), so illiquid pairs
 *      may be quiet — but ANY message (including heartbeat) resets the timer.
 *      90s of silence = dead TCP connection on VPS.
 *   2. TCP keepalive enabled on socket open.
 *   3. Ping-pong added (Kraken v2 supports { method: "ping" }).
 */

import WebSocket from "ws";
import { logger } from "../../logger.js";
import type { SpotQuote } from "../types.js";

const REST_PAIRS_URL  = "https://api.kraken.com/0/public/AssetPairs";
const REST_TICKER_URL = "https://api.kraken.com/0/public/Ticker";
const WS_URL          = "wss://ws.kraken.com/v2";
const RECONNECT_MS    = 5_000;
const PAIRS_REFRESH_MS = 10 * 60_000;
const REST_RESEED_MS  = 25_000;

/**
 * FIX: Silence watchdog. Kraken sends heartbeat frames periodically.
 * 90s of silence = dead TCP connection on VPS (NAT expired).
 */
const SILENCE_TIMEOUT_MS = 90_000;

/** FIX: Application-level ping every 30s to trigger pong response */
const PING_INTERVAL_MS = 30_000;

export interface ExchangeFees { maker: number; taker: number; }

export class KrakenSpotAdapter {
  readonly quotes  = new Map<string, SpotQuote>();
  readonly feeMap  = new Map<string, ExchangeFees>();

  private wsSymbolMap = new Map<string, string>();
  private pairKeyMap  = new Map<string, string>();

  private ws:           WebSocket | null = null;
  private stopped       = false;
  private pairsTimer:   ReturnType<typeof setTimeout>  | null = null;
  private reseedTimer:  ReturnType<typeof setInterval> | null = null;
  private pingTimer:    ReturnType<typeof setInterval> | null = null; // FIX
  private silenceTimer: ReturnType<typeof setTimeout>  | null = null; // FIX

  start(): void {
    this.stopped = false;
    void this.initPairsAndConnect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pairsTimer)   clearTimeout(this.pairsTimer);
    if (this.reseedTimer)  clearInterval(this.reseedTimer);
    if (this.pingTimer)    clearInterval(this.pingTimer);    // FIX
    if (this.silenceTimer) clearTimeout(this.silenceTimer);  // FIX
    this.ws?.terminate();
    this.ws = null;
  }

  private async initPairsAndConnect(): Promise<void> {
    if (this.stopped) return;

    try {
      const res = await fetch(REST_PAIRS_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`AssetPairs HTTP ${res.status}`);
      const body = (await res.json()) as {
        result: Record<string, {
          wsname?:     string;
          fees?:       [number, number][];
          fees_maker?: [number, number][];
        }>;
      };

      this.wsSymbolMap.clear();
      this.pairKeyMap.clear();
      this.feeMap.clear();
      for (const [pairKey, info] of Object.entries(body.result ?? {})) {
        if (!info.wsname) continue;
        const parts = info.wsname.split("/");
        if (parts.length !== 2 || parts[1] !== "USDT") continue;
        let sym = parts[0].toUpperCase();
        if (sym === "XBT") sym = "BTC";
        if (/^[XZ][A-Z]{2,5}$/.test(sym)) sym = sym.slice(1);
        this.wsSymbolMap.set(info.wsname, sym);
        this.pairKeyMap.set(pairKey, sym);

        const taker = (info.fees?.[0]?.[1]        ?? 0.40) / 100;
        const maker = (info.fees_maker?.[0]?.[1]  ?? 0.25) / 100;
        this.feeMap.set(sym, { maker, taker });
      }

      logger.info(
        { count: this.wsSymbolMap.size, feesLoaded: this.feeMap.size },
        "kraken spot WS pairs initialised",
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "kraken pairs init failed, retrying",
      );
      if (!this.stopped) setTimeout(() => void this.initPairsAndConnect(), RECONNECT_MS);
      return;
    }

    await this.restSeed();
    if (this.stopped) return;

    if (this.reseedTimer) clearInterval(this.reseedTimer);
    this.reseedTimer = setInterval(() => {
      if (!this.stopped) void this.restSeed();
    }, REST_RESEED_MS);

    this.connect();

    if (!this.stopped) {
      this.pairsTimer = setTimeout(
        () => void this.initPairsAndConnect(),
        PAIRS_REFRESH_MS,
      );
    }
  }

  // ── REST seed ─────────────────────────────────────────────────────────────

  private async restSeed(): Promise<void> {
    if (this.pairKeyMap.size === 0) return;
    try {
      const pairs = Array.from(this.pairKeyMap.keys()).join(",");
      const url   = `${REST_TICKER_URL}?pair=${encodeURIComponent(pairs)}`;
      const res   = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`Ticker HTTP ${res.status}`);
      const body = (await res.json()) as {
        result: Record<string, { b: [string, ...unknown[]]; a: [string, ...unknown[]] }>;
        error:  string[];
      };
      if (body.error?.length) throw new Error(body.error.join(", "));

      const now = Date.now();
      let count = 0;
      for (const [pairKey, tick] of Object.entries(body.result ?? {})) {
        const sym = this.pairKeyMap.get(pairKey);
        if (!sym) continue;
        const bid = parseFloat(tick.b[0]);
        const ask = parseFloat(tick.a[0]);
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) continue;
        this.quotes.set(sym, { bid, ask, receivedAt: now });
        count++;
      }
      logger.info({ count }, "kraken spot REST seed complete");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "kraken spot REST seed failed",
      );
    }
  }

  // ── Silence watchdog ──────────────────────────────────────────────────────

  /**
   * FIX: Reset silence watchdog on every WS message.
   * Kraken sends heartbeat frames periodically. If 90s passes with nothing,
   * the TCP connection is dead (NAT expired on VPS). Terminate and reconnect.
   */
  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.stopped) return;
      logger.warn("kraken spot WS silent for 90s — NAT/TCP likely dead, forcing reconnect");
      const old = this.ws;
      this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      try { old?.terminate(); } catch { /* ignore */ }
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_MS);
    }, SILENCE_TIMEOUT_MS);
  }

  private connect(): void {
    if (this.stopped || this.wsSymbolMap.size === 0) return;

    if (this.pingTimer)    { clearInterval(this.pingTimer);  this.pingTimer    = null; } // FIX
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }

    this.ws = new WebSocket(WS_URL, { handshakeTimeout: 15_000, perMessageDeflate: false });

    this.ws.on("open", () => {
      logger.info("kraken spot WS connected");

      // GPT ✓: TCP keepalive + no-delay
      const sock = (this.ws as unknown as { _socket?: import("net").Socket })._socket;
      if (sock) { sock.setKeepAlive(true, 30_000); sock.setNoDelay(true); }

      const wsSymbols = Array.from(this.wsSymbolMap.keys());
      for (let i = 0; i < wsSymbols.length; i += 100) {
        const chunk = wsSymbols.slice(i, i + 100);
        this.ws!.send(
          JSON.stringify({
            method: "subscribe",
            params: { channel: "ticker", symbol: chunk },
          }),
        );
      }

      this.resetSilenceTimer(); // FIX: start silence watchdog

      // FIX: application-level ping to Kraken v2 WS
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: "ping" }));
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.resetSilenceTimer(); // FIX: reset watchdog on EVERY message

      try {
        const msg = JSON.parse(raw.toString()) as {
          channel?: string;
          type?: string;
          data?: Array<{ symbol: string; bid: number; ask: number }>;
        };

        if (msg.channel !== "ticker" || !Array.isArray(msg.data)) return;

        const now = Date.now();
        for (const item of msg.data) {
          const sym = this.wsSymbolMap.get(item.symbol);
          if (!sym) continue;
          const bid = item.bid;
          const ask = item.ask;
          if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) continue;
          this.quotes.set(sym, { bid, ask, receivedAt: now });
        }
      } catch {
        // ignore
      }
    });

    this.ws.on("close", () => {
      logger.warn("kraken spot WS closed, reconnecting");
      if (this.pingTimer)    { clearInterval(this.pingTimer);  this.pingTimer    = null; } // FIX
      if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
      this.ws = null;
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_MS);
    });

    this.ws.on("error", (err) => {
      logger.error({ err: err.message }, "kraken spot WS error");
    });
  }
}

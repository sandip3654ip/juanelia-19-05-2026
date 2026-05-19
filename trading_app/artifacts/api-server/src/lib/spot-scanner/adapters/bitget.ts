/**
 * Bitget Spot WS adapter
 *
 * VPS FIXES APPLIED:
 *   1. Silence watchdog: if no WS message for SILENCE_TIMEOUT_MS, force reconnect.
 *      On VPS, NAT tables expire silently — 'close' event never fires.
 *   2. TCP keepalive enabled on socket open.
 *   3. Silence timer reset on every message (including "pong" heartbeat).
 */

import WebSocket from "ws";
import { logger } from "../../logger.js";
import type { SpotQuote } from "../types.js";

const REST_URL      = "https://api.bitget.com/api/v2/spot/market/tickers";
const REST_FEES_URL = "https://api.bitget.com/api/v2/spot/public/symbols";
const WS_URL        = "wss://ws.bitget.com/v2/ws/public";
const RECONNECT_MS  = 5_000;
const RESEED_MS     = 25_000;
const PING_MS       = 25_000;
const SUB_CHUNK     = 100;
const STABLES       = ["USDT", "USDC", "BUSD"];

/**
 * FIX: Silence watchdog timeout.
 * Bitget sends pong replies + ticker updates. If nothing arrives for 60s,
 * the TCP connection is dead (NAT expired on VPS). Force reconnect.
 */
const SILENCE_TIMEOUT_MS = 60_000;

function stripStable(s: string): string | null {
  const u = s.toUpperCase();
  for (const st of STABLES) if (u.endsWith(st)) return u.slice(0, -st.length);
  return null;
}

export interface ExchangeFees { maker: number; taker: number; }

export class BitgetSpotAdapter {
  readonly quotes  = new Map<string, SpotQuote>();
  readonly feeMap  = new Map<string, ExchangeFees>();

  private instIds:      string[]                                   = [];
  private ws:           WebSocket | null                           = null;
  private pingTimer:    ReturnType<typeof setInterval> | null      = null;
  private reseedTimer:  ReturnType<typeof setInterval> | null      = null;
  private silenceTimer: ReturnType<typeof setTimeout>  | null      = null; // FIX
  private stopped       = false;

  start(): void {
    this.stopped = false;
    void this.seedAndConnect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer)    clearInterval(this.pingTimer);
    if (this.reseedTimer)  clearInterval(this.reseedTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer); // FIX
    this.ws?.terminate();
    this.ws = null;
  }

  // ── Fee fetch ─────────────────────────────────────────────────────────────

  private async fetchFees(): Promise<void> {
    try {
      const res = await fetch(REST_FEES_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`symbols HTTP ${res.status}`);
      const body = (await res.json()) as {
        data: Array<{ symbol: string; makerFeeRate: string; takerFeeRate: string }>;
      };

      for (const item of body.data) {
        const sym = stripStable(item.symbol);
        if (!sym) continue;
        const maker = parseFloat(item.makerFeeRate);
        const taker = parseFloat(item.takerFeeRate);
        if (!isFinite(maker) || !isFinite(taker)) continue;
        this.feeMap.set(sym, { maker, taker });
      }
      logger.info({ count: this.feeMap.size }, "bitget spot fees loaded");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "bitget spot fee fetch failed",
      );
    }
  }

  // ── REST seed ─────────────────────────────────────────────────────────────

  private async restSeed(): Promise<void> {
    try {
      const res = await fetch(REST_URL, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data: Array<{ symbol: string; bidPr: string; askPr: string }>;
      };

      const now = Date.now();
      const ids: string[] = [];

      for (const item of body.data) {
        const sym = stripStable(item.symbol);
        if (!sym) continue;
        ids.push(item.symbol);
        const bid = parseFloat(item.bidPr);
        const ask = parseFloat(item.askPr);
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) continue;
        this.quotes.set(sym, { bid, ask, receivedAt: now });
      }

      this.instIds = ids;
      logger.info({ count: this.quotes.size }, "bitget spot REST seed complete");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "bitget spot REST seed failed",
      );
    }
  }

  // ── Connect sequence ──────────────────────────────────────────────────────

  private async seedAndConnect(): Promise<void> {
    if (this.stopped) return;
    await Promise.all([this.fetchFees(), this.restSeed()]);
    if (this.stopped) return;

    if (this.reseedTimer) clearInterval(this.reseedTimer);
    this.reseedTimer = setInterval(() => {
      if (!this.stopped) void this.restSeed();
    }, RESEED_MS);

    this.connect();
  }

  // ── Silence watchdog ──────────────────────────────────────────────────────

  /**
   * FIX: Reset silence watchdog on every WS message.
   * Bitget's "pong" text frame + ticker updates should keep this alive.
   * If 60s passes with nothing, the connection is dead on VPS.
   */
  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.stopped) return;
      logger.warn("bitget spot WS silent for 60s — NAT/TCP likely dead, forcing reconnect");
      const old = this.ws;
      this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      try { old?.terminate(); } catch { /* ignore */ }
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_MS);
    }, SILENCE_TIMEOUT_MS);
  }

  private connect(): void {
    if (this.stopped) return;

    if (this.pingTimer)    { clearInterval(this.pingTimer);  this.pingTimer    = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }

    this.ws = new WebSocket(WS_URL, { handshakeTimeout: 15_000, perMessageDeflate: false });

    this.ws.on("open", () => {
      logger.info("bitget spot WS connected");

      // GPT ✓: TCP keepalive + no-delay
      const sock = (this.ws as unknown as { _socket?: import("net").Socket })._socket;
      if (sock) { sock.setKeepAlive(true, 30_000); sock.setNoDelay(true); }

      this.subscribeAll();
      this.resetSilenceTimer(); // FIX: start silence watchdog

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send("ping");
        }
      }, PING_MS);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      const str = raw.toString();
      this.resetSilenceTimer(); // FIX: reset watchdog on EVERY message (including "pong")

      if (str === "pong") return;

      try {
        const msg = JSON.parse(str) as {
          action?: string;
          arg?:    { instType: string; channel: string; instId: string };
          data?:   Array<{ instId: string; bidPr?: string; askPr?: string }>;
        };

        if (!msg.data || !msg.arg || msg.arg.channel !== "ticker") return;
        if (msg.action !== "snapshot" && msg.action !== "update") return;

        const now = Date.now();
        for (const item of msg.data) {
          const sym = stripStable(item.instId);
          if (!sym) continue;

          const existing = this.quotes.get(sym);
          const bid = item.bidPr != null ? parseFloat(item.bidPr) : existing?.bid ?? 0;
          const ask = item.askPr != null ? parseFloat(item.askPr) : existing?.ask ?? 0;

          if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) continue;
          this.quotes.set(sym, { bid, ask, receivedAt: now });
        }
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("close", () => {
      if (this.pingTimer)    { clearInterval(this.pingTimer);  this.pingTimer    = null; }
      if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
      logger.warn("bitget spot WS closed, reconnecting");
      this.ws = null;
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_MS);
    });

    this.ws.on("error", (err) => {
      logger.error({ err: err.message }, "bitget spot WS error");
    });
  }

  private subscribeAll(): void {
    if (!this.ws || this.instIds.length === 0) return;
    for (let i = 0; i < this.instIds.length; i += SUB_CHUNK) {
      const args = this.instIds.slice(i, i + SUB_CHUNK).map((id) => ({
        instType: "SPOT",
        channel:  "ticker",
        instId:   id,
      }));
      this.ws.send(JSON.stringify({ op: "subscribe", args }));
    }
  }
}

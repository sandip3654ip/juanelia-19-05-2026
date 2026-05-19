/**
 * KuCoin Spot adapter — REST seed + WS live updates
 *
 * VPS FIXES APPLIED:
 *   1. Silence watchdog: if no WS message for SILENCE_TIMEOUT_MS, force reconnect.
 *      KuCoin sends pong replies to keep connection alive, but on VPS the NAT
 *      table can expire silently — 'close' event never fires.
 *   2. TCP keepalive enabled on socket open.
 *   3. Silence timer reset on every message.
 */

import WebSocket from "ws";
import { logger } from "../../logger.js";
import type { SpotQuote } from "../types.js";

const REST_TICKERS_URL = "https://api.kucoin.com/api/v1/market/allTickers";
const TOKEN_URL        = "https://api.kucoin.com/api/v1/bullet-public";
const RECONNECT_MS     = 5_000;
const REST_RESEED_MS   = 25_000;
const STABLES          = new Set(["USDT", "USDC", "BUSD"]);

/**
 * FIX: Silence watchdog timeout.
 * KuCoin server sends pings and ticker updates actively.
 * If nothing arrives for 60s, the TCP connection is dead on VPS.
 */
const SILENCE_TIMEOUT_MS = 60_000;

interface BulletResponse {
  data: {
    token: string;
    instanceServers: Array<{
      endpoint:     string;
      pingInterval: number;
      pingTimeout:  number;
    }>;
  };
}

function stripStable(s: string): string | null {
  const parts = s.split("-");
  if (parts.length !== 2) return null;
  if (!STABLES.has(parts[1].toUpperCase())) return null;
  return parts[0].toUpperCase();
}

export class KucoinSpotAdapter {
  readonly quotes = new Map<string, SpotQuote>();

  private ws:           WebSocket | null = null;
  private pingTimer:    ReturnType<typeof setInterval> | null = null;
  private reseedTimer:  ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout>  | null = null; // FIX
  private stopped = false;

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

  // ── REST seed ────────────────────────────────────────────────────────────
  private async restSeed(): Promise<void> {
    try {
      const res = await fetch(REST_TICKERS_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`allTickers HTTP ${res.status}`);
      const body = (await res.json()) as {
        data: { ticker: Array<{ symbolName: string; buy: string; sell: string }> };
      };

      const now = Date.now();
      let count = 0;
      for (const item of body.data.ticker) {
        const sym = stripStable(item.symbolName);
        if (!sym) continue;
        const bid = parseFloat(item.buy);
        const ask = parseFloat(item.sell);
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) continue;
        this.quotes.set(sym, { bid, ask, receivedAt: now });
        count++;
      }
      logger.info({ count }, "kucoin spot REST seed complete");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "kucoin spot REST seed failed",
      );
    }
  }

  // ── Connect sequence ──────────────────────────────────────────────────────
  private async seedAndConnect(): Promise<void> {
    if (this.stopped) return;

    await this.restSeed();
    if (this.stopped) return;

    if (this.reseedTimer) clearInterval(this.reseedTimer);
    this.reseedTimer = setInterval(() => {
      if (!this.stopped) void this.restSeed();
    }, REST_RESEED_MS);

    await this.connectWs();
  }

  // ── Silence watchdog ──────────────────────────────────────────────────────

  /**
   * FIX: Reset silence watchdog on every WS message.
   * KuCoin sends periodic pongs which should keep this alive.
   * 60s of silence = dead TCP connection on VPS.
   */
  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.stopped) return;
      logger.warn("kucoin spot WS silent for 60s — NAT/TCP likely dead, forcing reconnect");
      const old = this.ws;
      this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      try { old?.terminate(); } catch { /* ignore */ }
      if (!this.stopped) setTimeout(() => void this.connectWs(), RECONNECT_MS);
    }, SILENCE_TIMEOUT_MS);
  }

  private async connectWs(): Promise<void> {
    if (this.stopped) return;

    let token: string;
    let endpoint: string;
    let pingInterval: number;

    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`bullet-public HTTP ${res.status}`);
      const body = (await res.json()) as BulletResponse;
      token        = body.data.token;
      const server = body.data.instanceServers[0];
      endpoint     = server.endpoint;
      pingInterval = server.pingInterval;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "kucoin WS token fetch failed, retrying",
      );
      if (!this.stopped) setTimeout(() => void this.connectWs(), RECONNECT_MS);
      return;
    }

    const url = `${endpoint}?token=${token}`;
    if (this.pingTimer)    { clearInterval(this.pingTimer);  this.pingTimer    = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }
    this.ws = new WebSocket(url, { handshakeTimeout: 15_000, perMessageDeflate: false });

    this.ws.on("open", () => {
      logger.info("kucoin spot WS connected");

      // GPT ✓: TCP keepalive + no-delay
      const sock = (this.ws as unknown as { _socket?: import("net").Socket })._socket;
      if (sock) { sock.setKeepAlive(true, 30_000); sock.setNoDelay(true); }

      this.ws!.send(
        JSON.stringify({
          id:             Date.now().toString(),
          type:           "subscribe",
          topic:          "/market/ticker:all",
          privateChannel: false,
          response:       true,
        }),
      );

      this.resetSilenceTimer(); // FIX: start silence watchdog

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({ id: Date.now().toString(), type: "ping" }),
          );
        }
      }, pingInterval);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.resetSilenceTimer(); // FIX: reset watchdog on EVERY message

      try {
        const msg = JSON.parse(raw.toString()) as {
          type:     string;
          subject?: string;
          topic?:   string;
          data?:    { bestBid?: string; bestAsk?: string };
        };

        if (msg.type !== "message" || !msg.subject || !msg.data) return;

        const sym = stripStable(msg.subject);
        if (!sym) return;

        const bid = parseFloat(msg.data.bestBid ?? "");
        const ask = parseFloat(msg.data.bestAsk ?? "");
        if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return;

        this.quotes.set(sym, { bid, ask, receivedAt: Date.now() });
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("close", () => {
      logger.warn("kucoin spot WS closed, reconnecting");
      if (this.pingTimer)    { clearInterval(this.pingTimer);  this.pingTimer    = null; }
      if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } // FIX
      this.ws = null;
      if (!this.stopped) setTimeout(() => void this.connectWs(), RECONNECT_MS);
    });

    this.ws.on("error", (err) => {
      logger.error({ err: err.message }, "kucoin spot WS error");
    });
  }
}

/**
 * CoinSwitch PRO Futures adapter ("EXCHANGE_2").
 *
 * Protocol per official docs at https://api-trading.coinswitch.co/#ticker:
 *
 * REST seed (public, no auth):
 *   GET https://coinswitch.co/trade/api/v2/futures/all-pairs/ticker?exchange=EXCHANGE_2
 *   Returns 541 pairs with bid/ask/funding_rate/next_funding_timestamp. Poll every 5min.
 *
 * WS real-time (Socket.IO):
 *   URL:       wss://ws.coinswitch.co/exchange_2  (namespace /exchange_2)
 *   Path:      /pro/realtime-rates-socket/futures/exchange_2
 *   Subscribe: emit("FETCH_TICKER_INFO_CS_PRO", {event:"subscribe", pair:"BTCUSDT"})
 *   Receive:   on("FETCH_TICKER_INFO_CS_PRO", data)
 *              data = { [symbol]: { b, a, r, T, p, s, E, ... } }
 *
 * WS note: ticker is only emitted when trades happen on that pair in the
 * last minute. REST poll keeps funding rates fresh for low-volume instruments.
 *
 * Funding rate format: raw decimal per-8h (e.g. 0.00005 = 0.005%).
 * Both REST `funding_rate` and WS `r` use the same raw decimal format.
 *
 * Updates batched every 100ms to reduce latency while avoiding re-render storms.
 */

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { io, Socket } from "socket.io-client";
import { logger } from "../logger";
import { normalizeSymbol } from "./symbols";
import type { FeedTick } from "./aggregator";

const REST_BASE = "https://coinswitch.co";
const REST_PATH = "/trade/api/v2/futures/all-pairs/ticker";
const INSTRUMENT_INFO_PATH = "/trade/api/v2/futures/instrument_info";
const REST_POLL_MS = 5 * 60_000; // 5 min — avoids Cloudflare rate limits

const WS_BASE_URL = "https://ws.coinswitch.co";
const WS_SOCKET_PATH = "/pro/realtime-rates-socket/futures/exchange_2";
const WS_NAMESPACE = "/exchange_2";

const WS_BATCH_MS = 100;          // reduced from 500ms for lower latency
const RECONNECT_DELAY_MS  = 10_000;
const RECONNECT_MAX_MS    = 5 * 60_000; // cap backoff at 5 min
const CONNECT_ERR_OFFLINE = 5;          // consecutive connect_errors → "offline" log
const RESUBSCRIBE_INTERVAL_MS = 4 * 3_600_000; // re-subscribe every 4h for fresh rates

/** Per-symbol merged state: REST seeds funding; WS keeps bid/ask real-time. */
interface SymbolState {
  bestBid: number;
  bestAsk: number;
  fundingRate: number;
  fundingIntervalMs: number; // derived from nextFundingAt alignment (4h or 8h)
  nextFundingAt: number;
  receivedAt: number;
}

/** REST all-pairs ticker entry */
interface RestTicker {
  symbol: string;
  best_bid_price: string | number;
  best_ask_price: string | number;
  funding_rate: string | number;
  next_funding_timestamp: number;
  mark_price?: string | number;
}

/** WS ticker payload (short field names per CoinSwitch docs) */
interface WsTicker {
  b?: string | number;   // best bid
  a?: string | number;   // best ask
  r?: string | number;   // funding rate (raw decimal, per-8h)
  T?: string | number;   // next funding timestamp (Unix ms)
  p?: string | number;   // mark price
  s?: string;            // symbol
  E?: string | number;   // event timestamp (Unix ms)
}

const FOUR_HOURS_MS  = 4 * 3_600_000;
const EIGHT_HOURS_MS = 8 * 3_600_000;

/**
 * Infer funding interval from the next funding timestamp.
 * - If the timestamp is on an 8h UTC boundary (0h, 8h, 16h) → 8h
 * - If on a 4h boundary but NOT 8h (4h, 12h, 20h) → 4h
 * - Otherwise default to 8h
 */
function inferFundingIntervalMs(nextFundingAt: number): number {
  if (nextFundingAt % EIGHT_HOURS_MS === 0) return EIGHT_HOURS_MS;
  if (nextFundingAt % FOUR_HOURS_MS  === 0) return FOUR_HOURS_MS;
  return EIGHT_HOURS_MS;
}

const LEVERAGE_POLL_MS = 10 * 60_000; // refresh instrument_info every 10 minutes

export class CoinSwitchAdapter {
  private socket: Socket | null = null;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private resubTimer: ReturnType<typeof setTimeout> | null = null;
  private leverageTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Single reconnect timer — prevents stacked timers when connect_error fires
   * multiple times, or when disconnect fires after closeSocket() during reconnect.
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private symbolState: Map<string, SymbolState> = new Map();
  private activePairs: Set<string> = new Set(); // raw exchange symbols (e.g. "BTCUSDT")
  private pendingBatch: Map<string, FeedTick> = new Map();
  private ticks: Map<string, FeedTick> = new Map();
  private leverageMap: Map<string, number> = new Map(); // canonical symbol → max leverage
  private stopped = false;

  // WS connection backoff state
  private consecutiveConnectErrors = 0;
  private wsReconnectDelay         = RECONNECT_DELAY_MS;

  // Cookie jar: store Cloudflare/session cookies between REST requests
  private cookieJar: Map<string, string> = new Map();

  constructor(private onTick: (tick: FeedTick) => void) {}

  start() {
    this.stopped = false;
    this.fetchInstrumentInfo();
    this.pollRest(true);
  }

  stop() {
    this.stopped = true;
    if (this.restTimer)      { clearTimeout(this.restTimer);      this.restTimer     = null; }
    if (this.batchTimer)     { clearTimeout(this.batchTimer);     this.batchTimer    = null; }
    if (this.resubTimer)     { clearTimeout(this.resubTimer);     this.resubTimer    = null; }
    if (this.leverageTimer)  { clearTimeout(this.leverageTimer);  this.leverageTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.closeSocket();
  }

  getTicks(): Map<string, FeedTick> {
    return this.ticks;
  }

  getLeverageMap(): ReadonlyMap<string, number> {
    return this.leverageMap;
  }

  /**
   * Fetch /trade/api/v2/futures/instrument_info (authenticated).
   * Uses Ed25519 signing: sign("GET" + fullEndpoint + epochMs) with the hex secret.
   * Gracefully skips if COINSWITCH_API_KEY / COINSWITCH_API_SECRET are unset.
   */
  private async fetchInstrumentInfo() {
    const apiKey    = process.env["COINSWITCH_API_KEY"];
    const apiSecret = process.env["COINSWITCH_API_SECRET"];
    if (!apiKey || !apiSecret) {
      logger.warn("coinswitch instrument_info skipped — COINSWITCH_API_KEY/SECRET not set");
      return;
    }
    try {
      const params       = "exchange=EXCHANGE_2";
      const endpoint     = `${INSTRUMENT_INFO_PATH}?${params}`;
      const epoch        = String(Date.now());
      const msgBuf       = Buffer.from(`GET${endpoint}${epoch}`);
      // Build PKCS#8-wrapped Ed25519 private key from raw 32-byte hex seed
      const seedBytes    = Buffer.from(apiSecret, "hex");
      const pkcs8Header  = Buffer.from("302e020100300506032b657004220420", "hex");
      const privateKey   = createPrivateKey({
        key:    Buffer.concat([pkcs8Header, seedBytes]),
        format: "der",
        type:   "pkcs8",
      });
      const signature = cryptoSign(null, msgBuf, privateKey).toString("hex");

      const res = await fetch(`${REST_BASE}${endpoint}`, {
        headers: {
          "Content-Type":    "application/json",
          "X-AUTH-APIKEY":   apiKey,
          "X-AUTH-SIGNATURE": signature,
          "X-AUTH-EPOCH":    epoch,
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "coinswitch instrument_info non-OK");
        return;
      }
      const body = await res.json() as {
        data?: Record<string, { max_leverage?: string | number }>;
      };
      if (!body.data) return;

      let count = 0;
      for (const [rawSymbol, info] of Object.entries(body.data)) {
        const canonical = normalizeSymbol(rawSymbol, "coinswitch");
        if (!canonical) continue;
        const lev = parseInt(String(info.max_leverage ?? "0"), 10);
        if (lev > 0) { this.leverageMap.set(canonical, lev); count++; }
      }
      logger.info({ count }, "coinswitch leverage map populated");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "coinswitch instrument_info fetch error");
    } finally {
      // Schedule next refresh in 10 minutes; existing map keeps serving until then
      if (!this.stopped) {
        this.leverageTimer = setTimeout(() => {
          this.leverageTimer = null;
          this.fetchInstrumentInfo();
        }, LEVERAGE_POLL_MS);
      }
    }
  }

  // ─── Cookie jar ───────────────────────────────────────────────────────────

  /** Build a Cookie header string from the jar. */
  private getCookieHeader(): string {
    if (this.cookieJar.size === 0) return "";
    return [...this.cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Parse and store Set-Cookie headers from a fetch Response. */
  private storeCookies(res: Response) {
    // Node.js 18+ / undici: getSetCookie() returns array; fall back to get()
    const raw: string[] =
      (typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function")
        ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : (res.headers.get("set-cookie") ?? "").split(/,(?=[^ ])/).filter(Boolean);

    for (const cookie of raw) {
      const pair = cookie.split(";")[0].trim();
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  // ─── REST poll ────────────────────────────────────────────────────────────

  private async pollRest(initial = false) {
    if (this.stopped) return;
    try {
      const params = "exchange=EXCHANGE_2";
      const endpoint = `${REST_PATH}?${params}`;
      const url = `${REST_BASE}${endpoint}`;

      const headers: Record<string, string> = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Origin": "https://coinswitch.co",
        "Referer": "https://coinswitch.co/pro/futures",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      };

      // Add Ed25519 auth if credentials are available
      const apiKey    = process.env["COINSWITCH_API_KEY"];
      const apiSecret = process.env["COINSWITCH_API_SECRET"];
      if (apiKey && apiSecret) {
        try {
          const epoch    = String(Date.now());
          const msgBuf   = Buffer.from(`GET${endpoint}${epoch}`);
          const seedBytes   = Buffer.from(apiSecret, "hex");
          const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
          const privateKey  = createPrivateKey({
            key:    Buffer.concat([pkcs8Header, seedBytes]),
            format: "der",
            type:   "pkcs8",
          });
          const signature = cryptoSign(null, msgBuf, privateKey).toString("hex");
          headers["X-AUTH-APIKEY"]    = apiKey;
          headers["X-AUTH-SIGNATURE"] = signature;
          headers["X-AUTH-EPOCH"]     = epoch;
        } catch (signErr) {
          logger.warn({ err: (signErr as Error).message }, "coinswitch REST sign error");
        }
      }

      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) headers["Cookie"] = cookieHeader;

      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers });
      this.storeCookies(res);

      if (!res.ok) {
        logger.warn({ status: res.status }, "coinswitch REST non-OK");
        if (initial) {
          // REST failed on first try — still connect WS using static fallback pairs
          this.connectSocket();
        }
      } else {
        const body = await res.json() as { data?: Record<string, RestTicker> };
        const data = body.data ?? {};
        const now = Date.now();
        let count = 0;

        for (const [rawSymbol, item] of Object.entries(data)) {
          const canonical = normalizeSymbol(rawSymbol, "coinswitch");
          if (!canonical) continue;

          const bestBid = parseFloat(String(item.best_bid_price ?? "NaN"));
          const bestAsk = parseFloat(String(item.best_ask_price ?? "NaN"));
          const fundingRate = parseFloat(String(item.funding_rate ?? "NaN"));
          const nextFundingAt = item.next_funding_timestamp;

          if (isNaN(fundingRate)) continue;

          const existing = this.symbolState.get(canonical);
          const resolvedNextFunding = (nextFundingAt > now) ? nextFundingAt : (existing?.nextFundingAt ?? this.computeNextFunding());
          const fundingIntervalMs = inferFundingIntervalMs(resolvedNextFunding);

          const state: SymbolState = {
            bestBid: (!isNaN(bestBid) && bestBid > 0) ? bestBid : (existing?.bestBid ?? 0),
            bestAsk: (!isNaN(bestAsk) && bestAsk > 0) ? bestAsk : (existing?.bestAsk ?? 0),
            fundingRate,
            fundingIntervalMs,
            nextFundingAt: resolvedNextFunding,
            receivedAt: now,
          };

          this.symbolState.set(canonical, state);
          this.activePairs.add(rawSymbol);

          if (state.bestBid > 0 && state.bestAsk > 0) {
            this.emitTick(canonical, state, now);
          }
          count++;
        }

        if (initial) {
          logger.info({ count }, "coinswitch REST seed complete");
          this.connectSocket();
        } else {
          logger.info({ count }, "coinswitch REST poll complete");
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "coinswitch REST error");
      if (initial) {
        // Still connect WS even if REST throws — will subscribe static fallback
        this.connectSocket();
      }
    }

    if (!this.stopped) {
      this.restTimer = setTimeout(() => this.pollRest(false), REST_POLL_MS);
    }
  }

  // ─── WebSocket (socket.io-client) ─────────────────────────────────────────

  /**
   * Schedule a single WS reconnect. Funnels all reconnect triggers (connect_error,
   * disconnect) through one timer so they can't stack up and create duplicate
   * connections. Each call while a reconnect is already pending is a no-op.
   */
  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connectSocket();
    }, this.wsReconnectDelay);
  }

  private connectSocket() {
    if (this.stopped) return;

    // Always clean up any existing socket first to prevent leaked connections.
    // removeAllListeners BEFORE disconnect so that the "disconnect" event we
    // trigger here does NOT fire our handler and schedule yet another reconnect.
    this.closeSocket();

    this.socket = io(`${WS_BASE_URL}${WS_NAMESPACE}`, {
      path: WS_SOCKET_PATH,
      transports: ["websocket"],
      reconnection: false,
      timeout: 20_000,
    });

    this.socket.on("connect", () => {
      logger.info("coinswitch Socket.IO connected");
      this.consecutiveConnectErrors = 0;
      this.wsReconnectDelay         = RECONNECT_DELAY_MS;
      this.subscribeAll();
      this.scheduleResubscribe();
    });

    this.socket.on("FETCH_TICKER_INFO_CS_PRO", (data: unknown) => {
      this.handleWsTicker(data);
    });

    this.socket.on("connect_error", (err: Error) => {
      this.consecutiveConnectErrors++;
      if (this.consecutiveConnectErrors === 1) {
        logger.warn({ err: err.message }, "coinswitch Socket.IO connect_error");
      } else if (this.consecutiveConnectErrors === CONNECT_ERR_OFFLINE) {
        // Exponential backoff: double delay up to max
        this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, RECONNECT_MAX_MS);
        logger.warn(
          { retryMs: this.wsReconnectDelay },
          "coinswitch Socket.IO offline — backing off",
        );
      }
      this.scheduleReconnect();
    });

    this.socket.on("disconnect", (reason: string) => {
      logger.warn({ reason }, "coinswitch Socket.IO disconnected — reconnecting");
      if (this.resubTimer) { clearTimeout(this.resubTimer); this.resubTimer = null; }
      this.scheduleReconnect();
    });

    this.socket.on("error", (err: unknown) => {
      logger.warn({ err }, "coinswitch Socket.IO error");
    });
  }

  private subscribeAll() {
    if (!this.socket?.connected) return;
    const pairs = this.activePairs.size > 0
      ? [...this.activePairs]
      : STATIC_PAIRS_FALLBACK;
    for (const pair of pairs) {
      this.socket.emit("FETCH_TICKER_INFO_CS_PRO", { event: "subscribe", pair });
    }
    logger.info({ count: pairs.length }, "coinswitch subscribed to all pairs");
  }

  /** Periodically re-subscribe to refresh funding rates from WS response */
  private scheduleResubscribe() {
    if (this.resubTimer) clearTimeout(this.resubTimer);
    this.resubTimer = setTimeout(() => {
      if (!this.stopped && this.socket?.connected) {
        logger.info("coinswitch re-subscribing for fresh funding rates");
        this.subscribeAll();
        this.scheduleResubscribe();
      }
    }, RESUBSCRIBE_INTERVAL_MS);
  }

  // ─── WS tick handling (batched) ───────────────────────────────────────────

  private handleWsTicker(data: unknown) {
    if (!data || typeof data !== "object") return;
    const now = Date.now();

    for (const [symbol, raw] of Object.entries(data as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as WsTicker;

      // Accept any message that has at least one price/rate field.
      if (!("b" in t) && !("a" in t) && !("r" in t) && !("p" in t)) continue;

      const canonical = normalizeSymbol(symbol, "coinswitch");
      if (!canonical) continue;

      const bestBid = parseFloat(String(t.b ?? "NaN"));
      const bestAsk = parseFloat(String(t.a ?? "NaN"));
      const fundingRateWs = parseFloat(String(t.r ?? "NaN"));
      const nextFundingRaw = parseFloat(String(t.T ?? "NaN"));
      const markPrice = parseFloat(String(t.p ?? "NaN"));

      const existing = this.symbolState.get(canonical);

      // Derive bid/ask from mark price if bid/ask not present
      const derivedBid = (!isNaN(markPrice) && markPrice > 0)
        ? markPrice * 0.9995
        : NaN;
      const derivedAsk = (!isNaN(markPrice) && markPrice > 0)
        ? markPrice * 1.0005
        : NaN;

      const resolvedNextFunding = (!isNaN(nextFundingRaw) && nextFundingRaw > now)
        ? nextFundingRaw
        : (existing?.nextFundingAt ?? this.computeNextFunding());

      const state: SymbolState = {
        bestBid: (!isNaN(bestBid) && bestBid > 0)
          ? bestBid
          : (!isNaN(derivedBid) && derivedBid > 0)
            ? derivedBid
            : (existing?.bestBid ?? 0),
        bestAsk: (!isNaN(bestAsk) && bestAsk > 0)
          ? bestAsk
          : (!isNaN(derivedAsk) && derivedAsk > 0)
            ? derivedAsk
            : (existing?.bestAsk ?? 0),
        fundingRate: (!isNaN(fundingRateWs))
          ? fundingRateWs
          : (existing?.fundingRate ?? 0),
        // Infer interval from the next funding timestamp (WS `T` field)
        fundingIntervalMs: inferFundingIntervalMs(resolvedNextFunding),
        nextFundingAt: resolvedNextFunding,
        receivedAt: now,
      };

      this.symbolState.set(canonical, state);

      if (state.bestBid > 0 && state.bestAsk > 0) {
        this.emitTick(canonical, state, now);
      }
    }

    this.scheduleBatchFlush();
  }

  // ─── Tick emit ────────────────────────────────────────────────────────────

  private emitTick(canonical: string, state: SymbolState, now: number) {
    const tick: FeedTick = {
      exchange: "coinswitch",
      symbol: canonical,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      fundingRate: state.fundingRate,
      fundingIntervalMs: state.fundingIntervalMs,
      nextFundingAt: state.nextFundingAt,
      receivedAt: now,
    };
    this.ticks.set(canonical, tick);
    this.pendingBatch.set(canonical, tick);
  }

  // ─── Batch flush ──────────────────────────────────────────────────────────

  private scheduleBatchFlush() {
    if (this.batchTimer !== null) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      for (const tick of this.pendingBatch.values()) {
        this.onTick(tick);
      }
      this.pendingBatch.clear();
    }, WS_BATCH_MS);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private computeNextFunding(): number {
    const INTERVAL_MS = 8 * 3_600_000;
    return Math.ceil(Date.now() / INTERVAL_MS) * INTERVAL_MS;
  }

  private closeSocket() {
    if (this.resubTimer) { clearTimeout(this.resubTimer); this.resubTimer = null; }
    if (this.socket) {
      // removeAllListeners first so the "disconnect" event from our own
      // socket.disconnect() call does NOT re-trigger scheduleReconnect().
      this.socket.removeAllListeners();
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}

/**
 * Static fallback symbol list used only if REST seed fails entirely.
 * Derived from the live REST response (541 pairs as of 2026-05).
 */
const STATIC_PAIRS_FALLBACK: readonly string[] = [
  "0GUSDT","1000000BABYDOGEUSDT","1000000CHEEMSUSDT","1000000MOGUSDT","10000QUBICUSDT","10000SATSUSDT",
  "1000BONKUSDT","1000BTTUSDT","1000CATUSDT","1000FLOKIUSDT","1000LUNCUSDT","1000NEIROCTOUSDT",
  "1000PEPEUSDT","1000RATSUSDT","1000TAGUSDT","1000TOSHIUSDT","1000TURBOUSDT","1000XECUSDT",
  "1INCHUSDT","2ZUSDT","4USDT","AAPLUSDT","AAVEUSDT","ACEUSDT",
  "ACHUSDT","ACTUSDT","ACUUSDT","ACXUSDT","ADAUSDT","AERGOUSDT",
  "AEROUSDT","AEVOUSDT","AGIUSDT","AGLDUSDT","AIGENSYNUSDT","AIOUSDT",
  "AIOZUSDT","AIXBTUSDT","AKEUSDT","AKTUSDT","ALCHUSDT","ALGOUSDT",
  "ALICEUSDT","ALLOUSDT","ALPINEUSDT","ALTUSDT","AMZNUSDT","ANIMEUSDT",
  "ANKRUSDT","APEUSDT","APEXUSDT","API3USDT","APRUSDT","APTUSDT",
  "ARBUSDT","ARCUSDT","ARIAUSDT","ARKMUSDT","ARKUSDT","ARPAUSDT",
  "ARUSDT","ASPUSDT","ASRUSDT","ASTERUSDT","ASTRUSDT","ATHUSDT",
  "ATOMUSDT","ATUSDT","AUCTIONUSDT","AUSDT","AVAAIUSDT","AVAUSDT",
  "AVAXUSDT","AVNTUSDT","AWEUSDT","AXLUSDT","AXSUSDT","AZTECUSDT",
  "B2USDT","B3USDT","BABYUSDT","BANANAS31USDT","BANANAUSDT","BANDUSDT",
  "BANKUSDT","BANUSDT","BARDUSDT","BASEDUSDT","BATUSDT","BBUSDT",
  "BCHUSDT","BEAMUSDT","BEATUSDT","BELUSDT","BERAUSDT","BICOUSDT",
  "BIGTIMEUSDT","BILLUSDT","BIOUSDT","BIRBUSDT","BLASTUSDT","BLENDUSDT",
  "BLESSUSDT","BLUAIUSDT","BLURUSDT","BMTUSDT","BNBUSDT","BNTUSDT",
  "BOBAUSDT","BOBBOBUSDT","BOMEUSDT","BRETTUSDT","BREVUSDT","BROCCOLIUSDT",
  "BRUSDT","BSBUSDT","BSVUSDT","BTCUSDT","BTRUSDT","BUSDT",
  "C98USDT","CAKEUSDT","CARVUSDT","CATIUSDT","CCUSDT","CELOUSDT",
  "CETUSUSDT","CFGUSDT","CFXUSDT","CGPTUSDT","CHILLGUYUSDT","CHIPUSDT",
  "CHRUSDT","CHZUSDT","CKBUSDT","CLANKERUSDT","CLOUDUSDT","CLOUSDT",
  "CLUSDT","COAIUSDT","COINUSDT","COMPUSDT","COOKIEUSDT","COREUSDT",
  "COTIUSDT","COWUSDT","CRCLUSDT","CROSSUSDT","CROUSDT","CRVUSDT",
  "CTCUSDT","CUSDT","CVCUSDT","CVXUSDT","CYBERUSDT","CYSUSDT",
  "DASHUSDT","DATAUSDT","DBRUSDT","DEXEUSDT","DIAUSDT","DODOUSDT",
  "DOGEUSDT","DOTUSDT","DRIFTUSDT","DUSKUSDT","DYDXUSDT","DYMUSDT",
  "EDUUSDT","EGLDUSDT","EIGENUSDT","ENAUSDT","ENJUSDT","ENSUSDT",
  "EOSUSDT","ETCUSDT","ETHUSDT","ETHWUSDT","EURUSDT",
  "FETUSDT","FILUSDT","FLMUSDT","FLOCKUSDT","FLOWUSDT","FLRUSDT",
  "FORTHUSDT","FTMUSDT","FXSUSDT","GALAUSDT","GASUSDT","GFTUSDT",
  "GLMUSDT","GLMUSDT","GMTUSDT","GMXUSDT","GPTUSDT","GRAILUSDT",
  "GRASSUSDT","GRTUSDT","GTCUSDT","GUSDUSDT","HBARUSDT","HFTUSDT",
  "HIGHUSDT","HOOKUSDT","HOTUSDT","ICPUSDT","ICXUSDT","IDUSDT",
  "INJUSDT","IOSTUSDT","IOTAUSDT","IOTXUSDT","JASMYUSDT","JOEUSDT",
  "JTOUSDT","JUPUSDT","KASUSDT","KAVAUSDT","KLAYUSDT","KMNO USDT",
  "KNCUSDT","KSMUSDT","LDOUSDT","LEVERUSDT","LINAUSDT","LINKUSDT",
  "LITUSDT","LOOKSUSDT","LPTUSDT","LQTYUSDT","LRCUSDT","LTCUSDT",
  "LUMIAUSDT","LUNA2USDT","MAGICUSDT","MANAUSDT","MASKUSDT","MATICUSDT",
  "MAVUSDT","MBLUSDT","MDTUSDT","MELANIAUSDT","MERLUSDT","METISUSDT",
  "MKRUSDT","MNTUSDT","MOVEUSDT","MOVRUSDT","MTLUSDT","MYROUSDT",
  "NEARUSDT","NEOUSDT","NKNUSDT","NOTUSDT","NTRN USDT","OCEANUSDT",
  "OGUSDT","OMEUSDT","OMGUSDT","OMNIUSDT","ONDOUSDT","ONTUSDT",
  "OPUSDT","ORBSUSDT","ORDIUSDT","OXTUSDT","PAXGUSDT","PENDLEUSDT",
  "PEOPLEUSDT","PERPUSDT","PHBUSDT","PIXELUSDT","PLAUSDT","POLYXUSDT",
  "PONDUSDT","POPCATUSDT","PORTALUSDT","POWRUSDT","PYTHUSDT","QKCUSDT",
  "QNTUSDT","RAYUSDT","RDNTUSDT","REEFUSDT","REZUSDT","RLCUSDT",
  "RNDRUSDT","RONINUSDT","ROSEUSDT","RPLUSDT","RUNEUSDT","RVNUSDT",
  "SAGAUSDT","SANDUSDT","SCAUSDT","SCRUSDT","SEIUSDT","SFPUSDT",
  "SKLUSDT","SLPUSDT","SNXUSDT","SOLUSDT","SPELLUSDT","SSVUSDT",
  "STEEMUSDT","STGUSDT","STMXUSDT","STORJUSDT","STRKUSDT","STXUSDT",
  "SUIUSDT","SUNUSDT","SUPERUSDT","SUSHIUSDT","SWELLUSDT","SXPUSDT",
  "THETAUSDT","TIAUSDT","TOKENUSDT","TONUSDT","TROYUSDT","TRUUSDT",
  "TRXUSDT","TURBOUSDT","TWTUSDT","UMAUSDT","UNIUSDT","USDCUSDT",
  "VANRYUSDT","VETUSDT","VGXUSDT","VTHOUSDT","WAXPUSDT","WIFUSDT",
  "WINUSDT","WLDUSDT","WOOUSDT","WSMUSDT","XAIUSDT","XEMUSDT",
  "XLMUSDT","XMRUSDT","XRPUSDT","XTZUSDT","XVGUSDT","XVSUSDT",
  "YFIUSDT","ZECUSDT","ZENUSDT","ZETAUSDT","ZILUSDT","ZKUSDT","ZROUSDT",
];

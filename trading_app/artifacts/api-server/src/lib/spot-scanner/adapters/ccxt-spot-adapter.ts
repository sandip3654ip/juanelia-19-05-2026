/**
 * CCXT Pro unified spot adapter
 */

import ccxt from "ccxt";
import { logger } from "../../logger.js";
import type { SpotQuote } from "../types.js";

const STABLES = new Set(["USDT", "USDC", "BUSD"]);
const RECONNECT_DELAY_MS = 3_000;
const BITGET_FEES_URL = "https://api.bitget.com/api/v2/spot/public/symbols";

function stripQuote(ccxtSymbol: string): string | null {
  const slash = ccxtSymbol.indexOf("/");
  if (slash === -1) return null;
  const base  = ccxtSymbol.slice(0, slash).toUpperCase();
  const rest  = ccxtSymbol.slice(slash + 1).toUpperCase();
  const quote = rest.split(":")[0];
  if (!STABLES.has(quote)) return null;
  return base;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class CcxtSpotAdapter {
  readonly quotes = new Map<string, SpotQuote>();
  readonly feeMap = new Map<string, { maker: number; taker: number }>();
  get dataSource(): "ws" | "rest" { return "ws"; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ex: any = null;
  private stopped  = false;
  private symbols: string[] = [];

  constructor(private readonly exchangeId: "binance" | "bybit" | "kucoin" | "bitget") {}

  start(): void {
    this.stopped = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ExClass = (ccxt as any).pro[this.exchangeId];
    if (!ExClass) {
      logger.error({ exchange: this.exchangeId }, "ccxt.pro does not have this exchange");
      return;
    }
    this.ex = new ExClass({
      enableRateLimit: true,
      newUpdates:      true,
      options:         { defaultType: "spot" },
    });
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    void this.ex?.close().catch(() => {});
  }

  private async run(): Promise<void> {
    if (this.exchangeId === "bitget") {
      void this.fetchBitgetFees();
    }

    while (!this.stopped) {
      try {
        await this.ex.loadMarkets();
        this.symbols = Object.values(
          this.ex.markets as Record<string, {
            spot:   boolean;
            active: boolean;
            quote:  string;
            symbol: string;
          }>,
        )
          .filter(m => m.spot && m.active && STABLES.has(m.quote ?? ""))
          .map(m => m.symbol);

        logger.info(
          { exchange: this.exchangeId, count: this.symbols.length },
          "ccxt spot markets loaded",
        );
        break;
      } catch (err) {
        logger.warn(
          { exchange: this.exchangeId, err: String(err) },
          "ccxt loadMarkets failed — retrying in 3s",
        );
        await sleep(RECONNECT_DELAY_MS);
      }
    }

    if (this.stopped || this.symbols.length === 0) return;

    // LIVE TESTED on CCXT 4.5.54:
    // Binance watchTickers() all-market → bid/ask = null  (use watchBidsAsks instead)
    // Bybit   watchTickers(chunk)       → bid=undefined   (use watchBidsAsks instead)
    // KuCoin  watchTickers() no-args    → bid/ask correct
    // Bitget  watchTickers(chunk)       → bid/ask correct

    if (this.exchangeId === "binance") {
      await this.watchBinanceBidsAsks();
    } else if (this.exchangeId === "kucoin") {
      await this.watchAllMarketStream();
    } else if (this.exchangeId === "bybit") {
      await this.watchBybitBidsAsks();
    } else {
      await this.watchChunked();
    }

    logger.info({ exchange: this.exchangeId }, "ccxt spot adapter stopped");
  }

  // KuCoin: all-market broadcast
  private async watchAllMarketStream(): Promise<void> {
    while (!this.stopped) {
      try {
        const tickers = await this.ex.watchTickers() as Record<
          string,
          { bid: number | undefined; ask: number | undefined }
        >;
        const now = Date.now();
        for (const [sym, ticker] of Object.entries(tickers)) {
          const base = stripQuote(sym);
          if (!base) continue;
          const bid = typeof ticker.bid === "number" ? ticker.bid : 0;
          const ask = typeof ticker.ask === "number" ? ticker.ask : 0;
          if (bid > 0 && ask > 0) {
            this.quotes.set(base, { bid, ask, receivedAt: now });
          }
        }
      } catch (err) {
        if (this.stopped) break;
        logger.warn(
          { exchange: this.exchangeId, err: String(err) },
          "ccxt watchTickers (all-market) error — retrying",
        );
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  // Binance: watchBidsAsks chunks of 200 → real bid/ask via bookTicker stream
  private async watchBinanceBidsAsks(): Promise<void> {
    const CHUNK_SIZE = 200;
    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += CHUNK_SIZE) {
      chunks.push(this.symbols.slice(i, i + CHUNK_SIZE));
    }
    logger.info(
      { exchange: "binance", chunks: chunks.length, symbolsPerChunk: CHUNK_SIZE },
      "ccxt spot binance starting watchBidsAsks chunks",
    );
    await Promise.all(chunks.map(chunk => this.watchBinanceBidsAsksLoop(chunk)));
  }

  private async watchBinanceBidsAsksLoop(chunk: string[]): Promise<void> {
    while (!this.stopped) {
      try {
        const tickers = await this.ex.watchBidsAsks(chunk) as Record<
          string,
          { bid: number | undefined; ask: number | undefined }
        >;
        const now = Date.now();
        for (const [sym, ticker] of Object.entries(tickers)) {
          const base = stripQuote(sym);
          if (!base) continue;
          const bid = typeof ticker.bid === "number" ? ticker.bid : 0;
          const ask = typeof ticker.ask === "number" ? ticker.ask : 0;
          if (bid > 0 && ask > 0) {
            this.quotes.set(base, { bid, ask, receivedAt: now });
          }
        }
      } catch (err) {
        if (this.stopped) break;
        logger.warn(
          { exchange: "binance", err: String(err) },
          "ccxt binance watchBidsAsks error — retrying",
        );
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  // Bybit: watchBidsAsks chunks of 50 → real bid/ask
  private async watchBybitBidsAsks(): Promise<void> {
    const CHUNK_SIZE = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += CHUNK_SIZE) {
      chunks.push(this.symbols.slice(i, i + CHUNK_SIZE));
    }
    logger.info(
      { exchange: "bybit", chunks: chunks.length, symbolsPerChunk: CHUNK_SIZE },
      "ccxt spot bybit starting watchBidsAsks chunks",
    );
    await Promise.all(chunks.map(chunk => this.watchBybitChunkLoop(chunk)));
  }

  private async watchBybitChunkLoop(chunk: string[]): Promise<void> {
    while (!this.stopped) {
      try {
        const tickers = await this.ex.watchBidsAsks(chunk) as Record<
          string,
          { bid: number | undefined; ask: number | undefined }
        >;
        const now = Date.now();
        for (const [sym, ticker] of Object.entries(tickers)) {
          const base = stripQuote(sym);
          if (!base) continue;
          const bid = typeof ticker.bid === "number" ? ticker.bid : 0;
          const ask = typeof ticker.ask === "number" ? ticker.ask : 0;
          if (bid > 0 && ask > 0) {
            this.quotes.set(base, { bid, ask, receivedAt: now });
          }
        }
      } catch (err) {
        if (this.stopped) break;
        logger.warn(
          { exchange: "bybit", err: String(err) },
          "ccxt bybit watchBidsAsks error — retrying",
        );
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  // Bitget: watchTickers chunks of 100
  private async watchChunked(): Promise<void> {
    const CHUNK_SIZE = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += CHUNK_SIZE) {
      chunks.push(this.symbols.slice(i, i + CHUNK_SIZE));
    }
    logger.info(
      { exchange: this.exchangeId, chunks: chunks.length, symbolsPerChunk: CHUNK_SIZE },
      "ccxt spot starting chunked watchTickers",
    );
    await Promise.all(chunks.map(chunk => this.watchChunkLoop(chunk)));
  }

  private async watchChunkLoop(chunk: string[]): Promise<void> {
    while (!this.stopped) {
      try {
        const tickers = await this.ex.watchTickers(chunk) as Record<
          string,
          { bid: number | undefined; ask: number | undefined }
        >;
        const now = Date.now();
        for (const [sym, ticker] of Object.entries(tickers)) {
          const base = stripQuote(sym);
          if (!base) continue;
          const bid = typeof ticker.bid === "number" ? ticker.bid : 0;
          const ask = typeof ticker.ask === "number" ? ticker.ask : 0;
          if (bid > 0 && ask > 0) {
            this.quotes.set(base, { bid, ask, receivedAt: now });
          }
        }
      } catch (err) {
        if (this.stopped) break;
        logger.warn(
          { exchange: this.exchangeId, err: String(err) },
          "ccxt watchTickers (chunk) error — retrying",
        );
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  private async fetchBitgetFees(): Promise<void> {
    try {
      const res = await fetch(BITGET_FEES_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`symbols HTTP ${res.status}`);
      const body = (await res.json()) as {
        data: Array<{ symbol: string; makerFeeRate: string; takerFeeRate: string }>;
      };
      for (const item of body.data) {
        const base = item.symbol.toUpperCase().replace(/USDT$|USDC$|BUSD$/, "");
        if (!base) continue;
        const maker = parseFloat(item.makerFeeRate);
        const taker = parseFloat(item.takerFeeRate);
        if (!isFinite(maker) || !isFinite(taker)) continue;
        this.feeMap.set(base, { maker, taker });
      }
      logger.info({ count: this.feeMap.size }, "bitget spot fees loaded (ccxt adapter)");
    } catch (err) {
      logger.warn(
        { err: String(err) },
        "bitget spot fee fetch failed (ccxt adapter) — falling back to static rates",
      );
    }
  }
}

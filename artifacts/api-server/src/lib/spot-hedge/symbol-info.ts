/**
 * Exchange symbol info — step size, min qty, min notional.
 * Results are cached in-process for the full session.
 * All endpoints are public (no auth required).
 */

import { logger } from "../logger.js";
import type { HedgeExchange } from "./types.js";

export interface SymbolInfo {
  stepSize:    number;   // minimum base qty increment  e.g. 0.0001
  minQty:      number;   // minimum base order qty
  minNotional: number;   // minimum order value in USDT
}

const _cache = new Map<string, SymbolInfo>();
const FALLBACK: SymbolInfo = { stepSize: 0.0001, minQty: 0.0001, minNotional: 1 };

// ── Per-exchange fetchers ─────────────────────────────────────────────────────

async function fetchBinance(token: string): Promise<SymbolInfo> {
  const symbol = `${token.toUpperCase()}USDT`;
  const res    = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`);
  const data   = await res.json() as { symbols?: Array<{ filters: Array<Record<string, string>> }> };
  const sym    = data.symbols?.[0];
  if (!sym) throw new Error(`Binance: symbol ${symbol} not found in exchangeInfo`);

  let stepSize = FALLBACK.stepSize, minQty = FALLBACK.minQty, minNotional = FALLBACK.minNotional;
  for (const f of sym.filters) {
    if (f.filterType === "LOT_SIZE") {
      stepSize = parseFloat(f.stepSize ?? "0.0001");
      minQty   = parseFloat(f.minQty   ?? "0.0001");
    }
    if (f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL") {
      minNotional = parseFloat(f.minNotional ?? "1");
    }
  }
  return { stepSize, minQty, minNotional };
}

async function fetchBybit(token: string): Promise<SymbolInfo> {
  const symbol = `${token.toUpperCase()}USDT`;
  const res    = await fetch(`https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=${symbol}`);
  const data   = await res.json() as { result?: { list?: Array<Record<string, unknown>> } };
  const sym    = data.result?.list?.[0];
  if (!sym) throw new Error(`Bybit: symbol ${symbol} not found`);

  const lsf        = (sym.lotSizeFilter ?? {}) as Record<string, string>;
  const stepSize   = parseFloat(lsf.basePrecision ?? "0.0001");
  const minQty     = parseFloat(lsf.minOrderQty   ?? stepSize.toString());
  const minNotional = parseFloat((sym.minNotionalValue as string) ?? "1");
  return { stepSize, minQty, minNotional };
}

async function fetchKucoin(token: string): Promise<SymbolInfo> {
  // KuCoin public symbol endpoint (v1 — no auth needed)
  // Use market=USDS filter to fetch only USDT-quote pairs (~600 symbols) instead
  // of the full list (~5 000 symbols, ~1 MB), making the first call ~10× faster.
  const symbol = `${token.toUpperCase()}-USDT`;
  const res    = await fetch(`https://api.kucoin.com/api/v1/symbols?market=USDS`);
  const data   = await res.json() as { data?: Array<Record<string, string>> };
  const sym    = (data.data ?? []).find(s => s.symbol === symbol);
  if (!sym) throw new Error(`KuCoin: symbol ${symbol} not found`);

  const stepSize   = parseFloat(sym.baseIncrement ?? "0.0001");
  const minQty     = parseFloat(sym.baseMinSize   ?? stepSize.toString());
  const minNotional = parseFloat(sym.quoteMinSize ?? "1");
  return { stepSize, minQty, minNotional };
}

async function fetchBitget(token: string): Promise<SymbolInfo> {
  const symbol = `${token.toUpperCase()}USDT`;
  const res    = await fetch(`https://api.bitget.com/api/v2/spot/public/symbols?symbol=${symbol}`);
  const data   = await res.json() as { data?: Array<Record<string, string>> };
  const sym    = data.data?.[0];
  if (!sym) throw new Error(`Bitget: symbol ${symbol} not found`);

  // Bitget returns precision as number of decimal places
  const prec       = parseInt(sym.quantityPrecision ?? "4", 10);
  const stepSize   = Math.pow(10, -prec);
  const minQty     = parseFloat(sym.minTradeAmount ?? stepSize.toString());
  const minNotional = parseFloat(sym.minTradeUSDT ?? "1");
  return { stepSize, minQty, minNotional };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get symbol info for an exchange+token pair, cached for the session.
 * Falls back to safe defaults if the exchange API is unreachable.
 */
export async function getSymbolInfo(exchange: HedgeExchange, token: string): Promise<SymbolInfo> {
  const key = `${exchange}:${token.toUpperCase()}`;
  if (_cache.has(key)) return _cache.get(key)!;

  try {
    let info: SymbolInfo;
    if      (exchange === "binance") info = await fetchBinance(token);
    else if (exchange === "bybit")   info = await fetchBybit(token);
    else if (exchange === "kucoin")  info = await fetchKucoin(token);
    else                             info = await fetchBitget(token);

    _cache.set(key, info);
    logger.info({ exchange, token, info }, "spot-hedge: symbol info cached");
    return info;
  } catch (err) {
    logger.warn({ exchange, token, err: String(err) }, "spot-hedge: symbol info fetch failed — using fallback");
    _cache.set(key, FALLBACK);
    return FALLBACK;
  }
}

/** Floor a quantity to the exchange step size (never round up — avoids over-sell). */
export function floorToStep(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const factor = Math.round(1 / stepSize);   // e.g. 0.0001 → 10000
  return Math.floor(qty * factor) / factor;
}

/** Number of decimal places for a given step size. */
export function stepDecimals(stepSize: number): number {
  if (stepSize >= 1) return 0;
  return Math.round(-Math.log10(stepSize));
}

/** Clear the cache (useful for tests or when switching tokens mid-session). */
export function clearSymbolInfoCache(): void {
  _cache.clear();
}

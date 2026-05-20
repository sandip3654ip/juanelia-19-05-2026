import * as binance from "./binance.js";
import * as bybit   from "./bybit.js";
import * as kucoin  from "./kucoin.js";
import * as bitget  from "./bitget.js";
import type { TradeInput, TradeResult, CancelResult, Balance } from "./types.js";

export type { TradeInput, TradeResult, CancelResult, Balance } from "./types.js";
export type Exchange = "binance" | "bybit" | "kucoin" | "bitget";

function adapter(ex: Exchange) {
  if (ex === "binance") return binance;
  if (ex === "bybit")   return bybit;
  if (ex === "kucoin")  return kucoin;
  if (ex === "bitget")  return bitget;
  throw new Error(`Unknown exchange: ${ex}`);
}

export function placeOrder(exchange: Exchange, input: TradeInput): Promise<TradeResult> {
  return adapter(exchange).placeOrder(input);
}

export function fetchOrder(exchange: Exchange, symbol: string, orderId: string): Promise<TradeResult> {
  return adapter(exchange).fetchOrder(symbol, orderId);
}

export function cancelOrder(exchange: Exchange, symbol: string, orderId: string): Promise<CancelResult> {
  return adapter(exchange).cancelOrder(symbol, orderId);
}

export function getBalance(exchange: Exchange, asset?: string): Promise<Record<string, Balance>> {
  return adapter(exchange).getBalance(asset);
}

export async function getAllBalances(asset = "USDT"): Promise<Record<Exchange, Balance | null>> {
  const exchanges: Exchange[] = ["binance", "bybit", "kucoin", "bitget"];
  const settled = await Promise.allSettled(exchanges.map((ex) => getBalance(ex, asset)));
  const out = {} as Record<Exchange, Balance | null>;
  settled.forEach((r, i) => {
    out[exchanges[i]] = r.status === "fulfilled" ? (r.value[asset] ?? { free: 0, locked: 0 }) : null;
  });
  return out;
}

/**
 * KuCoin-specific: transfer a coin from MAIN (funding) account → TRADE (spot) account.
 * Needed before selling on KuCoin when coins arrived via external deposit
 * (deposits always land in MAIN; sell orders require coins in TRADE).
 * Throws if the transfer fails.
 */
export function kucoinTransferMainToTrade(currency: string, amount: number): Promise<void> {
  return kucoin.transferMainToTrade(currency, amount);
}

/**
 * KuCoin-specific: balance from the MAIN (funding) account.
 * Deposits always land here — never in the TRADE account that getBalance() reads.
 * Used for deposit-arrival detection in the bot engine.
 */
export function kucoinGetMainBalance(currency?: string): Promise<Record<string, Balance>> {
  return kucoin.getMainBalance(currency);
}

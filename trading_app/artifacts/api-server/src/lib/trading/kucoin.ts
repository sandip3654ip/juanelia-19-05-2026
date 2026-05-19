import crypto from "crypto";
import { logger } from "../logger.js";
import type { TradeInput, TradeResult, CancelResult, Balance } from "./types.js";

const BASE_URL = "https://api.kucoin.com";

function hmacB64(secret: string, msg: string): string {
  return crypto.createHmac("sha256", secret).update(msg).digest("base64");
}

function toSymbol(c: string): string { return `${c.toUpperCase()}-USDT`; }

function authHeaders(ts: string, method: string, path: string, body: string): Record<string, string> {
  const secret     = process.env.KUCOIN_API_SECRET     ?? "";
  const passphrase = process.env.KUCOIN_API_PASSPHRASE ?? "";
  const preHash    = `${ts}${method.toUpperCase()}${path}${body}`;
  return {
    "Content-Type":       "application/json",
    "KC-API-KEY":         process.env.KUCOIN_API_KEY ?? "",
    "KC-API-SIGN":        hmacB64(secret, preHash),
    "KC-API-TIMESTAMP":   ts,
    "KC-API-PASSPHRASE":  hmacB64(secret, passphrase),
    "KC-API-KEY-VERSION": "2",
  };
}

async function sPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ts  = String(Date.now());
  const str = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: authHeaders(ts, "POST", path, str), body: str });
  const d   = await res.json() as Record<string, unknown>;
  if (d.code !== "200000") throw new Error(`KuCoin POST ${path} → ${d.code}: ${d.msg}`);
  return d;
}

async function sGet(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const ts  = String(Date.now());
  const qs  = params && Object.keys(params).length > 0 ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${BASE_URL}${path}${qs}`, { headers: authHeaders(ts, "GET", `${path}${qs}`, "") });
  const d   = await res.json() as Record<string, unknown>;
  if (d.code !== "200000") throw new Error(`KuCoin GET ${path} → ${d.code}: ${d.msg}`);
  return d;
}

async function sDelete(path: string): Promise<Record<string, unknown>> {
  const ts  = String(Date.now());
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers: authHeaders(ts, "DELETE", path, "") });
  const d   = await res.json() as Record<string, unknown>;
  if (d.code !== "200000") throw new Error(`KuCoin DELETE ${path} → ${d.code}: ${d.msg}`);
  return d;
}

/** Fetch a single order's fill details by orderId. */
export async function fetchOrder(symbol: string, orderId: string): Promise<TradeResult> {
  const resp    = await sGet(`/api/v1/orders/${orderId}`);
  const raw     = resp.data as Record<string, unknown>;
  const execQty = parseFloat(String(raw.dealSize  ?? "0"));  // filled base qty
  const execQuo = parseFloat(String(raw.dealFunds ?? "0"));  // filled quote (USDT)
  return {
    success: true, orderId: String(raw.id ?? orderId),
    clientOrderId: (raw.clientOid as string) || undefined,
    exchange: "kucoin", symbol: symbol.toUpperCase(),
    side: raw.side as "buy" | "sell",
    type: raw.type as "market" | "limit",
    // KuCoin returns isActive as a JSON boolean, not a string — compare both forms
    status: (raw.isActive === true || raw.isActive === "true") ? "active" : "done",
    executedQty: execQty, executedQuoteQty: execQuo,
    avgPrice: execQty > 0 ? execQuo / execQty : 0,
    fee: parseFloat(String(raw.fee ?? "0")) || undefined,
    feeCurrency: (raw.feeCurrency as string) || undefined,
    raw: resp,
  };
}

export async function placeOrder(input: TradeInput): Promise<TradeResult> {
  const clientOid = input.clientOrderId ?? `arb-${Date.now()}`;
  const body: Record<string, unknown> = {
    clientOid, side: input.side, symbol: toSymbol(input.symbol), type: input.type,
  };
  if (input.type === "market") {
    if (input.side === "buy") {
      if (!input.quoteQty) throw new Error("quoteQty required for KuCoin market buy");
      body.funds = String(input.quoteQty);
    } else {
      if (!input.baseQty) throw new Error("baseQty required for KuCoin market sell");
      body.size = String(input.baseQty);
    }
  } else {
    if (!input.price || !input.baseQty) throw new Error("price + baseQty required for limit");
    body.price = String(input.price); body.size = String(input.baseQty);
  }
  const resp    = await sPost("/api/v1/orders", body);
  const data    = resp.data as Record<string, string>;
  const orderId = data.orderId;
  logger.info({ exchange: "kucoin", symbol: input.symbol, side: input.side, orderId }, "order placed");

  // KuCoin market orders fill asynchronously — retry up to 3 times with backoff
  // to handle the common case where the fill hasn't settled within 800ms.
  if (input.type === "market") {
    const retryDelays = [800, 1500, 2500]; // cumulative wait: 0.8s → 2.3s → 4.8s
    for (const delayMs of retryDelays) {
      await new Promise(r => setTimeout(r, delayMs));
      try {
        const result = await fetchOrder(input.symbol, orderId);
        if (result.executedQty > 0) return result; // filled — success
        logger.warn({ exchange: "kucoin", orderId, executedQty: 0 }, "fetchOrder returned 0 qty, retrying");
      } catch (err) {
        logger.warn({ exchange: "kucoin", orderId, err: String(err) }, "fetchOrder attempt failed, retrying");
      }
    }
    // All retries exhausted — order placed but fill details unavailable.
    // Bot compensation logic will handle the executedQty=0 case safely.
    logger.warn(
      { exchange: "kucoin", symbol: input.symbol, orderId },
      "placeOrder: all fetchOrder retries exhausted — executedQty unknown; bot will handle safely",
    );
  }

  return {
    success: true, orderId, clientOrderId: clientOid,
    exchange: "kucoin", symbol: input.symbol.toUpperCase(),
    side: input.side, type: input.type, status: "new",
    executedQty: 0, executedQuoteQty: 0, avgPrice: 0, raw: resp,
  };
}

export async function cancelOrder(symbol: string, orderId: string): Promise<CancelResult> {
  const resp = await sDelete(`/api/v1/orders/${orderId}`);
  logger.info({ exchange: "kucoin", symbol, orderId }, "order cancelled");
  return {
    success: true, orderId,
    exchange: "kucoin", symbol: symbol.toUpperCase(),
    status: "cancelled", raw: resp,
  };
}

export async function getBalance(currency?: string): Promise<Record<string, Balance>> {
  const params: Record<string, string> = { type: "trade" };
  if (currency) params.currency = currency;
  const resp   = await sGet("/api/v1/accounts", params);
  const result: Record<string, Balance> = {};
  for (const acc of (resp.data as Array<Record<string, string>>) ?? []) {
    const free = parseFloat(acc.available); const locked = parseFloat(acc.holds);
    if (free > 0 || locked > 0 || acc.currency === currency) result[acc.currency] = { free, locked };
  }
  return result;
}

/**
 * KuCoin MAIN (funding) account balance.
 * Deposits from external withdrawals always land here — never in the TRADE account.
 * Used by the bot to detect deposit arrival when the primary txId path is unavailable.
 */
export async function getMainBalance(currency?: string): Promise<Record<string, Balance>> {
  const params: Record<string, string> = { type: "main" };
  if (currency) params.currency = currency;
  const resp   = await sGet("/api/v1/accounts", params);
  const result: Record<string, Balance> = {};
  for (const acc of (resp.data as Array<Record<string, string>>) ?? []) {
    const free = parseFloat(acc.available); const locked = parseFloat(acc.holds);
    if (free > 0 || locked > 0 || acc.currency === currency) result[acc.currency] = { free, locked };
  }
  return result;
}

/**
 * Transfer a coin from KuCoin's MAIN (funding) account → TRADE (spot) account.
 * Needed before placing a sell order when coins arrived via an external deposit
 * (deposits always land in the MAIN account on KuCoin).
 *
 * Throws if the transfer fails so the bot can catch and fail the trade cleanly.
 */
export async function transferMainToTrade(currency: string, amount: number): Promise<void> {
  await sPost("/api/v2/accounts/inner-transfer", {
    clientOid: `bot-m2t-${Date.now()}`,
    currency,
    from:   "main",
    to:     "trade",
    amount: String(amount),
  });
  logger.info({ exchange: "kucoin", currency, amount }, "kucoin: main→trade transfer done");
}

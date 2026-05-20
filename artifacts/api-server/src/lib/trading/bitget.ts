import crypto from "crypto";
import { logger } from "../logger.js";
import type { TradeInput, TradeResult, CancelResult, Balance } from "./types.js";

const BASE_URL = "https://api.bitget.com";

function sign(ts: string, method: string, path: string, body: string): string {
  const secret = process.env.BITGET_API_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(`${ts}${method.toUpperCase()}${path}${body}`).digest("base64");
}

function toSymbol(c: string): string { return `${c.toUpperCase()}USDT`; }

function authHeaders(ts: string, method: string, path: string, body: string): Record<string, string> {
  return {
    "Content-Type":      "application/json",
    "ACCESS-KEY":        process.env.BITGET_API_KEY        ?? "",
    "ACCESS-SIGN":       sign(ts, method, path, body),
    "ACCESS-TIMESTAMP":  ts,
    "ACCESS-PASSPHRASE": process.env.BITGET_API_PASSPHRASE ?? "",
    "locale":            "en-US",
  };
}

async function sPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ts  = String(Date.now());
  const str = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: authHeaders(ts, "POST", path, str), body: str });
  const d   = await res.json() as Record<string, unknown>;
  if (d.code !== "00000") throw new Error(`Bitget POST ${path} → ${d.code}: ${d.msg}`);
  return d;
}

async function sGet(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const ts  = String(Date.now());
  const qs  = params && Object.keys(params).length > 0 ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${BASE_URL}${path}${qs}`, { headers: authHeaders(ts, "GET", `${path}${qs}`, "") });
  const d   = await res.json() as Record<string, unknown>;
  if (d.code !== "00000") throw new Error(`Bitget GET ${path} → ${d.code}: ${d.msg}`);
  return d;
}

/** Fetch a single order's fill details by orderId. */
export async function fetchOrder(symbol: string, orderId: string): Promise<TradeResult> {
  const resp    = await sGet("/api/v2/spot/trade/orderInfo", { orderId });
  const list    = (resp.data ?? []) as Array<Record<string, string>>;
  const o       = list[0] ?? {};
  // baseVolume = filled base qty; quoteVolume = filled quote (USDT)
  const execQty = parseFloat(o.baseVolume  ?? o.size      ?? "0");
  const execQuo = parseFloat(o.quoteVolume ?? o.amount    ?? "0");
  const avgPx   = parseFloat(o.priceAvg   ?? o.price     ?? "0");
  return {
    success: true, orderId: o.ordId ?? orderId,
    clientOrderId: o.clientOid || undefined,
    exchange: "bitget", symbol: symbol.toUpperCase(),
    side: o.side as "buy" | "sell",
    type: (o.orderType ?? "market") as "market" | "limit",
    status: o.status ?? "unknown",
    executedQty: execQty, executedQuoteQty: execQuo,
    avgPrice: execQty > 0 ? execQuo / execQty : avgPx,
    raw: resp,
  };
}

export async function placeOrder(input: TradeInput): Promise<TradeResult> {
  const body: Record<string, unknown> = {
    symbol:    toSymbol(input.symbol),
    side:      input.side,
    orderType: input.type === "market" ? "market" : "limit",
    force:     "gtc",
  };
  if (input.clientOrderId) body.clientOid = input.clientOrderId;
  if (input.type === "market") {
    if (input.side === "buy") {
      if (!input.quoteQty) throw new Error("quoteQty required for Bitget market buy");
      body.size = String(input.quoteQty);
    } else {
      if (!input.baseQty) throw new Error("baseQty required for Bitget market sell");
      body.size = String(input.baseQty);
    }
  } else {
    if (!input.price || !input.baseQty) throw new Error("price + baseQty required for limit");
    body.price = String(input.price); body.size = String(input.baseQty);
  }
  const resp = await sPost("/api/v2/spot/trade/place-order", body);
  const data = resp.data as Record<string, string>;
  logger.info({ exchange: "bitget", symbol: input.symbol, side: input.side, orderId: data.ordId }, "order placed");

  // Bitget market orders: fetch fill details after brief delay
  if (input.type === "market") {
    await new Promise(r => setTimeout(r, 800));
    try {
      return await fetchOrder(input.symbol, data.ordId);
    } catch (err) {
      // Order was placed (real money spent) but fill details unavailable.
      // Bot Phase 2 Guard A will catch executedQty=0 and fail the trade with a clear error.
      // User must manually check Bitget and sell any purchased coins.
      logger.warn(
        { exchange: "bitget", symbol: input.symbol, orderId: data.ordId, err: String(err) },
        "placeOrder: market buy placed but fetchOrder failed — executedQty unknown; bot will fail trade safely",
      );
    }
  }

  return {
    success: true, orderId: data.ordId, clientOrderId: data.clientOid || undefined,
    exchange: "bitget", symbol: input.symbol.toUpperCase(),
    side: input.side, type: input.type, status: "new",
    executedQty: 0, executedQuoteQty: 0, avgPrice: 0, raw: resp,
  };
}

export async function cancelOrder(symbol: string, orderId: string): Promise<CancelResult> {
  const resp = await sPost("/api/v2/spot/trade/cancel-order", { symbol: toSymbol(symbol), orderId });
  const data = resp.data as Record<string, string>;
  logger.info({ exchange: "bitget", symbol, orderId }, "order cancelled");
  return {
    success: true, orderId: data.ordId ?? orderId,
    exchange: "bitget", symbol: symbol.toUpperCase(),
    status: "cancelled", raw: resp,
  };
}

export async function getBalance(coin?: string): Promise<Record<string, Balance>> {
  const params: Record<string, string> = {};
  if (coin) params.coin = coin;
  const resp   = await sGet("/api/v2/spot/account/assets", params);
  const result: Record<string, Balance> = {};
  for (const asset of (resp.data as Array<Record<string, string>>) ?? []) {
    const free = parseFloat(asset.available ?? "0"); const locked = parseFloat(asset.frozen ?? "0");
    if (free > 0 || locked > 0 || asset.coin === coin) result[asset.coin] = { free, locked };
  }
  return result;
}

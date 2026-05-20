import crypto from "crypto";
import { logger } from "../logger.js";
import type { TradeInput, TradeResult, CancelResult, Balance } from "./types.js";

const BASE_URL    = "https://api.binance.com";
const RECV_WINDOW = 5_000;

function sign(qs: string): string {
  const secret = process.env.BINANCE_API_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}

function apiKey(): string { return process.env.BINANCE_API_KEY ?? ""; }

function toSymbol(c: string): string { return `${c.toUpperCase()}USDT`; }

async function signedReq(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number>,
): Promise<unknown> {
  params.timestamp  = Date.now();
  params.recvWindow = RECV_WINDOW;
  const qs  = new URLSearchParams(params as Record<string, string>).toString();
  const sig = sign(qs);
  const url = `${BASE_URL}${path}?${qs}&signature=${sig}`;
  const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": apiKey() } });
  const body = await res.json();
  if (!res.ok) {
    const b = body as { code: number; msg: string };
    throw new Error(`Binance ${method} ${path} → ${b.code}: ${b.msg}`);
  }
  return body;
}

export async function placeOrder(input: TradeInput): Promise<TradeResult> {
  const params: Record<string, string | number> = {
    symbol: toSymbol(input.symbol),
    side:   input.side.toUpperCase(),
    type:   input.type.toUpperCase(),
  };
  if (input.clientOrderId) params.newClientOrderId = input.clientOrderId;
  if (input.type === "market") {
    if (input.side === "buy") {
      if (!input.quoteQty) throw new Error("quoteQty required for Binance market buy");
      params.quoteOrderQty = input.quoteQty;
    } else {
      if (!input.baseQty) throw new Error("baseQty required for Binance market sell");
      params.quantity = input.baseQty;
    }
  } else {
    if (!input.price || !input.baseQty) throw new Error("price + baseQty required for limit");
    params.price       = input.price;
    params.quantity    = input.baseQty;
    params.timeInForce = "GTC";
  }
  const body  = await signedReq("POST", "/api/v3/order", params) as Record<string, unknown>;
  const fills = (body.fills as Array<Record<string, string>> | undefined) ?? [];
  const execQty   = parseFloat(body.executedQty         as string ?? "0");
  const execQuote = parseFloat(body.cummulativeQuoteQty as string ?? "0");
  logger.info({ exchange: "binance", symbol: input.symbol, side: input.side, orderId: body.orderId }, "order placed");
  return {
    success: true, orderId: String(body.orderId),
    clientOrderId: body.clientOrderId as string | undefined,
    exchange: "binance", symbol: input.symbol.toUpperCase(),
    side: input.side, type: input.type, status: body.status as string,
    executedQty: execQty, executedQuoteQty: execQuote,
    avgPrice: execQty > 0 ? execQuote / execQty : 0,
    fee: fills[0] ? parseFloat(fills[0].commission) : undefined,
    feeCurrency: fills[0]?.commissionAsset, raw: body,
  };
}

export async function fetchOrder(symbol: string, orderId: string): Promise<TradeResult> {
  const body      = await signedReq("GET", "/api/v3/order", { symbol: toSymbol(symbol), orderId }) as Record<string, unknown>;
  const execQty   = parseFloat(body.executedQty         as string ?? "0");
  const execQuote = parseFloat(body.cummulativeQuoteQty as string ?? "0");
  return {
    success: true, orderId: String(body.orderId),
    clientOrderId: body.clientOrderId as string | undefined,
    exchange: "binance", symbol: symbol.toUpperCase(),
    side: (body.side as string).toLowerCase() as "buy" | "sell",
    type: (body.type as string).toLowerCase() as "market" | "limit",
    status: body.status as string,
    executedQty: execQty, executedQuoteQty: execQuote,
    avgPrice: execQty > 0 ? execQuote / execQty : 0,
    raw: body,
  };
}

export async function cancelOrder(symbol: string, orderId: string): Promise<CancelResult> {
  const body = await signedReq("DELETE", "/api/v3/order", { symbol: toSymbol(symbol), orderId }) as Record<string, unknown>;
  logger.info({ exchange: "binance", symbol, orderId }, "order cancelled");
  return {
    success: true, orderId: String(body.orderId ?? orderId),
    exchange: "binance", symbol: symbol.toUpperCase(),
    status: body.status as string ?? "CANCELED", raw: body,
  };
}

export async function getBalance(asset?: string): Promise<Record<string, Balance>> {
  const body = await signedReq("GET", "/api/v3/account", {}) as Record<string, unknown>;
  const result: Record<string, Balance> = {};
  for (const b of (body.balances as Array<Record<string, string>>) ?? []) {
    const free = parseFloat(b.free); const locked = parseFloat(b.locked);
    if (free > 0 || locked > 0 || b.asset === asset) result[b.asset] = { free, locked };
  }
  return result;
}

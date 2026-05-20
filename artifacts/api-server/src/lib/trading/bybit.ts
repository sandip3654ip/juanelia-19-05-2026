import crypto from "crypto";
import { logger } from "../logger.js";
import type { TradeInput, TradeResult, CancelResult, Balance } from "./types.js";

const BASE_URL    = "https://api.bybit.com";
const RECV_WINDOW = "5000";

function sign(ts: string, payload: string): string {
  const secret = process.env.BYBIT_API_SECRET ?? "";
  const key    = process.env.BYBIT_API_KEY    ?? "";
  return crypto.createHmac("sha256", secret).update(`${ts}${key}${RECV_WINDOW}${payload}`).digest("hex");
}

function headers(ts: string, payload: string): Record<string, string> {
  return {
    "Content-Type":       "application/json",
    "X-BAPI-API-KEY":     process.env.BYBIT_API_KEY ?? "",
    "X-BAPI-SIGN":        sign(ts, payload),
    "X-BAPI-TIMESTAMP":   ts,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
  };
}

function toSymbol(c: string): string { return `${c.toUpperCase()}USDT`; }

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ts  = String(Date.now());
  const str = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: headers(ts, str), body: str });
  const d   = await res.json() as Record<string, unknown>;
  if ((d.retCode as number) !== 0) throw new Error(`Bybit POST ${path} → ${d.retCode}: ${d.retMsg}`);
  return d;
}

async function get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const ts  = String(Date.now());
  const qs  = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE_URL}${path}?${qs}`, { headers: headers(ts, qs) });
  const d   = await res.json() as Record<string, unknown>;
  if ((d.retCode as number) !== 0) throw new Error(`Bybit GET ${path} → ${d.retCode}: ${d.retMsg}`);
  return d;
}

/** Fetch a single order from history (market orders fill quickly and appear here). */
export async function fetchOrder(symbol: string, orderId: string): Promise<TradeResult> {
  const params = { category: "spot", symbol: toSymbol(symbol), orderId };

  // Try order history first (filled/cancelled orders)
  let order: Record<string, string> | undefined;
  try {
    const resp = await get("/v5/order/history", params);
    const list = ((resp.result as Record<string, unknown>)?.list ?? []) as Array<Record<string, string>>;
    order = list.find(o => o.orderId === orderId) ?? list[0];
  } catch { /* fall through to realtime */ }

  // Try open/active orders if not in history
  if (!order) {
    try {
      const resp = await get("/v5/order/realtime", params);
      const list = ((resp.result as Record<string, unknown>)?.list ?? []) as Array<Record<string, string>>;
      order = list.find(o => o.orderId === orderId) ?? list[0];
    } catch { /* ignore */ }
  }

  const o         = order ?? {};
  const execQty   = parseFloat(o.cumExecQty   ?? "0");
  const execQuote = parseFloat(o.cumExecValue ?? "0");
  return {
    success: true, orderId: o.orderId ?? orderId,
    clientOrderId: o.orderLinkId || undefined,
    exchange: "bybit", symbol: symbol.toUpperCase(),
    side: (o.side ?? "buy").toLowerCase() as "buy" | "sell",
    type: (o.orderType ?? "market").toLowerCase() as "market" | "limit",
    status: o.orderStatus ?? "unknown",
    executedQty: execQty, executedQuoteQty: execQuote,
    avgPrice: execQty > 0 ? execQuote / execQty : parseFloat(o.avgPrice ?? "0"),
    fee: parseFloat(o.cumExecFee ?? "0") || undefined,
    raw: order,
  };
}

export async function placeOrder(input: TradeInput): Promise<TradeResult> {
  const body: Record<string, unknown> = {
    category:  "spot",
    symbol:    toSymbol(input.symbol),
    side:      input.side === "buy" ? "Buy" : "Sell",
    orderType: input.type === "market" ? "Market" : "Limit",
  };
  if (input.clientOrderId) body.orderLinkId = input.clientOrderId;
  if (input.type === "market") {
    if (input.side === "buy") {
      if (!input.quoteQty) throw new Error("quoteQty required for Bybit market buy");
      body.marketUnit = "quoteCoin"; body.qty = String(input.quoteQty);
    } else {
      if (!input.baseQty) throw new Error("baseQty required for Bybit market sell");
      body.marketUnit = "baseCoin"; body.qty = String(input.baseQty);
    }
  } else {
    if (!input.price || !input.baseQty) throw new Error("price + baseQty required for limit");
    body.qty = String(input.baseQty); body.price = String(input.price); body.timeInForce = "GTC";
  }
  const resp   = await post("/v5/order/create", body);
  const result = resp.result as Record<string, string>;
  logger.info({ exchange: "bybit", symbol: input.symbol, side: input.side, orderId: result.orderId }, "order placed");

  // Market orders: wait briefly then fetch fill details (Bybit fills immediately but response lacks fill data)
  if (input.type === "market") {
    await new Promise(r => setTimeout(r, 600));
    try {
      return await fetchOrder(input.symbol, result.orderId);
    } catch (err) {
      // Order was placed (real money spent) but fill details unavailable.
      // Fall through to inline response which uses cumExecQty from create response.
      // If that is also 0, bot Phase 2 Guard A will fail the trade safely.
      logger.warn(
        { exchange: "bybit", symbol: input.symbol, orderId: result.orderId, err: String(err) },
        "placeOrder: market buy placed but fetchOrder failed — falling back to create-response fill data",
      );
    }
  }

  return {
    success: true, orderId: result.orderId,
    clientOrderId: result.orderLinkId || undefined,
    exchange: "bybit", symbol: input.symbol.toUpperCase(),
    side: input.side, type: input.type, status: result.orderStatus ?? "New",
    executedQty:      parseFloat(result.cumExecQty   ?? "0"),
    executedQuoteQty: parseFloat(result.cumExecValue ?? "0"),
    avgPrice:         parseFloat(result.avgPrice     ?? "0"),
    fee: parseFloat(result.cumExecFee ?? "0") || undefined, raw: resp,
  };
}

export async function cancelOrder(symbol: string, orderId: string): Promise<CancelResult> {
  const resp   = await post("/v5/order/cancel", { category: "spot", symbol: toSymbol(symbol), orderId });
  const result = resp.result as Record<string, string>;
  logger.info({ exchange: "bybit", symbol, orderId }, "order cancelled");
  return {
    success: true, orderId: result.orderId ?? orderId,
    exchange: "bybit", symbol: symbol.toUpperCase(),
    status: "cancelled", raw: resp,
  };
}

export async function getBalance(coin?: string): Promise<Record<string, Balance>> {
  const params: Record<string, string> = { accountType: "UNIFIED" };
  if (coin) params.coin = coin;
  const resp  = await get("/v5/account/wallet-balance", params);
  const coins = ((resp.result as Record<string, unknown[]>).list?.[0] as Record<string, unknown[]>)?.coin ?? [];
  const result: Record<string, Balance> = {};
  for (const c of coins as Array<Record<string, string>>) {
    const freeRaw = c.availableToWithdraw !== "" ? c.availableToWithdraw : c.walletBalance;
    const free    = parseFloat(freeRaw ?? "0");
    const locked  = parseFloat(c.locked ?? "0");
    if (free > 0 || locked > 0 || c.coin === coin) result[c.coin] = { free, locked };
  }
  return result;
}

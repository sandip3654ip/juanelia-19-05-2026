export interface TradeInput {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quoteQty?: number;
  baseQty?: number;
  price?: number;
  clientOrderId?: string;
}

export interface TradeResult {
  success: true;
  orderId: string;
  clientOrderId?: string;
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  status: string;
  executedQty: number;
  executedQuoteQty: number;
  avgPrice: number;
  fee?: number;
  feeCurrency?: string;
  raw?: unknown;
}

export interface CancelResult {
  success: true;
  orderId: string;
  exchange: string;
  symbol: string;
  status: string;
  raw?: unknown;
}

export interface Balance {
  free: number;
  locked: number;
}

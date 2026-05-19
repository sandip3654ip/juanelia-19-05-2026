/**
 * Standard public trading fee rates per exchange.
 * These are the default (lowest-volume tier) maker/taker rates.
 * Actual rates may be lower for high-volume accounts.
 */

export interface TradingFees {
  maker: number; // decimal e.g. 0.001 = 0.10%
  taker: number;
}

export const TRADING_FEES: Record<string, TradingFees> = {
  binance: { maker: 0.001,  taker: 0.001  }, // 0.10% / 0.10%
  bybit:   { maker: 0.001,  taker: 0.001  }, // 0.10% / 0.10%
  kucoin:  { maker: 0.001,  taker: 0.001  }, // 0.10% / 0.10%
  kraken:  { maker: 0.0016, taker: 0.0026 }, // 0.16% / 0.26%
  bitget:  { maker: 0.001,  taker: 0.001  }, // 0.10% / 0.10%
};

export function getTradingFees(exchange: string): TradingFees {
  return TRADING_FEES[exchange] ?? { maker: 0.001, taker: 0.001 };
}

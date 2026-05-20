// Projected profit calculation — pure function shared between
// SpotArbCard (display) and SpotArbTab (sort key).
//
// Universal Arbitrage Formula (user-verified):
//
//   Tokens      = A / B
//   SellValue   = Tokens × S
//   GrossProfit = SellValue − A
//
//   BuyFee      = A × BF%
//   SellFee     = SellValue × SF%       ← on sell value, not original A
//   TDSAmount   = SellValue × TDS%      ← on sell value (gross)
//   WF          = withdrawal fee (USDT)
//
//   NetProfit   = GrossProfit − BuyFee − SellFee − TDSAmount − WF
//   NetProfit%  = (NetProfit / A) × 100

export function computeProjectedProfit(opp, tradeAmount = 100) {
  const fees    = opp?.fees ?? {};
  const buyAsk  = opp?.buyAsk  ?? 0;
  const sellBid = opp?.sellBid ?? 0;

  // Effective rates (including 18% GST surcharge on exchange fee)
  const buyFeeEff  = (fees.buyFeeRate  ?? 0.001) * (1 + (fees.feeTaxRate ?? 0));
  const sellFeeEff = (fees.sellFeeRate ?? 0.001) * (1 + (fees.feeTaxRate ?? 0));
  const tdsRate    = fees.tdsRate ?? 0.01;

  // Step 1 — Tokens bought (full capital, fee charged separately)
  const tokens = buyAsk > 0 ? tradeAmount / buyAsk : 0;

  // Step 2 — Sell value
  const sellValue = tokens * sellBid;

  // Step 3 — Gross profit
  const grossProfit = sellValue - tradeAmount;

  // Step 4 — Buy fee (on trade amount)
  const buyFee = tradeAmount * buyFeeEff;

  // Step 5 — Sell fee (on sell value, not on A)
  const sellFee = sellValue * sellFeeEff;

  // Step 6 — TDS (on sell value, gross)
  const tdsAmount = sellValue * tdsRate;

  // Step 7 — Withdrawal fee in USDT
  const transferCoinFee = fees.totalTransferFeeInCoin ?? 0;
  const wdFee = transferCoinFee * (buyAsk > 0 ? buyAsk : 0);

  // Step 8 — Net profit
  const profit = grossProfit - buyFee - sellFee - tdsAmount - wdFee;

  // Step 9 — Net profit %
  const profitPercent = tradeAmount > 0 ? (profit / tradeAmount) * 100 : 0;

  return {
    buyFeeEff, sellFeeEff, tdsRate,
    tokens, sellValue, grossProfit,
    buyFee, sellFee, tdsAmount, wdFee,
    profit, profitPercent,
  };
}
